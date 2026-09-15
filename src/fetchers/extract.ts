/**
 * 候補リンクの本文を取り出す(詳細設計書 §6.1 の手順 5)。
 *
 * 方針:
 *   - PDF(官公庁の通知・事務連絡は PDF が主役)は unpdf でテキスト化する。
 *   - HTML は jsdom + Readability で本文だけを抜く。ナビゲーションやフッタの
 *     定型文が AI 入力に混ざると、分類の関連度も要約の質も落ちるため。
 *   - **例外を外に投げない**。本文が取れないことは「そのアイテムの情報が薄い」だけで、
 *     巡回そのものの失敗ではない。1 件の壊れた PDF で 1 ソース分の巡回を落とさない。
 *
 * セキュリティ(NFR / 詳細設計書 §11):
 *   jsdom は `runScripts` も `resources` も指定しない。これにより
 *   ページ内スクリプトは実行されず、外部リソース(画像・CSS・トラッカー)も
 *   一切取りに行かない。取得するのは HttpClient を通した本文 1 通だけに保つ。
 */

import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extractText, getDocumentProxy } from 'unpdf';

import type { ExtractedContent, HttpClient, ItemContentType } from '../types.js';
import { createLogger } from '../util/logger.js';

const logger = createLogger({ module: 'fetchers/extract' });

/** 本文が取れなかったときの戻り値(契約: 例外ではなくこれを返す)。 */
const EMPTY: ExtractedContent = { text: '', contentType: 'html', title: null };

/** Readability を諦めて cheerio に切り替える文字数のしきい値。 */
const MIN_READABLE_CHARS = 40;

/** 本文抽出時に落とす要素。ナビ・装飾・スクリプトは本文ではない。 */
const NOISE_SELECTOR = 'script, style, noscript, nav, header, footer, iframe, svg, form';

/** 連続する空白・改行を 1 つに畳み、maxChars で切り詰める。 */
function normalize(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return maxChars > 0 && collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

function mimeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** 拡張子が .pdf かどうか。クエリや #fragment を除いたパスで判定する。 */
function looksLikePdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return url.toLowerCase().split(/[?#]/)[0]?.endsWith('.pdf') === true;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** PDF からテキストを取り出す。ページはまとめて 1 本の文字列にする。 */
async function extractPdf(bytes: Uint8Array, maxChars: number): Promise<string> {
  // getDocumentProxy に渡したバッファは PDF.js 側で消費(detach)されるのでコピーを渡す。
  // verbosity: 0 は PDF.js が console に直接吐く警告を止めるため。
  // 構造化ログ(JSON Lines)に素のテキスト行が混ざると Cloud Logging 側で読めなくなる。
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return normalize(text, maxChars);
  } finally {
    // 1 回の巡回で多数の PDF を開くので、ワーカーが抱えるメモリを都度解放する。
    try {
      await pdf.loadingTask.destroy();
    } catch {
      // 解放できなくても実害は無い。
    }
  }
}

/** cheerio による代替抽出。Readability が本文を見つけられなかったときの受け皿。 */
function extractWithCheerio(html: string, maxChars: number): { text: string; title: string | null } {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  $(NOISE_SELECTOR).remove();
  const body = $('body');
  const raw = body.length > 0 ? body.text() : $.root().text();
  return { text: normalize(raw, maxChars), title: title === '' ? null : title };
}

/**
 * URL の本文を取り出す。
 *
 * @param maxChars 保存する最大文字数(runtime.maxContentChars)。超えた分は切り捨てる。
 * @returns 失敗しても例外は投げず `{ text: '', contentType: 'html', title: null }` を返す。
 */
export async function extractContent(
  url: string,
  http: HttpClient,
  maxChars: number,
): Promise<ExtractedContent> {
  try {
    const res = await http.get(url);
    const contentType = res.headers['content-type'] ?? '';
    const mime = mimeOf(contentType);

    // --- PDF ---------------------------------------------------------------
    if (mime === 'application/pdf' || mime.endsWith('/pdf') || looksLikePdfUrl(url)) {
      try {
        const text = await extractPdf(res.body, maxChars);
        if (text === '') {
          // 画像だけのスキャン PDF(OCR 無し)はここに来る。件名だけで扱う。
          logger.debug('PDF からテキストを抽出できませんでした', { url, bytes: res.body.byteLength });
        }
        return { text, contentType: 'pdf', title: null };
      } catch (e) {
        logger.warn('PDF の解析に失敗しました', { url, error: errorMessage(e) });
        return EMPTY;
      }
    }

    const html = res.text !== '' ? res.text : new TextDecoder('utf-8').decode(res.body);
    if (html.trim() === '') {
      logger.debug('本文が空でした', { url, status: res.status, contentType });
      return EMPTY;
    }

    // --- プレーンテキスト ---------------------------------------------------
    // HTML パーサを通す意味が無いのでそのまま整形する(contentType は 'text')。
    if (mime === 'text/plain') {
      return { text: normalize(html, maxChars), contentType: 'text', title: null };
    }

    // --- HTML --------------------------------------------------------------
    const extracted = extractHtml(html, res.finalUrl, maxChars);
    const type: ItemContentType = 'html';
    return { text: extracted.text, contentType: type, title: extracted.title };
  } catch (e) {
    // robots 不許可・404・タイムアウトなど。本文が無いだけで巡回は続ける。
    logger.warn('本文の取得に失敗しました', { url, error: errorMessage(e) });
    return EMPTY;
  }
}

/** HTML から本文とタイトルを取り出す。Readability → cheerio の順に試す。 */
function extractHtml(
  html: string,
  baseUrl: string,
  maxChars: number,
): { text: string; title: string | null } {
  let dom: JSDOM | null = null;
  try {
    // VirtualConsole はコンストラクタ時点で 'error' を握りつぶす実装になっており、
    // リスナ未登録の 'jsdomError' も EventEmitter の例外にはならない。
    // = 壊れた HTML / CSS のパースエラーでプロセスを落とさない。
    const virtualConsole = new VirtualConsole();
    // url を渡すのは Readability が相対 URL を絶対化するため。
    // runScripts / resources は **意図的に指定しない**(スクリプト実行も外部取得もしない)。
    dom = new JSDOM(html, { url: baseUrl, virtualConsole });

    const article = new Readability(dom.window.document).parse();
    const text = normalize(article?.textContent ?? '', maxChars);
    if (text.length >= MIN_READABLE_CHARS) {
      const title = (article?.title ?? '').trim();
      return { text, title: title === '' ? null : title };
    }
    // Readability が null / 実質空を返した(表組みだけの一覧ページなど)。
    logger.debug('Readability で本文を抽出できなかったため cheerio に切り替えます', { url: baseUrl });
  } catch (e) {
    logger.debug('jsdom / Readability の処理に失敗したため cheerio に切り替えます', {
      url: baseUrl,
      error: errorMessage(e),
    });
  } finally {
    // jsdom はタイマー等を抱えるので必ず閉じる(長時間動くジョブでのリーク防止)。
    try {
      dom?.window.close();
    } catch {
      // 閉じられなくても実害は無い。
    }
  }

  try {
    return extractWithCheerio(html, maxChars);
  } catch (e) {
    logger.warn('本文の抽出に失敗しました', { url: baseUrl, error: errorMessage(e) });
    return { text: '', title: null };
  }
}
