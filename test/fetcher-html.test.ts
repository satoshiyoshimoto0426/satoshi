/**
 * src/fetchers/html.ts のテスト(詳細設計書 §13「フェッチャー」層)。
 *
 * 検証の軸は契約 §src/fetchers/html.ts:
 *   - itemSelector による列挙。a 以外を指した場合は配下の最初の a を使う
 *   - 相対 URL は res.finalUrl 基準で絶対化し、http(s) 以外(javascript: 等)は除外
 *   - includeUrlPatterns / excludeUrlPatterns による絞り込みと URL の重複排除
 *   - タイトルが空なら URL の末尾パスセグメントを使う。titleFrom の 3 種
 *   - 和暦(令和)と西暦の日付を JST の暦日として ISO8601 UTC に直す
 *   - 日本の自治体サイトに実在する Shift_JIS ページが文字化けしないこと
 *
 * 外部ネットワークには一切出ない。Shift_JIS の検証だけは文字コード判定まで通したいので、
 * 本物の createHttpClient に fetchImpl を注入してフィクスチャのバイト列を返す。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fetchHtml } from '../src/fetchers/html.js';
import type {
  HtmlSourceOptions,
  HttpClient,
  HttpGetOptions,
  HttpResponse,
  Logger,
  RuntimeConfig,
  SourceConfig,
  SourceState,
} from '../src/types.js';
import { createHttpClient } from '../src/util/http.js';

const FIXTURE_DIR = new URL('./fixtures/', import.meta.url);

function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8');
}

function fixtureBytes(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURE_DIR));
}

const LIST_URL = 'https://www.example-mhlw.go.jp/stf/houdou/index.html';

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
        headers: stub.headers ?? { 'content-type': 'text/html; charset=utf-8' },
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

function htmlOptions(overrides: Partial<HtmlSourceOptions> = {}): HtmlSourceOptions {
  return {
    itemSelector: 'ul.m-listNews li',
    titleFrom: 'text',
    hrefFrom: 'href',
    dateSelector: null,
    includeUrlPatterns: [],
    excludeUrlPatterns: [],
    ...overrides,
  };
}

function htmlSource(
  html: Partial<HtmlSourceOptions> = {},
  overrides: Partial<SourceConfig> = {},
): SourceConfig {
  return {
    id: 'mhlw_houdou',
    name: '例示厚生労働省 報道発表資料',
    type: 'html',
    url: LIST_URL,
    channels: ['welfare'],
    priority: 'high',
    region: null,
    enabled: true,
    html: htmlOptions(html),
    egov: null,
    note: null,
    ...overrides,
  };
}

function sourceState(overrides: Partial<SourceState> = {}): SourceState {
  return {
    sourceId: 'mhlw_houdou',
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

/** 一覧フィクスチャに対して 1 回 fetchHtml する。 */
async function fetchList(html: Partial<HtmlSourceOptions> = {}, stub: StubResponse = {}) {
  const { http } = stubHttp({ text: fixtureText('list-mhlw.html'), finalUrl: LIST_URL, ...stub });
  return fetchHtml(htmlSource(html), http, null);
}

function urlsOf(candidates: { url: string }[]): string[] {
  return candidates.map((c) => c.url);
}

describe('fetchHtml: 抽出の基本', () => {
  it('itemSelector に一致した li から候補を抽出する', async () => {
    const result = await fetchList();
    expect(result.notModified).toBe(false);
    // li は 11 個。javascript: リンク 1 件と重複 URL 1 件が落ちて 9 件。
    expect(result.candidates).toHaveLength(9);
    expect(urlsOf(result.candidates)).toContain('https://www.example-mhlw.go.jp/stf/newpage_00001.html');
    expect(result.candidates[0]?.title).toBe('障害福祉サービス等報酬改定に関する通知の発出について');
  });

  it('itemSelector が a を直接指す場合も抽出できる', async () => {
    const result = await fetchList({ itemSelector: '#contents a' });
    // li 配下のリンク 12 本のうち javascript: 1 件と重複 1 件が落ちて 10 件。
    expect(result.candidates).toHaveLength(10);
    expect(urlsOf(result.candidates)).toContain(
      'https://www.example-mhlw.go.jp/stf/newpage_00008/shiryou.pdf',
    );
  });

  it('a 以外を指した場合は配下の最初の a を 1 件だけ拾う', async () => {
    const withLi = await fetchList();
    const urls = urlsOf(withLi.candidates);
    // 2 本のリンクを持つ li からは先頭の 1 本だけが候補になる。
    expect(urls).toContain('https://www.example-mhlw.go.jp/stf/newpage_00008.html');
    expect(urls).not.toContain('https://www.example-mhlw.go.jp/stf/newpage_00008/shiryou.pdf');
  });

  it('itemSelector の外側(ヘッダ・フッタ)のリンクは拾わない', async () => {
    const result = await fetchList();
    const urls = urlsOf(result.candidates);
    expect(urls).not.toContain('https://www.example-mhlw.go.jp/index.html');
    expect(urls).not.toContain('https://www.example-mhlw.go.jp/copyright.html');
  });

  it('一致する要素が無ければ例外を投げず空配列を返す', async () => {
    const result = await fetchList({ itemSelector: '.not-exist-anywhere a' });
    expect(result.candidates).toEqual([]);
  });
});

describe('fetchHtml: URL の絶対化と絞り込み', () => {
  it('相対 URL を finalUrl 基準で絶対化する', async () => {
    const { http } = stubHttp({
      text: fixtureText('list-mhlw.html'),
      // リダイレクトで別ホストへ飛んだ場合でも、base はリクエスト URL ではなく finalUrl。
      finalUrl: 'https://www.example-mhlw2.go.jp/stf/houdou/2026/index.html',
    });
    const result = await fetchHtml(
      htmlSource({}, { url: 'https://www.example-mhlw.go.jp/stf/houdou/' }),
      http,
      null,
    );
    expect(result.candidates[0]?.url).toBe('https://www.example-mhlw2.go.jp/stf/newpage_00001.html');
  });

  it('javascript: リンクを除外する', async () => {
    const result = await fetchList({ itemSelector: '#contents a' });
    for (const candidate of result.candidates) {
      expect(candidate.url.startsWith('javascript:')).toBe(false);
    }
    expect(urlsOf(result.candidates).some((u) => u.includes('void(0)'))).toBe(false);
  });

  it('includeUrlPatterns に一致するものだけ採用する', async () => {
    const result = await fetchList({ includeUrlPatterns: ['/stf/houdou/'] });
    expect(urlsOf(result.candidates)).toEqual([
      'https://www.example-mhlw.go.jp/stf/houdou/0000004.html',
      'https://www.example-mhlw.go.jp/stf/houdou/0000005.html',
    ]);
  });

  it('excludeUrlPatterns に一致するものを除外する', async () => {
    const result = await fetchList({
      itemSelector: '#contents a',
      excludeUrlPatterns: ['x.example-sns.com', '.pdf'],
    });
    const urls = urlsOf(result.candidates);
    expect(urls).toHaveLength(8);
    expect(urls.some((u) => u.includes('x.example-sns.com'))).toBe(false);
    expect(urls.some((u) => u.endsWith('.pdf'))).toBe(false);
  });

  it('include と exclude は併用でき、exclude が優先される', async () => {
    const result = await fetchList({
      itemSelector: '#contents a',
      includeUrlPatterns: ['/stf/newpage_00008'],
      excludeUrlPatterns: ['.pdf'],
    });
    expect(urlsOf(result.candidates)).toEqual(['https://www.example-mhlw.go.jp/stf/newpage_00008.html']);
  });

  it('同一 URL は 1 件に重複排除される', async () => {
    const result = await fetchList();
    const duplicated = urlsOf(result.candidates).filter(
      (u) => u === 'https://www.example-mhlw.go.jp/stf/newpage_00001.html',
    );
    expect(duplicated).toHaveLength(1);
    // 重複排除では最初の 1 件(= 一覧の上にあるもの)を残す。
    expect(result.candidates[0]?.title).toBe('障害福祉サービス等報酬改定に関する通知の発出について');
  });
});

describe('fetchHtml: タイトル', () => {
  it('タイトルが空のときは URL の最後のパスセグメントを使う', async () => {
    const result = await fetchList();
    const imageOnly = result.candidates.find(
      (c) => c.url === 'https://www.example-mhlw.go.jp/stf/newpage_00002.html',
    );
    expect(imageOnly?.title).toBe('newpage_00002.html');
  });

  it("titleFrom: 'text' はリンク文字列を使う", async () => {
    const result = await fetchList({ titleFrom: 'text' });
    const target = result.candidates.find(
      (c) => c.url === 'https://www.example-mhlw.go.jp/stf/newpage_00007.html',
    );
    expect(target?.title).toBe('テキストの見出し');
  });

  it("titleFrom: 'title' は title 属性を使う", async () => {
    const result = await fetchList({ titleFrom: 'title' });
    const target = result.candidates.find(
      (c) => c.url === 'https://www.example-mhlw.go.jp/stf/newpage_00007.html',
    );
    expect(target?.title).toBe('タイトル属性の見出し');
  });

  it("titleFrom: 'aria-label' は aria-label 属性を使う", async () => {
    const result = await fetchList({ titleFrom: 'aria-label' });
    const target = result.candidates.find(
      (c) => c.url === 'https://www.example-mhlw.go.jp/stf/newpage_00007.html',
    );
    expect(target?.title).toBe('アリアラベルの見出し');
  });

  it('行全体ではなくリンク文字列だけをタイトルにする(日付を含めない)', async () => {
    const result = await fetchList();
    expect(result.candidates[0]?.title).not.toContain('令和8年4月1日');
  });
});

describe('fetchHtml: 日付の解釈', () => {
  /** 指定 URL の候補の publishedAt を返す。 */
  async function publishedAtOf(url: string): Promise<string | null | undefined> {
    const result = await fetchList({ dateSelector: '.date' });
    return result.candidates.find((c) => c.url === url)?.publishedAt;
  }

  it('和暦「令和8年4月1日」を JST 00:00 の ISO8601 UTC にする', async () => {
    // 2026-04-01 の JST 00:00 = 2026-03-31T15:00:00.000Z(絶対ルール6)。
    await expect(publishedAtOf('https://www.example-mhlw.go.jp/stf/newpage_00001.html')).resolves.toBe(
      '2026-03-31T15:00:00.000Z',
    );
  });

  it('「令和元年」を 2019 年として扱う', async () => {
    await expect(publishedAtOf('https://www.example-mhlw.go.jp/stf/newpage_00006.html')).resolves.toBe(
      '2019-04-30T15:00:00.000Z',
    );
  });

  it('西暦「2026年4月3日」を解釈する', async () => {
    await expect(publishedAtOf('https://www.example-mhlw.go.jp/stf/newpage_00003.html')).resolves.toBe(
      '2026-04-02T15:00:00.000Z',
    );
  });

  it('西暦「2026/4/4」を解釈する', async () => {
    await expect(publishedAtOf('https://www.example-mhlw.go.jp/stf/houdou/0000004.html')).resolves.toBe(
      '2026-04-03T15:00:00.000Z',
    );
  });

  it('西暦「2026-04-05」を解釈する', async () => {
    await expect(publishedAtOf('https://www.example-mhlw.go.jp/stf/houdou/0000005.html')).resolves.toBe(
      '2026-04-04T15:00:00.000Z',
    );
  });

  it('dateSelector が null なら publishedAt は全件 null', async () => {
    const result = await fetchList({ dateSelector: null });
    for (const candidate of result.candidates) {
      expect(candidate.publishedAt).toBeNull();
    }
  });

  it('dateSelector が一致しなくても例外を投げず publishedAt を null にする', async () => {
    const result = await fetchList({ dateSelector: '.no-such-date' });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.publishedAt).toBeNull();
    }
  });
});

describe('fetchHtml: 異常系と条件付き GET', () => {
  it('空ボディでも例外を投げず空配列を返す', async () => {
    const { http } = stubHttp({ text: '' });
    const result = await fetchHtml(htmlSource(), http, null);
    expect(result.candidates).toEqual([]);
    expect(result.notModified).toBe(false);
  });

  it('304 のとき notModified: true で candidates は空、etag / lastModified は保持される', async () => {
    const state = sourceState({ etag: '"listetag"', lastModified: 'Wed, 01 Apr 2026 00:00:00 GMT' });
    const { http, calls } = stubHttp({ status: 304, text: '', headers: {} });
    const result = await fetchHtml(htmlSource(), http, state);

    expect(result.notModified).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.etag).toBe('"listetag"');
    expect(result.lastModified).toBe('Wed, 01 Apr 2026 00:00:00 GMT');
    expect(calls[0]?.options?.etag).toBe('"listetag"');
  });
});

// ---------------------------------------------------------------------------
// Shift_JIS の一覧ページ(自治体サイト対策)
// createHttpClient に fetchImpl を注入し、文字コード判定まで含めて検証する。
// ---------------------------------------------------------------------------

const SJIS_URL = 'https://www.example-pref.lg.jp/jigyousha/shogai/';

function silentLogger(): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child(): Logger {
      return logger;
    },
  };
  return logger;
}

function testRuntime(): RuntimeConfig {
  return {
    gcpProjectId: null,
    firestoreDatabaseId: '(default)',
    storeKind: 'memory',
    anthropicModel: 'claude-opus-5',
    userAgent: 'SeidoWatchBot/1.0 (+mailto:ops@example.com)',
    // テストでは待たない(実時間を消費しないため)。
    hostDelayMs: 0,
    hostConcurrency: 4,
    httpTimeoutMs: 5_000,
    maxNewItemsPerSource: 50,
    recheckPerSource: 5,
    maxContentChars: 6_000,
    retentionDays: 90,
    notifyWebhookUrl: null,
    notifyWebhookKind: null,
    dryRun: true,
  };
}

/**
 * Shift_JIS のフィクスチャを返す fetch スタブ。
 * robots.txt には全面許可を返す(ネットワークには出ない)。
 */
function sjisFetchImpl(contentType: string): typeof fetch {
  const bytes = fixtureBytes('list-municipal-sjis.html');
  const impl = (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/robots.txt')) {
      return Promise.resolve(
        new Response('User-agent: *\nAllow: /\n', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    }
    return Promise.resolve(
      new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': contentType } }),
    );
  };
  return impl as typeof fetch;
}

function sjisSource(): SourceConfig {
  return htmlSource(
    { itemSelector: 'ul.news_list li', dateSelector: '.day' },
    {
      id: 'mu_pref_example',
      name: '例示県 障害福祉サービス事業者向けお知らせ',
      url: SJIS_URL,
      region: '例示県',
    },
  );
}

describe('fetchHtml: Shift_JIS の一覧ページ', () => {
  it('Content-Type の charset=Shift_JIS から日本語タイトルを文字化けせず取れる', async () => {
    const http = createHttpClient(testRuntime(), silentLogger(), {
      fetchImpl: sjisFetchImpl('text/html; charset=Shift_JIS'),
      sleep: () => Promise.resolve(),
    });
    const result = await fetchHtml(sjisSource(), http, null);

    expect(result.candidates).toHaveLength(4);
    expect(result.candidates[0]?.title).toBe('障害福祉サービス事業者向け集団指導の実施について');
    expect(result.candidates[0]?.url).toBe('https://www.example-pref.lg.jp/jigyousha/shogai/20260401.html');
    expect(result.candidates[1]?.title).toBe('介護給付費等の算定に係る体制等に関する届出について');
    // 文字化けすると U+FFFD(置換文字)が現れる。1 つも無いことを確かめる。
    for (const candidate of result.candidates) {
      expect(candidate.title).not.toContain('\uFFFD');
    }
  });

  it('Content-Type に charset が無くても meta charset から判定できる', async () => {
    const http = createHttpClient(testRuntime(), silentLogger(), {
      fetchImpl: sjisFetchImpl('text/html'),
      sleep: () => Promise.resolve(),
    });
    const result = await fetchHtml(sjisSource(), http, null);

    expect(result.candidates[0]?.title).toBe('障害福祉サービス事業者向け集団指導の実施について');
    expect(result.candidates[2]?.title).toBe('指定障害福祉サービス事業者の指定更新手続きのご案内');
    for (const candidate of result.candidates) {
      expect(candidate.title).not.toContain('\uFFFD');
    }
  });

  it('Shift_JIS のページでも和暦の日付を ISO8601 UTC にできる', async () => {
    const http = createHttpClient(testRuntime(), silentLogger(), {
      fetchImpl: sjisFetchImpl('text/html; charset=Shift_JIS'),
      sleep: () => Promise.resolve(),
    });
    const result = await fetchHtml(sjisSource(), http, null);
    expect(result.candidates[0]?.publishedAt).toBe('2026-03-31T15:00:00.000Z');
    expect(result.candidates[2]?.publishedAt).toBe('2026-04-05T15:00:00.000Z');
  });
});

describe('Shift_JIS フィクスチャ自体の健全性', () => {
  it('list-municipal-sjis.html が Shift_JIS のバイト列のまま保存されている', () => {
    const bytes = fixtureBytes('list-municipal-sjis.html');
    // 「障」は Shift_JIS で 0x8F 0xE1。UTF-8 に変換し直されるとこの並びは消える。
    expect(bytes.includes(Buffer.from([0x8f, 0xe1]))).toBe(true);
    // UTF-8 として読めてしまうなら、それはもう Shift_JIS ではない。
    // (prettier などに整形させると壊れるため .prettierignore で除外している)
    expect(new TextDecoder('utf-8').decode(bytes)).toContain('\uFFFD');
  });
});
