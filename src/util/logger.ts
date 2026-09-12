/**
 * 構造化ロガー(JSON Lines)。
 *
 * 方針(詳細設計書 §12 / NFR-03 / NFR-06):
 *  - 1 レコード = 1 行の JSON。Cloud Logging がそのままフィールドとして解釈できる。
 *  - error のみ stderr、それ以外は stdout。
 *  - 秘密情報(LINE トークン / API キー / Slack Webhook URL)は絶対に出さない。
 *    キー名だけでなく「値の形」でも判定する。設定ミスや例外メッセージ経由で
 *    値が別のキーに紛れ込むことが現実にあるため。
 */

import type { Logger } from '../types.js';
import { systemClock } from './clock.js';

/** キー名がこれに一致したら、値の中身に関わらず伏せる。 */
const SECRET_KEY_RE = /token|key|secret|authorization|webhook|password/i;

/** 伏せた値の表示。 */
const REDACTED = '[REDACTED]';

/** 値そのものが秘密らしいと判定するパターン。 */
const BEARER_MARKER = 'Bearer ';
const SLACK_WEBHOOK_MARKER = 'hooks.slack.com';

/** 想定外に深い構造でスタックを食い潰さないための上限。 */
const MAX_DEPTH = 8;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 値の形から秘密情報を判定する。 */
function looksSecret(value: string): boolean {
  // 'Bearer xxx' は Authorization ヘッダそのもの。Slack Webhook は URL 自体が資格情報。
  return value.includes(BEARER_MARKER) || value.includes(SLACK_WEBHOOK_MARKER);
}

function sanitizeEntry(key: string, value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (SECRET_KEY_RE.test(key)) return REDACTED;
  return sanitizeValue(value, seen, depth);
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return looksSecret(value) ? REDACTED : value;
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      // JSON.stringify は bigint で例外を投げるため文字列化しておく。
      return value.toString();
    case 'function':
      return '[Function]';
    case 'symbol':
      return value.toString();
    default:
      break;
  }

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    // Error は列挙可能なプロパティを持たず JSON.stringify すると {} になってしまう。
    // 失敗の原因を握りつぶさないため、明示的に展開する。
    return {
      name: value.name,
      message: sanitizeValue(value.message, seen, depth + 1),
      stack: sanitizeValue(value.stack, seen, depth + 1),
    };
  }

  if (depth >= MAX_DEPTH) return '[TRUNCATED]';

  const obj = value as object;
  if (seen.has(obj)) return '[CIRCULAR]';
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeValue(v, seen, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeEntry(k, v, seen, depth + 1);
    }
    return out;
  } finally {
    // 同じオブジェクトが兄弟位置に 2 回現れるのは循環ではないので、抜けるときに外す。
    seen.delete(obj);
  }
}

/**
 * ログフィールドから秘密情報を取り除く。ネストしたオブジェクト・配列も再帰的に処理する。
 * 元のオブジェクトは変更しない。
 */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = sanitizeEntry(key, value, seen, 0);
  }
  return out;
}

/**
 * 出力する下限レベル。既定はすべて出す(debug)。
 * 本番で絞りたい場合のみ `LOG_LEVEL=info` などを設定する。
 */
function resolveThreshold(): number {
  const raw = (process.env['LOG_LEVEL'] ?? '').trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return LEVEL_ORDER[raw];
  }
  return LEVEL_ORDER.debug;
}

function emit(
  level: LogLevel,
  msg: string,
  base: Record<string, unknown>,
  fields?: Record<string, unknown>,
): void {
  const ts = systemClock.now().toISOString();
  const merged = fields ? { ...base, ...fields } : base;
  let line: string;
  try {
    line = JSON.stringify({ ts, level, msg, ...redact(merged) });
  } catch {
    // ログ出力の失敗でジョブ本体を落とさない。最低限「ログが壊れた事実」は残す。
    line = JSON.stringify({ ts, level, msg, logError: 'ログフィールドを JSON 化できませんでした' });
  }
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/**
 * ロガーを作る。`base` に入れたフィールド(job / runId など)は以降の全レコードに付く。
 */
export function createLogger(base: Record<string, unknown> = {}): Logger {
  const threshold = resolveThreshold();
  const bound: Record<string, unknown> = { ...base };

  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    emit(level, msg, bound, fields);
  };

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (fields) => createLogger({ ...bound, ...fields }),
  };
}
