/**
 * ソース設定の不一致を、実ページを見て診断する(運用手順書 §8 の補助)。
 *
 * verify-sources は「OK / NG」を判定するが、NG をどう直せばよいかは示さない。
 * 官公庁サイトの HTML 構造は事前に知りようがなく、設定を書いた時点では
 * itemSelector が当たるかどうかを確かめられない。このコマンドは
 * 「実際にどこにリンクが集まっているか」をページから読み取って候補を出す。
 *
 * 何も書き換えない(読み取りのみ)。出力を見て config/sources/*.yaml を直す。
 */

import * as cheerio from 'cheerio';

import type { AppContext, SourceConfig } from '../types.js';
import { isHttpUrl, resolveUrl } from '../util/url.js';

/** これ未満のリンクしか含まない領域は一覧ページの本体ではないとみなす。 */
const MIN_LINKS = 3;
/** 1 ソースあたりに出す候補セレクタの数。多すぎると読めない。 */
const MAX_CANDIDATES = 6;
/** 候補ごとに出すリンクの実例数。実例が無いと妥当性を判断できない。 */
const MAX_SAMPLES = 3;
/** 走査する要素数の上限。巨大ページで時間を使い切らないため。 */
const MAX_ELEMENTS = 2000;
/** 実例テキストの最大長。 */
const SAMPLE_TEXT_MAX = 60;

/**
 * cheerio の選択オブジェクト型。domhandler の要素型は直接扱わない
 * (domhandler は cheerio の推移的依存で、pnpm の配置では直接 import できない)。
 * 生ノードを引き回さず、常に $(node) で包んでから渡す。
 */
type CheerioSelection = ReturnType<cheerio.CheerioAPI>;

export interface DiagnoseSample {
  text: string;
  href: string;
}

export interface DiagnoseCandidate {
  /** そのまま itemSelector に書ける形('#main a' のように ' a' を補って使う)。 */
  selector: string;
  /** include/exclude 適用後のリンク数。 */
  links: number;
  samples: DiagnoseSample[];
}

export interface DiagnoseRow {
  sourceId: string;
  name: string;
  type: string;
  url: string | null;
  enabled: boolean;
  region: string | null;
  status: number | null;
  finalUrl: string | null;
  error: string | null;
  contentType: string | null;
  /** 現在の設定とその結果。null は html ソースでない場合。 */
  currentSelector: string | null;
  currentLinks: number | null;
  candidates: DiagnoseCandidate[];
  /** ページが公開している RSS / Atom。ボット拒否サイトの正攻法の代替になる。 */
  feeds: string[];
}

/** CSS セレクタとして安全に書ける識別子か。数字始まりや記号入りは避ける。 */
function isSafeIdent(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
}

/**
 * 要素を指す短いセレクタを作る。id があれば id、無ければ tag.class。
 * 一意性は保証しない(候補として人が読んで選ぶためのもの)。
 */
function selectorFor($el: CheerioSelection): string | null {
  const id = $el.attr('id');
  if (id !== undefined && isSafeIdent(id)) return `#${id}`;

  const classes = ($el.attr('class') ?? '')
    .trim()
    .split(/\s+/)
    .filter((c: string) => c !== '' && isSafeIdent(c));
  if (classes.length === 0) return null;

  const tag = $el.prop('tagName');
  if (typeof tag !== 'string' || tag === '') return null;

  return `${tag.toLowerCase()}.${classes.slice(0, 2).join('.')}`;
}

function squash(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > SAMPLE_TEXT_MAX ? `${t.slice(0, SAMPLE_TEXT_MAX)}…` : t;
}

/**
 * source の include/exclude を適用して、採用されるリンクだけを返す。
 * 設定が無い html 以外のソースでは絞り込まない。
 */
function collectFromAnchors(
  $: cheerio.CheerioAPI,
  anchors: CheerioSelection,
  source: SourceConfig,
  baseUrl: string,
): DiagnoseSample[] {
  const include = source.html?.includeUrlPatterns ?? [];
  const exclude = source.html?.excludeUrlPatterns ?? [];
  const seen = new Set<string>();
  const out: DiagnoseSample[] = [];

  anchors.each((_i, node) => {
    const $a = $(node);
    const raw = $a.attr('href');
    if (raw === undefined || raw.trim() === '') return;

    // resolveUrl は例外を投げず、解決できなければ null を返す。
    const absolute = resolveUrl(raw.trim(), baseUrl);
    if (absolute === null || !isHttpUrl(absolute)) return;
    if (include.length > 0 && !include.some((p) => p !== '' && absolute.includes(p))) return;
    if (exclude.some((p) => p !== '' && absolute.includes(p))) return;
    if (seen.has(absolute)) return;

    seen.add(absolute);
    out.push({ text: squash($a.text()), href: absolute });
  });

  return out;
}

/** 領域の配下にあるリンクを集める。 */
function keepableHrefs(
  $: cheerio.CheerioAPI,
  scope: CheerioSelection,
  source: SourceConfig,
  baseUrl: string,
): DiagnoseSample[] {
  return collectFromAnchors($, scope.find('a[href]'), source, baseUrl);
}

/** ページが <link rel="alternate"> で公開しているフィードの URL。 */
function findFeeds($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const out = new Set<string>();
  $('link[rel="alternate"]').each((_i, node) => {
    const $link = $(node);
    const type = ($link.attr('type') ?? '').toLowerCase();
    const href = $link.attr('href');
    if (href === undefined || href.trim() === '') return;
    if (!type.includes('rss') && !type.includes('atom') && !type.includes('xml')) return;
    const absolute = resolveUrl(href.trim(), baseUrl);
    if (absolute !== null && isHttpUrl(absolute)) out.add(absolute);
  });
  return [...out];
}

/**
 * リンクが集まっている領域を上位から拾う。
 *
 * 同じリンク数の候補が入れ子になっている場合は、より深い(具体的な)方を残す。
 * 外側の #wrapper と内側の #news-list が同数なら、後者のほうが設定として安全なため。
 */
function discoverCandidates(
  $: cheerio.CheerioAPI,
  source: SourceConfig,
  baseUrl: string,
): DiagnoseCandidate[] {
  const best = new Map<string, { links: number; depth: number; samples: DiagnoseSample[] }>();
  let examined = 0;

  $('[id], [class]').each((_i, node) => {
    // 巨大ページで時間を使い切らないよう、走査数に上限を置く(false で打ち切り)。
    examined += 1;
    if (examined > MAX_ELEMENTS) return false;

    const $el = $(node);
    const selector = selectorFor($el);
    if (selector === null) return;

    const samples = keepableHrefs($, $el, source, baseUrl);
    if (samples.length < MIN_LINKS) return;

    const depth = $el.parents().length;
    const prev = best.get(selector);
    // 同じセレクタが複数回現れる場合はリンク数が多いほうを代表にする。
    if (prev === undefined || samples.length > prev.links) {
      best.set(selector, { links: samples.length, depth, samples });
    }
    return;
  });

  const rows = [...best.entries()].map(([selector, v]) => ({ selector, ...v }));

  // リンク数が同じ入れ子は深いほうだけ残す。
  const byLinks = new Map<number, { selector: string; depth: number }>();
  for (const r of rows) {
    const cur = byLinks.get(r.links);
    if (cur === undefined || r.depth > cur.depth)
      byLinks.set(r.links, { selector: r.selector, depth: r.depth });
  }
  const survivors = rows.filter((r) => byLinks.get(r.links)?.selector === r.selector);

  return survivors
    .sort((a, b) => b.links - a.links || b.depth - a.depth)
    .slice(0, MAX_CANDIDATES)
    .map((r) => ({
      selector: `${r.selector} a`,
      links: r.links,
      samples: r.samples.slice(0, MAX_SAMPLES),
    }));
}

/** 1 ソースを診断する。例外は投げず、error に入れて返す。 */
export async function diagnoseSource(ctx: AppContext, source: SourceConfig): Promise<DiagnoseRow> {
  const row: DiagnoseRow = {
    sourceId: source.id,
    name: source.name,
    type: source.type,
    url: source.url,
    enabled: source.enabled,
    region: source.region,
    status: null,
    finalUrl: null,
    error: null,
    contentType: null,
    currentSelector: source.html?.itemSelector ?? null,
    currentLinks: null,
    candidates: [],
    feeds: [],
  };

  if (source.url === null) {
    row.error = 'url が設定されていません(egov ソースなど)';
    return row;
  }

  let res;
  try {
    res = await ctx.http.get(source.url);
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
    return row;
  }

  row.status = res.status;
  row.finalUrl = res.finalUrl;
  row.contentType = res.headers['content-type'] ?? null;

  if (res.status < 200 || res.status >= 300) return row;

  const html = res.text;
  if (html.trim() === '') {
    row.error = '本文が空でした(HTML ではない可能性)';
    return row;
  }

  const analysis = analyzeListingHtml(html, source, res.finalUrl);
  row.feeds = analysis.feeds;
  row.currentLinks = analysis.currentLinks;
  row.candidates = analysis.candidates;
  return row;
}

/**
 * 取得済みの HTML を解析する。ネットワークに触れないので単体で検証できる。
 *
 * currentLinks は「いまの itemSelector で実際に何件取れるか」。
 * 0 件ならセレクタが当たっていない(到達はしているのに黙って何も拾わない状態)。
 */
export function analyzeListingHtml(
  html: string,
  source: SourceConfig,
  baseUrl: string,
): { currentLinks: number | null; candidates: DiagnoseCandidate[]; feeds: string[] } {
  const $ = cheerio.load(html);
  const feeds = findFeeds($, baseUrl);

  let currentLinks: number | null = null;
  if (source.html !== null) {
    try {
      const matched = $(source.html.itemSelector);
      // itemSelector は `#contents a` のように a 自身を指す場合と、
      // a を内包する要素を指す場合がある。どちらでも数えられるようにする。
      // 親をたどって数えると、セレクタに一致しない兄弟リンクまで含めてしまうので使わない。
      const selfLinks = collectFromAnchors($, matched.filter('a[href]'), source, baseUrl).length;
      const innerLinks = keepableHrefs($, matched, source, baseUrl).length;
      currentLinks = Math.max(selfLinks, innerLinks);
    } catch {
      // 不正なセレクタ。null のままにして「判定できなかった」と区別する。
      currentLinks = null;
    }
  }

  return { currentLinks, candidates: discoverCandidates($, source, baseUrl), feeds };
}
