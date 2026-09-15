/**
 * e-Gov 法令 API から「改正のあった法令」の候補を取り出す(詳細設計書 §6.1 の「egov」分岐)。
 *
 * なぜ構造に依存しない実装にするのか:
 *   e-Gov 法令 API は v1(XML)→ v2(JSON)でレスポンス形が大きく変わっており、
 *   v2 の中でもエンドポイントごとに `law_info` / `revision_info` のような入れ子が違う。
 *   ここで特定の形に決め打ちすると、API が変わった日から「毎朝 0 件」で静かに壊れる。
 *   そこで「法令 ID らしきキー」「法令名らしきキー」「日付らしきキー」を
 *   再帰的に拾い集め、1 件も取れなければ理由をログに残して空配列を返す方針にする
 *   (契約: 例外は投げない。1 ソースの不調で他のソースを巻き込まない)。
 *
 * レコードの切り出し方:
 *   「ID と 名前 の両方を部分木に含み、かつ子オブジェクト単独ではその条件を満たさない」
 *   オブジェクトを 1 レコードとみなす。これにより
 *     { law_info: { law_id }, revision_info: { law_title } }
 *   のように ID と名前が兄弟の入れ子に分かれていても 1 件として拾える。
 */

import { XMLParser } from 'fast-xml-parser';

import type { Clock, FetchResult, HttpClient, SourceCandidate, SourceConfig, SourceState } from '../types.js';
import { createLogger } from '../util/logger.js';
import { isValidDateString, jstWallClockToUtc } from '../util/time.js';

const logger = createLogger({ module: 'fetchers/egov' });

/** 法令本文ページの URL 接頭辞(契約)。 */
const LAW_URL_PREFIX = 'https://laws.e-gov.go.jp/law/';

/** JSON も XML も受け付ける。API のバージョンで Content-Type が変わるため。 */
const EGOV_ACCEPT = 'application/json,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.7';

/**
 * 再帰の深さ上限。想定外に深い / 循環した構造でスタックを食い潰さないための保険(契約)。
 */
const MAX_DEPTH = 12;

/** 1 回の巡回で組み立てる候補の上限。API が巨大な一覧を返したときの暴走防止。 */
const MAX_RECORDS = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** キー名を比較用に正規化する。`law_id` / `lawId` / `LawId` / `LawID` が同じ 'lawid' になる。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 法令 ID らしきキー。 */
const LAW_ID_KEYS = new Set(['lawid']);
/** 法令番号らしきキー(ID が無いときのタイトル代用にも使う)。 */
const LAW_NUM_KEYS = new Set(['lawnum', 'lawno', 'lawnumber']);
/** 法令名らしきキー。 */
const LAW_NAME_KEYS = new Set(['lawname', 'lawtitle', 'lawfullname']);
/** 名前の代用になり得る一般的なキー。ID を伴う場合のみタイトルに使う。 */
const WEAK_NAME_KEYS = new Set(['title', 'name']);
/** 日付らしきキー。配列の順がそのまま優先順位(契約の並びに合わせる)。 */
const DATE_KEYS = ['promulgationdate', 'amendmentdate', 'updated', 'date'];

interface Fields {
  lawId: string | null;
  lawNum: string | null;
  name: string | null;
  weakName: string | null;
  date: string | null;
  /** 日付キーの優先順位。小さいほど優先(DATE_KEYS の添字、緩い一致は最下位)。 */
  dateRank: number;
}

const EMPTY_FIELDS: Fields = {
  lawId: null,
  lawNum: null,
  name: null,
  weakName: null,
  date: null,
  dateRank: Number.MAX_SAFE_INTEGER,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** スカラー値を文字列にする。数値の law_id / 日付(20260401)も扱えるようにするため。 */
function scalarToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return null;
  // fast-xml-parser は属性付き要素を { '#text': ... } にする。
  const rec = asRecord(value);
  if (rec && '#text' in rec) return scalarToString(rec['#text']);
  return null;
}

/** 日付キーの優先順位。見つからなければ null。 */
function dateRankOf(normalized: string): number | null {
  const index = DATE_KEYS.indexOf(normalized);
  if (index >= 0) return index;
  // `amendment_promulgate_date` や `enforcement_date` のような未知の日付キーも
  // 取りこぼさないが、既知のキーより優先順位は低くしておく。
  if (normalized.includes('date')) return DATE_KEYS.length;
  return null;
}

/** 左を優先して 2 つの Fields を合成する。 */
function mergeFields(primary: Fields, secondary: Fields): Fields {
  const useSecondaryDate =
    primary.date === null || (secondary.date !== null && secondary.dateRank < primary.dateRank);
  return {
    lawId: primary.lawId ?? secondary.lawId,
    lawNum: primary.lawNum ?? secondary.lawNum,
    name: primary.name ?? secondary.name,
    weakName: primary.weakName ?? secondary.weakName,
    date: useSecondaryDate ? secondary.date : primary.date,
    dateRank: useSecondaryDate ? secondary.dateRank : primary.dateRank,
  };
}

/** そのオブジェクトが自分自身のスカラー値として持っているフィールド。 */
function ownFields(record: Record<string, unknown>): Fields {
  let fields: Fields = { ...EMPTY_FIELDS };
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeKey(key);
    const text = scalarToString(value);
    if (text === null) continue;

    if (fields.lawId === null && LAW_ID_KEYS.has(normalized)) fields.lawId = text;
    else if (fields.lawNum === null && LAW_NUM_KEYS.has(normalized)) fields.lawNum = text;
    else if (fields.name === null && LAW_NAME_KEYS.has(normalized)) fields.name = text;
    else if (fields.weakName === null && WEAK_NAME_KEYS.has(normalized)) fields.weakName = text;

    const rank = dateRankOf(normalized);
    if (rank !== null && rank < fields.dateRank) {
      fields = { ...fields, date: text, dateRank: rank };
    }
  }
  return fields;
}

/** 子(オブジェクト・配列)を列挙する。 */
function childrenOf(node: unknown): unknown[] {
  if (Array.isArray(node)) return node;
  const record = asRecord(node);
  if (!record) return [];
  return Object.values(record).filter((v) => v !== null && typeof v === 'object');
}

/**
 * 部分木に含まれるフィールドを集める。浅い階層の値を優先する。
 * 同じオブジェクトを何度も辿るのでメモ化する(レコード判定で兄弟も評価するため)。
 */
function subtreeFields(
  node: unknown,
  depth: number,
  memo: Map<object, Fields>,
  visiting: Set<object>,
): Fields {
  if (depth > MAX_DEPTH) return EMPTY_FIELDS;
  if (node === null || typeof node !== 'object') return EMPTY_FIELDS;

  const obj = node as object;
  const cached = memo.get(obj);
  if (cached) return cached;
  // 循環参照(将来 JSON 以外の入力が来たとき)で無限ループしないための保険。
  if (visiting.has(obj)) return EMPTY_FIELDS;
  visiting.add(obj);

  let fields = Array.isArray(node) ? { ...EMPTY_FIELDS } : ownFields(node as Record<string, unknown>);
  for (const child of childrenOf(node)) {
    fields = mergeFields(fields, subtreeFields(child, depth + 1, memo, visiting));
  }

  visiting.delete(obj);
  memo.set(obj, fields);
  return fields;
}

type RecordPredicate = (f: Fields) => boolean;

/**
 * 条件を満たす「最も深い」オブジェクトをレコードとして集める。
 * 子オブジェクト単独で条件を満たすなら、そちらを掘り下げる。
 */
function findRecords(
  node: unknown,
  matches: RecordPredicate,
  depth: number,
  memo: Map<object, Fields>,
  out: Fields[],
): void {
  if (out.length >= MAX_RECORDS) return;
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const child of node) findRecords(child, matches, depth + 1, memo, out);
    return;
  }

  const visiting = new Set<object>();
  const children = childrenOf(node);
  const childMatches = children.some((c) => matches(subtreeFields(c, depth + 1, memo, visiting)));

  if (!childMatches && matches(subtreeFields(node, depth, memo, visiting))) {
    out.push(subtreeFields(node, depth, memo, visiting));
    return;
  }
  for (const child of children) findRecords(child, matches, depth + 1, memo, out);
}

/**
 * 日付文字列を ISO8601 UTC にする。
 * `2026-04-01` / `2026/4/1` / `20260401` は JST の暦日として 00:00 に寄せ、
 * タイムゾーン付きの完全な日時はそのまま解釈する(絶対ルール6)。
 */
function toIsoDate(raw: string): string | null {
  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  const parts = ymd ?? compact;
  if (parts) {
    const date = `${parts[1]}-${String(parts[2]).padStart(2, '0')}-${String(parts[3]).padStart(2, '0')}`;
    if (!isValidDateString(date)) return null;
    return jstWallClockToUtc(date, '00:00').toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** バイナリ扱いで text が空になったときの保険。UTF-8 として読み直す。 */
function bodyAsText(res: { text: string; body: Uint8Array }): string {
  if (res.text !== '') return res.text;
  if (res.body.byteLength === 0) return '';
  return new TextDecoder('utf-8').decode(res.body);
}

/**
 * JSON として読めればそれを、読めなければ XML として読む。どちらも失敗したら null。
 */
function parsePayload(raw: string, sourceId: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // JSON でないなら XML。v1 API や将来の形式変更に備える。
  }
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
    return parser.parse(trimmed);
  } catch (e) {
    logger.warn('e-Gov のレスポンスを JSON としても XML としても解析できませんでした', {
      sourceId,
      error: e instanceof Error ? e.message : String(e),
      head: trimmed.slice(0, 200),
    });
    return null;
  }
}

/**
 * e-Gov 法令 API を叩いて候補を返す。
 *
 * - `lookbackDays` より古い日付のものは除外する。
 * - **日付が取れないものは残す**(取りこぼし防止。契約)。
 * - 1 件も取れなくても例外は投げず、理由をログに残して空配列を返す。
 */
export async function fetchEgov(
  source: SourceConfig,
  http: HttpClient,
  state: SourceState | null,
  clock: Clock,
): Promise<FetchResult> {
  const egov = source.egov;
  if (!egov) {
    // スキーマ上ここには来ない。来ても巡回全体を巻き込まないよう 0 件で返す。
    logger.warn('egov ソースに egov 設定がありません', { sourceId: source.id });
    return { candidates: [], notModified: false, etag: null, lastModified: null };
  }

  const res = await http.get(egov.endpoint, {
    etag: state?.etag ?? null,
    lastModified: state?.lastModified ?? null,
    accept: EGOV_ACCEPT,
  });

  const etag = res.headers['etag'] ?? state?.etag ?? null;
  const lastModified = res.headers['last-modified'] ?? state?.lastModified ?? null;

  if (res.status === 304) {
    logger.debug('e-Gov の応答に変更がありません(304)', { sourceId: source.id });
    return { candidates: [], notModified: true, etag, lastModified };
  }

  const payload = parsePayload(bodyAsText(res), source.id);
  if (payload === null || typeof payload !== 'object') {
    logger.warn('e-Gov のレスポンスが空、または想定外の型でした', {
      sourceId: source.id,
      endpoint: egov.endpoint,
    });
    return { candidates: [], notModified: false, etag, lastModified };
  }

  // 段階的に条件を緩めて拾う。API の形が変わっても「まず ID + 名前」で正しく切り出し、
  // 駄目なら名前だけ、最後に ID だけ、と諦めを遅らせる。
  const passes: { label: string; matches: RecordPredicate }[] = [
    { label: 'id+name', matches: (f) => f.lawId !== null && (f.name ?? f.weakName) !== null },
    { label: 'name', matches: (f) => f.name !== null },
    { label: 'id', matches: (f) => f.lawId !== null },
  ];

  let records: Fields[] = [];
  let usedPass = 'none';
  for (const pass of passes) {
    const out: Fields[] = [];
    findRecords(payload, pass.matches, 0, new Map<object, Fields>(), out);
    if (out.length > 0) {
      records = out;
      usedPass = pass.label;
      break;
    }
  }

  if (records.length === 0) {
    logger.warn('e-Gov のレスポンスから法令情報を 1 件も抽出できませんでした', {
      sourceId: source.id,
      endpoint: egov.endpoint,
      // API 形状の変化を追えるよう、トップレベルの項目名だけ残す(本文は出さない)。
      // フィールド名に 'key' を含めるとロガーに伏せられてしまうため rootFields としている。
      rootFields: Object.keys(payload as Record<string, unknown>).slice(0, 20),
    });
    return { candidates: [], notModified: false, etag, lastModified };
  }

  const cutoffMs = clock.now().getTime() - egov.lookbackDays * MS_PER_DAY;
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();
  let tooOld = 0;
  let undated = 0;

  for (const record of records) {
    const publishedAt = record.date === null ? null : toIsoDate(record.date);
    if (publishedAt !== null && new Date(publishedAt).getTime() < cutoffMs) {
      tooOld += 1;
      continue;
    }
    if (publishedAt === null) undated += 1;

    // lawId が取れないときは endpoint 自体を出典にする(URL を捏造しない)。
    const url = record.lawId ? `${LAW_URL_PREFIX}${encodeURIComponent(record.lawId)}` : egov.endpoint;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = record.name ?? record.weakName ?? record.lawNum ?? record.lawId ?? '法令改正情報';
    candidates.push({ url, title, publishedAt });
  }

  logger.debug('e-Gov のレスポンスを解析しました', {
    sourceId: source.id,
    pass: usedPass,
    records: records.length,
    candidates: candidates.length,
    tooOld,
    undated,
  });

  return { candidates, notModified: false, etag, lastModified };
}
