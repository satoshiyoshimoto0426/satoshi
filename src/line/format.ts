/**
 * LINE 配信本文の整形(詳細設計書 §9 / §9.1、要件定義書 FR-06 / FR-07 / FR-09 / FR-11 / FR-11a)。
 *
 * 方針:
 *  - 文面テンプレートは詳細設計書 §9 / 要件定義書 §11 の例文と 1 文字も違わないようにする。
 *    受信者にとっては毎朝同じ形で届くことが信頼性そのものなので、体裁の揺れは不具合として扱う。
 *  - インデントは全角スペース(U+3000)1 つ。LINE のトーク画面は等幅ではないため、
 *    半角スペースだと行頭が揃って見えない。
 *  - 文字数は必ずコードポイント数(`[...text].length`)で数える。LINE の 5,000 文字上限は
 *    コードポイント基準であり、`String.length`(UTF-16 コードユニット)では絵文字や
 *    サロゲートペアを含む本文で過大に見積もってしまう。
 *  - 現在時刻はこのモジュールでは使わない(日付は呼び出し側から dateJst で渡される)。
 */

import type { ChannelConfig, CoverageSummary, DigestEntry, Importance } from '../types.js';
import { WEEKDAY_JA, WEEKDAY_KEYS, addDaysToDate, formatJstHeaderDate } from '../util/time.js';

/** LINE テキストメッセージ 1 通の上限(FR-09)。 */
export const LINE_TEXT_LIMIT = 5000;

/** 本文末尾の免責(詳細設計書 §9)。 */
export const DISCLAIMER =
  '※本まとめはAIが公的情報・報道を要約したものです。報道は速報であり、実際の手続きは必ず出典元の公的情報をご確認ください。';

/** 「新着なし」配信末尾の注意書き(詳細設計書 §9.1 / FR-11)。 */
export const EMPTY_NOTICE = '※この配信が届かない日はシステム障害の可能性があります。管理者へご連絡ください。';

/** 行頭インデント。全角スペース 1 つ。 */
const INDENT = '　';

/** 見出し行のタイトル。 */
const TITLE = '【本日の制度・法改正まとめ】';

/** 週次配信のチャネルの見出し行のタイトル。 */
const WEEKLY_TITLE = '【今週の制度・法改正まとめ】';

/** 至急(週次配信のチャネルで、まとめの日以外に送る定型文)の見出し。 */
const URGENT_TITLE = '【至急】期限が近い制度情報';

/**
 * 至急の末尾の注意書き。AI の要約ではなく、AI の判定(重要度・期限)で選んだ記事の
 * タイトルと出典をそのまま並べたものであることを明示する。
 */
export const URGENT_NOTICE =
  '※AIが「重要・期限が近い」と判定した新着を、定期のまとめとは別にお知らせしています。手続きは必ず出典元の公的情報をご確認ください。';

/** 至急に載せる記事タイトルの最大文字数。長い件名で 1 通が埋まらないようにする。 */
const URGENT_TITLE_MAX_CHARS = 80;

/** 重要度 high の見出しに付ける印(詳細設計書 §9)。 */
const IMPORTANT_MARK = '【重要】';

/** 切り詰めたことを示す記号。 */
const ELLIPSIS = '…';

/** 重要度の強さ。数値が大きいほど残す価値が高い。 */
const IMPORTANCE_RANK: Record<Importance, number> = { high: 3, medium: 2, low: 1 };

/** コードポイント数。LINE の文字数上限はこの数え方。 */
function charCount(text: string): number {
  return [...text].length;
}

/** コードポイント単位で先頭 n 文字を取り出す(サロゲートペアを割らない)。 */
function sliceChars(text: string, n: number): string {
  return [...text].slice(0, Math.max(0, n)).join('');
}

/**
 * 1 行に収めるための正規化。
 * AI 生成テキストには改行や連続空白が紛れ込むことがあり、そのまま出すと
 * 全角スペースのインデントが崩れて「■」項目の境界が読めなくなるため潰す。
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 週次配信の曜日の表記(例: '月曜')。毎日配信のチャネルでは null。 */
function weeklyLabel(channel: ChannelConfig): string | null {
  if (channel.weeklyOn === null) return null;
  return `${WEEKDAY_JA[WEEKDAY_KEYS.indexOf(channel.weeklyOn)] ?? ''}曜`;
}

/** 見出し 2 行(日付 + チャネル名)。通常文面・新着なし文面で共通。 */
function buildHeader(channel: ChannelConfig, dateJst: string): string {
  if (channel.weeklyOn !== null) {
    // 週次のまとめの対象は [7 日前 07:00, 当日 07:00)。読み手には「何日から何日の分か」で示す。
    const from = formatJstHeaderDate(addDaysToDate(dateJst, -7));
    const to = formatJstHeaderDate(addDaysToDate(dateJst, -1));
    return `${WEEKLY_TITLE}${from}〜${to}\n${channel.name}`;
  }
  return `${TITLE}${formatJstHeaderDate(dateJst)}\n${channel.name}`;
}

/**
 * ダイジェスト項目 1 件のブロック。
 * dateNote が null / 空なら行ごと省略する(詳細設計書 §9)。
 * affected も空なら省略する(要件定義書 §11 の 3 件目の例のとおり、
 * パブコメなど「対象」を特定できない項目がある)。
 */
function buildEntryBlock(entry: DigestEntry, index: number): string {
  const mark = entry.importance === 'high' ? IMPORTANT_MARK : '';
  const lines = [`■${index}. ${mark}${oneLine(entry.headline)}`, `${INDENT}${oneLine(entry.summary)}`];

  const affected = oneLine(entry.affected);
  if (affected !== '') lines.push(`${INDENT}対象: ${affected}`);

  const dateNote = entry.dateNote === null ? '' : oneLine(entry.dateNote);
  if (dateNote !== '') lines.push(`${INDENT}${dateNote}`);

  // 出典は必ず最後。LINE が URL を自動リンクするので装飾は付けない。
  lines.push(`${INDENT}出典: ${oneLine(entry.sourceUrl)}`);
  return lines.join('\n');
}

/**
 * 通常の配信本文を組み立てる(詳細設計書 §9)。
 * ブロック(見出し / 各項目 / その他件数 / 免責)を空行 1 つで連結する。
 */
export function formatDigestMessage(
  channel: ChannelConfig,
  dateJst: string,
  entries: DigestEntry[],
  omittedCount: number,
): string {
  const blocks: string[] = [buildHeader(channel, dateJst)];

  entries.forEach((entry, i) => {
    blocks.push(buildEntryBlock(entry, i + 1));
  });

  // FR-07: 絞り込みで落とした分は件数だけ知らせる。0 件なら行そのものを出さない。
  if (omittedCount > 0) {
    // 管理画面(M4-03)は未実装なので、存在しない場所へ案内しない。
    // 「割愛した」とだけ伝え、必要なら運用者が preview / 監査データで確認する。
    blocks.push(`その他の新着 ${omittedCount} 件は重要度が低いため割愛しました。`);
  }

  blocks.push(DISCLAIMER);
  return blocks.join('\n\n');
}

/**
 * 巡回実績の 1 行(FR-11a)。
 * 失敗したソースがあれば「N ソース中 M ソース」と明示し、受信者と運用者が
 * 「新着が無かった日」と「監視が欠けた日」を区別できるようにする。
 */
function buildCoverageLine(coverage: CoverageSummary): string {
  const scope =
    coverage.succeeded < coverage.total
      ? `${coverage.total} ソース中 ${coverage.succeeded} ソース`
      : `${coverage.succeeded} ソース`;
  // 巡回記録が無い(= 時刻が分からない)日でも文として自然に読めるよう時刻部分ごと落とす。
  const at = coverage.lastCollectedAtJst === null ? '' : `${coverage.lastCollectedAtJst} 時点で `;
  return `(本日 ${at}${scope}を確認しました)`;
}

/**
 * 新着 0 件の日の配信本文(詳細設計書 §9.1 / FR-11)。
 * 配信が届かない日 = 障害、と受信者が判断できるようにするため 0 件でも必ず送る。
 */
export function formatEmptyMessage(
  channel: ChannelConfig,
  dateJst: string,
  coverage: CoverageSummary,
): string {
  const label = weeklyLabel(channel);
  // 週次配信では「届かない日 = 障害」が成り立たない(まとめの日以外は送らない)ので、曜日で言い換える。
  const notice =
    label === null
      ? EMPTY_NOTICE
      : `※毎週${label}にこの配信が届かない場合はシステム障害の可能性があります。管理者へご連絡ください。`;
  return [
    buildHeader(channel, dateJst),
    `${label === null ? '本日' : '今週'}の新着はありません。\n${buildCoverageLine(coverage)}`,
    notice,
  ].join('\n\n');
}

/** 至急 1 件分の材料。AI の生成文は使わず、記事のタイトル・期限・出典をそのまま載せる。 */
export interface UrgentNotice {
  title: string;
  /** 自治体の記事なら地域名(FR-18)。国の記事は null。 */
  region: string | null;
  /** 期限(YYYY-MM-DD)。 */
  deadline: string;
  url: string;
}

function buildUrgentBlock(notice: UrgentNotice, index: number): string {
  const title = oneLine(notice.title);
  const clipped =
    charCount(title) <= URGENT_TITLE_MAX_CHARS
      ? title
      : `${sliceChars(title, URGENT_TITLE_MAX_CHARS - 1)}${ELLIPSIS}`;
  const region = notice.region === null ? '' : `${oneLine(notice.region)}: `;
  return [
    `■${index}. ${region}${clipped}`,
    `${INDENT}期限: ${formatJstHeaderDate(notice.deadline)}`,
    `${INDENT}出典: ${oneLine(notice.url)}`,
  ].join('\n');
}

function buildUrgentText(
  channel: ChannelConfig,
  dateJst: string,
  notices: UrgentNotice[],
  omittedCount: number,
): string {
  const blocks = [`${URGENT_TITLE} ${formatJstHeaderDate(dateJst)}\n${channel.name}`];
  notices.forEach((notice, i) => blocks.push(buildUrgentBlock(notice, i + 1)));
  if (omittedCount > 0) {
    blocks.push(`ほかに期限が近い情報が ${omittedCount} 件あります。次回以降にお知らせします。`);
  }
  blocks.push(URGENT_NOTICE);
  return blocks.join('\n\n');
}

/**
 * 至急の本文を組み立てる。文字数上限に収まるまで末尾(期限が遠いもの)から落とす。
 * 落とした分は「ほかに N 件」に合算し、返り値の notices には本文に載ったものだけを返す。
 */
export function formatUrgentMessage(
  channel: ChannelConfig,
  dateJst: string,
  notices: UrgentNotice[],
  omittedCount: number,
): { text: string; notices: UrgentNotice[] } {
  const limit = Math.min(channel.maxChars, LINE_TEXT_LIMIT);
  const kept = [...notices];
  for (;;) {
    const text = buildUrgentText(channel, dateJst, kept, omittedCount + notices.length - kept.length);
    if (charCount(text) <= limit || kept.length <= 1) {
      // 1 件でも収まらない(URL が異常に長いなど)場合も、送れない本文は返さない。
      return {
        text: charCount(text) <= limit ? text : `${sliceChars(text, Math.max(0, limit - 1))}${ELLIPSIS}`,
        notices: kept,
      };
    }
    kept.pop();
  }
}

/** 落とす 1 件を選ぶ: 重要度が最も低いもの。同率なら末尾(= AI が並べた順で後ろ)。 */
function indexOfLeastImportant(entries: DigestEntry[]): number {
  let worst = 0;
  for (let i = 1; i < entries.length; i++) {
    const current = entries[i];
    const best = entries[worst];
    if (!current || !best) continue;
    // '<=' にすることで同率のときは後ろの要素が選ばれる(末尾優先)。
    if (IMPORTANCE_RANK[current.importance] <= IMPORTANCE_RANK[best.importance]) worst = i;
  }
  return worst;
}

/** 1 件だけ残った本文が上限を超える場合に、その項目の summary を末尾「…」付きで詰める。 */
function truncateToLimit(
  channel: ChannelConfig,
  dateJst: string,
  entry: DigestEntry,
  omittedCount: number,
  limit: number,
): { text: string; entry: DigestEntry } {
  const original = oneLine(entry.summary);
  let keep = charCount(original);

  // 超過分をまとめて削ってから 1 文字ずつ詰める。二分探索するほどの件数ではない。
  for (;;) {
    const summary = keep <= 0 ? '' : `${sliceChars(original, keep)}${ELLIPSIS}`;
    const candidate: DigestEntry = { ...entry, summary };
    const text = formatDigestMessage(channel, dateJst, [candidate], omittedCount);
    const over = charCount(text) - limit;
    if (over <= 0) return { text, entry: candidate };
    if (keep <= 0) break;
    keep = Math.max(0, keep - Math.max(1, over));
  }

  // summary を空にしても収まらない(見出しや URL 自体が異常に長い)場合の最終手段。
  // 「必ず上限内に収める」ことを優先し、本文全体を切り詰める。
  const stripped: DigestEntry = { ...entry, summary: '' };
  const full = formatDigestMessage(channel, dateJst, [stripped], omittedCount);
  return {
    text: `${sliceChars(full, Math.max(0, limit - 1))}${ELLIPSIS}`,
    entry: stripped,
  };
}

/**
 * 文字数上限(FR-09)に収まるまで項目を削って整形し直す。
 *
 * 削る順は「重要度が低いもの → 同率なら末尾」。出力順は入力順のまま保つ
 * (重要度は "どれを落とすか" の判断にだけ使う。並べ替えは AI 側の責務)。
 * 削った分は omittedCount に加算されるので、受信者には「その他の新着 N 件」として届く。
 */
export function fitToLimit(
  channel: ChannelConfig,
  dateJst: string,
  entries: DigestEntry[],
  omittedCount: number,
): { text: string; entries: DigestEntry[]; droppedCount: number } {
  // チャネル設定が LINE の物理上限より大きくても、実際に送れるのは 5,000 文字まで。
  const limit = Math.min(channel.maxChars, LINE_TEXT_LIMIT);

  const kept = [...entries];
  let droppedCount = 0;

  for (;;) {
    const text = formatDigestMessage(channel, dateJst, kept, omittedCount + droppedCount);
    if (charCount(text) <= limit) {
      return { text, entries: kept, droppedCount };
    }
    if (kept.length <= 1) break;
    kept.splice(indexOfLeastImportant(kept), 1);
    droppedCount += 1;
  }

  const last = kept[0];
  if (!last) {
    // 項目 0 件でも超える = 見出しや免責だけで上限を超えるほど limit が小さい。
    // 設定ミスの可能性が高いが、送れない本文を返すよりは切り詰めて返す。
    const text = formatDigestMessage(channel, dateJst, [], omittedCount + droppedCount);
    return {
      text: charCount(text) <= limit ? text : `${sliceChars(text, Math.max(0, limit - 1))}${ELLIPSIS}`,
      entries: [],
      droppedCount,
    };
  }

  const truncated = truncateToLimit(channel, dateJst, last, omittedCount + droppedCount, limit);
  // 本文に載ったのは切り詰め後の内容なので、entries もそれに合わせる(記録と本文を一致させる)。
  return { text: truncated.text, entries: [truncated.entry], droppedCount };
}
