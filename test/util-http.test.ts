/**
 * src/util/http.ts の単体テスト。
 *
 * 本モジュールは唯一「外へ出る」経路なので、テストは必ず fetchImpl と sleep を
 * 注入して行う(実ネットワークには絶対に出さない)。
 *
 * 検証する契約:
 *  - NFR-07: 同一ホストへの最小アクセス間隔(runtime.hostDelayMs、既定 2000ms)と robots.txt 尊重。
 *  - 詳細設計書 §6.1: 条件付き GET(304)、リトライ(429 / 5xx)と即時失敗(4xx)。
 *  - 日本の官公庁サイト対策: Shift_JIS の UTF-8 変換。
 *  - 品質ゲート Q2: checkReachable の HEAD → GET フォールバック。
 */
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';

import type { Logger, RuntimeConfig } from '../src/types.js';
import { HttpError, RobotsDisallowedError } from '../src/types.js';
import { createHttpClient } from '../src/util/http.js';

const USER_AGENT = 'SeidoWatchBot/1.0 (+mailto:ops@example.com)';

/** 既定は hostDelayMs=0。間隔そのものを見るテストだけ 2000 に上げる。 */
function makeRuntime(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    gcpProjectId: null,
    firestoreDatabaseId: '(default)',
    storeKind: 'memory',
    anthropicModel: 'claude-opus-5',
    userAgent: USER_AGENT,
    hostDelayMs: 0,
    hostConcurrency: 4,
    httpTimeoutMs: 5000,
    maxNewItemsPerSource: 50,
    maxContentChars: 6000,
    retentionDays: 90,
    slackWebhookUrl: null,
    dryRun: false,
    ...over,
  };
}

/** ログは検証対象ではないので捨てる(テスト出力を汚さない)。 */
function silentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger(),
  };
}

interface StubCall {
  url: string;
  method: string;
  headers: Headers;
  /** タイムアウト検証用。createHttpClient が渡す AbortSignal。 */
  signal: AbortSignal | null;
}

type Route = (call: StubCall) => Response | Promise<Response>;

function createFetchStub(route: Route): { fetchImpl: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: StubCall = {
      url: String(input),
      method: String(init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return route(call);
  };
  return { fetchImpl, calls };
}

/** 要求された待機 ms を記録するだけの sleep。実時間は消費しない。 */
function recordingSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    fn: async (ms: number): Promise<void> => {
      calls.push(ms);
    },
  };
}

function isRobotsRequest(call: StubCall): boolean {
  return new URL(call.url).pathname === '/robots.txt';
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function robotsTxt(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

/** robots.txt は 404(= 全面許可)、それ以外は単純な HTML を返す既定ルート。 */
const defaultRoute: Route = (call) =>
  isRobotsRequest(call) ? new Response('', { status: 404 }) : html('<html><body>ok</body></html>');

describe('同一ホストへの最小アクセス間隔(NFR-07)', () => {
  it('同一ホストへの連続アクセスの間に hostDelayMs の待機が挿入される', async () => {
    const sleeper = recordingSleep();
    const { fetchImpl, calls } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime({ hostDelayMs: 2000 }), silentLogger(), {
      fetchImpl,
      sleep: sleeper.fn,
    });

    await http.get('https://example.jp/a', { skipRobots: true });
    await http.get('https://example.jp/b', { skipRobots: true });
    await http.get('https://example.jp/c', { skipRobots: true });

    expect(calls).toHaveLength(3);
    // 1 回目は待たない。2・3 回目の直前にそれぞれ約 2000ms の待機が要求される。
    expect(sleeper.calls).toHaveLength(2);
    for (const ms of sleeper.calls) {
      expect(ms).toBeGreaterThan(1900);
      expect(ms).toBeLessThanOrEqual(2000);
    }
    const total = sleeper.calls.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(3800);
    expect(total).toBeLessThanOrEqual(4000);
  });

  it('同時に投げても同一ホストは直列化され、待機の合計は変わらない', async () => {
    const sleeper = recordingSleep();
    const { fetchImpl, calls } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime({ hostDelayMs: 2000 }), silentLogger(), {
      fetchImpl,
      sleep: sleeper.fn,
    });

    await Promise.all([
      http.get('https://example.jp/a', { skipRobots: true }),
      http.get('https://example.jp/b', { skipRobots: true }),
      http.get('https://example.jp/c', { skipRobots: true }),
    ]);

    expect(calls).toHaveLength(3);
    expect(sleeper.calls).toHaveLength(2);
    const total = sleeper.calls.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(3800);
  });

  it('異なるホスト同士では待機が挿入されない', async () => {
    const sleeper = recordingSleep();
    const { fetchImpl, calls } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime({ hostDelayMs: 2000 }), silentLogger(), {
      fetchImpl,
      sleep: sleeper.fn,
    });

    await http.get('https://a.example.jp/x', { skipRobots: true });
    await http.get('https://b.example.jp/x', { skipRobots: true });
    await http.get('https://c.example.jp/x', { skipRobots: true });

    expect(calls).toHaveLength(3);
    expect(sleeper.calls).toEqual([]);
  });

  it('待機時間は runtime.hostDelayMs に従う', async () => {
    const sleeper = recordingSleep();
    const { fetchImpl } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime({ hostDelayMs: 5000 }), silentLogger(), {
      fetchImpl,
      sleep: sleeper.fn,
    });

    await http.get('https://example.jp/a', { skipRobots: true });
    await http.get('https://example.jp/b', { skipRobots: true });

    expect(sleeper.calls).toHaveLength(1);
    expect(sleeper.calls[0]).toBeGreaterThan(4900);
    expect(sleeper.calls[0]).toBeLessThanOrEqual(5000);
  });
});

describe('robots.txt の尊重', () => {
  it('Disallow されている URL は RobotsDisallowedError を投げる', async () => {
    const { fetchImpl } = createFetchStub((call) =>
      isRobotsRequest(call)
        ? robotsTxt('User-agent: *\nDisallow: /private\n')
        : html('<html><body>取得できてはいけない</body></html>'),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.get('https://example.jp/private/secret.html')).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
  });

  it('Disallow されていない URL は取得できる', async () => {
    const { fetchImpl } = createFetchStub((call) =>
      isRobotsRequest(call)
        ? robotsTxt('User-agent: *\nDisallow: /private\n')
        : html('<html><body>公開ページ</body></html>'),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/public/news.html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('公開ページ');
  });

  it('判定には runtime.userAgent が使われる', async () => {
    const rules = 'User-agent: SeidoWatchBot\nDisallow: /no-bot\n\nUser-agent: *\nAllow: /\n';
    const route: Route = (call) =>
      isRobotsRequest(call) ? robotsTxt(rules) : html('<html><body>ok</body></html>');

    const ours = createHttpClient(makeRuntime(), silentLogger(), {
      fetchImpl: createFetchStub(route).fetchImpl,
    });
    await expect(ours.get('https://example.jp/no-bot/a.html')).rejects.toBeInstanceOf(RobotsDisallowedError);

    // UA が違えば同じ robots.txt でも許可される(= UA を見ている証拠)。
    const other = createHttpClient(makeRuntime({ userAgent: 'OtherBot/1.0' }), silentLogger(), {
      fetchImpl: createFetchStub(route).fetchImpl,
    });
    await expect(other.get('https://example.jp/no-bot/a.html')).resolves.toMatchObject({ status: 200 });
  });

  it('robots.txt が 404 なら「許可」として扱う', async () => {
    const { fetchImpl } = createFetchStub((call) =>
      isRobotsRequest(call) ? new Response('', { status: 404 }) : html('<html><body>ok</body></html>'),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.get('https://example.jp/a.html')).resolves.toMatchObject({ status: 200 });
  });

  it('robots.txt が 5xx でも「許可」として扱う', async () => {
    const { fetchImpl } = createFetchStub((call) =>
      isRobotsRequest(call) ? new Response('', { status: 503 }) : html('<html><body>ok</body></html>'),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.get('https://example.jp/a.html')).resolves.toMatchObject({ status: 200 });
  });

  it('robots.txt の取得自体がネットワークエラーでも「許可」として扱う', async () => {
    const { fetchImpl } = createFetchStub((call) => {
      if (isRobotsRequest(call)) throw new TypeError('fetch failed');
      return html('<html><body>ok</body></html>');
    });
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.get('https://example.jp/a.html')).resolves.toMatchObject({ status: 200 });
  });

  it('robots.txt の取得で無限再帰しない(robots.txt 自身は robots チェックをしない)', async () => {
    const { fetchImpl, calls } = createFetchStub((call) =>
      isRobotsRequest(call)
        ? robotsTxt('User-agent: *\nDisallow: /robots.txt\nAllow: /\n')
        : html('<html><body>ok</body></html>'),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    // robots.txt 自身を Disallow している意地悪な robots.txt でも取得は完了する。
    await expect(http.get('https://example.jp/a.html')).resolves.toMatchObject({ status: 200 });

    const robotsCalls = calls.filter(isRobotsRequest);
    expect(robotsCalls).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('robots.txt はホスト単位でキャッシュされ、2 回目以降は取得しない', async () => {
    const { fetchImpl, calls } = createFetchStub((call) =>
      isRobotsRequest(call) ? robotsTxt('User-agent: *\nAllow: /\n') : html('<html><body>ok</body></html>'),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await http.get('https://example.jp/a.html');
    await http.get('https://example.jp/b.html');
    await http.get('https://other.jp/c.html');

    expect(calls.filter(isRobotsRequest).map((call) => call.url)).toEqual([
      'https://example.jp/robots.txt',
      'https://other.jp/robots.txt',
    ]);
  });
});

describe('リクエストヘッダ', () => {
  it('User-Agent に runtime.userAgent が入り、Accept-Language が付く', async () => {
    const { fetchImpl, calls } = createFetchStub(defaultRoute);
    const http = createHttpClient(
      makeRuntime({ userAgent: 'TestBot/9.9 (+mailto:t@example.com)' }),
      silentLogger(),
      {
        fetchImpl,
      },
    );

    await http.get('https://example.jp/a.html', { skipRobots: true });

    expect(calls[0]?.headers.get('user-agent')).toBe('TestBot/9.9 (+mailto:t@example.com)');
    expect(calls[0]?.headers.get('accept-language')).toBe('ja,en;q=0.8');
  });

  it('robots.txt の取得にも User-Agent が付く', async () => {
    const { fetchImpl, calls } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await http.get('https://example.jp/a.html');

    const robotsCall = calls.find(isRobotsRequest);
    expect(robotsCall?.headers.get('user-agent')).toBe(USER_AGENT);
  });

  it('etag / lastModified が If-None-Match / If-Modified-Since として送られる', async () => {
    const { fetchImpl, calls } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await http.get('https://example.jp/a.html', {
      skipRobots: true,
      etag: 'W/"abc123"',
      lastModified: 'Wed, 09 Sep 2026 12:00:00 GMT',
    });

    expect(calls[0]?.headers.get('if-none-match')).toBe('W/"abc123"');
    expect(calls[0]?.headers.get('if-modified-since')).toBe('Wed, 09 Sep 2026 12:00:00 GMT');
  });

  it('etag / lastModified が無ければ条件付きヘッダを送らない', async () => {
    const { fetchImpl, calls } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await http.get('https://example.jp/a.html', { skipRobots: true, etag: null, lastModified: null });

    expect(calls[0]?.headers.has('if-none-match')).toBe(false);
    expect(calls[0]?.headers.has('if-modified-since')).toBe(false);
  });

  it('accept オプションが Accept ヘッダになる', async () => {
    const { fetchImpl, calls } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await http.get('https://example.jp/feed.rdf', { skipRobots: true, accept: 'application/rss+xml' });

    expect(calls[0]?.headers.get('accept')).toBe('application/rss+xml');
  });
});

describe('条件付き GET の 304', () => {
  it('304 は例外にならず status 304 で返る', async () => {
    const { fetchImpl } = createFetchStub((call) =>
      isRobotsRequest(call) ? new Response('', { status: 404 }) : new Response(null, { status: 304 }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/a.html', { skipRobots: true, etag: '"v1"' });

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
    expect(res.body.byteLength).toBe(0);
    expect(res.finalUrl).toBe('https://example.jp/a.html');
  });

  it('304 は再試行されない', async () => {
    const { fetchImpl, calls } = createFetchStub(() => new Response(null, { status: 304 }));
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await http.get('https://example.jp/a.html', { skipRobots: true, etag: '"v1"' });

    expect(calls).toHaveLength(1);
  });

  it('応答ヘッダ(etag / last-modified)を小文字キーで返す', async () => {
    const { fetchImpl } = createFetchStub(
      () =>
        new Response('<html></html>', {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            ETag: 'W/"v2"',
            'Last-Modified': 'Thu, 10 Sep 2026 00:00:00 GMT',
          },
        }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/a.html', { skipRobots: true });

    expect(res.headers['etag']).toBe('W/"v2"');
    expect(res.headers['last-modified']).toBe('Thu, 10 Sep 2026 00:00:00 GMT');
  });
});

describe('文字コード変換(日本の官公庁サイト対策)', () => {
  const JAPANESE = '障害福祉サービス等報酬改定について(令和8年度)';

  it('Content-Type の charset で Shift_JIS を UTF-8 に変換する', async () => {
    const source = `<html><body><h1>${JAPANESE}</h1></body></html>`;
    const bytes = new Uint8Array(iconv.encode(source, 'Shift_JIS'));
    const { fetchImpl } = createFetchStub(
      () => new Response(bytes, { status: 200, headers: { 'content-type': 'text/html; charset=Shift_JIS' } }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/sjis.html', { skipRobots: true });

    expect(res.text).toContain(JAPANESE);
    // 変換せず UTF-8 として読むと文字化けする = 実際に変換が働いている証拠。
    expect(Buffer.from(res.body).toString('utf8')).not.toContain(JAPANESE);
  });

  it('HTML の <meta charset> 指定で Shift_JIS を UTF-8 に変換する', async () => {
    const source = `<html><head><meta charset="Shift_JIS"></head><body><h1>${JAPANESE}</h1></body></html>`;
    const bytes = new Uint8Array(iconv.encode(source, 'Shift_JIS'));
    // Content-Type には charset を書かない(自治体サイトでよくある形)。
    const { fetchImpl } = createFetchStub(
      () => new Response(bytes, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/meta-sjis.html', { skipRobots: true });

    expect(res.text).toContain(JAPANESE);
    expect(Buffer.from(res.body).toString('utf8')).not.toContain(JAPANESE);
  });

  it('<meta http-equiv="Content-Type"> 指定でも Shift_JIS を変換する', async () => {
    const source =
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">` +
      `</head><body><h1>${JAPANESE}</h1></body></html>`;
    const bytes = new Uint8Array(iconv.encode(source, 'Shift_JIS'));
    const { fetchImpl } = createFetchStub(
      () => new Response(bytes, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/httpequiv-sjis.html', { skipRobots: true });

    expect(res.text).toContain(JAPANESE);
  });

  it('XML 宣言の encoding 指定(Shift_JIS の RSS)も変換する', async () => {
    const source = `<?xml version="1.0" encoding="Shift_JIS"?><rss><channel><title>${JAPANESE}</title></channel></rss>`;
    const bytes = new Uint8Array(iconv.encode(source, 'Shift_JIS'));
    const { fetchImpl } = createFetchStub(
      () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/xml' } }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/feed.xml', { skipRobots: true });

    expect(res.text).toContain(JAPANESE);
  });

  it('EUC-JP も UTF-8 に変換する', async () => {
    const source = `<html><body>${JAPANESE}</body></html>`;
    const bytes = new Uint8Array(iconv.encode(source, 'EUC-JP'));
    const { fetchImpl } = createFetchStub(
      () => new Response(bytes, { status: 200, headers: { 'content-type': 'text/html; charset=EUC-JP' } }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/eucjp.html', { skipRobots: true });

    expect(res.text).toContain(JAPANESE);
  });

  it('charset 指定が無ければ UTF-8 として読む', async () => {
    const source = `<html><body>${JAPANESE}</body></html>`;
    const { fetchImpl } = createFetchStub(
      () =>
        new Response(new Uint8Array(Buffer.from(source, 'utf8')), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/utf8.html', { skipRobots: true });

    expect(res.text).toContain(JAPANESE);
  });

  it('バイナリ(PDF)は text を空にして body だけ埋める', async () => {
    const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'binary'));
    const { fetchImpl } = createFetchStub(
      () => new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const res = await http.get('https://example.jp/notice.pdf', { skipRobots: true });

    expect(res.text).toBe('');
    expect(res.body.byteLength).toBe(pdfBytes.byteLength);
  });
});

describe('リトライとエラー', () => {
  it('429 は再試行される(既定 2 回 = 計 3 回)', async () => {
    const { fetchImpl, calls } = createFetchStub(() => new Response('', { status: 429 }));
    const sleeper = recordingSleep();
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl, sleep: sleeper.fn });

    await expect(http.get('https://example.jp/a.html', { skipRobots: true })).rejects.toMatchObject({
      name: 'HttpError',
      status: 429,
    });
    expect(calls).toHaveLength(3);
  });

  it('500 は再試行される', async () => {
    const { fetchImpl, calls } = createFetchStub(() => new Response('', { status: 500 }));
    const sleeper = recordingSleep();
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl, sleep: sleeper.fn });

    await expect(http.get('https://example.jp/a.html', { skipRobots: true })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(calls).toHaveLength(3);
  });

  it('再試行の途中で成功したらその結果を返す', async () => {
    let n = 0;
    const { fetchImpl, calls } = createFetchStub(() => {
      n += 1;
      return n < 3 ? new Response('', { status: 503 }) : html('<html><body>復旧</body></html>');
    });
    const sleeper = recordingSleep();
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl, sleep: sleeper.fn });

    const res = await http.get('https://example.jp/a.html', { skipRobots: true });

    expect(res.status).toBe(200);
    expect(res.text).toContain('復旧');
    expect(calls).toHaveLength(3);
  });

  it('ネットワークエラーは再試行される', async () => {
    const { fetchImpl, calls } = createFetchStub(() => {
      throw new TypeError('fetch failed');
    });
    const sleeper = recordingSleep();
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl, sleep: sleeper.fn });

    await expect(http.get('https://example.jp/a.html', { skipRobots: true })).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(3);
  });

  it('404 は再試行されず HttpError になる', async () => {
    const { fetchImpl, calls } = createFetchStub(() => new Response('', { status: 404 }));
    const sleeper = recordingSleep();
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl, sleep: sleeper.fn });

    const error = await http
      .get('https://example.jp/missing.html', { skipRobots: true })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).url).toBe('https://example.jp/missing.html');
    expect(calls).toHaveLength(1);
    expect(sleeper.calls).toEqual([]);
  });

  it('403 も再試行されない', async () => {
    const { fetchImpl, calls } = createFetchStub(() => new Response('', { status: 403 }));
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.get('https://example.jp/a.html', { skipRobots: true })).rejects.toMatchObject({
      status: 403,
    });
    expect(calls).toHaveLength(1);
  });

  it('retries オプションで再試行回数を変えられる', async () => {
    const { fetchImpl, calls } = createFetchStub(() => new Response('', { status: 500 }));
    const sleeper = recordingSleep();
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl, sleep: sleeper.fn });

    await expect(
      http.get('https://example.jp/a.html', { skipRobots: true, retries: 0 }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it('robots 不許可は再試行されない', async () => {
    const { fetchImpl, calls } = createFetchStub((call) =>
      isRobotsRequest(call) ? robotsTxt('User-agent: *\nDisallow: /\n') : html('ダメ'),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.get('https://example.jp/a.html')).rejects.toBeInstanceOf(RobotsDisallowedError);
    // robots.txt の 1 回だけ。本体 URL へは一度も出ない。
    expect(calls.filter((call) => !isRobotsRequest(call))).toHaveLength(0);
  });

  it('タイムアウト用の AbortSignal が渡り、時間切れで中断される', async () => {
    const { fetchImpl, calls } = createFetchStub(async (call) => {
      if (isRobotsRequest(call)) return new Response('', { status: 404 });
      // 応答を返さないサーバ。AbortSignal が発火しなければ永久に終わらない。
      return new Promise<Response>((_resolve, reject) => {
        call.signal?.addEventListener('abort', () => reject(new Error('タイムアウトで中断')));
      });
    });
    const http = createHttpClient(makeRuntime({ httpTimeoutMs: 20 }), silentLogger(), { fetchImpl });

    await expect(http.get('https://example.jp/slow.html', { skipRobots: true, retries: 0 })).rejects.toThrow(
      'タイムアウトで中断',
    );

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('URL として解釈できない入力は TypeError', async () => {
    const { fetchImpl } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.get('これは URL ではありません')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('checkReachable(品質ゲート Q2 / verify-sources)', () => {
  it('200 なら ok:true', async () => {
    const { fetchImpl, calls } = createFetchStub((call) =>
      isRobotsRequest(call) ? new Response('', { status: 404 }) : new Response('', { status: 200 }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.checkReachable('https://example.jp/a.html')).resolves.toEqual({
      ok: true,
      status: 200,
      error: null,
    });
    // まず HEAD で確認する(本文を無駄にダウンロードしない)。
    expect(calls.filter((call) => !isRobotsRequest(call)).map((call) => call.method)).toEqual(['HEAD']);
  });

  it('リダイレクト(3xx)も ok:true', async () => {
    const { fetchImpl } = createFetchStub((call) =>
      isRobotsRequest(call) ? new Response('', { status: 404 }) : new Response('', { status: 301 }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.checkReachable('https://example.jp/a.html')).resolves.toMatchObject({
      ok: true,
      status: 301,
    });
  });

  it('HEAD が 405 を返したら GET にフォールバックする', async () => {
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (isRobotsRequest(call)) return new Response('', { status: 404 });
      return call.method === 'HEAD' ? new Response('', { status: 405 }) : new Response('', { status: 200 });
    });
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.checkReachable('https://example.jp/a.html')).resolves.toEqual({
      ok: true,
      status: 200,
      error: null,
    });
    expect(calls.filter((call) => !isRobotsRequest(call)).map((call) => call.method)).toEqual([
      'HEAD',
      'GET',
    ]);
  });

  it('HEAD が 501 / 403 でも GET にフォールバックする', async () => {
    for (const headStatus of [501, 403]) {
      const { fetchImpl, calls } = createFetchStub((call) => {
        if (isRobotsRequest(call)) return new Response('', { status: 404 });
        return call.method === 'HEAD'
          ? new Response('', { status: headStatus })
          : new Response('', { status: 200 });
      });
      const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

      await expect(http.checkReachable('https://example.jp/a.html')).resolves.toMatchObject({ ok: true });
      expect(calls.filter((call) => !isRobotsRequest(call)).map((call) => call.method)).toEqual([
        'HEAD',
        'GET',
      ]);
    }
  });

  it('404 なら ok:false と status 404 を返す', async () => {
    const { fetchImpl } = createFetchStub((call) =>
      isRobotsRequest(call) ? new Response('', { status: 404 }) : new Response('', { status: 404 }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const result = await http.checkReachable('https://example.jp/missing.html');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toBe('HTTP 404');
  });

  it('例外が起きても投げずに ok:false を返す', async () => {
    const { fetchImpl } = createFetchStub((call) => {
      if (isRobotsRequest(call)) return new Response('', { status: 404 });
      throw new TypeError('fetch failed');
    });
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const result = await http.checkReachable('https://example.jp/a.html');

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain('fetch failed');
  });

  it('robots.txt で不許可なら投げずに ok:false を返す', async () => {
    const { fetchImpl } = createFetchStub((call) =>
      isRobotsRequest(call) ? robotsTxt('User-agent: *\nDisallow: /\n') : new Response('', { status: 200 }),
    );
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    const result = await http.checkReachable('https://example.jp/a.html');

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain('RobotsDisallowedError');
  });

  it('URL を解釈できない場合も投げずに ok:false を返す', async () => {
    const { fetchImpl } = createFetchStub(defaultRoute);
    const http = createHttpClient(makeRuntime(), silentLogger(), { fetchImpl });

    await expect(http.checkReachable('URL ではない')).resolves.toEqual({
      ok: false,
      status: null,
      error: 'URL を解釈できません',
    });
  });
});
