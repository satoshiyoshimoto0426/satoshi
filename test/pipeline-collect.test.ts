/**
 * collect ジョブの結合テスト(詳細設計書 §6.1 / §13「結合」、要件定義書 FR-02 / FR-03 / NFR-06)。
 *
 * 本物の fetchers / store / pipeline を通し、外部依存(HTTP・AI)だけをフェイクにする。
 * ここで守りたいのは次の 4 点。
 *  1. 同じページを何度巡回しても items が増えない(FR-03 の重複排除)。
 *  2. 更新は「更新」として検知され、再分類の対象に戻る(FR-02)。
 *  3. 取りこぼし・切り捨て・失敗を黙って捨てない(Run とログと通知に残る)。
 *  4. 1 ソースの事故が他ソースの取り込みを止めない。
 */

import { describe, expect, it } from 'vitest';

import { runCollect, shouldWarnAgain } from '../src/pipeline/collect.js';
import { HttpError, RobotsDisallowedError } from '../src/types.js';
import type { Item, SourceState } from '../src/types.js';
import { createFakeHttp, makeContext, makeListHtml, makeSource, mutableClock } from './helpers/fakes.js';
import type { FakeHttpClient, MakeContextOptions, TestContext } from './helpers/fakes.js';

const LIST_URL = 'https://www.mhlw.go.jp/stf/news.html';
const ARTICLE_A = 'https://www.mhlw.go.jp/stf/newpage_00001.html';
const ARTICLE_B = 'https://www.mhlw.go.jp/stf/newpage_00002.html';

const BODY_A =
  '令和8年度障害福祉サービス等報酬改定に関するQ&A(第3報)を公表しました。専門的支援実施加算の算定要件を明確化しています。';
const BODY_B =
  '就労選択支援の実施要綱の一部改正について通知しました。アセスメント様式を変更し、10月1日から適用します。';

/** 一覧 1 ページ + 記事 2 本の、標準的な HTML ソース環境を作る。 */
function setup(options: MakeContextOptions = {}): { ctx: TestContext; http: FakeHttpClient } {
  const http = createFakeHttp({
    lists: {
      [LIST_URL]: makeListHtml([
        { href: ARTICLE_A, text: '報酬改定Q&A(第3報)の公表について' },
        { href: ARTICLE_B, text: '就労選択支援 実施要綱の一部改正について' },
      ]),
    },
    articles: { [ARTICLE_A]: BODY_A, [ARTICLE_B]: BODY_B },
  });
  const ctx = makeContext({ http, ...options });
  return { ctx, http };
}

function itemOf(ctx: TestContext, canonicalUrl: string): Item {
  const found = ctx.store.dump().items.find((item) => item.canonicalUrl === canonicalUrl);
  if (found === undefined) throw new Error(`アイテムが見つかりません: ${canonicalUrl}`);
  return found;
}

/** 巡回状態の雛形。テストごとに必要な値だけ上書きする。 */
function makeState(overrides: Partial<SourceState> = {}): SourceState {
  return {
    sourceId: 'mhlw_news',
    lastFetchedAt: '2026-09-12T12:00:00.000Z',
    lastSuccessAt: '2026-09-12T12:00:00.000Z',
    consecutiveFailures: 0,
    etag: null,
    lastModified: null,
    lastError: null,
    lastNewCount: 0,
    lastCandidateCount: 0,
    consecutiveEmpty: 0,
    warnedAtFailureCount: 0,
    warnedAtEmptyCount: 0,
    ...overrides,
  };
}

describe('runCollect: 新着の取り込みと重複排除(FR-03)', () => {
  it('新規候補が items になり、本文と分類が保存される', async () => {
    const { ctx } = setup();

    const run = await runCollect(ctx);

    expect(run.job).toBe('collect');
    expect(run.status).toBe('succeeded');
    expect(run.counts.sourcesTotal).toBe(1);
    expect(run.counts.sourcesSucceeded).toBe(1);
    expect(run.counts.fetched).toBe(2);
    expect(run.counts.newItems).toBe(2);
    expect(run.counts.classified).toBe(2);
    expect(run.errors).toEqual([]);

    const items = ctx.store.dump().items;
    expect(items).toHaveLength(2);

    const a = itemOf(ctx, ARTICLE_A);
    expect(a.sourceId).toBe('mhlw_news');
    expect(a.title).toBe('報酬改定Q&A(第3報)の公表について');
    expect(a.contentText).toContain('専門的支援実施加算');
    expect(a.contentType).toBe('html');
    expect(a.detectedAt).toBe('2026-09-12T22:30:00.000Z');
    expect(a.classification).not.toBeNull();
    expect(a.classifiedAt).not.toBeNull();
    expect(a.digestedIn).toEqual([]);
  });

  it('2 回続けて実行しても items は増えない(同一情報の再取り込みをしない)', async () => {
    const { ctx, http } = setup();

    const first = await runCollect(ctx);
    const idsAfterFirst = ctx.store
      .dump()
      .items.map((item) => item.id)
      .sort();
    const articleFetches = http.getCount(ARTICLE_A);

    const second = await runCollect(ctx);
    const idsAfterSecond = ctx.store
      .dump()
      .items.map((item) => item.id)
      .sort();

    expect(first.counts.newItems).toBe(2);
    expect(second.counts.newItems).toBe(0);
    // 本文が変わっていないので「更新」にはならない。
    expect(second.counts.updatedItems).toBe(0);
    expect(idsAfterSecond).toEqual(idsAfterFirst);
    expect(ctx.store.dump().items).toHaveLength(2);
    // 定期再チェック(recheckPerSource)で本文は取り直されるが、
    // 1 巡回あたりの件数は上限で抑えられている(NFR-07: 相手サイトへの負荷)。
    const extra = http.getCount(ARTICLE_A) - articleFetches;
    expect(extra).toBeGreaterThanOrEqual(0);
    expect(extra).toBeLessThanOrEqual(ctx.config.runtime.recheckPerSource);
  });

  it('再チェックの上限が 0 なら既知 URL を取り直さない(負荷を完全に止められる)', async () => {
    const { ctx, http } = setup({ runtime: { recheckPerSource: 0 } });

    await runCollect(ctx);
    const before = http.getCount(ARTICLE_A);
    await runCollect(ctx);

    expect(http.getCount(ARTICLE_A)).toBe(before);
  });

  it('一覧の見出しが変わらないまま本文だけ差し替わった更新を検知する(FR-02)', async () => {
    // 官公庁の典型パターン: 「◯◯について」のリンク文字列はそのままで、
    // ページ本体に Q&A 第3報や新様式が追記される。
    // 一覧の変化だけを見ていると永久に検知できず、更新が誰にも届かない。
    const clock = mutableClock('2026-09-12T21:00:00.000Z');
    const { ctx, http } = setup({ clock });

    await runCollect(ctx, { skipClassify: true });
    const before = itemOf(ctx, ARTICLE_A);

    // 一覧は一切変えず、本文だけ差し替える。
    clock.set('2026-09-13T03:00:00.000Z');
    http.setArticle(ARTICLE_A, `${BODY_A} 第4報を追加で公表しました。`);

    const run = await runCollect(ctx, { skipClassify: true });
    const after = itemOf(ctx, ARTICLE_A);

    expect(run.counts.updatedItems).toBe(1);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.updatedAt).toBe('2026-09-13T03:00:00.000Z');
    // 再分類の対象に戻る。
    expect(after.classification).toBeNull();
    expect(after.classifiedAt).toBeNull();
    // 初検知時刻は据え置く。
    expect(after.detectedAt).toBe(before.detectedAt);
  });

  it('utm 付き・http スキームの重複リンクは正規化で 1 件に集約される', async () => {
    const http = createFakeHttp({
      lists: {
        [LIST_URL]: makeListHtml([
          { href: `${ARTICLE_A}?utm_source=mailmag&utm_medium=email`, text: '報酬改定Q&A(第3報)' },
          { href: 'http://www.mhlw.go.jp/stf/newpage_00001.html', text: '報酬改定Q&A(第3報)' },
          { href: `${ARTICLE_A}#section2`, text: '報酬改定Q&A(第3報)' },
        ]),
      },
      articles: { [ARTICLE_A]: BODY_A },
    });
    const ctx = makeContext({ http });

    const run = await runCollect(ctx);

    expect(run.counts.fetched).toBe(3);
    expect(run.counts.newItems).toBe(1);
    const items = ctx.store.dump().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.canonicalUrl).toBe(ARTICLE_A);
  });
});

describe('runCollect: 既知 URL の更新検知(FR-02 / 詳細設計書 §6.1 の 6)', () => {
  it('本文が変わると classification / classifiedAt が null に戻り updatedAt が進む', async () => {
    const clock = mutableClock('2026-09-12T21:00:00.000Z');
    const { ctx, http } = setup({ clock });

    await runCollect(ctx);
    const before = itemOf(ctx, ARTICLE_A);
    expect(before.classification).not.toBeNull();
    expect(before.classifiedAt).not.toBeNull();

    // 一覧の見出しが変わり、本文も差し替わった(= 記事が更新された)状態を作る。
    clock.set('2026-09-13T03:00:00.000Z');
    http.setList(
      LIST_URL,
      makeListHtml([
        { href: ARTICLE_A, text: '報酬改定Q&A(第3報)の公表について(第4報を追加)' },
        { href: ARTICLE_B, text: '就労選択支援 実施要綱の一部改正について' },
      ]),
    );
    http.setArticle(ARTICLE_A, `${BODY_A} 第4報を追加で公表しました。`);

    // 分類を挟まずに「更新直後」の状態を観測する(分類まで走ると再分類済みになるため)。
    const run = await runCollect(ctx, { skipClassify: true });
    const after = itemOf(ctx, ARTICLE_A);

    expect(run.counts.updatedItems).toBe(1);
    expect(run.counts.newItems).toBe(0);
    expect(after.classification).toBeNull();
    expect(after.classifiedAt).toBeNull();
    expect(after.updatedAt).toBe('2026-09-13T03:00:00.000Z');
    // 初検知時刻は据え置く(詳細設計書 §5.1)。
    expect(after.detectedAt).toBe(before.detectedAt);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.title).toBe('報酬改定Q&A(第3報)の公表について(第4報を追加)');
    // digestedIn は消さない(同じ記事を再配信しないため)。
    expect(after.digestedIn).toEqual(before.digestedIn);

    // 次の巡回で再分類され、classifiedAt が updatedAt 以降になる(= 更新分が配信候補に戻る)。
    clock.set('2026-09-13T04:00:00.000Z');
    await runCollect(ctx);
    const reclassified = itemOf(ctx, ARTICLE_A);
    expect(reclassified.classification).not.toBeNull();
    expect(reclassified.classifiedAt).not.toBeNull();
    expect(String(reclassified.classifiedAt) >= reclassified.updatedAt).toBe(true);
  });

  it('見出しだけが変わり本文が同じなら分類は維持される(無駄な再分類をしない)', async () => {
    const clock = mutableClock('2026-09-12T21:00:00.000Z');
    const { ctx, http } = setup({ clock });

    await runCollect(ctx);
    const before = itemOf(ctx, ARTICLE_A);

    clock.set('2026-09-13T03:00:00.000Z');
    http.setList(
      LIST_URL,
      makeListHtml([
        { href: ARTICLE_A, text: '報酬改定Q&A(第3報)の公表について ' },
        { href: ARTICLE_B, text: '就労選択支援 実施要綱の一部改正について' },
      ]),
    );

    const run = await runCollect(ctx, { skipClassify: true });
    const after = itemOf(ctx, ARTICLE_A);

    expect(run.counts.updatedItems).toBe(0);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.classification).not.toBeNull();
    expect(after.classifiedAt).toBe(before.classifiedAt);
  });
});

describe('runCollect: 新規上限の切り捨て(詳細設計書 §6.1)', () => {
  it('maxNewItemsPerSource を超えた候補は取り込まれず、件数が Run とログに残る', async () => {
    const links = [1, 2, 3, 4, 5].map((n) => ({
      href: `https://www.mhlw.go.jp/stf/newpage_1000${n}.html`,
      text: `新着のお知らせ ${n}`,
    }));
    const http = createFakeHttp({ lists: { [LIST_URL]: makeListHtml(links) } });
    for (const link of links)
      http.setArticle(link.href, `${link.text}の本文です。制度改正の内容を記載しています。`);
    const ctx = makeContext({ http, runtime: { maxNewItemsPerSource: 2 } });

    const run = await runCollect(ctx);

    expect(run.counts.newItems).toBe(2);
    expect(ctx.store.dump().items).toHaveLength(2);
    // 黙って捨てない: 繰り越した件数を Run の counts / errors とログの両方に残す。
    expect(run.counts.skipped).toBe(3);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toContain('新規候補 5 件');
    expect(run.errors[0]).toContain('3 件を今回は取り込みませんでした');
    expect(run.status).toBe('partial');

    const warned = ctx.logger.find('warn', '新規候補が 1 回の上限を超えました');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields.deferred).toBe(3);
    expect(warned[0]?.fields.limit).toBe(2);
    expect(warned[0]?.fields.candidates).toBe(5);
  });
});

describe('runCollect: 失敗の隔離と記録', () => {
  it('1 ソースが例外を投げても他ソースの取り込みは完了し、Run は partial になる', async () => {
    const cfaList = 'https://www.cfa.go.jp/news.html';
    const cfaArticle = 'https://www.cfa.go.jp/policies/shougaijishien/00001.html';
    const http = createFakeHttp({
      lists: { [cfaList]: makeListHtml([{ href: cfaArticle, text: '障害児支援に関する新着' }]) },
      articles: { [cfaArticle]: '児童発達支援ガイドラインの改正について周知します。' },
    });
    http.setError(LIST_URL, new HttpError(503, LIST_URL, 'HTTP 503: サーバが応答しません'));

    const ctx = makeContext({
      http,
      sources: [makeSource(), makeSource({ id: 'cfa_news', name: 'こども家庭庁 新着情報', url: cfaList })],
    });

    const run = await runCollect(ctx);

    expect(run.status).toBe('partial');
    expect(run.counts.sourcesTotal).toBe(2);
    expect(run.counts.sourcesSucceeded).toBe(1);
    expect(run.counts.sourcesFailed).toBe(1);
    // 失敗した側のアイテムは無いが、成功した側は取り込めている。
    const items = ctx.store.dump().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.canonicalUrl).toBe(cfaArticle);

    expect(run.errors.some((e) => e.includes('mhlw_news'))).toBe(true);
    const failedState = ctx.store.dump().sourceStates.find((s) => s.sourceId === 'mhlw_news');
    expect(failedState?.consecutiveFailures).toBe(1);
    expect(failedState?.lastError).toContain('503');
    expect(failedState?.lastSuccessAt).toBeNull();
    expect(ctx.notifier.withTitle('巡回に失敗したソースがあります')).toHaveLength(1);
  });

  it('robots.txt 不許可のソースはスキップされ、失敗として数えられる', async () => {
    const cfaList = 'https://www.cfa.go.jp/news.html';
    const cfaArticle = 'https://www.cfa.go.jp/policies/shougaijishien/00001.html';
    const http = createFakeHttp({
      lists: { [cfaList]: makeListHtml([{ href: cfaArticle, text: '障害児支援に関する新着' }]) },
      articles: { [cfaArticle]: '児童発達支援ガイドラインの改正について周知します。' },
    });
    http.setError(LIST_URL, new RobotsDisallowedError(LIST_URL));

    const ctx = makeContext({
      http,
      sources: [makeSource(), makeSource({ id: 'cfa_news', name: 'こども家庭庁 新着情報', url: cfaList })],
    });

    const run = await runCollect(ctx);

    expect(run.counts.sourcesFailed).toBe(1);
    expect(run.counts.sourcesSucceeded).toBe(1);
    expect(run.status).toBe('partial');
    expect(ctx.logger.find('warn', 'robots.txt により取得が許可されていない')).toHaveLength(1);

    const state = ctx.store.dump().sourceStates.find((s) => s.sourceId === 'mhlw_news');
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.lastError).toContain('robots.txt');
    // 取り込みは一切行われない。
    expect(ctx.store.dump().items.every((item) => item.sourceId === 'cfa_news')).toBe(true);
  });
});

describe('runCollect: 連続失敗の通知(詳細設計書 §12)', () => {
  it('連続失敗が 3 回に達した回に警告を通知する', async () => {
    const http = createFakeHttp({});
    http.setError(LIST_URL, new HttpError(500, LIST_URL, 'HTTP 500: 内部エラー'));
    const ctx = makeContext({ http });
    ctx.store.seed({ sourceStates: [makeState({ consecutiveFailures: 2, warnedAtFailureCount: 0 })] });

    await runCollect(ctx);

    const warnings = ctx.notifier.withTitle('ソースの連続失敗');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe('warn');
    expect(warnings[0]?.lines.some((line) => line.includes('3 回連続'))).toBe(true);

    const state = ctx.store.dump().sourceStates.find((s) => s.sourceId === 'mhlw_news');
    expect(state?.consecutiveFailures).toBe(3);
    expect(state?.warnedAtFailureCount).toBe(3);
  });

  it('同じ失敗回数では重複通知しない(warnedAtFailureCount による抑止)', async () => {
    const http = createFakeHttp({});
    http.setError(LIST_URL, new HttpError(500, LIST_URL, 'HTTP 500: 内部エラー'));
    const ctx = makeContext({ http });
    // 「失敗 3 回目で既に通知済み」の状態。次の失敗も 3 回目扱いなら通知しない。
    ctx.store.seed({ sourceStates: [makeState({ consecutiveFailures: 2, warnedAtFailureCount: 3 })] });

    await runCollect(ctx);

    expect(ctx.notifier.withTitle('ソースの連続失敗')).toHaveLength(0);
    const state = ctx.store.dump().sourceStates.find((s) => s.sourceId === 'mhlw_news');
    expect(state?.consecutiveFailures).toBe(3);
    expect(state?.warnedAtFailureCount).toBe(3);
  });

  it('復旧すると consecutiveFailures と warnedAtFailureCount が 0 に戻る', async () => {
    const { ctx } = setup();
    ctx.store.seed({
      sourceStates: [makeState({ consecutiveFailures: 3, warnedAtFailureCount: 3, lastError: 'HTTP 500' })],
    });

    const run = await runCollect(ctx);

    expect(run.status).toBe('succeeded');
    const state = ctx.store.dump().sourceStates.find((s) => s.sourceId === 'mhlw_news');
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.warnedAtFailureCount).toBe(0);
    expect(state?.lastError).toBeNull();
    expect(state?.lastNewCount).toBe(2);
    expect(ctx.notifier.withTitle('ソースの連続失敗')).toHaveLength(0);
  });
});

describe('runCollect: bootstrap と 304', () => {
  it('bootstrap では本文を取得せず、既知化の分類を付けて未分類を 0 にする', async () => {
    const { ctx, http } = setup();

    const run = await runCollect(ctx, { bootstrap: true });

    expect(run.counts.newItems).toBe(2);
    // 記事本文へのアクセスは 1 度も行わない(初回の大量取得を避ける)。
    expect(http.getCount(ARTICLE_A)).toBe(0);
    expect(http.getCount(ARTICLE_B)).toBe(0);
    expect(http.getCount(LIST_URL)).toBe(1);

    const item = itemOf(ctx, ARTICLE_A);
    expect(item.contentText).toBe('');
    expect(item.classifiedAt).toBe('2026-09-12T22:30:00.000Z');
    expect(item.classification).not.toBeNull();
    expect(item.classification?.relevance).toBe(0);
    expect(item.classification?.channels).toEqual([]);

    // 既知扱いなので AI 分類は走らず、未分類も残らない。
    expect(ctx.ai.classifyCalls).toHaveLength(0);
    expect(await ctx.store.listUnclassifiedItems(10)).toEqual([]);
    expect(run.counts.classified).toBe(0);
  });

  it('304(未更新)は新規 0 件の成功として扱い、etag を保持する', async () => {
    const http = createFakeHttp({
      lists: {
        [LIST_URL]: {
          html: makeListHtml([{ href: ARTICLE_A, text: '報酬改定Q&A(第3報)の公表について' }]),
          etag: 'W/"list-v1"',
          lastModified: 'Sat, 12 Sep 2026 21:00:00 GMT',
        },
      },
      articles: { [ARTICLE_A]: BODY_A },
    });
    const ctx = makeContext({ http });

    const first = await runCollect(ctx);
    expect(first.counts.newItems).toBe(1);
    expect(ctx.store.dump().sourceStates[0]?.etag).toBe('W/"list-v1"');

    const second = await runCollect(ctx);

    expect(second.status).toBe('succeeded');
    expect(second.counts.sourcesSucceeded).toBe(1);
    expect(second.counts.fetched).toBe(0);
    expect(second.counts.newItems).toBe(0);
    expect(ctx.store.dump().items).toHaveLength(1);
    expect(ctx.logger.find('info', '前回から更新がありません(304)')).toHaveLength(1);

    const state = ctx.store.dump().sourceStates.find((s) => s.sourceId === 'mhlw_news');
    expect(state?.etag).toBe('W/"list-v1"');
    expect(state?.lastModified).toBe('Sat, 12 Sep 2026 21:00:00 GMT');
    expect(state?.lastNewCount).toBe(0);
    expect(state?.consecutiveFailures).toBe(0);
  });
});

describe('runCollect: 実行記録(NFR-06)', () => {
  it('Run を開始時(running)と終了時の 2 回書き込む', async () => {
    const { ctx } = setup();

    const run = await runCollect(ctx);

    expect(ctx.store.runWrites).toHaveLength(2);
    const [started, finished] = ctx.store.runWrites;
    expect(started?.id).toBe(run.id);
    expect(started?.status).toBe('running');
    expect(started?.finishedAt).toBeNull();
    // coverage(§9.1)が読むため、開始時点で対象ソース数が埋まっていること。
    expect(started?.counts.sourcesTotal).toBe(1);

    expect(finished?.id).toBe(run.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.finishedAt).not.toBeNull();
    expect(finished?.date).toBe('2026-09-13');
    expect(ctx.store.dump().runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 静かな故障の検知(要件 G5)
//
// HTTP は 200 なのに一覧から候補リンクが 1 件も取れない = セレクタ失効の疑い。
// これを「成功」として記録すると consecutiveFailures は 0 のままで health にも
// Slack にも出ず、受信者には「正常に監視した結果、新着なし」と配信されてしまう。
// 本番ソース 45 件のうち 42 件が HTML セレクタ依存なので、ここが塞がっていないと
// 見落としに気づく手段が無くなる。
// ---------------------------------------------------------------------------

describe('runCollect: 候補 0 件(セレクタ失効)の検知', () => {
  function emptySetup(): { ctx: TestContext; http: FakeHttpClient } {
    const http = createFakeHttp({ lists: { [LIST_URL]: makeListHtml([]) } });
    const ctx = makeContext({ http });
    return { ctx, http };
  }

  it('候補 0 件でも失敗にはせず、consecutiveEmpty を進める', async () => {
    const { ctx } = emptySetup();

    const run = await runCollect(ctx, { skipClassify: true });

    expect(run.status).toBe('succeeded');
    expect(run.counts.sourcesFailed).toBe(0);

    const state = await ctx.store.getSourceState('mhlw_news');
    expect(state?.consecutiveEmpty).toBe(1);
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.lastCandidateCount).toBe(0);
  });

  it('候補が取れたら consecutiveEmpty は 0 に戻る', async () => {
    const { ctx, http } = emptySetup();
    await runCollect(ctx, { skipClassify: true });
    expect((await ctx.store.getSourceState('mhlw_news'))?.consecutiveEmpty).toBe(1);

    http.setList(LIST_URL, makeListHtml([{ href: ARTICLE_A, text: '報酬改定Q&A(第3報)の公表について' }]));
    http.setArticle(ARTICLE_A, BODY_A);
    await runCollect(ctx, { skipClassify: true });

    const state = await ctx.store.getSourceState('mhlw_news');
    expect(state?.consecutiveEmpty).toBe(0);
    expect(state?.lastCandidateCount).toBe(1);
  });

  it('4 回連続(= まる 1 日)で警告を通知する。3 回目までは通知しない', async () => {
    const { ctx } = emptySetup();

    for (let i = 0; i < 3; i += 1) await runCollect(ctx, { skipClassify: true });
    expect(ctx.notifier.calls.filter((c) => c.title.includes('候補が取れない'))).toHaveLength(0);

    await runCollect(ctx, { skipClassify: true });

    const warned = ctx.notifier.calls.filter((c) => c.title.includes('候補が取れない'));
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe('warn');
    expect(warned[0]?.lines.join('\n')).toContain('verify-sources');
    expect((await ctx.store.getSourceState('mhlw_news'))?.consecutiveEmpty).toBe(4);
  });

  it('304(未更新)は候補 0 件でも異常としない', async () => {
    const http = createFakeHttp({ lists: { [LIST_URL]: { status: 304, html: '' } } });
    const ctx = makeContext({ http });

    await runCollect(ctx, { skipClassify: true });

    const state = await ctx.store.getSourceState('mhlw_news');
    expect(state?.consecutiveEmpty).toBe(0);
  });
});

describe('shouldWarnAgain: 連続失敗の通知抑制', () => {
  // 壊れたソースは直すまで毎回失敗する。巡回は 1 日 4 回なので、毎回通知すると
  // 42 本壊れている状態で 1 日 168 通になり、本当に見るべき 1 通が埋もれる。
  // かといって初回だけにすると悪化に気づけないので、回数が倍になったときだけ出す。
  const THRESHOLD = 3;

  it('しきい値に達したら 1 通目を出す', () => {
    expect(shouldWarnAgain(3, THRESHOLD, 0)).toBe(true);
  });

  it('しきい値未満では出さない', () => {
    expect(shouldWarnAgain(1, THRESHOLD, 0)).toBe(false);
    expect(shouldWarnAgain(2, THRESHOLD, 0)).toBe(false);
  });

  it('同じ故障の繰り返しでは出さない', () => {
    expect(shouldWarnAgain(4, THRESHOLD, 3)).toBe(false);
    expect(shouldWarnAgain(5, THRESHOLD, 3)).toBe(false);
  });

  it('回数が倍になったら悪化として再度出す', () => {
    expect(shouldWarnAgain(6, THRESHOLD, 3)).toBe(true);
    expect(shouldWarnAgain(12, THRESHOLD, 6)).toBe(true);
    expect(shouldWarnAgain(24, THRESHOLD, 12)).toBe(true);
  });

  it('1 か月壊れ続けても通知は数通に収まる', () => {
    // 1 日 4 回 × 30 日 = 120 回の失敗。
    let warned = 0;
    let warnedAt = 0;
    for (let n = 1; n <= 120; n += 1) {
      if (shouldWarnAgain(n, THRESHOLD, warnedAt)) {
        warned += 1;
        warnedAt = n;
      }
    }
    // 毎回通知なら 118 通。抑制が効いていることを数で確かめる。
    expect(warned).toBeLessThanOrEqual(7);
    // 完全に黙ってしまっては「まだ直っていない」ことが伝わらない。
    expect(warned).toBeGreaterThanOrEqual(5);
  });
});
