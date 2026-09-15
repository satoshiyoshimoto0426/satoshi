/**
 * deliver ジョブ(詳細設計書 §6.3 / §9.2、要件定義書 FR-10 / FR-12 / FR-14 / FR-15)。
 *
 * 役割は「すでに出来ているダイジェストを LINE へ流す」ことだけに絞る。
 * 生成はしない。生成が無ければそれは summarize 側の異常であり、ここで握り潰さずに通知する
 * (詳細設計書 §12 の「07:45 時点で当日 deliveries が無い → 常に異常」に対応する見張り)。
 *
 * 設計上いちばん大事なのは **二重配信をしない** ことと **送りっぱなしにしない** こと。
 *  - 二重配信対策(FR-12): deliveries の id を `<channelId>_<JST日付>` に固定し、
 *    status='sent' なら何度実行しても送らない。
 *  - 送信記録の取りこぼし対策: retryKey は「送信する前に」必ず永続化する。
 *    送信直後にプロセスが落ちても、次回同じ retryKey で再送すれば LINE 側が重複排除してくれる
 *    (詳細設計書 §9.2)。逆に retryKey を毎回作り直すと、LINE には届いているのに
 *    記録が無い → 再実行で二重配信、という最悪の事故になる。
 */

import type { AppContext, ChannelConfig, Delivery, Digest, Run, RunCounts } from '../types.js';
import { addDays, isoOf, toJstDateString } from '../util/time.js';

export interface DeliverOptions {
  /** 配信対象の JST 日付 'YYYY-MM-DD'。省略時は実行時点の JST 日付。 */
  date?: string;
  /** 対象チャネル id。省略時は全チャネル。 */
  channelIds?: string[];
  /** true なら送信も記録もせず、文面をログに出すだけ。 */
  dryRun?: boolean;
}

/** digests / deliveries の id 規則(詳細設計書 §6.3)。両者で同じキーを使う。 */
function documentIdFor(channelId: string, dateJst: string): string {
  return `${channelId}_${dateJst}`;
}

/** RunCounts の初期値。deliver で意味を持つのは sent / skipped だけで、他は 0 のまま。 */
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

/** 例外から表示用メッセージを取り出す。トークンなどの秘密情報は元々例外に載せない。 */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 配信を実行する。
 *
 * 戻り値の Run は開始時(status='running')と終了時の 2 回 store に書き込む。
 * 途中でプロセスが落ちても「走り出したが終わっていない実行」が記録に残るようにするため。
 */
export async function runDeliver(ctx: AppContext, opts: DeliverOptions = {}): Promise<Run> {
  const startedAt = ctx.clock.now();
  const dateJst = opts.date ?? toJstDateString(startedAt);
  const startedIso = isoOf(startedAt);
  const runId = ctx.newId();
  const logger = ctx.logger.child({ job: 'deliver', runId, date: dateJst });

  // runtime.dryRun でも実送信はされないが、それだと「送っていないのに deliveries が sent」になり、
  // 翌日の本番実行が冪等スキップしてしまう。記録ごと止めるため両者を同一視する。
  const dryRun = opts.dryRun === true || ctx.config.runtime.dryRun;

  // チャネルの絞り込みは Run を記録する前に行う。綴り間違いで落ちたときに
  // 'running' のまま終わらない実行記録を残さないため。
  const channels = selectChannels(ctx, opts.channelIds);

  const counts = emptyCounts();
  const errors: string[] = [];
  const run: Run = {
    id: runId,
    job: 'deliver',
    startedAt: startedIso,
    finishedAt: null,
    status: 'running',
    counts,
    date: dateJst,
    errors,
    expiresAt: addDays(startedIso, ctx.config.runtime.retentionDays),
  };
  await ctx.store.putRun(run);
  logger.info('配信を開始します', { channels: channels.map((c) => c.id), dryRun });

  const finish = async (): Promise<Run> => {
    run.finishedAt = isoOf(ctx.clock.now());
    run.status = decideStatus(counts.sent, errors.length);
    await ctx.store.putRun(run);
    logger.info('配信を終了しました', { status: run.status, sent: counts.sent, skipped: counts.skipped });
    return run;
  };

  try {
    for (const channel of channels) {
      await deliverChannel(ctx, channel, dateJst, dryRun, counts, errors);
    }
  } catch (e) {
    // 個別チャネルの失敗は deliverChannel 内で捕捉済み。ここに来るのは store 障害など想定外の事態。
    const message = errorMessage(e);
    errors.push(`配信ジョブが異常終了しました: ${message}`);
    logger.error('配信ジョブが異常終了しました', { error: message });
    run.finishedAt = isoOf(ctx.clock.now());
    run.status = 'failed';
    await ctx.store.putRun(run);
    throw e;
  }

  return finish();
}

/** 対象チャネルを決める。未知の id を黙って無視すると「配信したつもり」になるので落とす。 */
function selectChannels(ctx: AppContext, channelIds?: string[]): ChannelConfig[] {
  const all = ctx.config.channels;
  if (channelIds === undefined || channelIds.length === 0) return all;

  const known = new Set(all.map((channel) => channel.id));
  const unknown = channelIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`未知のチャネル id です: ${unknown.join(', ')}(設定にあるのは ${[...known].join(', ')})`);
  }
  return all.filter((channel) => channelIds.includes(channel.id));
}

/** 実行結果の総合判定。1 件でも送れていれば partial、1 件も送れず失敗があれば failed。 */
function decideStatus(sent: number, errorCount: number): Run['status'] {
  if (errorCount === 0) return 'succeeded';
  return sent > 0 ? 'partial' : 'failed';
}

/**
 * チャネル 1 件の配信。例外はここで閉じ込め、他チャネルの配信を巻き添えにしない。
 */
async function deliverChannel(
  ctx: AppContext,
  channel: ChannelConfig,
  dateJst: string,
  dryRun: boolean,
  counts: RunCounts,
  errors: string[],
): Promise<void> {
  const logger = ctx.logger.child({ job: 'deliver', channelId: channel.id, date: dateJst });
  const documentId = documentIdFor(channel.id, dateJst);

  const digest = await ctx.store.getDigest(documentId);

  // 1. ダイジェストが無い = summarize が失敗したか動いていない。0 件の日も digest は作られる
  //    設計(FR-11)なので、「無い」は常に異常(詳細設計書 §12)。
  if (digest === null) {
    const message = `ダイジェストがありません(${documentId})。summarize が失敗した可能性があります。`;
    logger.error('ダイジェストが見つかりません', { digestId: documentId });
    errors.push(`${channel.id}: ${message}`);
    counts.skipped += 1;
    await ctx.notifier.notify('error', 'ダイジェストが見つかりません', [
      `チャネル: ${channel.name}(${channel.id})`,
      `対象日: ${dateJst}`,
      message,
      `復旧手順: pnpm cli summarize --date ${dateJst} --channel ${channel.id} --force のあと pnpm cli deliver --date ${dateJst}`,
    ]);
    return;
  }

  // 2. 状態による早期スキップ。
  if (digest.status === 'delivered') {
    logger.info('配信済みのためスキップします(冪等)', { digestId: digest.id });
    counts.skipped += 1;
    return;
  }
  if (digest.status === 'skipped') {
    // sendWhenEmpty=false のチャネルで新着 0 件だった場合。異常ではないのでログのみ。
    logger.info('配信対象外(skipped)のためスキップします', { digestId: digest.id });
    counts.skipped += 1;
    return;
  }
  if (digest.status === 'failed') {
    logger.warn('生成に失敗したダイジェストのためスキップします', { digestId: digest.id });
    counts.skipped += 1;
    await ctx.notifier.notify('error', '生成に失敗したダイジェストがあります', [
      `チャネル: ${channel.name}(${channel.id})`,
      `対象日: ${dateJst}`,
      `status=failed のため配信しませんでした。pnpm cli summarize --date ${dateJst} --channel ${channel.id} --force で作り直してください。`,
    ]);
    return;
  }

  // 3. 承認モード(FR-15)。approved 以外は運用者の承認待ちなので送らない。
  if (channel.requireApproval && digest.status !== 'approved') {
    logger.info('承認待ちのため配信しません', { digestId: digest.id, status: digest.status });
    counts.skipped += 1;
    await ctx.notifier.notify('info', '配信の承認待ちです', [
      `チャネル: ${channel.name}(${channel.id})`,
      `対象日: ${dateJst}`,
      `承認するには: pnpm cli approve --date ${dateJst} --channel ${channel.id}`,
      `文面の確認: pnpm cli preview --date ${dateJst} --channel ${channel.id}`,
    ]);
    return;
  }

  // 4. 配信記録による冪等判定(FR-12)。digest.status の更新に失敗していても、
  //    こちらが sent なら LINE には届いているので二度と送らない。
  const existing = await ctx.store.getDelivery(documentId);
  if (existing !== null && existing.status === 'sent') {
    logger.info('送信済みのためスキップします(冪等)', { deliveryId: existing.id });
    counts.skipped += 1;
    return;
  }

  // 5. ドライラン。送信も記録もせず、文面だけをログに残す。
  if (dryRun) {
    logger.info('ドライラン: 送信しません', {
      digestId: digest.id,
      isEmpty: digest.isEmpty,
      entries: digest.entries.length,
      messageText: digest.messageText,
    });
    counts.skipped += 1;
    return;
  }

  // 6. retryKey は既存があれば必ず再利用する。同じ retryKey での再送は LINE 側で重複排除される
  //    (詳細設計書 §9.2)ので、「送ったかどうか分からない」状態から安全に復帰できる。
  const retryKey = existing?.retryKey ?? ctx.newId();
  const attemptStartedIso = isoOf(ctx.clock.now());
  const pending: Delivery = {
    id: documentId,
    channelId: channel.id,
    date: dateJst,
    digestId: digest.id,
    lineRequestId: null,
    retryKey,
    // 送信前に書くレコードは必ず failed で置く。送信中にプロセスが落ちた場合、
    // 「記録が無い(= 未送信とみなす)」より「失敗したかもしれない」として残すほうが安全なため。
    status: 'failed',
    attempts: (existing?.attempts ?? 0) + 1,
    sentAt: null,
    error: '送信結果が確定していません(送信前の記録)',
    updatedAt: attemptStartedIso,
    expiresAt: addDays(attemptStartedIso, ctx.config.runtime.retentionDays),
  };
  await ctx.store.putDelivery(pending);

  try {
    // トークンはここで初めて解決する。値はログにも例外にも出さない(詳細設計書 §11)。
    const token = await ctx.resolveLineToken(channel);
    const result = await ctx.line.broadcast(token, digest.messageText, retryKey);
    const sentIso = isoOf(ctx.clock.now());

    await ctx.store.putDelivery({
      ...pending,
      status: 'sent',
      lineRequestId: result.requestId,
      sentAt: sentIso,
      error: null,
      updatedAt: sentIso,
    });
    await ctx.store.putDigest({ ...digest, status: 'delivered', updatedAt: sentIso });

    counts.sent += 1;
    logger.info('配信しました', {
      digestId: digest.id,
      lineRequestId: result.requestId,
      status: result.status,
      chars: [...digest.messageText].length,
    });
  } catch (e) {
    const message = errorMessage(e);
    const failedIso = isoOf(ctx.clock.now());

    await ctx.store.putDelivery({ ...pending, status: 'failed', error: message, updatedAt: failedIso });
    // digest は 'generated'(または 'approved')のまま残す。status を failed にしてしまうと
    // 翌日の手動再実行(pnpm cli deliver --date ...)で送り直せなくなるため。
    errors.push(`${channel.id}: ${message}`);
    logger.error('配信に失敗しました', { digestId: digest.id, attempts: pending.attempts, error: message });
    await ctx.notifier.notify('error', 'LINE 配信に失敗しました', [
      `チャネル: ${channel.name}(${channel.id})`,
      `対象日: ${dateJst}`,
      `試行回数: ${pending.attempts}`,
      `エラー: ${message}`,
      `再配信: pnpm cli deliver --date ${dateJst} --channel ${channel.id}(冪等キーが効くので二重配信になりません)`,
    ]);
  }
}

/**
 * 承認モード(FR-15)のダイジェストを承認する。
 * 冪等: すでに配信済み(delivered)のものは何もせずそのまま返す。
 */
export async function approveDigest(ctx: AppContext, channelId: string, dateJst: string): Promise<Digest> {
  const documentId = documentIdFor(channelId, dateJst);
  const digest = await ctx.store.getDigest(documentId);

  if (digest === null) {
    throw new Error(
      `${dateJst} のチャネル '${channelId}' のまとめが見つかりません。` +
        `先に pnpm cli summarize --date ${dateJst} --channel ${channelId} を実行してください` +
        `(日付とチャネル id の綴りもご確認ください)。`,
    );
  }

  if (digest.status === 'delivered') {
    // 配信後の承認は意味を持たない。状態を巻き戻すと再配信の判定が狂うのでそのまま返す。
    ctx.logger.info('すでに配信済みのため承認は不要です', { digestId: digest.id, channelId, date: dateJst });
    return digest;
  }

  const approved: Digest = { ...digest, status: 'approved', updatedAt: isoOf(ctx.clock.now()) };
  await ctx.store.putDigest(approved);
  ctx.logger.info('ダイジェストを承認しました', {
    digestId: approved.id,
    channelId,
    date: dateJst,
    previousStatus: digest.status,
  });
  return approved;
}
