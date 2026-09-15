/**
 * RSS フィードから候補リンクを取り出す(詳細設計書 §6.1 の「rss」分岐)。
 *
 * なぜ 3 形式を 1 本で扱うか:
 *   日本の官公庁は形式がばらばらで、厚労省の新着は RDF(RSS 1.0, `news.rdf`)、
 *   経産省など一部は RSS 2.0、比較的新しいサイトは Atom 1.0 を出す。
 *   ソース YAML の `type: rss` は「フィードである」以上の情報を持たないので、
 *   取得してから中身を見て形式を判定する。判定に失敗しても落とさず 0 件を返し、
 *   verify-sources / source_state 側で「候補 0 件」として気づけるようにする。
 *
 * fast-xml-parser の注意点(このファイルの設計がここに依存している):
 *   - 同名要素が 1 つしか無いとき、配列ではなく単体の値になる。
 *     そのため要素の取り出しは必ず `toArray()` を通す。
 *   - 属性は `ignoreAttributes: false` + `attributeNamePrefix: '@_'` で
 *     `@_href` のようなキーになる(Atom の link は属性側にある)。
 *   - 名前空間の接頭辞は保持される。RDF のルートは `rdf:RDF`、日付は `dc:date`。
 *   - テキストと属性が同居する要素は `{'#text': ..., '@_...': ...}` になるため、
 *     テキスト取得は必ず `textOf()` を通す。
 */

import { XMLParser } from 'fast-xml-parser';

import type { FetchResult, HttpClient, SourceCandidate, SourceConfig, SourceState } from '../types.js';
import { createLogger } from '../util/logger.js';
import { jstWallClockToUtc } from '../util/time.js';
import { isHttpUrl, resolveUrl } from '../util/url.js';

const logger = createLogger({ module: 'fetchers/rss' });

/** フィードであることを相手に伝える Accept。XML を返してくれない CDN 対策。 */
const FEED_ACCEPT =
  'application/rss+xml,application/atom+xml,application/rdf+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8';

/**
 * 契約で指定された 3 オプションで固定する。
 * `parseTagValue`(既定 true)により数字だけのテキストは number になり得るので、
 * 取り出し側(`textOf`)で必ず文字列化する。
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

/**
 * fast-xml-parser が解かない HTML 実体参照を解く。
 *
 * なぜ必要か: fast-xml-parser は XML の実体参照(&amp; &lt; など)は解くが、
 * `&nbsp;` や `&hellip;` のような HTML 実体参照は解かない。また官公庁の
 * フィードには `&amp;#039;` のような二重エスケープが実在する。
 * ここは「もう 1 回だけ」解くことで二重エスケープも吸収する。
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '・',
  laquo: '«',
  raquo: '»',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  yen: '¥',
};

function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (matched, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // 不正なコードポイントは元の文字列を残す(壊すより残したほうが読める)。
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return matched;
      try {
        return String.fromCodePoint(code);
      } catch {
        return matched;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? matched;
  });
}

/** 連続する空白・改行を 1 つに畳む。フィードのタイトルは改行入りのことがある。 */
function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 単一要素が配列にならない fast-xml-parser 対策。
 * 「item が 1 件のフィードだけ取りこぼす」という気づきにくい故障を防ぐ。
 */
function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** 配列化したうえでオブジェクトのものだけ残す。 */
function toRecords(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const v of toArray(value)) {
    const rec = asRecord(v);
    if (rec) out.push(rec);
  }
  return out;
}

/** 要素のテキストを取り出す。`{'#text': ...}` 形・数値・配列のいずれでも読める。 */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return normalizeSpace(decodeEntities(value));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = textOf(v);
      if (t !== '') return t;
    }
    return '';
  }
  const rec = asRecord(value);
  return rec ? textOf(rec['#text']) : '';
}

function attrOf(value: unknown, name: string): string {
  const rec = asRecord(value);
  return rec ? textOf(rec[name]) : '';
}

/**
 * フィードの実体(item / entry)を取り出す。
 *   RSS 2.0 : rss.channel.item
 *   Atom 1.0: feed.entry
 *   RDF(RSS 1.0): rdf:RDF.item(item は channel の外に並ぶのが RSS 1.0 の形)
 */
function selectEntries(root: Record<string, unknown>): {
  format: string;
  entries: Record<string, unknown>[];
} {
  const rss = asRecord(root['rss']);
  if (rss) {
    const entries: Record<string, unknown>[] = [];
    for (const channel of toRecords(rss['channel'])) {
      entries.push(...toRecords(channel['item']));
    }
    // channel を省いた壊れかけの RSS も拾っておく(取りこぼしより多少のノイズを選ぶ)。
    entries.push(...toRecords(rss['item']));
    if (entries.length > 0) return { format: 'rss2', entries };
  }

  const feed = asRecord(root['feed']);
  if (feed) {
    const entries = toRecords(feed['entry']);
    if (entries.length > 0) return { format: 'atom', entries };
  }

  // RDF は名前空間接頭辞付きのキーになる。接頭辞無しで書かれている例も拾う。
  const rdf = asRecord(root['rdf:RDF']) ?? asRecord(root['RDF']);
  if (rdf) {
    const entries = toRecords(rdf['item']);
    // 念のため channel 配下も見る(RSS 1.0 の items は参照リストだが、実体を入れる実装がある)。
    for (const channel of toRecords(rdf['channel'])) {
      entries.push(...toRecords(channel['item']));
    }
    if (entries.length > 0) return { format: 'rdf', entries };
  }

  // ここまでで見つからない = 想定外の形。深さを限って item / entry を探す最後の保険。
  const found = deepFindEntries(root, 0);
  if (found.length > 0) return { format: 'unknown', entries: found };

  return { format: 'unknown', entries: [] };
}

/** 想定外の形のフィード用。深さ 6 までで最初に見つかった item / entry 群を返す。 */
function deepFindEntries(node: unknown, depth: number): Record<string, unknown>[] {
  if (depth > 6) return [];
  const rec = asRecord(node);
  if (!rec) return [];
  for (const [key, value] of Object.entries(rec)) {
    // 名前空間接頭辞を落として比較する(例: 'ns:item')。
    const local = (key.includes(':') ? (key.split(':').pop() ?? key) : key).toLowerCase();
    if (local === 'item' || local === 'entry') {
      const entries = toRecords(value);
      if (entries.length > 0) return entries;
    }
  }
  for (const value of Object.values(rec)) {
    for (const child of toArray(value)) {
      const found = deepFindEntries(child, depth + 1);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/**
 * 1 件分のリンクを取り出す。形式ごとに置き場所が違うので順に探す。
 *   1. Atom: link 要素の `@_href`(rel=alternate を優先、無ければ最初の href)
 *   2. RSS2 / RDF: link 要素のテキスト
 *   3. RDF: item の `rdf:about` 属性(link が無い実装がある)
 *   4. guid / id が URL ならそれを使う
 */
/**
 * キー名を大文字小文字と名前空間接頭辞を無視して引く。
 *
 * 「RSS」と名乗りながら独自スキーマを返す配信元が実在する。
 * 例: WAM NET の都道府県フィードは <RSS_LIST><ITEM><URL>… と全て大文字。
 * 小文字決め打ちで探すと 1 件も取れず、しかも HTTP は 200 なので
 * 「巡回成功・中身は永久に 0 件」という静かな故障になる。
 */
function pickField(item: Record<string, unknown>, names: string[]): unknown {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(item)) {
    const local = key.includes(':') ? (key.split(':').pop() ?? key) : key;
    if (wanted.has(local.toLowerCase())) return value;
  }
  return undefined;
}

function extractLink(item: Record<string, unknown>): string {
  const links = toArray(item['link']);

  // 1. Atom。rel が無い link は仕様上 alternate 扱いなので同じ優先度で拾う。
  let firstHref = '';
  for (const link of links) {
    const href = attrOf(link, '@_href');
    if (href === '') continue;
    const rel = attrOf(link, '@_rel');
    if (rel === '' || rel.toLowerCase() === 'alternate') return href;
    if (firstHref === '') firstHref = href;
  }
  if (firstHref !== '') return firstHref;

  // 2. RSS2 / RDF
  for (const link of links) {
    const text = textOf(link);
    if (text !== '') return text;
  }

  // 3. 独自スキーマ。<URL> や <Link> のように綴りが違うものを拾う。
  const alt = pickField(item, ['link', 'url', 'guid']);
  if (alt !== undefined) {
    const text = textOf(alt);
    if (text !== '') return text;
  }

  // 4. RDF の rdf:about
  const about = textOf(item['@_rdf:about']) || textOf(item['@_about']);
  if (about !== '') return about;

  // 4. guid(isPermaLink=false なら URL ではない)/ Atom の id
  const guid = item['guid'];
  const guidRec = asRecord(guid);
  const isPermaLink = guidRec ? textOf(guidRec['@_isPermaLink']) : '';
  if (isPermaLink.toLowerCase() !== 'false') {
    const guidText = textOf(guid);
    if (isHttpUrl(guidText)) return guidText;
  }
  const id = textOf(item['id']);
  if (isHttpUrl(id)) return id;

  return '';
}

/** 日付の候補キー。左が優先。RDF は dc:date、Atom は published / updated を使う。 */
const DATE_KEYS = ['pubDate', 'dc:date', 'published', 'updated', 'date', 'issued', 'modified'] as const;

/**
 * タイムゾーンを持たない日時表記。例: '2026-09-15 12:00' / '2026-09-15'。
 * 国内の配信元がこの形で書いた場合、意図している時刻は日本時間である。
 */
const WALL_CLOCK_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/;

/**
 * 日付を ISO8601 UTC で返す。解釈できなければ null(検知時刻で代用する)。
 *
 * タイムゾーンの無い表記を Date に直接渡してはいけない。実行環境の時間帯で
 * 解釈されるため、UTC で動く Cloud Run では 9 時間ずれる。日付境界をまたぐと
 * 「前日の記事」として扱われ、当日のダイジェストから漏れる。
 */
function extractPublishedAt(item: Record<string, unknown>): string | null {
  for (const key of DATE_KEYS) {
    // 綴りが違う配信元(<DATE> など)も拾う。
    const raw = textOf(item[key]) || textOf(pickField(item, [key]));
    if (raw === '') continue;

    const wall = WALL_CLOCK_RE.exec(raw.trim());
    if (wall) {
      try {
        return jstWallClockToUtc(wall[1] ?? '', wall[2] ?? '00:00').toISOString();
      } catch {
        // 形式が合わなければ通常の解釈に委ねる。
      }
    }

    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    logger.debug('フィードの日付を解釈できませんでした', { key, raw });
  }
  return null;
}

/** URL の末尾パスをタイトルの代用にする。タイトル空欄のフィード対策。 */
function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter((s) => s !== '');
    const last = segments[segments.length - 1];
    if (!last) return u.hostname;
    try {
      return decodeURIComponent(last);
    } catch {
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
 * RSS / Atom / RDF フィードを取得して候補リンクを返す。
 *
 * 条件付き GET で 304 が返った場合は `notModified: true` で即座に戻る
 * (相手サーバへの負荷を減らすのが目的。NFR-07)。
 */
export async function fetchRss(
  source: SourceConfig,
  http: HttpClient,
  state: SourceState | null,
): Promise<FetchResult> {
  const url = source.url;
  if (!url) {
    // スキーマ上ここには来ないが、来たときに巡回全体を巻き込まないよう 0 件で返す。
    logger.warn('rss ソースに url が設定されていません', { sourceId: source.id });
    return { candidates: [], notModified: false, etag: null, lastModified: null };
  }

  const res = await http.get(url, {
    etag: state?.etag ?? null,
    lastModified: state?.lastModified ?? null,
    accept: FEED_ACCEPT,
  });

  const etag = res.headers['etag'] ?? state?.etag ?? null;
  const lastModified = res.headers['last-modified'] ?? state?.lastModified ?? null;

  if (res.status === 304) {
    logger.debug('フィードに変更がありません(304)', { sourceId: source.id, url });
    return { candidates: [], notModified: true, etag, lastModified };
  }

  const xml = bodyAsText(res);
  if (xml.trim() === '') {
    logger.warn('フィードの本文が空でした', { sourceId: source.id, url, status: res.status });
    return { candidates: [], notModified: false, etag, lastModified };
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (e) {
    // XML が壊れていても巡回全体は止めない。ソース単位の失敗として扱えるよう投げ直す。
    const message = e instanceof Error ? e.message : String(e);
    logger.warn('フィードの XML を解析できませんでした', { sourceId: source.id, url, error: message });
    return { candidates: [], notModified: false, etag, lastModified };
  }

  const root = asRecord(parsed);
  if (!root) {
    logger.warn('フィードの構造が想定外です', { sourceId: source.id, url });
    return { candidates: [], notModified: false, etag, lastModified };
  }

  const { format, entries } = selectEntries(root);
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const rawLink = extractLink(entry);
    if (rawLink === '') continue;

    // 相対 URL で書かれたフィードが実在するのでリダイレクト後の URL を base に絶対化する。
    const absolute = resolveUrl(rawLink, res.finalUrl);
    if (!absolute || !isHttpUrl(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    const title = textOf(entry['title']) || textOf(pickField(entry, ['title'])) || titleFromUrl(absolute);
    candidates.push({ url: absolute, title, publishedAt: extractPublishedAt(entry) });
  }

  logger.debug('フィードを解析しました', {
    sourceId: source.id,
    url,
    format,
    entries: entries.length,
    candidates: candidates.length,
  });
  if (candidates.length === 0) {
    // 「到達はするが 0 件」は静かな故障。必ず警告として残す(詳細設計書 §14)。
    logger.warn('フィードから候補を 1 件も取得できませんでした', { sourceId: source.id, url, format });
  }

  return { candidates, notModified: false, etag, lastModified };
}
