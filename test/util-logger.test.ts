/**
 * src/util/logger.ts の単体テスト。
 *
 * 最重要の観点は NFR-03「秘密情報をログに出さない」。
 * LINE チャネルアクセストークン・Anthropic API キー・Slack Webhook URL は
 * キー名でも値の形でも伏せられなければならない。
 * 併せて詳細設計書 §12 の「1 レコード = 1 行の JSON」も検証する。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, redact } from '../src/util/logger.js';

const REDACTED = '[REDACTED]';

type WriteFn = typeof process.stdout.write;

let stdoutLines: string[];
let stderrLines: string[];
let originalStdoutWrite: WriteFn;
let originalStderrWrite: WriteFn;
let originalLogLevel: string | undefined;

/** 書き込まれた生チャンクを行に割る。改行区切りが守られているかもここで見る。 */
function splitChunks(chunks: string[]): string[] {
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line !== '');
}

function parsedStdout(): Record<string, unknown>[] {
  return splitChunks(stdoutLines).map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  stdoutLines = [];
  stderrLines = [];
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    stdoutLines.push(String(chunk));
    return true;
  }) as WriteFn;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderrLines.push(String(chunk));
    return true;
  }) as WriteFn;
  // LOG_LEVEL は createLogger 時に読まれる。環境に左右されないよう固定する。
  originalLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
});

describe('redact', () => {
  it('キー名が token / apiKey / authorization / webhook / secret / password のものを伏せる', () => {
    const out = redact({
      token: 'abcdef',
      apiKey: 'sk-ant-xxxx',
      authorization: 'Basic dXNlcjpwYXNz',
      webhook: 'https://example.com/x',
      secret: 'projects/p/secrets/s/versions/latest',
      password: 'p@ssw0rd',
    });

    expect(out).toEqual({
      token: REDACTED,
      apiKey: REDACTED,
      authorization: REDACTED,
      webhook: REDACTED,
      secret: REDACTED,
      password: REDACTED,
    });
  });

  it('キー名の判定は大文字小文字を区別せず、部分一致でも伏せる', () => {
    const out = redact({
      ACCESS_TOKEN: 'x',
      lineTokenSecret: 'y',
      AuthorizationHeader: 'z',
      slackWebhookUrl: 'w',
      ANTHROPIC_API_KEY: 'k',
    });

    for (const value of Object.values(out)) {
      expect(value).toBe(REDACTED);
    }
  });

  it('秘密でないキーはそのまま残す', () => {
    expect(redact({ url: 'https://www.mhlw.go.jp/', status: 200, ok: true, region: null })).toEqual({
      url: 'https://www.mhlw.go.jp/',
      status: 200,
      ok: true,
      region: null,
    });
  });

  it('ネストしたオブジェクトの中でも伏せる', () => {
    const out = redact({
      request: {
        url: 'https://api.line.me/v2/bot/message/broadcast',
        headers: { 'content-type': 'application/json', authorization: 'Bearer LINE-TOKEN' },
      },
      channel: { id: 'welfare', lineTokenSecret: 'projects/p/secrets/line-token-welfare/versions/latest' },
    });

    const request = out['request'] as Record<string, unknown>;
    const headers = request['headers'] as Record<string, unknown>;
    expect(headers['authorization']).toBe(REDACTED);
    expect(headers['content-type']).toBe('application/json');
    expect(request['url']).toBe('https://api.line.me/v2/bot/message/broadcast');

    const channel = out['channel'] as Record<string, unknown>;
    expect(channel['lineTokenSecret']).toBe(REDACTED);
    expect(channel['id']).toBe('welfare');
  });

  it('配列の要素に含まれるネストしたオブジェクトでも伏せる', () => {
    const out = redact({
      channels: [
        { id: 'ai_reskill', token: 'AAAA' },
        { id: 'welfare', nested: { deep: { apiKey: 'BBBB' } } },
      ],
    });

    const channels = out['channels'] as Record<string, unknown>[];
    expect(channels[0]?.['token']).toBe(REDACTED);
    const nested = channels[1]?.['nested'] as Record<string, unknown>;
    const deep = nested['deep'] as Record<string, unknown>;
    expect(deep['apiKey']).toBe(REDACTED);
    expect(channels[1]?.['id']).toBe('welfare');
  });

  it("値が 'Bearer ' で始まる場合はキー名に関わらず伏せる", () => {
    const out = redact({ note: 'Bearer 0123456789abcdef', header: 'Bearer xxx' });
    expect(out['note']).toBe(REDACTED);
    expect(out['header']).toBe(REDACTED);
  });

  it('値が hooks.slack.com を含む URL の場合は伏せる', () => {
    const out = redact({
      notifyTarget: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
      message: '通知先は https://hooks.slack.com/services/T000/B000/XXXXXXXX です',
    });
    expect(out['notifyTarget']).toBe(REDACTED);
    expect(out['message']).toBe(REDACTED);
  });

  it('ネストした値の形(Bearer / Slack Webhook)でも伏せる', () => {
    const out = redact({
      outer: { inner: ['Bearer zzz', 'https://hooks.slack.com/services/A/B/C', '普通の値'] },
    });
    const outer = out['outer'] as Record<string, unknown>;
    expect(outer['inner']).toEqual([REDACTED, REDACTED, '普通の値']);
  });

  it('元のオブジェクトを書き換えない', () => {
    const fields = { token: 'secret-value', nested: { apiKey: 'k' } };
    redact(fields);
    expect(fields.token).toBe('secret-value');
    expect(fields.nested.apiKey).toBe('k');
  });
});

describe('createLogger', () => {
  it('出力は 1 行 1 JSON である', () => {
    const logger = createLogger();
    logger.info('1 件目', { a: 1 });
    logger.info('2 件目', { b: 2 });
    logger.debug('3 件目');

    // write のチャンクは必ず改行終端。
    for (const chunk of stdoutLines) {
      expect(chunk.endsWith('\n')).toBe(true);
    }

    const lines = splitChunks(stdoutLines);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      // 行の途中に改行が残っていないこと。
      expect(line.includes('\n')).toBe(false);
    }
  });

  it('レコードに ts / level / msg とフィールドが入る', () => {
    const logger = createLogger();
    logger.info('HTTP 応答', { url: 'https://www.mhlw.go.jp/', status: 200 });

    const [record] = parsedStdout();
    expect(record).toBeDefined();
    expect(record?.['level']).toBe('info');
    expect(record?.['msg']).toBe('HTTP 応答');
    expect(record?.['url']).toBe('https://www.mhlw.go.jp/');
    expect(record?.['status']).toBe(200);
    expect(typeof record?.['ts']).toBe('string');
    expect(new Date(String(record?.['ts'])).toISOString()).toBe(record?.['ts']);
  });

  it('error は stderr、それ以外は stdout に出す', () => {
    const logger = createLogger();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(splitChunks(stdoutLines)).toHaveLength(3);
    expect(splitChunks(stderrLines)).toHaveLength(1);
    const errRecord = JSON.parse(splitChunks(stderrLines)[0] ?? '{}') as Record<string, unknown>;
    expect(errRecord['level']).toBe('error');
  });

  it('秘密情報はログ出力でも伏せられる(ネストを含む)', () => {
    const logger = createLogger();
    logger.info('LINE 配信', {
      channelId: 'welfare',
      auth: { authorization: 'Bearer REAL-LINE-TOKEN' },
      slackWebhookUrl: 'https://hooks.slack.com/services/T/B/X',
      raw: 'Bearer REAL-LINE-TOKEN',
    });

    const line = splitChunks(stdoutLines)[0] ?? '';
    expect(line).not.toContain('REAL-LINE-TOKEN');
    expect(line).not.toContain('hooks.slack.com');

    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record['channelId']).toBe('welfare');
    expect((record['auth'] as Record<string, unknown>)['authorization']).toBe(REDACTED);
    expect(record['slackWebhookUrl']).toBe(REDACTED);
    expect(record['raw']).toBe(REDACTED);
  });

  it('base に渡したフィールドが全レコードに付く', () => {
    const logger = createLogger({ job: 'collect', runId: 'run-1' });
    logger.info('開始');
    logger.warn('警告');

    for (const record of parsedStdout()) {
      expect(record['job']).toBe('collect');
      expect(record['runId']).toBe('run-1');
    }
  });

  it('child() が親のフィールドを引き継ぎ、自分のフィールドを足す', () => {
    const parent = createLogger({ job: 'collect', runId: 'run-1' });
    const child = parent.child({ sourceId: 'mhlw_news_rss' });
    child.info('ソース巡回');

    const [record] = parsedStdout();
    expect(record?.['job']).toBe('collect');
    expect(record?.['runId']).toBe('run-1');
    expect(record?.['sourceId']).toBe('mhlw_news_rss');
  });

  it('child() は同名フィールドを上書きし、親には影響しない', () => {
    const parent = createLogger({ job: 'collect', stage: 'parent' });
    const child = parent.child({ stage: 'child' });

    child.info('子');
    parent.info('親');

    const records = parsedStdout();
    expect(records[0]?.['stage']).toBe('child');
    expect(records[1]?.['stage']).toBe('parent');
  });

  it('child() の孫でも秘密情報は伏せられる', () => {
    const grandchild = createLogger({ job: 'deliver' }).child({ channelId: 'welfare' }).child({
      token: 'REAL-TOKEN',
    });
    grandchild.info('孫');

    const line = splitChunks(stdoutLines)[0] ?? '';
    expect(line).not.toContain('REAL-TOKEN');
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record['token']).toBe(REDACTED);
    expect(record['channelId']).toBe('welfare');
    expect(record['job']).toBe('deliver');
  });

  it('呼び出しごとのフィールドが base を一時的に上書きする', () => {
    const logger = createLogger({ job: 'collect' });
    logger.info('上書き', { job: 'summarize' });
    logger.info('既定');

    const records = parsedStdout();
    expect(records[0]?.['job']).toBe('summarize');
    expect(records[1]?.['job']).toBe('collect');
  });
});
