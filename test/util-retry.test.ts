/**
 * src/util/retry.ts の単体テスト。
 *
 * 契約(モジュール契約 §src/util/retry.ts):
 *  - 指数バックオフは baseDelayMs * 2^(attempt-1)(= base, base*2, base*4 ...)。
 *  - shouldRetry が false を返したら再試行せず即座に投げる。
 *  - 最終試行でも失敗したら最後の例外を投げる。
 * 実時間を消費しないよう sleep は必ず注入して「要求された待機 ms の列」を検証する。
 */
import { describe, expect, it, vi } from 'vitest';

import { sleep, withRetry } from '../src/util/retry.js';

/** 注入用の待機関数。要求された ms を記録するだけで実際には待たない。 */
function recordingSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    fn: async (ms: number): Promise<void> => {
      calls.push(ms);
    },
  };
}

describe('withRetry', () => {
  it('成功したらそのまま値を返し、待機しない', async () => {
    const sleeper = recordingSleep();
    const fn = vi.fn(async () => 'ok');

    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1000, sleep: sleeper.fn })).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeper.calls).toEqual([]);
  });

  it('指数バックオフ: 要求された待機 ms が base, base*2, base*4 になる', async () => {
    const sleeper = recordingSleep();
    const fn = vi.fn(async () => {
      throw new Error('一時的な失敗');
    });

    await expect(withRetry(fn, { retries: 3, baseDelayMs: 2000, sleep: sleeper.fn })).rejects.toThrow(
      '一時的な失敗',
    );

    // 初回 + 再試行 3 回 = 4 回実行、待機は再試行の直前だけなので 3 回。
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleeper.calls).toEqual([2000, 4000, 8000]);
  });

  it('baseDelayMs が変わってもバックオフ倍率は 2 のべき乗', async () => {
    const sleeper = recordingSleep();
    const fn = vi.fn(async () => {
      throw new Error('失敗');
    });

    await expect(withRetry(fn, { retries: 2, baseDelayMs: 250, sleep: sleeper.fn })).rejects.toThrow('失敗');

    expect(sleeper.calls).toEqual([250, 500]);
  });

  it('shouldRetry が false を返したら即座に投げ、sleep を呼ばない', async () => {
    const sleeper = recordingSleep();
    const permanent = new Error('404 相当の恒久的な失敗');
    const fn = vi.fn(async () => {
      throw permanent;
    });
    const shouldRetry = vi.fn(() => false);

    await expect(
      withRetry(fn, { retries: 3, baseDelayMs: 1000, shouldRetry, sleep: sleeper.fn }),
    ).rejects.toBe(permanent);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(permanent);
    expect(sleeper.calls).toEqual([]);
  });

  it('shouldRetry が true の間だけ再試行する', async () => {
    const sleeper = recordingSleep();
    const fn = vi.fn(async () => {
      throw new Error('再試行可能');
    });

    await expect(
      withRetry(fn, { retries: 2, baseDelayMs: 100, shouldRetry: () => true, sleep: sleeper.fn }),
    ).rejects.toThrow('再試行可能');

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeper.calls).toEqual([100, 200]);
  });

  it('最終試行でも失敗したら「最後の」例外を投げる', async () => {
    const sleeper = recordingSleep();
    const errors = [new Error('1回目'), new Error('2回目'), new Error('3回目(最後)')];
    let i = 0;
    const fn = vi.fn(async () => {
      const e = errors[i];
      i += 1;
      throw e;
    });

    await expect(withRetry(fn, { retries: 2, baseDelayMs: 10, sleep: sleeper.fn })).rejects.toBe(errors[2]);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('途中で成功したらそれ以降は再試行しない', async () => {
    const sleeper = recordingSleep();
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt += 1;
      if (attempt < 3) throw new Error(`失敗 ${attempt}`);
      return `成功 ${attempt}`;
    });

    await expect(withRetry(fn, { retries: 5, baseDelayMs: 1000, sleep: sleeper.fn })).resolves.toBe('成功 3');

    // 3 回目で成功したので 4 回目以降は実行されず、待機も 2 回だけ。
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeper.calls).toEqual([1000, 2000]);
  });

  it('retries=0 なら 1 回だけ実行して待機しない', async () => {
    const sleeper = recordingSleep();
    const fn = vi.fn(async () => {
      throw new Error('一発勝負');
    });

    await expect(withRetry(fn, { retries: 0, baseDelayMs: 1000, sleep: sleeper.fn })).rejects.toThrow(
      '一発勝負',
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeper.calls).toEqual([]);
  });

  it('onRetry に例外・試行番号・待機 ms が渡る', async () => {
    const sleeper = recordingSleep();
    const onRetry = vi.fn();
    const failure = new Error('一時的');
    const fn = vi.fn(async () => {
      throw failure;
    });

    await expect(withRetry(fn, { retries: 2, baseDelayMs: 500, onRetry, sleep: sleeper.fn })).rejects.toBe(
      failure,
    );

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, failure, 1, 500);
    expect(onRetry).toHaveBeenNthCalledWith(2, failure, 2, 1000);
  });

  it('onRetry は待機の前に呼ばれる(ログが先に出る)', async () => {
    const order: string[] = [];
    const fn = vi.fn(async () => {
      throw new Error('失敗');
    });

    await expect(
      withRetry(fn, {
        retries: 1,
        baseDelayMs: 100,
        onRetry: () => order.push('onRetry'),
        sleep: async () => {
          order.push('sleep');
        },
      }),
    ).rejects.toThrow('失敗');

    expect(order).toEqual(['onRetry', 'sleep']);
  });
});

describe('sleep', () => {
  it('指定ミリ秒後に解決する', async () => {
    const startedAt = Date.now();
    await sleep(20);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  it('負数でも例外にならず即座に解決する', async () => {
    await expect(sleep(-100)).resolves.toBeUndefined();
  });
});
