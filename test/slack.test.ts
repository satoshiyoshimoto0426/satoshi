/**
 * Slack 通知(詳細設計書 §12 / 要件定義書 FR-13 / NFR-03)のテスト。
 *
 * 通知は運用者への連絡手段であって業務処理ではない。Slack が落ちていても配信ジョブを
 * 道連れにしてはいけないので「例外が外に出ないこと」を最優先で検証する。
 * Webhook URL は資格情報そのものなので、ログに出ないことも必ず見る。
 *
 * fetch は必ずスタブを注入する。実ネットワークには一切出ない。
 */

import { describe, expect, it, vi } from 'vitest';
import { createNoopNotifier, createSlackNotifier } from '../src/notify/slack.js';
import { createLogger } from '../src/util/logger.js';
import type { Logger, NotifyLevel, RuntimeConfig } from '../src/types.js';

const WEBHOOK = 'https://hooks.slack.com/services/T00000000/B00000000/ZZZZsecretZZZZ';

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
  body: string;
}

function stubFetch(responder: (attempt: number) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(responder(calls.length));
  };
  return { impl, calls };
}

/** 送信された Slack 本文(payload の text)を取り出す。 */
function sentText(call: FetchCall | undefined): string {
  const parsed: unknown = JSON.parse(call?.body ?? 'null');
  if (parsed === null || typeof parsed !== 'object') return '';
  const text = (parsed as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

// ---------------------------------------------------------------------------
// 送信しない条件
// ---------------------------------------------------------------------------

describe('送信しない条件', () => {
  it('Webhook 未設定(null)なら fetch を呼ばない', async () => {
    const { impl, calls } = stubFetch(() => new Response('ok', { status: 200 }));
    const records: LogRecord[] = [];
    const notifier = createSlackNotifier(runtimeConfig({ slackWebhookUrl: null }), recordingLogger(records), {
      fetchImpl: impl,
    });

    await notifier.notify('error', '配信に失敗しました', ['welfare: LINE API 503']);

    expect(calls).toHaveLength(0);
    // 送らなくても内容はログに残す(運用者が気づけるように)。
    expect(records.length).toBeGreaterThan(0);
  });

  it('Webhook が空文字でも fetch を呼ばない', async () => {
    const { impl, calls } = stubFetch(() => new Response('ok', { status: 200 }));
    const notifier = createSlackNotifier(runtimeConfig({ slackWebhookUrl: '' }), recordingLogger([]), {
      fetchImpl: impl,
    });

    await notifier.notify('warn', '警告', ['a']);

    expect(calls).toHaveLength(0);
  });

  it('dryRun なら Webhook が設定されていても fetch を呼ばない', async () => {
    const { impl, calls } = stubFetch(() => new Response('ok', { status: 200 }));
    const notifier = createSlackNotifier(
      runtimeConfig({ slackWebhookUrl: WEBHOOK, dryRun: true }),
      recordingLogger([]),
      { fetchImpl: impl },
    );

    await notifier.notify('info', '実行しました', ['collect: 新着 3 件']);

    expect(calls).toHaveLength(0);
  });

  it('createNoopNotifier は何も送らず解決する', async () => {
    const records: LogRecord[] = [];
    const notifier = createNoopNotifier(recordingLogger(records));

    await expect(notifier.notify('error', 'タイトル', ['行'])).resolves.toBeUndefined();
    expect(records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 本文の組み立て
// ---------------------------------------------------------------------------

describe('本文の組み立て', () => {
  it('Webhook 宛に JSON の text を POST する', async () => {
    const { impl, calls } = stubFetch(() => new Response('ok', { status: 200 }));
    const notifier = createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), recordingLogger([]), {
      fetchImpl: impl,
    });

    await notifier.notify('info', '収集が完了しました', ['mhlw: 3 件', 'cas: 1 件']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK);
    expect(calls[0]?.method).toBe('POST');
    expect(sentText(calls[0])).toBe('🟢 *収集が完了しました*\n• mhlw: 3 件\n• cas: 1 件');
  });

  const emojis: Array<{ level: NotifyLevel; emoji: string }> = [
    { level: 'info', emoji: '🟢' },
    { level: 'warn', emoji: '🟡' },
    { level: 'error', emoji: '🔴' },
  ];

  for (const { level, emoji } of emojis) {
    it(`level=${level} には ${emoji} が付く`, async () => {
      const { impl, calls } = stubFetch(() => new Response('ok', { status: 200 }));
      const notifier = createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), recordingLogger([]), {
        fetchImpl: impl,
      });

      await notifier.notify(level, 'タイトル', ['明細']);

      expect(sentText(calls[0]).startsWith(`${emoji} *タイトル*`)).toBe(true);
    });
  }

  it('lines が 20 件を超えると先頭 20 件 + 「ほか N 件」になる', async () => {
    const { impl, calls } = stubFetch(() => new Response('ok', { status: 200 }));
    const notifier = createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), recordingLogger([]), {
      fetchImpl: impl,
    });

    const lines = Array.from({ length: 25 }, (_, i) => `除外 ${i + 1}`);
    await notifier.notify('warn', '品質ゲートで除外しました', lines);

    const body = sentText(calls[0]).split('\n');
    expect(body[0]).toBe('🟡 *品質ゲートで除外しました*');
    expect(body).toHaveLength(1 + 20 + 1);
    expect(body[1]).toBe('• 除外 1');
    expect(body[20]).toBe('• 除外 20');
    expect(body[21]).toBe('ほか 5 件');
    expect(sentText(calls[0])).not.toContain('除外 21');
  });

  it('lines がちょうど 20 件なら「ほか」は付かない', async () => {
    const { impl, calls } = stubFetch(() => new Response('ok', { status: 200 }));
    const notifier = createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), recordingLogger([]), {
      fetchImpl: impl,
    });

    await notifier.notify(
      'warn',
      'タイトル',
      Array.from({ length: 20 }, (_, i) => `行 ${i + 1}`),
    );

    const body = sentText(calls[0]).split('\n');
    expect(body).toHaveLength(21);
    expect(sentText(calls[0])).not.toContain('ほか');
  });
});

// ---------------------------------------------------------------------------
// 失敗してもジョブを落とさない
// ---------------------------------------------------------------------------

describe('送信失敗の扱い(通知失敗でジョブを落とさない)', () => {
  it('fetch が例外を投げても外に出さない', async () => {
    const impl: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const records: LogRecord[] = [];
    const notifier = createSlackNotifier(
      runtimeConfig({ slackWebhookUrl: WEBHOOK }),
      recordingLogger(records),
      { fetchImpl: impl },
    );

    await expect(notifier.notify('error', '配信に失敗しました', ['welfare'])).resolves.toBeUndefined();
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('fetch が同期的に投げても外に出さない', async () => {
    const impl: typeof fetch = () => {
      throw new Error('同期例外');
    };
    const notifier = createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), recordingLogger([]), {
      fetchImpl: impl,
    });

    await expect(notifier.notify('error', 'タイトル', ['行'])).resolves.toBeUndefined();
  });

  it('非 2xx 応答でも例外にせず warn に留める', async () => {
    const { impl, calls } = stubFetch(() => new Response('invalid_payload', { status: 400 }));
    const records: LogRecord[] = [];
    const notifier = createSlackNotifier(
      runtimeConfig({ slackWebhookUrl: WEBHOOK }),
      recordingLogger(records),
      { fetchImpl: impl },
    );

    await expect(notifier.notify('warn', 'タイトル', ['行'])).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('500 応答でも例外にしない', async () => {
    const { impl } = stubFetch(() => new Response('server error', { status: 500 }));
    const notifier = createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), recordingLogger([]), {
      fetchImpl: impl,
    });

    await expect(notifier.notify('error', 'タイトル', ['行'])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 秘密情報
// ---------------------------------------------------------------------------

describe('Webhook URL を漏らさない(NFR-03)', () => {
  it('成功・非 2xx・未設定のいずれの経路でも Notifier が URL をログに渡さない', async () => {
    const records: LogRecord[] = [];
    const logger = recordingLogger(records);

    const success = stubFetch(() => new Response('ok', { status: 200 }));
    await createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), logger, {
      fetchImpl: success.impl,
    }).notify('info', '成功', ['行']);

    const failed = stubFetch(() => new Response('invalid_token', { status: 403 }));
    await createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), logger, {
      fetchImpl: failed.impl,
    }).notify('warn', '非 2xx', ['行']);

    await createSlackNotifier(runtimeConfig({ slackWebhookUrl: null }), logger, {
      fetchImpl: success.impl,
    }).notify('error', '未設定', ['行']);

    expect(records.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(records);
    expect(dumped).not.toContain(WEBHOOK);
    expect(dumped).not.toContain('ZZZZsecretZZZZ');
    expect(dumped).not.toContain('hooks.slack.com');
  });

  it('本番ロガー経由の実出力にも URL が出ない(例外メッセージに URL が混ざった場合も含む)', async () => {
    const chunks: string[] = [];
    const capture = (chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    };
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(capture as unknown as typeof process.stdout.write);
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(capture as unknown as typeof process.stderr.write);

    try {
      const logger = createLogger({ job: 'deliver' });

      const success = stubFetch(() => new Response('ok', { status: 200 }));
      await createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), logger, {
        fetchImpl: success.impl,
      }).notify('info', '成功', ['行']);

      // 外部由来のエラーメッセージに URL が混ざるケース。
      const thrown: typeof fetch = () => Promise.reject(new Error(`connect ECONNREFUSED ${WEBHOOK}`));
      await createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), logger, {
        fetchImpl: thrown,
      }).notify('error', '例外', ['行']);

      // 応答本文に URL が混ざるケース。
      const echoed = stubFetch(() => new Response(`bad webhook: ${WEBHOOK}`, { status: 404 }));
      await createSlackNotifier(runtimeConfig({ slackWebhookUrl: WEBHOOK }), logger, {
        fetchImpl: echoed.impl,
      }).notify('warn', '非 2xx', ['行']);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }

    const dumped = chunks.join('');
    expect(dumped.length).toBeGreaterThan(0);
    expect(dumped).not.toContain(WEBHOOK);
    expect(dumped).not.toContain('ZZZZsecretZZZZ');
    expect(dumped).not.toContain('hooks.slack.com');
  });
});
