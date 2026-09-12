/**
 * 実行時設定(環境変数由来)の読み込み。
 * 詳細設計書 §2 / §11、要件定義書 NFR-03 / NFR-07 に対応する。
 *
 * 設計意図:
 * - 値は Cloud Run Jobs の Secret 参照や Scheduler のジョブ定義から注入される。
 *   誤った値のまま黙って既定値に落ちると「なぜか 2 秒待っていない」「なぜか本番に送信した」
 *   といった事故になるため、解釈できない値は必ず ConfigError で落とす。
 * - 秘密情報(SLACK_WEBHOOK_URL など)は検証エラーでも値を出力しない(NFR-03)。
 */
import { ConfigError } from '../types.js';
import type { RuntimeConfig } from '../types.js';

/** 未設定と空文字は同じ「未設定」として扱う(Cloud Run の空 Secret 対策)。 */
function readRaw(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return readRaw(env, key) ?? fallback;
}

function readNullableString(env: NodeJS.ProcessEnv, key: string): string | null {
  return readRaw(env, key) ?? null;
}

/**
 * 整数の環境変数を読む。
 * `'2000ms'` や `'2e3'` のような紛らわしい表記は受け付けない(意図しない値で動かさないため)。
 */
function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = readRaw(env, key);
  if (raw === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new ConfigError(`環境変数 ${key} は整数で指定してください(指定値: '${raw}')`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError(`環境変数 ${key} の値が大きすぎます(指定値: '${raw}')`);
  }
  if (parsed < min) {
    throw new ConfigError(`環境変数 ${key} は ${min} 以上で指定してください(指定値: ${parsed})`);
  }
  return parsed;
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/** 真偽値の環境変数を読む。綴り間違い(`ture` など)を true/false に丸めず落とす。 */
function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readRaw(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (TRUE_WORDS.has(raw)) return true;
  if (FALSE_WORDS.has(raw)) return false;
  throw new ConfigError(`環境変数 ${key} は true / false で指定してください(指定値: '${raw}')`);
}

function readStoreKind(env: NodeJS.ProcessEnv): RuntimeConfig['storeKind'] {
  const raw = readRaw(env, 'STORE_KIND')?.toLowerCase() ?? 'firestore';
  if (raw === 'firestore' || raw === 'memory') return raw;
  throw new ConfigError(
    `環境変数 STORE_KIND は 'firestore' または 'memory' を指定してください(指定値: '${raw}')`,
  );
}

/**
 * Slack Webhook URL。値そのものが秘密なので、エラーメッセージにも値を含めない(NFR-03)。
 */
function readSlackWebhookUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = readRaw(env, 'SLACK_WEBHOOK_URL');
  if (raw === undefined) return null;
  if (!raw.startsWith('https://')) {
    throw new ConfigError(
      '環境変数 SLACK_WEBHOOK_URL は https:// で始まる URL を指定してください(値は秘匿のため表示しません)',
    );
  }
  return raw;
}

/**
 * 環境変数から実行時設定を組み立てる。
 * 既定値は詳細設計書 §6.1 のレート制限・上限値に合わせてある。
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const runtime: RuntimeConfig = {
    gcpProjectId: readNullableString(env, 'GCP_PROJECT_ID'),
    firestoreDatabaseId: readString(env, 'FIRESTORE_DATABASE_ID', '(default)'),
    storeKind: readStoreKind(env),
    anthropicModel: readString(env, 'ANTHROPIC_MODEL', 'claude-opus-5'),
    userAgent: readString(env, 'USER_AGENT', 'SeidoWatchBot/1.0 (+mailto:ops@example.com)'),
    // 同一ホストへは 2 秒以上空ける(NFR-07)。テストでのみ 0 に落とせるよう下限は 0。
    hostDelayMs: readInt(env, 'HOST_DELAY_MS', 2000, 0),
    hostConcurrency: readInt(env, 'HOST_CONCURRENCY', 4, 1),
    httpTimeoutMs: readInt(env, 'HTTP_TIMEOUT_MS', 20000, 1),
    // 初回登録時の大量取込を防ぐ上限(詳細設計書 §6.1)。
    maxNewItemsPerSource: readInt(env, 'MAX_NEW_ITEMS_PER_SOURCE', 50, 1),
    maxContentChars: readInt(env, 'MAX_CONTENT_CHARS', 6000, 1),
    // 監査データの保持日数(FR-16)。
    retentionDays: readInt(env, 'RETENTION_DAYS', 90, 1),
    slackWebhookUrl: readSlackWebhookUrl(env),
    dryRun: readBool(env, 'DRY_RUN', false),
  };
  return runtime;
}
