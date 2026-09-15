/**
 * LINE Messaging API クライアント(詳細設計書 §9.2)。
 *
 * 方針:
 *  - broadcast は「全友だちに 1 通」。再送は必ず同じ `X-Line-Retry-Key` で行う。
 *    LINE 側がこのキーで重複排除するので、ネットワーク断で応答を取り損ねた場合でも
 *    受信者に二重配信されない(FR-12 の冪等性は deliveries の記録とこのキーの両輪で担保する)。
 *  - 429 / 5xx とネットワークエラーのみ再送する。4xx(429 以外)はトークン失効や
 *    本文不正など恒久的な失敗なので、待っても直らない。即座に諦めて通知に回す。
 *  - チャネルアクセストークンは例外メッセージにもログにも絶対に出さない(NFR / §11)。
 *    LINE の応答本文をそのまま転記する箇所があるため、念のため値一致で伏せ字にする。
 *
 * 契約により、このファイルは `fetch` を直接呼んでよい数少ないモジュールの 1 つ
 * (HttpClient は robots.txt 判定やホスト間隔制御を行うため API 呼び出しには使わない)。
 */

import type { BroadcastResult, LineClient, Logger, RuntimeConfig } from '../types.js';
import { LineApiError } from '../types.js';
import { sleep as defaultSleep, withRetry } from '../util/retry.js';

export interface LineClientDeps {
  /** テストで差し替える fetch。既定はグローバル fetch。 */
  fetchImpl?: typeof fetch;
  /** テストで差し替える待機関数。実時間を消費せずバックオフを検証するため。 */
  sleep?: (ms: number) => Promise<void>;
}

const BROADCAST_URL = 'https://api.line.me/v2/bot/message/broadcast';

/** 応答の追跡 ID。deliveries に保存して LINE 側の調査に使う。 */
const REQUEST_ID_HEADER = 'x-line-request-id';

/** 再送回数と初回待機。2s → 4s → 8s の指数バックオフ(詳細設計書 §9.2)。 */
const RETRIES = 3;
const BASE_DELAY_MS = 2000;

/** 応答本文からエラー説明を取り出すときの長さ上限(ログを汚さないため)。 */
const MAX_DETAIL_CHARS = 500;

/** LINE のエラー応答。形が変わっても落ちないよう最小限だけ型を付ける。 */
interface LineErrorBody {
  message?: unknown;
  details?: unknown;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * 応答本文やエラーメッセージにトークンが紛れ込んでいた場合に備えて伏せる。
 * 「出さないつもり」だけでは事故は防げないので、出口で値そのものを潰す。
 */
function stripToken(text: string, token: string): string {
  if (token === '' || !text.includes(token)) return text;
  return text.split(token).join('[REDACTED]');
}

/** LINE のエラー応答から人間が読める説明を組み立てる。 */
function extractDetail(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (trimmed === '') return '';

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') {
      const body = parsed as LineErrorBody;
      const parts: string[] = [];
      if (typeof body.message === 'string' && body.message !== '') parts.push(body.message);
      // details[].message には「どのプロパティが不正か」が入る。原因追跡に有用なので拾う。
      if (Array.isArray(body.details)) {
        for (const d of body.details) {
          if (d !== null && typeof d === 'object') {
            const m = (d as LineErrorBody).message;
            if (typeof m === 'string' && m !== '') parts.push(m);
          }
        }
      }
      if (parts.length > 0) return parts.join(' / ').slice(0, MAX_DETAIL_CHARS);
    }
  } catch {
    // JSON でない(HTML のエラーページなど)。本文をそのまま短く添える。
  }
  return trimmed.slice(0, MAX_DETAIL_CHARS);
}

/** 再送して直る見込みがある失敗か。 */
function isRetryable(e: unknown): boolean {
  if (e instanceof LineApiError) {
    // 429(レート制限)と 5xx(LINE 側の一時障害)だけ再送する。
    return e.status === 429 || e.status >= 500;
  }
  // fetch の例外 = ネットワーク断 / タイムアウト。一時的な可能性が高いので再送する。
  return true;
}

export function createLineClient(runtime: RuntimeConfig, logger: Logger, deps?: LineClientDeps): LineClient {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const sleepFn = deps?.sleep ?? defaultSleep;

  async function send(token: string, text: string, retryKey: string): Promise<BroadcastResult> {
    const res = await fetchImpl(BROADCAST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        // 再送時も同じ値を使うことが重複排除の前提(詳細設計書 §9.2)。
        'X-Line-Retry-Key': retryKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ type: 'text', text }] }),
      // LINE 側が無応答のまま配信ジョブを占有しないよう必ず打ち切る。
      signal: AbortSignal.timeout(runtime.httpTimeoutMs),
    });

    const requestId = res.headers.get(REQUEST_ID_HEADER);

    if (res.status >= 200 && res.status < 300) {
      // 成功時の本文は空 JSON。読み捨てて接続を解放する。
      await res.text().catch(() => '');
      return { requestId, status: res.status };
    }

    const bodyText = await res.text().catch(() => '');
    const detail = stripToken(extractDetail(bodyText), token);
    throw new LineApiError(
      res.status,
      detail === ''
        ? `LINE 配信に失敗しました (HTTP ${res.status})`
        : `LINE 配信に失敗しました (HTTP ${res.status}): ${detail}`,
    );
  }

  async function broadcast(token: string, text: string, retryKey: string): Promise<BroadcastResult> {
    const chars = [...text].length;

    if (runtime.dryRun) {
      // ドライランでは送信せず本文をそのまま出す。目視レビュー(preview / --dry-run)の要。
      // retryKey は秘密ではないが、ロガーは /key/i のキー名を伏せるため retryId という名前で出す。
      logger.info('DRY-RUN: LINE 配信を行わず本文を出力します', { retryId: retryKey, chars, text });
      return { requestId: 'dry-run', status: 200 };
    }

    const result = await withRetry(() => send(token, text, retryKey), {
      retries: RETRIES,
      baseDelayMs: BASE_DELAY_MS,
      shouldRetry: isRetryable,
      onRetry: (e, attempt, delayMs) => {
        logger.warn('LINE 配信に失敗したため再送します', {
          retryId: retryKey,
          attempt,
          delayMs,
          // errorMessage の中身は stripToken 済み(LineApiError 生成時に処理している)。
          error: stripToken(errorMessage(e), token),
        });
      },
      sleep: sleepFn,
    });

    logger.info('LINE 配信に成功しました', {
      retryId: retryKey,
      chars,
      status: result.status,
      requestId: result.requestId,
    });
    return result;
  }

  return { broadcast };
}
