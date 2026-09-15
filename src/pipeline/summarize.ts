/**
 * 日次ダイジェスト生成ジョブ(詳細設計書 §6.2 / 要件定義書 FR-05〜FR-09・FR-11・FR-16・FR-18)。
 *
 * 毎朝 07:00 JST に起動し、チャネルごとに「直近 24 時間の関連アイテム」を AI で要約して
 * `digests` に保存する。実際の LINE 送信は deliver ジョブの責務で、ここでは配信物を作るだけ。
 *
 * 設計上の重要な約束:
 *  - **「新着なし」と「障害」を絶対に混同しない。**
 *    元記事があったのに品質ゲートで全滅した場合は、status='failed' として配信対象から外し、
 *    運用者へ error 通知する(§7 の分岐)。ここで「本日の新着はありません」と送ってしまうと、
 *    受信者は「監視は正常、ただ新着が無い日」と受け取る。それは事実と異なり、
 *    受信者の実務判断を誤らせる。本システムで最も守るべき誠実性の境界がこの分岐。
 *  - **1 チャネルの失敗が他チャネルを止めない。**(可用性 NFR-01)
 *  - 現在時刻は必ず `ctx.clock.now()` 経由(テスト容易性・契約)。
 *  - 監査のため、model / prompt / rawResponse / usage / coverage / expiresAt を必ず保存する(FR-16)。
 */

import { ConfigError } from '../types.js';
import type {
  AppContext,
  ChannelConfig,
  Classification,
  CoverageSummary,
  Digest,
  DigestEntry,
  DigestInputItem,
  ExcludedEntry,
  Importance,
  Item,
  Logger,
  Run,
  RunCounts,
  RunStatus,
  SourceConfig,
} from '../types.js';
import { fitToLimit, formatEmptyMessage } from '../line/format.js';
import { addDays, digestWindow, isValidDateString, isoOf, toJstDateString } from '../util/time.js';
import { computeCoverage } from './coverage.js';
import { applyQualityGate } from './quality-gate.js';

export interface SummarizeOptions {
  /** 対象日(JST, YYYY-MM-DD)。省略時は現在時刻の JST 日付。 */
  date?: string;
  /** 対象チャネル ID。省略時は全チャネル。 */
  channelIds?: string[];
  /** 既存の digest があっても作り直す。 */
  force?: boolean;
}

/** 対象ウィンドウの締め時刻(JST)。詳細設計書 §6.2: [前日 07:00, 当日 07:00)。 */
const WINDOW_CUTOFF_JST = '07:00';

/** 1 回の AI 呼び出しに渡すアイテムの上限(詳細設計書 §7.2)。 */
const MAX_AI_INPUT_ITEMS = 20;

/** AI 入力に載せる本文の長さ(詳細設計書 §7.2)。 */
const EXCERPT_CHARS = 3000;

/** 重要度の強さ。並べ替えにのみ使う。 */
const IMPORTANCE_RANK: Record<Importance, number> = { high: 3, medium: 2, low: 1 };

/**
 * 更新記事を再掲するまでの最小間隔(日)。
 * 既知ページの内容が変わると collect が再分類対象に戻す(詳細設計書 §6.1 の 6)。
 * その更新も配信しないと「更新は検知したが誰にも届かない」状態になるが、
 * 無条件に拾うと日付や訪問者数だけが変わるページを毎日再掲してしまう。
 * そこで「直近この日数のあいだ同じチャネルで配信していないこと」を条件にする。
 */
const REDELIVER_MIN_INTERVAL_DAYS = 7;

/**
 * 未配信のまま取り残されたアイテムを何日さかのぼって拾い直すか(繰り越し)。
 *
 * なぜ必要か:
 *   ダイジェストの対象はその日のウィンドウに入るアイテムだけだが、
 *   - AI 入力の上限 20 件を超えた分
 *   - 文字数調整で本文から落ちた分
 *   - 巡回には入ったが classify が追いつかず未分類だった分
 *   はどれも digestedIn が付かないまま翌日のウィンドウから外れ、**二度と配信されない**。
 *   報酬改定の公表日のように 1 日に大量に出る日ほど落ちるため、
 *   「後手を踏まない」という本システムの目的に直接反する。
 *   そこで、まだ一度も配信していないアイテムはこの日数だけ候補に戻す。
 */
const CARRY_OVER_DAYS = 3;

/**
 * 更新記事をさかのぼって探す日数。
 *
 * 7 日ルール(REDELIVER_MIN_INTERVAL_DAYS)は再掲を「遅らせる」ためのものであって
 * 「捨てる」ためのものではない。ところが更新の検出をその日のウィンドウだけで行うと、
 * 配信直後に更新された記事は 7 日ルールで弾かれ、翌日以降は updatedAt がウィンドウ外に
 * なるため二度と拾われない。報酬改定 Q&A の追補や様式差替えなど、見落とすと最も痛い
 * 更新がここに落ちる。そこで更新の検出はこの日数だけさかのぼり、
 * 「7 日経った日」に改めて候補へ戻す。
 */
const UPDATE_LOOKBACK_DAYS = REDELIVER_MIN_INTERVAL_DAYS + 7;

/** 分類済みであることが確定したアイテム。null チェックを 1 度で済ませるための内部型。 */
interface Candidate {
  item: Item;
  classification: Classification;
}

function emptyCounts(): RunCounts {
  return {
    sourcesTotal: 0,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    fetched: 0,
    newItems: 0,
    updatedItems: 0,
    classified: 0,
    digestsGenerated: 0,
    excluded: 0,
    sent: 0,
    skipped: 0,
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** コードポイント単位で切り詰める(サロゲートペアを割らない)。 */
function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * 通知は運用者への連絡手段であって業務処理ではない。
 * 通知先の障害でダイジェスト生成を道連れにしないよう、失敗は握りつぶしてログに留める。
 */
async function safeNotify(
  ctx: AppContext,
  log: Logger,
  level: 'info' | 'warn' | 'error',
  title: string,
  lines: string[],
): Promise<void> {
  try {
    await ctx.notifier.notify(level, title, lines);
  } catch (e) {
    log.warn('運用通知の送信に失敗しました', { error: errorMessage(e) });
  }
}

/** 対象チャネルを解決する。存在しない ID は設定ミスなので即座にエラーにする。 */
function resolveChannels(ctx: AppContext, channelIds: string[] | undefined): ChannelConfig[] {
  const all = ctx.config.channels;
  if (channelIds === undefined || channelIds.length === 0) return all;

  const byId = new Map(all.map((channel) => [channel.id, channel]));
  const resolved: ChannelConfig[] = [];
  const unknown: string[] = [];
  for (const id of channelIds) {
    const found = byId.get(id);
    if (found === undefined) unknown.push(id);
    else resolved.push(found);
  }
  if (unknown.length > 0) {
    throw new ConfigError(
      `存在しないチャネル ID が指定されました: ${unknown.join(', ')}(設定されているチャネル: ${all
        .map((c) => c.id)
        .join(', ')})`,
    );
  }
  return resolved;
}

/**
 * digestedIn に入っているダイジェスト ID から「このチャネルで最後に配信した JST 日付」を取り出す。
 * ダイジェスト ID は `${channelId}_${YYYY-MM-DD}` 形式なので、ID から復元できる。
 * 別途フィールドを持たせるより、既にある情報から導くほうが不整合が起きない。
 */
function lastDigestedDate(item: Item, channelId: string): string | null {
  const prefix = `${channelId}_`;
  let latest: string | null = null;
  for (const id of item.digestedIn) {
    if (!id.startsWith(prefix)) continue;
    const date = id.slice(prefix.length);
    if (!isValidDateString(date)) continue;
    if (latest === null || date > latest) latest = date;
  }
  return latest;
}

/**
 * 更新記事(既知 URL の本文が変わったもの)をダイジェスト候補に加えてよいか。
 *
 * 条件:
 *  1. 更新後に再分類が済んでいること(classifiedAt が更新時刻以降)。
 *     未分類のまま拾うと、内容が変わったのに古い判定で配信してしまう。
 *  2. 直近 REDELIVER_MIN_INTERVAL_DAYS 日のあいだ、このチャネルで配信していないこと。
 *     軽微な更新の再掲を防ぐ。
 */
function isRedeliverableUpdate(
  item: Item,
  channel: ChannelConfig,
  dateJst: string,
  windowFrom: string,
): boolean {
  if (item.classifiedAt === null) return false;
  if (item.classifiedAt < item.updatedAt) return false;

  const last = lastDigestedDate(item, channel.id);
  if (last === null) {
    // このチャネルで一度も配信していないものは「再掲」ではない。
    // 直近 24 時間に更新されたものだけをここで拾い、それより古い未配信分は
    // 繰り越し(CARRY_OVER_DAYS)の担当にする。ここで広く拾うと、
    // 繰り越しの上限日数が実質無効になり、古い記事がいつまでも候補に残る。
    return item.updatedAt >= windowFrom;
  }

  // 最終配信日より後に更新されたものだけを再掲の対象にする。
  // これが無いと、更新されていない古い記事まで 7 日ごとに再掲されてしまう。
  // 配信日は JST 日付までしか分からないので、その日の終わり(翌日 00:00 JST = 前日 15:00Z)と比べる。
  const lastDeliveredEnd = addDays(`${last}T15:00:00.000Z`, 0);
  if (item.updatedAt <= lastDeliveredEnd) return false;

  // 7 日ルールは再掲を「遅らせる」ためのもの。まだ 7 日経っていない日は見送るが、
  // 更新の検出自体を UPDATE_LOOKBACK_DAYS だけさかのぼっているので、
  // 7 日経った日に改めてここへ来て true になる(捨てられない)。
  // addDays は ISO8601 を扱うので、日付だけの比較用に 00:00Z を補って計算する。
  const earliest = addDays(`${last}T00:00:00.000Z`, REDELIVER_MIN_INTERVAL_DAYS).slice(0, 10);
  return dateJst >= earliest;
}

/**
 * ダイジェスト候補の絞り込み(詳細設計書 §6.2 の 1、要件定義書 §5.4)。
 * 返す配列はウィンドウ内の並び(detectedAt 昇順)のまま。
 */
function selectCandidates(
  windowItems: Item[],
  channel: ChannelConfig,
  digestId: string,
  log: Logger,
): { candidates: Candidate[]; unclassified: number } {
  // 要件定義書 §5.4: 自治体ページが国の通知を転載しただけのものは、国側を優先して落とす。
  // 「国側のアイテムが同じウィンドウに存在するか」でしか判定できないため、
  // 国のアイテム(region === null)が 1 件も無い日は転載側を残す(情報の欠落を防ぐ)。
  const hasNationalItem = windowItems.some((item) => item.region === null);

  const candidates: Candidate[] = [];
  let duplicateOfNational = 0;
  let unclassified = 0;

  for (const item of windowItems) {
    const classification = item.classification;
    if (classification === null) {
      // 未分類は対象外だが、黙って捨ててはいけない。
      // AI の分類が終日失敗すると全アイテムがここに落ち、対象 0 件 =「新着なし」として
      // 配信されてしまう。件数を呼び出し元へ返し、0 件判定の前に障害かどうかを見分ける。
      unclassified += 1;
      continue;
    }
    if (!classification.channels.includes(channel.id)) continue;
    if (classification.relevance < channel.relevanceThreshold) continue;
    // 同じダイジェストに二度載せない(再実行しても本文が膨らまない)。
    if (item.digestedIn.includes(digestId)) continue;

    // 転載除外は「自治体のページが国の通知をそのまま載せているだけ」の重複を防ぐためのもの。
    // region が null のアイテム(= 国のソースで初検知したもの)には適用しない。
    // 適用すると、国の通知そのものが「自治体の転載」として無言で落ちる事故になる。
    if (classification.isDuplicateOfNational && item.region !== null && hasNationalItem) {
      duplicateOfNational += 1;
      continue;
    }

    candidates.push({ item, classification });
  }

  if (duplicateOfNational > 0) {
    log.info('国の通知の転載とみなしたアイテムを除外しました', { count: duplicateOfNational });
  }
  if (unclassified > 0) {
    log.warn('未分類のままのアイテムがあります', { count: unclassified });
  }
  return { candidates, unclassified };
}

/** 重要度 desc → 関連度 desc → 検知が新しい順。最後の 2 つは結果を決定的にするための同値解消。 */
function compareCandidates(a: Candidate, b: Candidate): number {
  const byImportance =
    IMPORTANCE_RANK[b.classification.importance] - IMPORTANCE_RANK[a.classification.importance];
  if (byImportance !== 0) return byImportance;

  const byRelevance = b.classification.relevance - a.classification.relevance;
  if (byRelevance !== 0) return byRelevance;

  if (a.item.detectedAt !== b.item.detectedAt) {
    return a.item.detectedAt < b.item.detectedAt ? 1 : -1;
  }
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

/** AI 入力 1 件を組み立てる。ソース名と補足メモは判断材料として渡す(FR-18 の地域明記にも効く)。 */
function toDigestInput(candidate: Candidate, sourceById: Map<string, SourceConfig>): DigestInputItem {
  const source = sourceById.get(candidate.item.sourceId);
  const sourceName =
    source === undefined
      ? candidate.item.sourceId
      : source.note === null || source.note === ''
        ? source.name
        : `${source.name}(${source.note})`;

  return {
    id: candidate.item.id,
    title: candidate.item.title,
    url: candidate.item.canonicalUrl,
    kind: candidate.classification.kind,
    importance: candidate.classification.importance,
    effectiveDate: candidate.classification.effectiveDate,
    deadline: candidate.classification.deadline,
    region: candidate.item.region,
    sourceName,
    excerpt: truncate(candidate.item.contentText, EXCERPT_CHARS),
  };
}

/** digest レコードの共通部分。createdAt は再生成(force)でも最初の生成時刻を保つ。 */
interface DigestDraft {
  entries: DigestEntry[];
  excluded: ExcludedEntry[];
  omittedCount: number;
  isEmpty: boolean;
  coverage: CoverageSummary;
  messageText: string;
  status: Digest['status'];
  model: string;
  prompt: string;
  rawResponse: string;
  usage: Digest['usage'];
}

function buildDigest(
  ctx: AppContext,
  channel: ChannelConfig,
  dateJst: string,
  digestId: string,
  existing: Digest | null,
  draft: DigestDraft,
): Digest {
  const nowIso = isoOf(ctx.clock.now());
  return {
    id: digestId,
    channelId: channel.id,
    date: dateJst,
    ...draft,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    // FR-16: 監査データの保持期間。Firestore の TTL ポリシーがこの値で削除する。
    expiresAt: addDays(nowIso, ctx.config.runtime.retentionDays),
  };
}

/**
 * 日次ダイジェストを生成する。
 * 例外を投げるのは「指定が不正でジョブとして成立しない」場合のみ。
 * 個々のチャネルの失敗は Run に記録して返す(他チャネルの配信物は作り切る)。
 */
export async function runSummarize(ctx: AppContext, opts: SummarizeOptions = {}): Promise<Run> {
  const runId = ctx.newId();
  const log = ctx.logger.child({ job: 'summarize', runId });

  const startedAt = isoOf(ctx.clock.now());
  const dateJst = opts.date ?? toJstDateString(ctx.clock.now());
  if (!isValidDateString(dateJst)) {
    throw new ConfigError(
      `対象日は 'YYYY-MM-DD' 形式の実在する日付で指定してください: ${opts.date ?? dateJst}`,
    );
  }

  const channels = resolveChannels(ctx, opts.channelIds);
  const window = digestWindow(dateJst, WINDOW_CUTOFF_JST);
  const sourceById = new Map(ctx.config.sources.map((source) => [source.id, source]));

  const counts = emptyCounts();
  // summarize の処理単位はチャネル。RunCounts の sources* をチャネル数として使う
  // (Run の集計項目は全ジョブ共通のため、ジョブごとに意味を割り当てる)。
  counts.sourcesTotal = channels.length;
  const errors: string[] = [];

  const run: Run = {
    id: runId,
    job: 'summarize',
    startedAt,
    finishedAt: null,
    status: 'running',
    counts,
    date: dateJst,
    errors,
    expiresAt: addDays(startedAt, ctx.config.runtime.retentionDays),
  };
  // 実行中であることを先に記録する。途中でプロセスが落ちても「走った形跡」が残る(NFR-06)。
  await ctx.store.putRun(run);

  log.info('summarize を開始します', {
    date: dateJst,
    channels: channels.map((c) => c.id),
    from: window.from,
    to: window.to,
    force: opts.force === true,
  });

  // 巡回実績は日付にのみ依存するので 1 回だけ求めて全チャネルで使い回す。
  let coverageCache: CoverageSummary | null = null;
  const getCoverage = async (): Promise<CoverageSummary> => {
    if (coverageCache !== null) return coverageCache;
    try {
      coverageCache = await computeCoverage(ctx, dateJst);
    } catch (e) {
      // 巡回実績が出せないことは digest 本体の生成失敗ではない。
      // ただし「確認できた」と偽ることはできないので、成功 0 件として保守的に記録する。
      const message = `巡回実績の集計に失敗しました: ${errorMessage(e)}`;
      log.warn(message);
      errors.push(message);
      coverageCache = {
        total: ctx.config.sources.filter((s) => s.enabled).length,
        succeeded: 0,
        lastCollectedAtJst: null,
      };
    }
    return coverageCache;
  };

  for (const channel of channels) {
    const channelLog = log.child({ channelId: channel.id });
    try {
      const outcome = await summarizeChannel({
        ctx,
        log: channelLog,
        channel,
        dateJst,
        window,
        sourceById,
        counts,
        force: opts.force === true,
        getCoverage,
        onError: (message) => errors.push(message),
      });
      // 品質ゲート全滅は例外ではないが「配信物を作れなかった」ので失敗として数える。
      // 全チャネルがこの状態なら Run 全体を failed にしたい(= 運用者が必ず気づく)。
      if (outcome === 'failed') counts.sourcesFailed += 1;
      else counts.sourcesSucceeded += 1;
    } catch (e) {
      // 1 チャネルの失敗で他チャネルを止めない(NFR-01)。
      const message = `${channel.id}: ${errorMessage(e)}`;
      counts.sourcesFailed += 1;
      errors.push(message);
      channelLog.error('ダイジェスト生成に失敗しました', { error: errorMessage(e) });
      await safeNotify(ctx, channelLog, 'error', `ダイジェスト生成に失敗しました(${channel.name})`, [
        `対象日: ${dateJst}`,
        message,
        '本日の配信は行われません。原因を確認のうえ `summarize --force` で再実行してください。',
      ]);
    }
  }

  run.finishedAt = isoOf(ctx.clock.now());
  run.status = finalStatus(counts, errors);
  await ctx.store.putRun(run);

  log.info('summarize を終了しました', {
    status: run.status,
    generated: counts.digestsGenerated,
    skipped: counts.skipped,
    excluded: counts.excluded,
    failed: counts.sourcesFailed,
  });

  return run;
}

function finalStatus(counts: RunCounts, errors: string[]): RunStatus {
  if (counts.sourcesTotal > 0 && counts.sourcesFailed === counts.sourcesTotal) return 'failed';
  if (counts.sourcesFailed > 0 || errors.length > 0) return 'partial';
  return 'succeeded';
}

interface ChannelJob {
  ctx: AppContext;
  log: Logger;
  channel: ChannelConfig;
  dateJst: string;
  window: { from: string; to: string };
  sourceById: Map<string, SourceConfig>;
  counts: RunCounts;
  force: boolean;
  getCoverage: () => Promise<CoverageSummary>;
  onError: (message: string) => void;
}

/** チャネル 1 つの処理結果。'failed' は「配信できる digest を作れなかった」の意。 */
type ChannelOutcome = 'ok' | 'failed';

/** チャネル 1 つ分のダイジェストを生成して保存する(詳細設計書 §6.2)。 */
async function summarizeChannel(job: ChannelJob): Promise<ChannelOutcome> {
  const { ctx, log, channel, dateJst, counts } = job;
  const digestId = `${channel.id}_${dateJst}`;

  // --- 1. 冪等性: 既にあるなら作り直さない ------------------------------------
  const existing = await ctx.store.getDigest(digestId);
  if (existing !== null && !job.force) {
    counts.skipped += 1;
    log.info('既にダイジェストが存在するためスキップしました', {
      digestId,
      status: existing.status,
    });
    return 'ok';
  }

  // --- 2〜3. 対象ウィンドウのアイテムを絞り込む -------------------------------
  // 新着(detectedAt がウィンドウ内)に加え、既知 URL の内容が更新されたもの
  // (updatedAt がウィンドウ内)も対象にする。detectedAt は初検知時刻のまま据え置かれるため、
  // 更新分は detectedAt のクエリでは拾えず、「更新は検知したが誰にも届かない」状態になる(FR-02)。
  // 繰り越し用に、ウィンドウ開始より CARRY_OVER_DAYS 日さかのぼった範囲も引く。
  const carryWindow = { from: addDays(job.window.from, -CARRY_OVER_DAYS), to: job.window.from };

  // 更新の検出はウィンドウより広くさかのぼる(理由は UPDATE_LOOKBACK_DAYS のコメント)。
  const updateWindow = {
    from: addDays(job.window.from, -UPDATE_LOOKBACK_DAYS),
    to: job.window.to,
    field: 'updatedAt' as const,
  };

  const [freshItems, touchedItems, carryItems] = await Promise.all([
    ctx.store.listItemsInWindow(job.window),
    ctx.store.listItemsInWindow(updateWindow),
    ctx.store.listItemsInWindow(carryWindow),
  ]);

  // force での作り直しでは、この digest 自身が付けた「使用済み」印を無かったことにする。
  // さもないと再生成のたびに対象が 0 件になり、「新着はあったのに
  // 『本日の新着はありません』」という事実と異なる配信物ができてしまう
  // (再利用防止の印は "他の日のダイジェストで使った" ことを表すためのもの)。
  // force で印を外したアイテムの id。作り直しの最後に「本文へ載らなかったもの」を
  // 未配信へ戻すため、外す前の状態を覚えておく必要がある。
  const hadOwnMark = new Set<string>();
  const forgetOwnMark = (item: Item): Item => {
    if (!job.force || !item.digestedIn.includes(digestId)) return item;
    hadOwnMark.add(item.id);
    return { ...item, digestedIn: item.digestedIn.filter((id) => id !== digestId) };
  };

  const byId = new Map(freshItems.map((item) => [item.id, forgetOwnMark(item)]));
  let updatedPicked = 0;
  for (const touched of touchedItems) {
    const item = forgetOwnMark(touched);
    if (byId.has(item.id)) continue; // 新着として既に入っている
    if (item.detectedAt >= job.window.from) continue; // ウィンドウ内の新着(取りこぼし防止の保険)
    if (!isRedeliverableUpdate(item, channel, dateJst, job.window.from)) continue;
    byId.set(item.id, item);
    updatedPicked += 1;
  }

  if (updatedPicked > 0) {
    log.info('内容が更新された既知アイテムを候補に加えました', { count: updatedPicked });
  }

  // 繰り越し: 直近数日のうち、このチャネルで一度も配信していないアイテムを候補に戻す。
  // 「まだ誰にも届いていない」ものだけが対象なので、同じ記事が繰り返し配信されることはない。
  let carriedOver = 0;
  for (const carried of carryItems) {
    const item = forgetOwnMark(carried);
    if (byId.has(item.id)) continue;
    // このチャネルで配信済みなら対象外(他チャネルでの配信は関係ない)。
    // 単純な接頭辞一致では、チャネル id が別 id の接頭辞になっているとき
    //(welfare と welfare_child)に取り違える。lastDigestedDate と同じ判定に揃える。
    if (lastDigestedDate(item, channel.id) !== null) continue;
    byId.set(item.id, item);
    carriedOver += 1;
  }
  if (carriedOver > 0) {
    log.info('未配信のまま残っていたアイテムを繰り越しました', {
      count: carriedOver,
      days: CARRY_OVER_DAYS,
    });
  }

  const windowItems = [...byId.values()].sort((a, b) =>
    a.detectedAt < b.detectedAt ? -1 : a.detectedAt > b.detectedAt ? 1 : a.id < b.id ? -1 : 1,
  );
  const { candidates, unclassified } = selectCandidates(windowItems, channel, digestId, log);

  // --- 4. 重要度 → 関連度 で並べ、上位 20 件だけを AI に渡す --------------------
  const sorted = [...candidates].sort(compareCandidates);
  const targets = sorted.slice(0, MAX_AI_INPUT_ITEMS);
  // 21 件目以降は AI に見せないが、黙って消さず「その他 N 件」として読者に伝える(FR-07)。
  const omittedByCap = sorted.length - targets.length;

  log.info('ダイジェスト対象を絞り込みました', {
    windowItems: windowItems.length,
    candidates: candidates.length,
    unclassified,
    targets: targets.length,
    omittedByCap,
  });

  const coverage = await job.getCoverage();

  // --- 5. 0 件の日 ------------------------------------------------------------
  if (targets.length === 0) {
    // 未分類のアイテムが残っている状態で「新着なし」と配信してはいけない。
    //
    // AI の分類が終日失敗すると(API 障害・スキーマ不適合など)、巡回で取れた
    // アイテムはすべて classification: null のままここに落ちる。その結果
    // 「対象 0 件 = 新着なし」と判断され、受信者には「監視は正常、ただ新着が無い日」
    // として届く。品質ゲート全滅を failed にしているのと同じ理由で、ここも障害扱いにする。
    // 報酬改定の公表日に AI が落ちていれば、その日の情報がまるごと失われる。
    if (unclassified > 0) {
      const failed = buildDigest(ctx, channel, dateJst, digestId, existing, {
        entries: [],
        excluded: [],
        omittedCount: unclassified,
        isEmpty: false, // アイテムはあった。「新着なし」ではない。
        coverage,
        messageText: '', // 配信してはいけないので本文は作らない。
        status: 'failed',
        model: ctx.config.runtime.anthropicModel,
        prompt: '',
        rawResponse: '',
        usage: null,
      });
      await ctx.store.putDigest(failed);

      const message =
        `${channel.id}: ウィンドウ内に未分類のアイテムが ${unclassified} 件残っています` +
        '(AI 分類の失敗が疑われます)';
      job.onError(message);
      log.error('未分類アイテムが残っているため「新着なし」を配信しません', {
        digestId,
        unclassified,
      });
      await safeNotify(ctx, log, 'error', `ダイジェストを配信できません(${channel.name})`, [
        message,
        `対象日: ${dateJst}`,
        '分類が終わっていないため「本日の新着はありません」とは配信しません。',
        'collect を再実行して分類を完了させたうえで、summarize --force を実行してください。',
      ]);
      return 'failed';
    }

    await putEmptyDigest(job, digestId, existing, coverage);
    return 'ok';
  }

  // --- 6. AI 生成 → 品質ゲート → 文字数調整 -----------------------------------
  const inputs = targets.map((candidate) => toDigestInput(candidate, job.sourceById));
  const { digest: raw, meta } = await ctx.ai.generateDigest(channel, dateJst, inputs);

  const gate = await applyQualityGate(ctx, {
    channel,
    entries: raw.entries,
    items: targets.map((candidate) => candidate.item),
  });

  // --- 7. 品質ゲートで全滅 = 障害 ---------------------------------------------
  // 元記事が存在したのに 1 件も配信できない状態は「新着なし」ではない。
  // ここで「本日の新着はありません」と送ると、受信者は監視が正常に働いたと誤解する。
  // 受信者の実務判断を誤らせないため、sendWhenEmpty の設定に関わらず障害として扱い、
  // status='failed'(= deliver 対象外)にして運用者へ error 通知する。
  if (gate.entries.length === 0) {
    const failed = buildDigest(ctx, channel, dateJst, digestId, existing, {
      entries: [],
      excluded: gate.excluded,
      omittedCount: raw.omittedCount + gate.excluded.length + omittedByCap,
      isEmpty: false, // 対象アイテムはあった。「新着なし」ではない。
      coverage,
      messageText: '', // 配信してはいけないので本文は作らない。
      status: 'failed',
      model: meta.model,
      prompt: meta.prompt,
      rawResponse: meta.rawResponse,
      usage: meta.usage,
    });
    await ctx.store.putDigest(failed);

    counts.excluded += gate.excluded.length;
    const message = `${channel.id}: 対象 ${targets.length} 件すべてが品質ゲートで除外されました`;
    job.onError(message);
    log.error('品質ゲートを通過した項目が 0 件になりました', {
      digestId,
      targets: targets.length,
      excluded: gate.excluded.length,
    });
    await safeNotify(ctx, log, 'error', `ダイジェストを配信できません(${channel.name})`, [
      `対象日: ${dateJst} / 対象アイテム: ${targets.length} 件`,
      '品質ゲートを通過した項目が 0 件のため、status=failed として配信を見送りました。',
      '「本日の新着はありません」とは配信しません(新着はあったため)。',
      ...gate.excluded.map((e) => `${e.check} ${e.headline}: ${e.reason}`),
    ]);
    return 'failed';
  }

  // FR-07(件数上限)をコード側で強制する。
  // プロンプトでも maxItems を指示しているが、AI の出力が指示どおりである保証は無い。
  // 「機械的にあらゆる情報が流れてきて誰も追えなくなる」ことを防ぐのが本システムの
  // 存在理由なので、件数は最後にプログラムで切る。
  // 重要度の高い順に残し、溢れた分は黙って消さず「その他 N 件」に合算する。
  const ranked = [...gate.entries].sort(
    (a, b) => IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance],
  );
  const keep = new Set(ranked.slice(0, channel.maxItems));
  const capped = gate.entries.filter((entry) => keep.has(entry)); // 出力順は AI の並びを保つ
  const omittedByItemCap = gate.entries.length - capped.length;
  if (omittedByItemCap > 0) {
    log.info('件数上限を超えた項目を「その他」に回しました', {
      channelId: channel.id,
      maxItems: channel.maxItems,
      omitted: omittedByItemCap,
    });
  }

  // Q7(文字数)。落ちた分も含めて「その他 N 件」に合算する。
  const omittedBase = raw.omittedCount + gate.excluded.length + omittedByCap + omittedByItemCap;
  const fitted = fitToLimit(channel, dateJst, capped, omittedBase);

  const digest = buildDigest(ctx, channel, dateJst, digestId, existing, {
    entries: fitted.entries,
    excluded: gate.excluded,
    omittedCount: omittedBase + fitted.droppedCount,
    isEmpty: false,
    coverage,
    messageText: fitted.text,
    // 承認モードでも status は generated。承認の判定は deliver 側の責務(契約)。
    status: 'generated',
    model: meta.model,
    prompt: meta.prompt,
    rawResponse: meta.rawResponse,
    usage: meta.usage,
  });
  // --- 8. 再利用防止: 実際に本文へ載った項目だけを「使用済み」にする ------------
  // 品質ゲートや文字数調整で落ちた項目は配信されていないので、次回以降の候補に残す。
  //
  // **putDigest より先に行う。** 順序を逆にすると、digest が status='generated' で
  // 保存された後に印付けが失敗した場合、deliver はその digest を配信する一方で
  // item に印が付かず、翌日の繰り越しが同じ記事をもう一度拾って二重配信になる(FR-03 違反)。
  // 印付けが先なら、失敗しても「配信していないのに印が付く」ことはあっても
  // 「配信したのに印が付かない」ことは起きない(前者は取りこぼしだが、通知で気づける)。
  const usedItemIds = [...new Set(fitted.entries.map((entry) => entry.itemId))];
  if (usedItemIds.length > 0) {
    await ctx.store.markItemsDigested(usedItemIds, digestId);
  }

  // force で作り直したとき、前回は載ったが今回は載らなかった項目は「未配信」に戻す。
  // 戻さないと、配信されていないのに配信済みと見なされ、繰り越しの対象からも外れて
  // 永久に埋もれる。--force は障害からの復旧手段なので、打つほど取りこぼしが
  // 増えるようでは使えない。
  if (job.force) {
    const used = new Set(usedItemIds);
    const dropped = [...hadOwnMark].filter((id) => !used.has(id));
    if (dropped.length > 0) {
      await ctx.store.unmarkItemsDigested(dropped, digestId);
      log.info('作り直しで本文から外れた項目を未配信に戻しました', {
        digestId,
        count: dropped.length,
      });
    }
  }

  await ctx.store.putDigest(digest);

  counts.digestsGenerated += 1;
  counts.excluded += gate.excluded.length;

  log.info('ダイジェストを生成しました', {
    digestId,
    entries: fitted.entries.length,
    excluded: gate.excluded.length,
    omittedCount: digest.omittedCount,
    chars: [...fitted.text].length,
    // 目標件数(Q6)を下回っても配信はする。運用者が気づけるようログには残す。
    belowMinItems: fitted.entries.length < channel.minItems,
  });

  // --- 9. 除外があれば理由付きで通知(FR-13) ---------------------------------
  if (gate.excluded.length > 0) {
    await safeNotify(ctx, log, 'warn', `品質ゲートで ${gate.excluded.length} 件を除外しました`, [
      `チャネル: ${channel.name}(${channel.id}) / 対象日: ${dateJst}`,
      `配信する項目: ${fitted.entries.length} 件`,
      ...gate.excluded.map((e) => `${e.check} ${e.headline}: ${e.reason}`),
    ]);
  }

  return 'ok';
}

/**
 * 対象 0 件の日の digest を保存する(詳細設計書 §6.2 の 3 / §9.1 / FR-11)。
 * sendWhenEmpty=true なら「新着はありません」を配信物として作る。
 * 受信者が「配信が届かない = システム障害」と判別できることが、この文面の目的。
 */
async function putEmptyDigest(
  job: ChannelJob,
  digestId: string,
  existing: Digest | null,
  coverage: CoverageSummary,
): Promise<void> {
  const { ctx, log, channel, dateJst, counts } = job;
  const send = channel.sendWhenEmpty;

  const digest = buildDigest(ctx, channel, dateJst, digestId, existing, {
    entries: [],
    excluded: [],
    omittedCount: 0,
    isEmpty: true,
    coverage,
    messageText: send ? formatEmptyMessage(channel, dateJst, coverage) : '',
    status: send ? 'generated' : 'skipped',
    // AI は呼んでいない。監査上「呼ばなかった」ことが分かるよう prompt / rawResponse は空にする(FR-16)。
    model: ctx.config.runtime.anthropicModel,
    prompt: '',
    rawResponse: '',
    usage: null,
  });
  await ctx.store.putDigest(digest);

  if (send) {
    counts.digestsGenerated += 1;
    log.info('対象 0 件のため「新着なし」の digest を生成しました', {
      digestId,
      coverage,
    });
  } else {
    counts.skipped += 1;
    log.info('対象 0 件かつ sendWhenEmpty=false のため配信を見送ります', { digestId });
  }
}
