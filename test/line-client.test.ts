/**
 * LINE Messaging API クライアント(詳細設計書 §9.2 / FR-10 / FR-12 / NFR-03)のテスト。
 *
 * fetch は必ずスタブを注入する。実ネットワークには一切出ない。
 * 冪等性(同じ X-Line-Retry-Key での再送)とトークン秘匿は配信システムの要なので厳密に見る。
 */

import { describe, expect, it } from 'vitest';
import { createLineClient } from '../src/line/client.js';
import type { Logger, RuntimeConfig } from '../src/types.js';
import { LineApiError } from '../src/types.js';

const BROADCAST_URL = 'https://api.line.me/v2/bot/message/broadcast';
const TOKEN = 'line-channel-access-token-SECRET-VALUE';

// ---------------------------------------------------------------------------
// テスト用の足回り
// ---------------------------------------------------------------------------

function runtimeConfig(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    gcpProjectId: null,
    firestoreDatabaseId: '(default)',
    storeKind: 'memory',
    anthropicModel: 'claude-opus-5',
    userAgent: 'SeidoWatchBot/1.0 (+mailto:ops@example.com)',
    hostDelayMs: 2000,
    hostConcurrency: 4,
    httpTimeoutMs: 20_000,
    maxNewItemsPerSource: 50,
    recheckPerSource: 5,
    maxContentChars: 6000,
    retentionDays: 90,
    slackWebhookUrl: null,
    dryRun: false,
    ...over,
  };
}

interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields: Record<string, unknown>;
}

function recordingLogger(records: LogRecord[]): Logger {
  const push =
    (level: LogRecord['level']) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      records.push({ level, msg, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return logger;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(responder: (attempt: number) => Response): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(responder(calls.length));
  };
  return { impl, calls };
}

function okResponse(requestId = 'req-0123456789'): Response {
  return new Response('{}', { status: 200, headers: { 'x-line-request-id': requestId } });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** テストで待機列を検証するための sleep スタブ。実時間は消費しない。 */
function stubSleep(): { fn: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    fn: (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

describe('broadcast: リクエストの形(詳細設計書 §9.2)', () => {
  it('正しい URL・メソッド・3 ヘッダ・ボディ形状で送る', async () => {
    const { impl, calls } = stubFetch(() => okResponse());
    const sleep = stubSleep();
    const client = createLineClient(runtimeConfig(), recordingLogger([]), {
      fetchImpl: impl,
      sleep: sleep.fn,
    });

    await client.broadcast(TOKEN, '本日の制度・法改正まとめ', 'retry-key-0001');

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(BROADCAST_URL);
    expect(call?.method).toBe('POST');

    // ヘッダは Authorization / X-Line-Retry-Key / Content-Type の 3 つだけ。
    expect(Object.keys(call?.headers ?? {}).sort()).toEqual([
      'authorization',
      'content-type',
      'x-line-retry-key',
    ]);
    expect(call?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers['x-line-retry-key']).toBe('retry-key-0001');
    expect(call?.headers['content-type']).toBe('application/json');

    expect(JSON.parse(call?.body ?? 'null')).toEqual({
      messages: [{ type: 'text', text: '本日の制度・法改正まとめ' }],
    });

    expect(sleep.waits).toEqual([]);
  });

  it('応答ヘッダ x-line-request-id を requestId に入れる', async () => {
    const { impl } = stubFetch(() => okResponse('req-abcdef123456'));
    const client = createLineClient(runtimeConfig(), recordingLogger([]), { fetchImpl: impl });

    const result = await client.broadcast(TOKEN, '本文', 'retry-key-0002');

    expect(result).toEqual({ requestId: 'req-abcdef123456', status: 200 });
  });

  it('x-line-request-id が無ければ requestId は null', async () => {
    const { impl } = stubFetch(() => new Response('{}', { status: 200 }));
    const client = createLineClient(runtimeConfig(), recordingLogger([]), { fetchImpl: impl });

    const result = await client.broadcast(TOKEN, '本文', 'retry-key-0003');

    expect(result).toEqual({ requestId: null, status: 200 });
  });
});

// ---------------------------------------------------------------------------
// リトライ(冪等性)
// ---------------------------------------------------------------------------

describe('broadcast: リトライと冪等性', () => {
  it('429 で再送し、同じ retryKey を使う', async () => {
    const { impl, calls } = stubFetch((attempt) =>
      attempt === 1 ? errorResponse(429, 'Too Many Requests') : okResponse('req-after-429'),
    );
    const sleep = stubSleep();
    const client = createLineClient(runtimeConfig(), recordingLogger([]), {
      fetchImpl: impl,
      sleep: sleep.fn,
    });

    const result = await client.broadcast(TOKEN, '本文', 'retry-key-429');

    expect(result.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.headers['x-line-retry-key'])).toEqual(['retry-key-429', 'retry-key-429']);
    expect(sleep.waits).toEqual([2000]);
  });

  it('503 で再送し、待機列は 2000 / 4000 / 8000 で最後の失敗を投げる', async () => {
    const { impl, calls } = stubFetch(() => errorResponse(503, 'Service Unavailable'));
    const sleep = stubSleep();
    const client = createLineClient(runtimeConfig(), recordingLogger([]), {
      fetchImpl: impl,
      sleep: sleep.fn,
    });

    const error: unknown = await client.broadcast(TOKEN, '本文', 'retry-key-503').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LineApiError);
    expect((error as LineApiError).status).toBe(503);

    // 初回 + 3 回の再送 = 4 回。
    expect(calls).toHaveLength(4);
    // 冪等性の要: 再送でも必ず同じ Retry-Key。
    expect(new Set(calls.map((c) => c.headers['x-line-retry-key']))).toEqual(new Set(['retry-key-503']));
    expect(sleep.waits).toEqual([2000, 4000, 8000]);
  });

  it('ネットワーク例外でも同じ retryKey で再送する', async () => {
    const calls: string[] = [];
    let attempt = 0;
    const impl: typeof fetch = (_input, init) => {
      attempt += 1;
      const headers = new Headers(init?.headers);
      calls.push(headers.get('x-line-retry-key') ?? '');
      if (attempt < 3) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve(okResponse('req-after-network'));
    };
    const sleep = stubSleep();
    const client = createLineClient(runtimeConfig(), recordingLogger([]), {
      fetchImpl: impl,
      sleep: sleep.fn,
    });

    const result = await client.broadcast(TOKEN, '本文', 'retry-key-net');

    expect(result.requestId).toBe('req-after-network');
    expect(calls).toEqual(['retry-key-net', 'retry-key-net', 'retry-key-net']);
    expect(sleep.waits).toEqual([2000, 4000]);
  });
});

// ---------------------------------------------------------------------------
// 恒久的な失敗とトークン秘匿
// ---------------------------------------------------------------------------

describe('broadcast: 4xx は即失敗(トークンを漏らさない)', () => {
  it('400 は再送せず LineApiError を投げる', async () => {
    const { impl, calls } = stubFetch(() => errorResponse(400, 'The request body has 1 error(s)'));
    const sleep = stubSleep();
    const client = createLineClient(runtimeConfig(), recordingLogger([]), {
      fetchImpl: impl,
      sleep: sleep.fn,
    });

    const error: unknown = await client.broadcast(TOKEN, '本文', 'retry-key-400').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LineApiError);
    expect((error as LineApiError).status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(sleep.waits).toEqual([]);
  });

  it('401 も再送しない', async () => {
    const { impl, calls } = stubFetch(() => errorResponse(401, 'Invalid access token'));
    const client = createLineClient(runtimeConfig(), recordingLogger([]), { fetchImpl: impl });

    await expect(client.broadcast(TOKEN, '本文', 'retry-key-401')).rejects.toBeInstanceOf(LineApiError);
    expect(calls).toHaveLength(1);
  });

  it('例外メッセージにもログにもトークンが含まれない', async () => {
    // LINE がエラー応答にトークンを含めて返してきた場合でも漏らさないこと。
    const { impl } = stubFetch(() => errorResponse(400, `Invalid access token: ${TOKEN}`));
    const records: LogRecord[] = [];
    const client = createLineClient(runtimeConfig(), recordingLogger(records), { fetchImpl: impl });

    const error: unknown = await client.broadcast(TOKEN, '本文', 'retry-key-leak').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LineApiError);
    expect((error as LineApiError).message).not.toContain(TOKEN);
    expect(JSON.stringify(records)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// ドライラン
// ---------------------------------------------------------------------------

describe('broadcast: dryRun', () => {
  it('fetch を一度も呼ばず requestId は dry-run', async () => {
    const { impl, calls } = stubFetch(() => {
      throw new Error('dryRun では fetch を呼んではいけません');
    });
    const records: LogRecord[] = [];
    const client = createLineClient(runtimeConfig({ dryRun: true }), recordingLogger(records), {
      fetchImpl: impl,
    });

    const result = await client.broadcast(TOKEN, 'ドライラン本文', 'retry-key-dry');

    expect(calls).toHaveLength(0);
    expect(result).toEqual({ requestId: 'dry-run', status: 200 });
    // 目視レビューのため本文はログに出す。トークンは出さない。
    expect(JSON.stringify(records)).toContain('ドライラン本文');
    expect(JSON.stringify(records)).not.toContain(TOKEN);
  });
});
