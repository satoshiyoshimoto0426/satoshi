/**
 * HTML の新着一覧ページから候補リンクを取り出す(詳細設計書 §6.1 の「html」分岐)。
 *
 * 設計の前提(config/sources/*.yaml の実データより):
 *   - itemSelector は `#contents a` / `main a` のように「本文領域のリンク全部」と
 *     広めに書き、`includeUrlPatterns` でそのサイト配下に絞る運用になっている。
 *     したがってここは「大量のリンクが来る」前提で、除外と重複排除を丁寧に行う。
 *   - 官公庁サイトはリダイレクトが多い(http→https、www 有無、年度ディレクトリ)。
 *     相対 URL の base はリクエスト URL ではなく **リダイレクト後の finalUrl** を使う。
 *     さもないと旧ディレクトリ配下の存在しない URL を量産してしまう。
 *   - 日付欄はマークアップが千差万別。`dateSelector` が無ければ publishedAt は null にし、
 *     収集時刻(detectedAt)で代用する(詳細設計書 §4.2 のコメント「無ければ検知日時を使う」)。
 */

import * as cheerio from 'cheerio';

import type { FetchResult, HttpClient, SourceCandidate, SourceConfig, SourceState } from '../types.js';
import { ConfigError } from '../types.js';
import { createLogger } from '../util/logger.js';
import { isValidDateString, jstWallClockToUtc } from '../util/time.js';
import { isHttpUrl, resolveUrl } from '../util/url.js';

const logger = createLogger({ module: 'fetchers/html' });

/**
 * 日付セレクタを探して親をさかのぼる段数の上限。
 *
 * なぜ上限を設けるか: 上限なしに body までさかのぼると「ページ内のどこかにある
 * 無関係な日付」を掴んでしまう。リンクと日付が同じ行(li / tr / dl)に入っている
 * という一般的なマークアップを拾える範囲として 5 段に留める。
 */
const MAX_ANCESTOR_LEVELS = 5;

/**
 * 令和の基準年。令和元年(= 1 年)が 2019 年なので 令和 N 年 = 2018 + N。
 * 官公庁・自治体ページは「令和8年4月1日」「R8年4月1日」の和暦表記が今も主流。
 */
const REIWA_BASE_YEAR = 2018;

/** 和暦(令和)。`令和8年4月1日` / `R8年4月1日` / `令和元年4月1日`。 */
const WAREKI_RE = /(?:令和|[Rr])\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
/** 西暦の漢字表記。`2026年4月1日`。 */
const KANJI_RE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
/** 区切り文字表記。`2026/4/1` / `2026-04-01` / `2026.4.1`(自治体サイトに実在)。 */
const DELIMITED_RE = /(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const ymd = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  // 2026-02-30 のような実在しない日付を弾く(誤植・レイアウト崩れへの保険)。
  return isValidDateString(ymd) ? ymd : null;
}

/**
 * テキストから最初に見つかった日付を 'YYYY-MM-DD'(JST の暦日)で返す。
 * 和暦を先に見るのは「令和8年4月1日」の "8年4月1日" 部分が
 * 西暦パターンに誤マッチしないようにするため。
 */
function parseJapaneseDate(text: string): string | null {
  const wareki = WAREKI_RE.exec(text);
  if (wareki) {
    const era = wareki[1] === '元' ? 1 : Number(wareki[1]);
    return buildDate(REIWA_BASE_YEAR + era, Number(wareki[2]), Number(wareki[3]));
  }
  const kanji = KANJI_RE.exec(text);
  if (kanji) return buildDate(Number(kanji[1]), Number(kanji[2]), Number(kanji[3]));
  const delimited = DELIMITED_RE.exec(text);
  if (delimited) return buildDate(Number(delimited[1]), Number(delimited[2]), Number(delimited[3]));
  return null;
}

/**
 * 掲載日を ISO8601 UTC にする。
 * ページ上の日付は JST の暦日なので、その日の JST 00:00 を UTC に直して保存する
 * (絶対ルール6: 保存は ISO8601 UTC、JST は表示と日付境界の計算にのみ使う)。
 */
function toIsoFromJstDate(ymd: string): string | null {
  try {
    return jstWallClockToUtc(ymd, '00:00').toISOString();
  } catch {
    return null;
  }
}

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** URL の末尾パスをタイトルの代用にする。画像だけのリンクなど text が空のとき用。 */
function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter((s) => s !== '');
    const last = segments[segments.length - 1];
    if (!last) return u.hostname;
    try {
      return decodeURIComponent(last);
    } catch {
      // %xx が壊れている URL。そのまま使うほうが情報が残る。
      return last;
    }
  } catch {
    return url;
  }
}

/** バイナリ扱いで text が空になったときの保険。UTF-8 として読み直す。 */
function bodyAsText(res: { text: string; body: Uint8Array }): string {
  if (res.text !== '') return res.text;
  if (res.body.byteLength === 0) return '';
  return new TextDecoder('utf-8').decode(res.body);
}

/**
 * itemSelector で要素を列挙する。
 * 不正なセレクタは YAML の書き間違いなので、原因が分かる ConfigError にして落とす
 * (黙って 0 件にすると「巡回しているのに検知しない」最も気づきにくい故障になる)。
 */
function selectItems($: cheerio.CheerioAPI, selector: string, sourceId: string) {
  try {
    return $(selector).toArray();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`ソース ${sourceId} の itemSelector が不正です: ${selector}(${message})`);
  }
}

/**
 * HTML の一覧ページを取得して候補リンクを返す。
 *
 * 抽出の流れ(契約 §src/fetchers/html.ts):
 *   itemSelector で列挙 → a 要素を決める → href を絶対化 → http(s) 以外を除外
 *   → include / exclude で絞る → URL の重複排除 → タイトル → 日付
 */
export async function fetchHtml(
  source: SourceConfig,
  http: HttpClient,
  state: SourceState | null,
): Promise<FetchResult> {
  const url = source.url;
  const options = source.html;
  if (!url || !options) {
    // スキーマ上ここには来ない。来ても巡回全体を巻き込まないよう 0 件で返す。
    logger.warn('html ソースの url / html 設定がありません', { sourceId: source.id });
    return { candidates: [], notModified: false, etag: null, lastModified: null };
  }

  const res = await http.get(url, {
    etag: state?.etag ?? null,
    lastModified: state?.lastModified ?? null,
  });

  const etag = res.headers['etag'] ?? state?.etag ?? null;
  const lastModified = res.headers['last-modified'] ?? state?.lastModified ?? null;

  if (res.status === 304) {
    logger.debug('ページに変更がありません(304)', { sourceId: source.id, url });
    return { candidates: [], notModified: true, etag, lastModified };
  }

  const html = bodyAsText(res);
  if (html.trim() === '') {
    logger.warn('ページの本文が空でした', { sourceId: source.id, url, status: res.status });
    return { candidates: [], notModified: false, etag, lastModified };
  }

  const $ = cheerio.load(html);

  /**
   * 日付テキストを探す。要素自身 → 配下 → 親を最大 5 段さかのぼる、の順で
   * 最初に一致したテキストを返す。見つからなければ null。
   * ($ を捕まえた内部関数にして cheerio のジェネリック型を引き回さずに済ませている)
   */
  const findDateText = ($item: ReturnType<typeof $>, selector: string): string | null => {
    try {
      if ($item.is(selector)) {
        const own = normalizeSpace($item.text());
        if (own !== '') return own;
      }
      const inside = $item.find(selector).first();
      if (inside.length > 0) {
        const text = normalizeSpace(inside.text());
        if (text !== '') return text;
      }

      let $parent = $item.parent();
      for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
        if ($parent.length === 0 || $parent.is('body') || $parent.is('html')) break;
        const hit = $parent.find(selector).first();
        if (hit.length > 0) {
          const text = normalizeSpace(hit.text());
          if (text !== '') return text;
        }
        $parent = $parent.parent();
      }
    } catch (e) {
      // dateSelector が不正でも巡回は続ける(日付が無くても検知日時で代用できる)。
      logger.debug('dateSelector の評価に失敗しました', {
        selector,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return null;
  };

  const matched = selectItems($, options.itemSelector, source.id);
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();
  let skippedNoHref = 0;
  let skippedFiltered = 0;

  for (const element of matched) {
    const $item = $(element);
    // itemSelector が li / tr を指している場合に備え、a 以外なら配下の最初の a を使う。
    const $anchor = $item.is('a') ? $item : $item.find('a').first();
    if ($anchor.length === 0) {
      skippedNoHref += 1;
      continue;
    }

    const href = $anchor.attr(options.hrefFrom);
    if (!href || href.trim() === '') {
      skippedNoHref += 1;
      continue;
    }

    // base はリダイレクト後の URL。相対パスの解決先がずれるのを防ぐ。
    const absolute = resolveUrl(href.trim(), res.finalUrl);
    // `javascript:` や `mailto:` は resolveUrl を通ってしまうのでここで落とす。
    if (!absolute || !isHttpUrl(absolute)) {
      skippedFiltered += 1;
      continue;
    }

    if (options.includeUrlPatterns.length > 0) {
      const included = options.includeUrlPatterns.some((p) => p !== '' && absolute.includes(p));
      if (!included) {
        skippedFiltered += 1;
        continue;
      }
    }
    if (options.excludeUrlPatterns.some((p) => p !== '' && absolute.includes(p))) {
      skippedFiltered += 1;
      continue;
    }

    // 同じ URL が一覧内に複数回出る(画像リンクとテキストリンク)のはよくある。最初の 1 件だけ残す。
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    // タイトルはリンク要素から取る。itemSelector が li / tr を指していても、
    // 行全体のテキスト(日付や区分ラベルを含む)ではなくリンク文字列を使う。
    const linkText =
      options.titleFrom === 'text'
        ? normalizeSpace($anchor.text())
        : normalizeSpace($anchor.attr(options.titleFrom) ?? '');
    // trim して空なら URL の最後のパスセグメントを使う(契約)。画像だけのリンク対策。
    const title = linkText === '' ? titleFromUrl(absolute) : linkText;

    let publishedAt: string | null = null;
    if (options.dateSelector) {
      const dateText = findDateText($item, options.dateSelector);
      if (dateText !== null) {
        const ymd = parseJapaneseDate(dateText);
        if (ymd) publishedAt = toIsoFromJstDate(ymd);
      }
    }

    candidates.push({ url: absolute, title, publishedAt });
  }

  logger.debug('一覧ページを解析しました', {
    sourceId: source.id,
    url,
    matched: matched.length,
    candidates: candidates.length,
    skippedNoHref,
    skippedFiltered,
  });
  if (candidates.length === 0) {
    // 「到達はするがセレクタが合っていない」= 静かな故障。必ず警告として残す(詳細設計書 §14)。
    logger.warn('一覧ページから候補を 1 件も取得できませんでした', {
      sourceId: source.id,
      url,
      itemSelector: options.itemSelector,
      matched: matched.length,
    });
  }

  return { candidates, notModified: false, etag, lastModified };
}
