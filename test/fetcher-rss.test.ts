/**
 * src/fetchers/rss.ts のテスト(詳細設計書 §13「フェッチャー」層)。
 *
 * 検証の軸は契約 §src/fetchers/rss.ts:
 *   - RSS 2.0 / Atom 1.0 / RDF(RSS 1.0)の 3 形式から candidates が取れること
 *   - 要素が 1 件しか無いフィードでも取りこぼさないこと(fast-xml-parser の配列化問題)
 *   - link の絶対化は res.finalUrl 基準
 *   - 日付は ISO8601。解釈できなければ null(例外にしない)
 *   - 壊れた XML / 空ボディ / 304 で例外を投げないこと
 *
 * 外部ネットワークには一切出ない。HttpClient はこのファイル内のスタブを注入する。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fetchRss } from '../src/fetchers/rss.js';
import type { HttpClient, HttpGetOptions, HttpResponse, SourceConfig, SourceState } from '../src/types.js';

const FIXTURE_DIR = new URL('./fixtures/', import.meta.url);

function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
}

interface StubResponse {
  status?: number;
  text?: string;
  headers?: Record<string, string>;
  finalUrl?: string;
}

interface StubHttp {
  http: HttpClient;
  calls: { url: string; options: HttpGetOptions | undefined }[];
}

/** 固定レスポンスを返す HttpClient。実サイトへは出ない。 */
function stubHttp(stub: StubResponse): StubHttp {
  const calls: { url: string; options: HttpGetOptions | undefined }[] = [];
  const http: HttpClient = {
    get(url: string, options?: HttpGetOptions): Promise<HttpResponse> {
      calls.push({ url, options });
      const text = stub.text ?? '';
      const response: HttpResponse = {
        status: stub.status ?? 200,
        text,
        body: new TextEncoder().encode(text),
        headers: stub.headers ?? { 'content-type': 'application/xml; charset=utf-8' },
        finalUrl: stub.finalUrl ?? url,
      };
      return Promise.resolve(response);
    },
    checkReachable(): Promise<{ ok: boolean; status: number | null; error: string | null }> {
      throw new Error('このテストでは checkReachable を呼びません');
    },
  };
  return { http, calls };
}

function rssSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'mhlw_news_rss',
    name: '例示厚生労働省 新着情報',
    type: 'rss',
    url: 'https://www.example-mhlw.go.jp/stf/news.rdf',
    channels: ['welfare'],
    priority: 'high',
    region: null,
    enabled: true,
    html: null,
    egov: null,
    note: null,
    ...overrides,
  };
}

function sourceState(overrides: Partial<SourceState> = {}): SourceState {
  return {
    sourceId: 'mhlw_news_rss',
    lastFetchedAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    etag: null,
    lastModified: null,
    lastError: null,
    lastNewCount: 0,
    lastCandidateCount: 0,
    consecutiveEmpty: 0,
    warnedAtFailureCount: 0,
    warnedAtEmptyCount: 0,
    ...overrides,
  };
}

describe('fetchRss: RSS 2.0', () => {
  const feedUrl = 'https://www.example-meti.go.jp/rss/index.xml';

  async function fetchFixture() {
    const { http } = stubHttp({ text: fixtureText('rss-rss2.xml'), finalUrl: feedUrl });
    return fetchRss(rssSource({ id: 'meti_rss', url: feedUrl }), http, null);
  }

  it('3 件すべての候補を取り出す', async () => {
    const result = await fetchFixture();
    expect(result.notModified).toBe(false);
    expect(result.candidates).toHaveLength(3);
  });

  it('CDATA のタイトルをそのまま読む', async () => {
    const result = await fetchFixture();
    expect(result.candidates[0]?.title).toBe('令和8年度 リスキリング支援事業の公募について');
    expect(result.candidates[0]?.url).toBe('https://www.example-meti.go.jp/press/2026/04/20260401001.html');
  });

  it('HTML エンティティ(名前付き・数値参照)をデコードする', async () => {
    const result = await fetchFixture();
    expect(result.candidates[1]?.title).toBe('中小企業&小規模事業者向け補助金の受付開始');
  });

  it('相対 link を finalUrl 基準で絶対化する', async () => {
    const { http } = stubHttp({
      text: fixtureText('rss-rss2.xml'),
      // リダイレクト後の URL を base にする(契約)。リクエスト URL とは別ホストにして区別する。
      finalUrl: 'https://www2.example-meti.go.jp/rss/2026/index.xml',
    });
    const result = await fetchRss(
      rssSource({ id: 'meti_rss', url: 'https://www.example-meti.go.jp/rss/index.xml' }),
      http,
      null,
    );
    expect(result.candidates[1]?.url).toBe('https://www2.example-meti.go.jp/press/2026/04/20260402002.html');
  });

  it('pubDate を ISO8601 UTC にする', async () => {
    const result = await fetchFixture();
    expect(result.candidates[0]?.publishedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(result.candidates[1]?.publishedAt).toBe('2026-04-02T01:30:00.000Z');
  });

  it('解釈できない日付は例外にせず null にする', async () => {
    const result = await fetchFixture();
    expect(result.candidates[2]?.title).toBe('日付欄が壊れている記事');
    expect(result.candidates[2]?.publishedAt).toBeNull();
  });
});

describe('fetchRss: Atom 1.0', () => {
  const feedUrl = 'https://www.example-cfa.go.jp/feed/atom.xml';

  async function fetchFixture() {
    const { http } = stubHttp({ text: fixtureText('rss-atom.xml'), finalUrl: feedUrl });
    return fetchRss(rssSource({ id: 'cfa_atom', url: feedUrl }), http, null);
  }

  it('entry すべての候補を取り出す', async () => {
    const result = await fetchFixture();
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.title).toBe('児童福祉法施行規則の一部を改正する省令の公布について');
  });

  it('link[rel=alternate] を rel=edit より優先する', async () => {
    const result = await fetchFixture();
    expect(result.candidates[0]?.url).toBe('https://www.example-cfa.go.jp/news/2026/04/0401.html');
  });

  it('rel 無しの link も採用する', async () => {
    const result = await fetchFixture();
    expect(result.candidates[1]?.url).toBe('https://www.example-cfa.go.jp/news/2026/04/0402.html');
  });

  it('published を +09:00 のオフセット付きで ISO8601 UTC にする', async () => {
    const result = await fetchFixture();
    // published(2026-04-02T14:00:00+09:00)は updated より優先される。
    expect(result.candidates[1]?.publishedAt).toBe('2026-04-02T05:00:00.000Z');
    expect(result.candidates[0]?.publishedAt).toBe('2026-04-01T00:00:00.000Z');
  });

  it('二重エスケープされた実体参照もデコードする', async () => {
    const result = await fetchFixture();
    expect(result.candidates[2]?.title).toBe('保育所等における"安全計画"の策定状況について');
  });

  it('相対 href を finalUrl 基準で絶対化する', async () => {
    const result = await fetchFixture();
    expect(result.candidates[2]?.url).toBe('https://www.example-cfa.go.jp/news/2026/04/0403.html');
  });
});

describe('fetchRss: RDF(RSS 1.0)', () => {
  const feedUrl = 'https://www.example-mhlw.go.jp/stf/news.rdf';

  async function fetchFixture() {
    const { http } = stubHttp({ text: fixtureText('rss-rdf.xml'), finalUrl: feedUrl });
    return fetchRss(rssSource(), http, null);
  }

  it('rdf:RDF 直下の item を取り出す', async () => {
    const result = await fetchFixture();
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.title).toBe('障害福祉サービス等報酬改定に関する通知の発出について');
    expect(result.candidates[0]?.url).toBe('https://www.example-mhlw.go.jp/stf/newpage_00001.html');
  });

  it('dc:date を ISO8601 UTC にする', async () => {
    const result = await fetchFixture();
    expect(result.candidates[0]?.publishedAt).toBe('2026-04-01T01:00:00.000Z');
  });

  it('link を持たない item は rdf:about を URL に使う', async () => {
    const result = await fetchFixture();
    expect(result.candidates[1]?.url).toBe('https://www.example-mhlw.go.jp/stf/newpage_00002.html');
    expect(result.candidates[1]?.title).toBe('人材開発支援助成金&キャリアアップ助成金の令和8年度改正');
  });

  it('日付要素が無い item は publishedAt を null にする', async () => {
    const result = await fetchFixture();
    expect(result.candidates[2]?.url).toBe('https://www.example-mhlw.go.jp/stf/newpage_00003.html');
    expect(result.candidates[2]?.publishedAt).toBeNull();
  });

  it('item が 1 件だけ(配列にならない)でも 1 件取り出す', async () => {
    // fast-xml-parser は同名要素が 1 つだと配列にしない。ここを取りこぼすと
    // 「たまに新着が 1 件の日だけ検知されない」という気づきにくい故障になる。
    const single = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
      ' xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">',
      '  <channel rdf:about="https://www.example-mhlw.go.jp/stf/news.rdf">',
      '    <title>例示厚生労働省 新着情報</title>',
      '    <link>https://www.example-mhlw.go.jp/</link>',
      '    <description>新着情報</description>',
      '  </channel>',
      '  <item rdf:about="https://www.example-mhlw.go.jp/stf/newpage_09999.html">',
      '    <title>唯一の新着記事</title>',
      '    <link>https://www.example-mhlw.go.jp/stf/newpage_09999.html</link>',
      '    <dc:date>2026-04-01T10:00:00+09:00</dc:date>',
      '  </item>',
      '</rdf:RDF>',
    ].join('\n');
    const { http } = stubHttp({ text: single, finalUrl: feedUrl });
    const result = await fetchRss(rssSource(), http, null);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.title).toBe('唯一の新着記事');
    expect(result.candidates[0]?.publishedAt).toBe('2026-04-01T01:00:00.000Z');
  });

  it('RSS 2.0 でも item が 1 件だけのとき 1 件取り出す', async () => {
    const single = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0"><channel>',
      '  <title>例示経済産業省 新着情報</title>',
      '  <link>https://www.example-meti.go.jp/</link>',
      '  <item>',
      '    <title>唯一の報道発表</title>',
      '    <link>https://www.example-meti.go.jp/press/2026/04/only.html</link>',
      '    <pubDate>Wed, 01 Apr 2026 09:00:00 +0900</pubDate>',
      '  </item>',
      '</channel></rss>',
    ].join('\n');
    const { http } = stubHttp({ text: single });
    const result = await fetchRss(rssSource({ url: 'https://www.example-meti.go.jp/rss.xml' }), http, null);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.url).toBe('https://www.example-meti.go.jp/press/2026/04/only.html');
  });

  it('Atom でも entry が 1 件だけのとき 1 件取り出す', async () => {
    const single = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      '  <title>例示こども家庭庁 新着情報</title>',
      '  <entry>',
      '    <title>唯一のお知らせ</title>',
      '    <link rel="alternate" href="https://www.example-cfa.go.jp/news/only.html"/>',
      '    <updated>2026-04-01T09:00:00+09:00</updated>',
      '  </entry>',
      '</feed>',
    ].join('\n');
    const { http } = stubHttp({ text: single });
    const result = await fetchRss(rssSource({ url: 'https://www.example-cfa.go.jp/atom.xml' }), http, null);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.url).toBe('https://www.example-cfa.go.jp/news/only.html');
  });
});

describe('fetchRss: 異常系', () => {
  it('壊れた XML でも例外を投げず空配列を返す', async () => {
    const { http } = stubHttp({ text: '<<<これは XML として解析できない' });
    const result = await fetchRss(rssSource(), http, null);
    expect(result.candidates).toEqual([]);
    expect(result.notModified).toBe(false);
  });

  it('フィードの代わりに HTML が返っても空配列を返す', async () => {
    const { http } = stubHttp({ text: '<html><body><h1>404 Not Found</h1></body></html>' });
    const result = await fetchRss(rssSource(), http, null);
    expect(result.candidates).toEqual([]);
  });

  it('空ボディでも例外を投げず空配列を返す', async () => {
    const { http } = stubHttp({ text: '' });
    const result = await fetchRss(rssSource(), http, null);
    expect(result.candidates).toEqual([]);
    expect(result.notModified).toBe(false);
  });

  it('空白だけのボディでも空配列を返す', async () => {
    const { http } = stubHttp({ text: '   \n  \n' });
    const result = await fetchRss(rssSource(), http, null);
    expect(result.candidates).toEqual([]);
  });
});

describe('fetchRss: 条件付き GET', () => {
  it('304 のとき notModified: true で candidates は空、etag / lastModified は保持される', async () => {
    const state = sourceState({ etag: '"abc123"', lastModified: 'Wed, 01 Apr 2026 00:00:00 GMT' });
    const { http, calls } = stubHttp({ status: 304, text: '', headers: {} });
    const result = await fetchRss(rssSource(), http, state);

    expect(result.notModified).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.etag).toBe('"abc123"');
    expect(result.lastModified).toBe('Wed, 01 Apr 2026 00:00:00 GMT');
    // 条件付き GET のために前回値が HttpClient へ渡っていること。
    expect(calls[0]?.options?.etag).toBe('"abc123"');
    expect(calls[0]?.options?.lastModified).toBe('Wed, 01 Apr 2026 00:00:00 GMT');
  });

  it('200 応答のヘッダにある etag / last-modified を返す', async () => {
    const { http } = stubHttp({
      text: fixtureText('rss-rdf.xml'),
      headers: {
        'content-type': 'application/rdf+xml',
        etag: '"newetag"',
        'last-modified': 'Fri, 03 Apr 2026 01:00:00 GMT',
      },
    });
    const result = await fetchRss(rssSource(), http, sourceState({ etag: '"abc123"' }));
    expect(result.etag).toBe('"newetag"');
    expect(result.lastModified).toBe('Fri, 03 Apr 2026 01:00:00 GMT');
    expect(result.notModified).toBe(false);
  });
});

describe('fetchRss: RSS を名乗る独自スキーマ(WAM NET 都道府県フィード)', () => {
  // 実在の配信元。ルートが <RSS_LIST>、項目が大文字の <ITEM>、
  // リンクが <URL>、日付が <DATE> で、標準の RSS ではない。
  // 小文字決め打ちで探すと 0 件になるが HTTP は 200 なので、
  // 「巡回成功・中身は永久に 0 件」という静かな故障になる。
  const feedUrl = 'https://www.example-wam.go.jp/pref_rss/rss_all_new.xml';

  async function fetchFixture() {
    const { http } = stubHttp({ text: fixtureText('rss-wam-pref.xml'), finalUrl: feedUrl });
    return fetchRss(rssSource({ id: 'wam_pref', url: feedUrl }), http, null);
  }

  it('大文字の ITEM を候補として取り出す', async () => {
    const result = await fetchFixture();
    expect(result.candidates).toHaveLength(2);
  });

  it('<URL> と <TITLE> を読む', async () => {
    const result = await fetchFixture();
    expect(result.candidates[0]?.url).toBe('https://www.pref.osaka.lg.jp/jigyoshido/shitei/index.html');
    expect(result.candidates[0]?.title).toBe('障害福祉サービス事業者の指定申請について（令和８年度）');
  });

  it('タイムゾーンの無い <DATE> を日本時間として解釈する', async () => {
    const result = await fetchFixture();
    // 2026-09-15 12:00 JST = 2026-09-15T03:00:00Z。
    // 実行環境の時間帯で解釈すると UTC の Cloud Run では 9 時間ずれ、
    // 日付境界をまたぐと当日のダイジェストから漏れる。
    expect(result.candidates[0]?.publishedAt).toBe('2026-09-15T03:00:00.000Z');
  });
});
