/**
 * src/fetchers/extract.ts のテスト(詳細設計書 §13「フェッチャー」層)。
 *
 * 検証の軸は契約 §src/fetchers/extract.ts:
 *   - HTML から本文が取れ、maxChars で切り詰められること
 *   - Readability が使えない壊れた HTML でも cheerio のフォールバックで文字列が返ること
 *   - script / style / nav / header / footer の中身が本文に混ざらないこと
 *   - 空白の正規化(連続する空白・改行が 1 つになる)
 *   - Content-Type が PDF なら contentType: 'pdf'
 *   - 失敗しても例外を投げず { text: '', contentType: 'html', title: null } を返すこと
 *
 * 外部ネットワークには一切出ない。HttpClient はこのファイル内のスタブを注入する。
 */

import { describe, expect, it } from 'vitest';

import { extractContent } from '../src/fetchers/extract.js';
import type { HttpClient, HttpGetOptions, HttpResponse } from '../src/types.js';
import { HttpError, RobotsDisallowedError } from '../src/types.js';

const PAGE_URL = 'https://www.example-mhlw.go.jp/stf/newpage_00001.html';

interface StubResponse {
  status?: number;
  text?: string;
  body?: Uint8Array;
  headers?: Record<string, string>;
  finalUrl?: string;
  /** これを指定すると get が例外を投げる(robots 不許可・404・タイムアウトの再現)。 */
  error?: Error;
}

function stubHttp(stub: StubResponse): HttpClient {
  return {
    get(url: string, _options?: HttpGetOptions): Promise<HttpResponse> {
      if (stub.error) return Promise.reject(stub.error);
      const text = stub.text ?? '';
      const response: HttpResponse = {
        status: stub.status ?? 200,
        text,
        body: stub.body ?? new TextEncoder().encode(text),
        headers: stub.headers ?? { 'content-type': 'text/html; charset=utf-8' },
        finalUrl: stub.finalUrl ?? url,
      };
      return Promise.resolve(response);
    },
    checkReachable(): Promise<{ ok: boolean; status: number | null; error: string | null }> {
      throw new Error('このテストでは checkReachable を呼びません');
    },
  };
}

/** 官公庁の通知ページを模した HTML。ナビ・スクリプト・フッタを本文の周りに置く。 */
const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="ja">
  <head>
    <title>障害福祉サービス等報酬改定に関する通知の発出について</title>
    <style>.m-listNews { color: red; font-size: 14px; }</style>
    <script>var tracker = "計測スクリプトの中身";</script>
  </head>
  <body>
    <header id="header">ヘッダの案内文とグローバルナビゲーション</header>
    <nav class="m-globalNav">サイト内検索 / 組織で探す / 分野別に探す</nav>
    <article id="contents">
      <h1>障害福祉サービス等報酬改定に関する通知の発出について</h1>
      <p>
        令和8年度障害福祉サービス等報酬改定に関する通知を各都道府県知事、各指定都市市長及び
        各中核市市長あてに発出しましたのでお知らせします。今回の改定では、障害者の重度化・
        高齢化に対応した支援体制の構築、医療的ケア児者への支援の充実、地域生活支援拠点等の
        機能強化を柱としています。
      </p>
      <p>
        施行期日は令和8年4月1日です。算定に係る体制等に関する届出は、令和8年4月15日までに
        指定権者へ提出してください。届出書の様式は本ページ下部の関連資料からダウンロードできます。
        なお、経過措置の取扱いについては別途通知する予定です。
      </p>
      <p>
        本件に関するお問い合わせは、社会・援護局障害保健福祉部障害福祉課までお願いします。
        報道関係者向けの資料は報道発表資料のページに掲載しています。
      </p>
    </article>
    <footer id="footer">フッタの著作権表示 Copyright example</footer>
    <script>console.log("フッタのスクリプトの中身");</script>
  </body>
</html>`;

describe('extractContent: HTML の本文抽出', () => {
  it('本文が取れ、contentType は html になる', async () => {
    const result = await extractContent(PAGE_URL, stubHttp({ text: ARTICLE_HTML }), 6_000);
    expect(result.contentType).toBe('html');
    expect(result.text).toContain('令和8年度障害福祉サービス等報酬改定に関する通知');
    expect(result.text).toContain('施行期日は令和8年4月1日です');
  });

  it('本文から得たタイトルを返す', async () => {
    const result = await extractContent(PAGE_URL, stubHttp({ text: ARTICLE_HTML }), 6_000);
    expect(result.title).toContain('障害福祉サービス等報酬改定');
  });

  it('maxChars で切り詰める', async () => {
    const result = await extractContent(PAGE_URL, stubHttp({ text: ARTICLE_HTML }), 20);
    expect(result.text).toHaveLength(20);
  });

  it('script / style / nav / header / footer の中身は本文に混ざらない', async () => {
    const result = await extractContent(PAGE_URL, stubHttp({ text: ARTICLE_HTML }), 6_000);
    expect(result.text).not.toContain('計測スクリプトの中身');
    expect(result.text).not.toContain('フッタのスクリプトの中身');
    expect(result.text).not.toContain('font-size');
    expect(result.text).not.toContain('サイト内検索');
    expect(result.text).not.toContain('ヘッダの案内文');
    expect(result.text).not.toContain('フッタの著作権表示');
  });

  it('cheerio へフォールバックする場合も script / style / nav / header / footer を除く', async () => {
    // Readability が本文とみなせない短いページ(表組みだけの一覧など)を模す。
    const shortHtml = [
      '<!DOCTYPE html><html lang="ja"><head><title>お知らせ</title>',
      '<style>.a{color:red}</style><script>var s = "スクリプトの中身";</script></head>',
      '<body><header>ヘッダの案内文</header><nav>サイト内検索</nav>',
      '<div id="contents">通知を発出しました。</div>',
      '<footer>フッタの著作権表示</footer></body></html>',
    ].join('');
    const result = await extractContent(PAGE_URL, stubHttp({ text: shortHtml }), 6_000);

    expect(result.text).toContain('通知を発出しました。');
    expect(result.text).not.toContain('スクリプトの中身');
    expect(result.text).not.toContain('color:red');
    expect(result.text).not.toContain('サイト内検索');
    expect(result.text).not.toContain('ヘッダの案内文');
    expect(result.text).not.toContain('フッタの著作権表示');
  });

  it('連続する空白・改行を 1 つに畳む', async () => {
    const spaced = [
      '<!DOCTYPE html><html lang="ja"><head><title>空白の多いページ</title></head><body>',
      '<div id="contents">改行と     空白が\n\n\t 大量に    入った    本文です。</div>',
      '</body></html>',
    ].join('');
    const result = await extractContent(PAGE_URL, stubHttp({ text: spaced }), 6_000);

    expect(result.text).toBe('改行と 空白が 大量に 入った 本文です。');
    expect(/\s\s/.test(result.text)).toBe(false);
    expect(result.text).not.toContain('\n');
    expect(result.text).not.toContain('\t');
  });

  it('壊れた HTML でも例外を投げず文字列を返す', async () => {
    const broken = '<<>><div class="x"><p>壊れた HTML の本文です<span>閉じていないタグ';
    const result = await extractContent(PAGE_URL, stubHttp({ text: broken }), 6_000);

    expect(result.contentType).toBe('html');
    expect(typeof result.text).toBe('string');
    expect(result.text).toContain('壊れた HTML の本文です');
  });

  it('タグが 1 つも無いゴミでも例外を投げない', async () => {
    const result = await extractContent(PAGE_URL, stubHttp({ text: '\u0000\u0001 壊れたバイト列' }), 6_000);
    expect(result.contentType).toBe('html');
    expect(typeof result.text).toBe('string');
  });
});

describe('extractContent: 失敗しても例外を投げない', () => {
  it('空レスポンスなら既定値を返す', async () => {
    const result = await extractContent(PAGE_URL, stubHttp({ text: '', body: new Uint8Array(0) }), 6_000);
    expect(result).toEqual({ text: '', contentType: 'html', title: null });
  });

  it('空白だけのレスポンスでも既定値を返す', async () => {
    const result = await extractContent(PAGE_URL, stubHttp({ text: '   \n \t ' }), 6_000);
    expect(result).toEqual({ text: '', contentType: 'html', title: null });
  });

  it('HTTP エラーでも例外を投げず既定値を返す', async () => {
    const result = await extractContent(PAGE_URL, stubHttp({ error: new HttpError(404, PAGE_URL) }), 6_000);
    expect(result).toEqual({ text: '', contentType: 'html', title: null });
  });

  it('robots.txt 不許可でも例外を投げず既定値を返す', async () => {
    const result = await extractContent(
      PAGE_URL,
      stubHttp({ error: new RobotsDisallowedError(PAGE_URL) }),
      6_000,
    );
    expect(result).toEqual({ text: '', contentType: 'html', title: null });
  });
});

// ---------------------------------------------------------------------------
// PDF
// 官公庁の通知は PDF が主役なので、PDF 判定と失敗時の挙動を押さえる。
// ---------------------------------------------------------------------------

/**
 * 最小限の PDF を組み立てる(xref のオフセットを計算して埋める)。
 * フィクスチャのバイナリを持たずにテストを自己完結させるため。
 */
function buildMinimalPdf(content: string): Uint8Array {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R' +
      ' /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

describe('extractContent: PDF', () => {
  const pdfUrl = 'https://www.example-mhlw.go.jp/content/000012345';

  it('Content-Type が application/pdf なら contentType は pdf になる', async () => {
    const body = buildMinimalPdf('BT /F1 24 Tf 72 720 Td (Houshu Kaitei Tsuuchi) Tj ET');
    const http = stubHttp({ body, text: '', headers: { 'content-type': 'application/pdf' } });
    const result = await extractContent(pdfUrl, http, 6_000);

    expect(result.contentType).toBe('pdf');
    expect(result.text).toContain('Houshu Kaitei Tsuuchi');
    expect(result.title).toBeNull();
  });

  it('PDF でも maxChars で切り詰める', async () => {
    const body = buildMinimalPdf('BT /F1 24 Tf 72 720 Td (Houshu Kaitei Tsuuchi) Tj ET');
    const http = stubHttp({ body, text: '', headers: { 'content-type': 'application/pdf' } });
    const result = await extractContent(pdfUrl, http, 6);

    expect(result.contentType).toBe('pdf');
    expect(result.text).toHaveLength(6);
  });

  it('壊れた PDF バイト列でも例外を投げず既定値を返す', async () => {
    const broken = new Uint8Array(Buffer.from('%PDF-1.4\nこれは壊れた PDF です', 'utf8'));
    const http = stubHttp({ body: broken, text: '', headers: { 'content-type': 'application/pdf' } });
    const result = await extractContent(pdfUrl, http, 6_000);

    expect(result).toEqual({ text: '', contentType: 'html', title: null });
  });

  it('URL の拡張子が .pdf なら Content-Type が無くても PDF として扱う', async () => {
    const body = buildMinimalPdf('BT /F1 24 Tf 72 720 Td (Shiryou) Tj ET');
    const http = stubHttp({ body, text: '', headers: {} });
    const result = await extractContent('https://www.example-mhlw.go.jp/content/000012345.pdf', http, 6_000);

    expect(result.contentType).toBe('pdf');
    expect(result.text).toContain('Shiryou');
  });
});
