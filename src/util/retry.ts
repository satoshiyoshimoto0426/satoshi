/**
 * 指数バックオフ付きリトライ。
 *
 * 用途: HTTP(429 / 5xx / ネットワーク断)、AI API、LINE 配信。
 * 方針(詳細設計書 §6.1 / NFR-01): 一時的な失敗は諦めず、恒久的な失敗
 * (4xx など)は即座に諦める。判定は呼び出し側が `shouldRetry` で決める。
 */

/** 指定ミリ秒待つ。テストでは `RetryOptions.sleep` に差し替えて実時間を消費しない。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export interface RetryOptions {
  /** 初回試行のあとに許す「再試行」の回数。2 なら最大 3 回実行する。 */
  retries: number;
  /** 1 回目の再試行までの待ち時間(ms)。以降は 2 倍ずつ伸びる。 */
  baseDelayMs: number;
  /** 再試行してよい失敗か。省略時はすべて再試行する。 */
  shouldRetry?: (e: unknown) => boolean;
  /** 再試行の直前に呼ばれる。ログ出力用。ここで例外を投げてはならない。 */
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
  /** 待機関数。テスト用に注入可能。既定は setTimeout ベースの sleep。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * fn を最大 `retries + 1` 回実行する。
 * バックオフは `baseDelayMs * 2^(attempt-1)`(attempt は失敗した試行の 1 始まりの番号)。
 * 最終試行でも失敗した場合は最後の例外をそのまま投げる(握りつぶさない)。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleepFn = opts.sleep ?? sleep;
  // 負値や小数を渡されても暴走しないよう正規化する。
  const retries = Math.max(0, Math.trunc(opts.retries));
  const maxAttempts = retries + 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts) break;
      // 再試行しても無駄な失敗(4xx など)はここで打ち切り、最後の例外を投げる。
      if (opts.shouldRetry && !opts.shouldRetry(e)) break;
      const delayMs = opts.baseDelayMs * Math.pow(2, attempt - 1);
      opts.onRetry?.(e, attempt, delayMs);
      await sleepFn(delayMs);
    }
  }
  throw lastError;
}
