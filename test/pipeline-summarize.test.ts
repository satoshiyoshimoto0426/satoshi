/**
 * summarize ジョブの結合テスト(詳細設計書 §6.2 / §13、要件定義書 FR-05 / FR-11 / FR-16)。
 *
 * このジョブの出力はそのまま受信者に届く配信物になるため、次の 2 つを最重要に置く。
 *  1. **対象の選び方が仕様どおり**であること(ウィンドウ境界・閾値・再利用防止・更新記事)。
 *  2. **「新着なし」と「障害」を混同しない**こと。元記事があったのに 1 件も出せなかった日は
 *     status='failed' として配信を見送る。ここが崩れると「監視は正常」という誤ったメッセージを
 *     受信者へ送ってしまう。
 */

import { describe, expect, it } from 'vitest';

import { runSummarize } from '../src/pipeline/summarize.js';
import { AiError } from '../src/types.js';
import type { Digest, Item, Run, RunCounts } from '../src/types.js';
import { addDays, digestWindow } from '../src/util/time.js';
import {
  DEFAULT_DATE_JST,
  DEFAULT_NOW,
  makeChannel,
  makeClassification,
  makeContext,
  makeItem,
  mutableClock,
} from './helpers/fakes.js';
import { fixedClock } from '../src/util/clock.js';
import type { MakeContextOptions, TestContext } from './helpers/fakes.js';

/** 既定時刻(JST 2026-09-13 07:30)における対象ウィンドウ。 */
const WINDOW_FROM = '2026-09-11T22:00:00.000Z';
const WINDOW_TO = '2026-09-12T22:00:00.000Z';
/** ウィンドウの内側にある代表的な時刻。 */
const INSIDE = '2026-09-12T10:00:00.000Z';

const DIGEST_ID = `welfare_${DEFAULT_DATE_JST}`;

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

/** 当日の collect 実行記録。coverage(§9.1)の数字の元になる。 */
function collectRun(date: string = DEFAULT_DATE_JST): Run {
  return {
    id: `run-collect-${date}`,
    job: 'collect',
    startedAt: '2026-09-12T21:00:00.000Z',
    finishedAt: '2026-09-12T21:05:00.000Z',
    status: 'succeeded',
    counts: { ...emptyCounts(), sourcesTotal: 4, sourcesSucceeded: 4 },
    date,
    errors: [],
    expiresAt: '2026-12-11T21:00:00.000Z',
  };
}

/** 連番 URL のアイテム。既定ではウィンドウ内・分類済み・閾値以上。 */
function item(n: number, overrides: Partial<Item> = {}): Item {
  return makeItem({
    canonicalUrl: `https://www.mhlw.go.jp/stf/newpage_1000${n}.html`,
    title: `制度改正のお知らせ ${n}`,
    contentText: `制度改正のお知らせ ${n} の本文です。報酬改定の内容を記載しています。`,
    detectedAt: INSIDE,
    ...overrides,
  });
}

function setup(items: Item[], options: MakeContextOptions = {}): TestContext {
  const ctx = makeContext(options);
  ctx.store.seed({ items, runs: [collectRun()] });
  return ctx;
}

function digestOf(ctx: TestContext, id: string = DIGEST_ID): Digest {
  const found = ctx.store.dump().digests.find((d) => d.id === id);
  if (found === undefined) throw new Error(`ダイジェストが見つかりません: ${id}`);
  return found;
}

/** AI に渡された入力アイテムの id 集合(何を対象に選んだか)。 */
function aiInputIds(ctx: TestContext, callIndex = 0): string[] {
  return (ctx.ai.digestCalls[callIndex]?.items ?? []).map((i) => i.id).sort();
}

describe('runSummarize: 対象ウィンドウ(詳細設計書 §6.2)', () => {
  it('JST 07:00 カットオフの境界を厳密に切り分ける', async () => {
    // 対象日 2026-09-13 のウィンドウは JST 09-12 07:00 〜 09-13 07:00。
    expect(digestWindow(DEFAULT_DATE_JST, '07:00')).toEqual({ from: WINDOW_FROM, to: WINDOW_TO });

    // ウィンドウ前後のアイテムは「検知した翌日に配信済み」にしておく。
    // 未配信のものは繰り越し(CARRY_OVER_DAYS)で拾われ、
    // 配信後に更新されたものは再掲の対象になる仕様なので、
    // そのどちらでもない状態にしないとウィンドウ境界そのものを判定できない。
    // (検知より前の日付で配信済みにすると現実に起こり得ない状態になるので避ける)
    const justBefore = item(1, {
      detectedAt: '2026-09-11T21:59:59.999Z',
      digestedIn: ['welfare_2026-09-12'],
    });
    const atFrom = item(2, { detectedAt: WINDOW_FROM });
    const inside = item(3, { detectedAt: INSIDE });
    const justBeforeTo = item(4, { detectedAt: '2026-09-12T21:59:59.999Z' });
    const atTo = item(5, { detectedAt: WINDOW_TO, digestedIn: ['welfare_2026-09-13'] });

    const ctx = setup([justBefore, atFrom, inside, justBeforeTo, atTo]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    // from は含み(>= from)、to は含まない(< to)。
    expect(aiInputIds(ctx)).toEqual([atFrom.id, inside.id, justBeforeTo.id].sort());
    const digest = digestOf(ctx);
    expect(digest.entries.map((e) => e.itemId).sort()).toEqual(
      [atFrom.id, inside.id, justBeforeTo.id].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // 繰り越し(未配信のまま消えないこと)
  //
  // 件数上限・文字数上限・分類の遅れで本文に載らなかったアイテムは digestedIn が
  // 付かないまま翌日のウィンドウから外れ、放置すると二度と配信されない。
  // 「後手を踏まない」という本システムの目的に直接反するため、繰り越す。
  // -------------------------------------------------------------------------

  it('ウィンドウ前でも未配信なら繰り越して候補にする', async () => {
    const inWindow = item(1, { detectedAt: INSIDE });
    // ウィンドウ開始の 1 日前。まだどのダイジェストにも載っていない。
    const leftOver = item(2, { detectedAt: '2026-09-11T10:00:00.000Z', digestedIn: [] });

    const ctx = setup([inWindow, leftOver]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([inWindow.id, leftOver.id].sort());
  });

  it('このチャネルで配信済みのものは繰り越さない(再配信しない)', async () => {
    const inWindow = item(1, { detectedAt: INSIDE });
    const alreadySent = item(2, {
      detectedAt: '2026-09-11T10:00:00.000Z',
      digestedIn: ['welfare_2026-09-12'],
    });

    const ctx = setup([inWindow, alreadySent]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([inWindow.id]);
  });

  it('他チャネルでの配信は繰り越しを妨げない', async () => {
    const inWindow = item(1, { detectedAt: INSIDE });
    const sentOnOtherChannel = item(2, {
      detectedAt: '2026-09-11T10:00:00.000Z',
      digestedIn: ['ai_reskill_2026-09-12'],
    });

    const ctx = setup([inWindow, sentOnOtherChannel]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([inWindow.id, sentOnOtherChannel.id].sort());
  });

  // -------------------------------------------------------------------------
  // 更新の再掲は「遅らせる」ものであって「捨てる」ものではない
  //
  // 配信直後に更新された記事を 7 日ルールで弾いたまま忘れると、
  // 翌日以降は updatedAt がウィンドウ外になり二度と拾われない。
  // 報酬改定 Q&A の追補や様式差替えなど、見落とすと最も痛い更新がここに落ちる。
  // -------------------------------------------------------------------------

  it('配信直後の更新は当日は見送るが、7 日後に必ず再掲される', async () => {
    const base = {
      detectedAt: '2026-09-05T01:00:00.000Z',
      // 9/10 に配信済み。その後 9/11 に本文が更新され、再分類も済んでいる。
      digestedIn: ['welfare_2026-09-10'],
      updatedAt: '2026-09-11T02:00:00.000Z',
      classifiedAt: '2026-09-11T03:00:00.000Z',
    };

    // 9/13(最終配信から 3 日)はまだ見送る。
    const soon = setup([item(1, base)]);
    await runSummarize(soon, { date: '2026-09-13' });
    expect(aiInputIds(soon)).toEqual([]);

    // 9/17(最終配信から 7 日)で再掲される。更新が捨てられていないこと。
    const later = setup([item(1, base)], { clock: fixedClock('2026-09-16T23:00:00.000Z') });
    later.store.seed({ runs: [collectRun('2026-09-17')] });
    await runSummarize(later, { date: '2026-09-17' });
    expect(aiInputIds(later)).toEqual([item(1, base).id]);
  });

  it('更新されていない配信済み記事は 7 日経っても再掲しない', async () => {
    // updatedAt が最終配信日より前 = 配信後に何も変わっていない。
    const untouched = item(1, {
      detectedAt: '2026-09-05T01:00:00.000Z',
      updatedAt: '2026-09-05T01:00:00.000Z',
      classifiedAt: '2026-09-05T02:00:00.000Z',
      digestedIn: ['welfare_2026-09-10'],
    });

    const ctx = setup([untouched], { clock: fixedClock('2026-09-16T23:00:00.000Z') });
    ctx.store.seed({ runs: [collectRun('2026-09-17')] });
    await runSummarize(ctx, { date: '2026-09-17' });

    expect(aiInputIds(ctx)).toEqual([]);
  });

  it('force の作り直しで本文から外れた項目は「未配信」に戻る', async () => {
    // --force は障害からの復旧手段。作り直しで載らなくなった項目が配信済みのまま残ると、
    // 繰り越しの対象からも外れて永久に埋もれ、打つほど取りこぼしが増えてしまう。
    const kept = item(1, { detectedAt: INSIDE });
    const dropped = item(2, { detectedAt: INSIDE });

    // 1 回目: 2 件とも本文に載る。
    const ctx = setup([kept, dropped]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });
    for (const id of [kept.id, dropped.id]) {
      expect((await ctx.store.getItem(id))?.digestedIn).toContain(DIGEST_ID);
    }

    // 2 回目: maxItems を 1 に絞って作り直すと 1 件しか載らない。
    ctx.config.channels = ctx.config.channels.map((c) => (c.id === 'welfare' ? { ...c, maxItems: 1 } : c));
    await runSummarize(ctx, { date: DEFAULT_DATE_JST, force: true });

    const digest = digestOf(ctx);
    const usedIds = digest.entries.map((e) => e.itemId);
    expect(usedIds).toHaveLength(1);

    const unusedId = [kept.id, dropped.id].find((id) => !usedIds.includes(id));
    expect(unusedId).toBeDefined();
    // 載らなかった方は印が外れ、次回以降の候補に戻っている。
    expect((await ctx.store.getItem(unusedId as string))?.digestedIn).not.toContain(DIGEST_ID);
    // 載った方は印が付いたまま(再配信しない)。
    expect((await ctx.store.getItem(usedIds[0] as string))?.digestedIn).toContain(DIGEST_ID);
  });

  it('繰り越し期間より古いものは拾わない(無限に溜め込まない)', async () => {
    const inWindow = item(1, { detectedAt: INSIDE });
    // ウィンドウ開始の 4 日前 = CARRY_OVER_DAYS(3 日)より前。
    const tooOld = item(2, { detectedAt: '2026-09-07T10:00:00.000Z', digestedIn: [] });

    const ctx = setup([inWindow, tooOld]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([inWindow.id]);
  });

  it('関連度がしきい値未満のもの・未分類のもの・他チャネル向けのものは対象にしない', async () => {
    const target = item(1);
    const lowRelevance = item(2, { classification: makeClassification({ relevance: 0.59 }) });
    const unclassified = item(3, { classification: null, classifiedAt: null });
    const otherChannel = item(4, { classification: makeClassification({ channels: ['ai_reskill'] }) });

    const ctx = setup([target, lowRelevance, unclassified, otherChannel]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([target.id]);
    expect(digestOf(ctx).entries).toHaveLength(1);
  });

  it('当該ダイジェストで既に使ったアイテムは再利用しない', async () => {
    const target = item(1);
    const alreadyUsed = item(2, { digestedIn: [DIGEST_ID] });

    const ctx = setup([target, alreadyUsed]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([target.id]);
  });
});

describe('runSummarize: 自治体の転載除外(要件定義書 FR-18 / §5.4)', () => {
  it('同じウィンドウに国のアイテムがあるとき、転載の自治体アイテムを落とす', async () => {
    const national = item(1, { title: '国の通知', region: null });
    const municipal = item(2, {
      title: '大阪府による国通知の転載',
      region: '大阪府',
      sourceId: 'osaka_pref_shogai',
      classification: makeClassification({ isDuplicateOfNational: true }),
    });

    const ctx = setup([national, municipal]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([national.id]);
    expect(ctx.logger.find('info', '国の通知の転載とみなしたアイテムを除外しました')).toHaveLength(1);
  });

  it('国のアイテムが無い日は転載扱いでも落とさない(情報の欠落を防ぐ)', async () => {
    const municipal = item(2, {
      title: '大阪府による国通知の転載',
      region: '大阪府',
      sourceId: 'osaka_pref_shogai',
      classification: makeClassification({ isDuplicateOfNational: true }),
    });

    const ctx = setup([municipal]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([municipal.id]);
    expect(digestOf(ctx).entries).toHaveLength(1);
  });
});

describe('runSummarize: 更新記事の取り込み(FR-02 / 詳細設計書 §6.2 の B)', () => {
  /** detectedAt はウィンドウより前、updatedAt はウィンドウ内、という「更新された既知記事」。 */
  function updatedItem(n: number, overrides: Partial<Item> = {}): Item {
    return item(n, {
      detectedAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-12T09:00:00.000Z',
      classifiedAt: '2026-09-12T09:30:00.000Z',
      ...overrides,
    });
  }

  it('再分類済みの更新記事は候補に入り、再分類前のものは入らない', async () => {
    const reclassified = updatedItem(1);
    // classifiedAt < updatedAt: 内容が変わったのに古い判定のまま = まだ配信してはいけない。
    const stale = updatedItem(2, { classifiedAt: '2026-09-11T00:00:00.000Z' });

    const ctx = setup([reclassified, stale]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([reclassified.id]);
    expect(ctx.logger.find('info', '内容が更新された既知アイテムを候補に加えました')).toHaveLength(1);
  });

  it('直近 7 日以内に同じチャネルで配信済みなら再掲しない(8 日前なら再掲する)', async () => {
    // 2026-09-10 配信 = 対象日 2026-09-13 から 3 日前。再掲しない。
    const recentlyDelivered = updatedItem(1, { digestedIn: ['welfare_2026-09-10'] });
    // 2026-09-05 配信 = 8 日前。再掲してよい。
    const longAgo = updatedItem(2, { digestedIn: ['welfare_2026-09-05'] });
    // 別チャネルでの配信履歴は、このチャネルの再掲判断には影響しない。
    const otherChannelOnly = updatedItem(3, { digestedIn: ['ai_reskill_2026-09-12'] });

    const ctx = setup([recentlyDelivered, longAgo, otherChannelOnly]);
    await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    expect(aiInputIds(ctx)).toEqual([longAgo.id, otherChannelOnly.id].sort());
  });
});

describe('runSummarize: 0 件の日(FR-11 / 詳細設計書 §9.1)', () => {
  it('sendWhenEmpty=true なら isEmpty の digest を generated で作る', async () => {
    const ctx = setup([]);

    const run = await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    const digest = digestOf(ctx);
    expect(digest.isEmpty).toBe(true);
    expect(digest.status).toBe('generated');
    expect(digest.entries).toEqual([]);
    expect(digest.messageText).toContain('本日の新着はありません。');
    // FR-11a: 巡回実績を添えて「監視はしていた」ことを示す。
    expect(digest.messageText).toContain('(本日 06:05 時点で 4 ソースを確認しました)');
    expect(digest.coverage).toEqual({ total: 4, succeeded: 4, lastCollectedAtJst: '06:05' });
    // AI は呼ばない(監査上「呼ばなかった」ことが分かる状態にする)。
    expect(ctx.ai.digestCalls).toHaveLength(0);
    expect(digest.prompt).toBe('');
    expect(digest.rawResponse).toBe('');
    expect(digest.usage).toBeNull();
    expect(run.counts.digestsGenerated).toBe(1);
    expect(run.status).toBe('succeeded');
  });

  it('sendWhenEmpty=false なら status は skipped になる', async () => {
    const ctx = setup([], { channels: [makeChannel({ sendWhenEmpty: false })] });

    const run = await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    const digest = digestOf(ctx);
    expect(digest.status).toBe('skipped');
    expect(digest.isEmpty).toBe(true);
    expect(digest.messageText).toBe('');
    expect(run.counts.digestsGenerated).toBe(0);
    expect(run.counts.skipped).toBe(1);
  });
});

describe('runSummarize: 品質ゲートで全滅した日(誠実性の境界)', () => {
  it('元記事があったのに 1 件も通らなければ failed にし、「新着なし」として配信しない', async () => {
    const ctx = setup([item(1), item(2)]);
    // 入力に無い URL(幻覚)だけを返す AI。品質ゲート Q1 で全滅する。
    ctx.ai.setDigestEntries('welfare', (items) =>
      items.map((input) => ({
        itemId: input.id,
        headline: `${input.title}(捏造された出典)`,
        summary: '入力に存在しない URL を出典にした項目です。',
        affected: '事業所',
        dateNote: null,
        sourceUrl: 'https://www.example.com/hallucinated',
        importance: 'high' as const,
      })),
    );

    const run = await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    const digest = digestOf(ctx);
    expect(digest.status).toBe('failed');
    // 「新着なし」ではない。対象アイテムは存在した。
    expect(digest.isEmpty).toBe(false);
    expect(digest.messageText).toBe('');
    expect(digest.messageText).not.toContain('本日の新着はありません');
    expect(digest.entries).toEqual([]);
    expect(digest.excluded).toHaveLength(2);
    expect(digest.excluded.every((e) => e.check === 'Q1')).toBe(true);
    // 監査のため、失敗した回でも AI 応答は保存する(FR-16)。
    expect(digest.rawResponse).not.toBe('');

    expect(run.status).toBe('failed');
    expect(run.counts.sourcesFailed).toBe(1);
    expect(run.counts.digestsGenerated).toBe(0);
    expect(run.counts.excluded).toBe(2);

    const alerts = ctx.notifier.withTitle('ダイジェストを配信できません');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe('error');
  });
});

describe('runSummarize: 監査情報の保存(FR-16)', () => {
  it('prompt / rawResponse / model / usage / coverage / expiresAt を digest に残す', async () => {
    const ctx = setup([item(1), item(2)]);

    await runSummarize(ctx, { date: DEFAULT_DATE_JST });
    const digest = digestOf(ctx);

    expect(digest.model).toBe('claude-opus-5');
    expect(digest.prompt).toContain('channel=welfare');
    expect(digest.prompt).toContain(`date=${DEFAULT_DATE_JST}`);
    expect(JSON.parse(digest.rawResponse)).toMatchObject({ omittedCount: 0 });
    expect(digest.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 0,
    });
    expect(digest.coverage).toEqual({ total: 4, succeeded: 4, lastCollectedAtJst: '06:05' });
    // TTL は保持日数(90 日)後。監査期間の担保。
    expect(digest.expiresAt).toBe(addDays(DEFAULT_NOW, 90));
    expect(digest.createdAt).toBe(DEFAULT_NOW);
    expect(digest.date).toBe(DEFAULT_DATE_JST);
    expect(digest.channelId).toBe('welfare');

    // 実際に本文へ載った項目だけを「使用済み」にする。
    const used = ctx.store.dump().items.filter((i) => i.digestedIn.includes(DIGEST_ID));
    expect(used).toHaveLength(2);
  });
});

describe('runSummarize: 再実行(冪等と force)', () => {
  it('force 無しの再実行はスキップし、force 有りでは同じ対象で作り直す', async () => {
    const clock = mutableClock(DEFAULT_NOW);
    const ctx = setup([item(1), item(2)], { clock });

    await runSummarize(ctx, { date: DEFAULT_DATE_JST });
    const first = digestOf(ctx);
    expect(first.entries).toHaveLength(2);
    expect(ctx.ai.digestCalls).toHaveLength(1);

    // 2 回目(force 無し): 既にあるので作り直さない。
    clock.set('2026-09-12T23:00:00.000Z');
    const skipped = await runSummarize(ctx, { date: DEFAULT_DATE_JST });
    expect(skipped.counts.skipped).toBe(1);
    expect(skipped.counts.digestsGenerated).toBe(0);
    expect(ctx.ai.digestCalls).toHaveLength(1);
    expect(digestOf(ctx).updatedAt).toBe(first.updatedAt);

    // 3 回目(force 有り): 同じ対象アイテムで作り直す。
    clock.set('2026-09-13T00:00:00.000Z');
    const forced = await runSummarize(ctx, { date: DEFAULT_DATE_JST, force: true });
    const regenerated = digestOf(ctx);

    expect(forced.counts.digestsGenerated).toBe(1);
    expect(ctx.ai.digestCalls).toHaveLength(2);
    expect(aiInputIds(ctx, 1)).toEqual(aiInputIds(ctx, 0));
    expect(regenerated.entries).toHaveLength(2);
    expect(regenerated.isEmpty).toBe(false);
    expect(regenerated.messageText).not.toContain('本日の新着はありません');
    // 最初の生成時刻は保つ(監査の連続性)。更新時刻だけ進む。
    expect(regenerated.createdAt).toBe(first.createdAt);
    expect(regenerated.updatedAt).toBe('2026-09-13T00:00:00.000Z');
  });
});

describe('runSummarize: チャネルの独立性(NFR-01)', () => {
  it('1 チャネルの AI が例外を投げても、もう一方のチャネルは生成される', async () => {
    const both = makeClassification({ channels: ['ai_reskill', 'welfare'] });
    const ctx = setup([item(1, { classification: both }), item(2, { classification: both })], {
      channels: [
        makeChannel({ id: 'ai_reskill', name: 'AIリスキリング制度情報局', topics: '人材開発支援助成金' }),
        makeChannel(),
      ],
    });
    ctx.ai.setDigestFailure('ai_reskill', new AiError('AI 応答の取得に失敗しました', false));

    const run = await runSummarize(ctx, { date: DEFAULT_DATE_JST });

    // 失敗した側は digest を作らない(作りかけを配信対象にしない)。
    expect(ctx.store.dump().digests.map((d) => d.id)).toEqual([DIGEST_ID]);
    const welfare = digestOf(ctx);
    expect(welfare.status).toBe('generated');
    expect(welfare.entries).toHaveLength(2);

    expect(run.status).toBe('partial');
    expect(run.counts.sourcesTotal).toBe(2);
    expect(run.counts.sourcesSucceeded).toBe(1);
    expect(run.counts.sourcesFailed).toBe(1);
    expect(run.errors.some((e) => e.includes('ai_reskill'))).toBe(true);

    const alerts = ctx.notifier.withTitle('ダイジェスト生成に失敗しました');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe('error');
  });
});
