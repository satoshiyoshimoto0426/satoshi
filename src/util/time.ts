/**
 * JST(日本標準時)と UTC の変換。
 *
 * 方針(NFR-08): 保存は常に ISO8601 UTC 文字列、JST は「表示」と「日付境界の計算」にだけ使う。
 *
 * なぜ Intl / toLocaleString を使わないか:
 *   - 実行環境の TZ 設定や ICU データの有無に結果が左右されるため。Cloud Run と
 *     開発機と CI で挙動が変わるのは配信日付のズレという致命的な事故に直結する。
 *   - JST は夏時間を持たない固定オフセット (+09:00) なので、UTC ミリ秒に
 *     9 時間を足し引きするだけで厳密に計算できる。
 * したがって本ファイルは「UTC ミリ秒 + JST_OFFSET_MS」を UTC 系のゲッタ
 * (getUTCFullYear など)で読む、という手計算だけで構成する。
 */

/** JST は UTC+9 の固定オフセット(夏時間なし)。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 曜日の表記。getUTCDay() の 0=日曜 に対応する順序で並べる。 */
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 'HH:MM'。1 桁時('7:30')も受け付ける。設定ミスで全滅させないための緩和。 */
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** JST の壁時計として読むための「9 時間進めた Date」。UTC 系ゲッタで読むこと。 */
function shiftToJst(d: Date): Date {
  return new Date(d.getTime() + JST_OFFSET_MS);
}

function assertValidDate(d: Date, label: string, raw: string): void {
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`${label}: 不正な日時です: ${raw}`);
  }
}

/** ISO8601 UTC 文字列(例: '2026-09-12T00:00:00.000Z')。 */
export function isoOf(d: Date): string {
  assertValidDate(d, 'isoOf', String(d));
  return d.toISOString();
}

/** その瞬間が JST で何月何日かを 'YYYY-MM-DD' で返す。 */
export function toJstDateString(d: Date): string {
  assertValidDate(d, 'toJstDateString', String(d));
  const j = shiftToJst(d);
  return `${String(j.getUTCFullYear()).padStart(4, '0')}-${pad2(j.getUTCMonth() + 1)}-${pad2(j.getUTCDate())}`;
}

/** その瞬間の JST 時刻を 'HH:MM' で返す。 */
export function toJstTimeString(d: Date): string {
  assertValidDate(d, 'toJstTimeString', String(d));
  const j = shiftToJst(d);
  return `${pad2(j.getUTCHours())}:${pad2(j.getUTCMinutes())}`;
}

/**
 * JST の壁時計(日付 + HH:MM)を UTC の瞬間に変換する。
 * 例: ('2026-09-12', '07:00') → 2026-09-11T22:00:00.000Z
 */
export function jstWallClockToUtc(dateJst: string, hhmm: string): Date {
  const dm = DATE_RE.exec(dateJst);
  if (!dm) {
    throw new TypeError(`jstWallClockToUtc: 日付は 'YYYY-MM-DD' 形式で指定してください: ${dateJst}`);
  }
  const tm = TIME_RE.exec(hhmm);
  if (!tm) {
    throw new TypeError(`jstWallClockToUtc: 時刻は 'HH:MM' 形式で指定してください: ${hhmm}`);
  }
  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new TypeError(`jstWallClockToUtc: 実在しない日時です: ${dateJst} ${hhmm}`);
  }
  // Date.UTC で「JST の壁時計をそのまま UTC として組んだ値」を作り、9 時間戻して真の UTC にする。
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0) - JST_OFFSET_MS);
}

/**
 * ダイジェストの対象ウィンドウ(直近 24 時間)を返す。
 * 詳細設計書 §6.2: detectedAt が [前日 cutoff, 当日 cutoff) のアイテムが対象。
 */
export function digestWindow(dateJst: string, cutoffHhmm: string): { from: string; to: string } {
  const to = jstWallClockToUtc(dateJst, cutoffHhmm);
  const from = new Date(to.getTime() - MS_PER_DAY);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * LINE 本文の見出し用の日付表記。例: '9/12(土)'。
 * 月日はゼロ埋めしない(日本語の掲示としてはこちらが自然)。
 */
export function formatJstHeaderDate(dateJst: string): string {
  const m = DATE_RE.exec(dateJst);
  if (!m) {
    throw new TypeError(`formatJstHeaderDate: 日付は 'YYYY-MM-DD' 形式で指定してください: ${dateJst}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // 曜日は「その暦日」の曜日。UTC で組めば実行環境の TZ に依存しない。
  const weekday = WEEKDAY_JA[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '';
  return `${month}/${day}(${weekday})`;
}

/** ISO8601 文字列に日数を加算して ISO8601 文字列で返す。負数で減算。 */
export function addDays(iso: string, days: number): string {
  const base = new Date(iso);
  assertValidDate(base, 'addDays', iso);
  // UTC のミリ秒で加算する。JST は固定オフセットなので日付境界のズレは起きない。
  return new Date(base.getTime() + days * MS_PER_DAY).toISOString();
}

/** 'YYYY-MM-DD' 形式であり、かつ実在する日付か(2026-02-30 は false)。 */
export function isValidDateString(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC は 2026-02-30 を 3/2 に繰り上げる。組み直した値が一致するかで実在性を判定する。
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
