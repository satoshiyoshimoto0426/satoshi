/**
 * collect → summarize → deliver の通し結合テスト(詳細設計書 §13「結合」)。
 *
 * 実装は本物、外部(HTTP / AI / LINE / 通知)だけがフェイク。
 * ここで最終的に確かめたいのは「LINE に届いた 1 通のテキスト」そのものであり、
 * 次の 4 点が守られていること。
 *  - 全項目に出典 URL が付いている(要件定義書 G2 / FR-06)
 *  - 出典は AI へ渡した入力にあった URL だけ(G4 / 品質ゲート Q1: 幻覚を配信しない)
 *  - LINE 上限 5,000 文字以内かつ channel.maxChars 以内(FR-09)
 *  - 何周実行しても配信は 1 回(FR-12)
 */

import { describe, expect, it } from 'vitest';

import { runCollect } from '../src/pipeline/collect.js';
import { runDeliver } from '../src/pipeline/deliver.js';
import { runSummarize } from '../src/pipeline/summarize.js';
import type { Digest } from '../src/types.js';
import { fixedClock } from '../src/util/clock.js';
import {
  createFakeAi,
  createFakeHttp,
  createFakeLine,
  createTestStore,
  makeContext,
  makeListHtml,
  mutableClock,
} from './helpers/fakes.js';
import type { FakeHttpClient, TestContext } from './helpers/fakes.js';

const LIST_URL = 'https://www.mhlw.go.jp/stf/news.html';
const ARTICLE_1 = 'https://www.mhlw.go.jp/stf/newpage_00001.html';
const ARTICLE_2 = 'https://www.mhlw.go.jp/stf/newpage_00002.html';
const ARTICLE_3 = 'https://www.mhlw.go.jp/stf/newpage_00003.html';

const ARTICLES: Array<{ url: string; title: string; body: string }> = [
  {
    url: ARTICLE_1,
    title: '令和8年度 障害福祉サービス等報酬改定Q&A(第3報)',
    body: '専門的支援実施加算の算定要件を明確化しました。令和8年4月1日から適用します。',
  },
  {
    url: ARTICLE_2,
    title: '就労選択支援 実施要綱の一部改正について',
    body: 'アセスメント様式を変更しました。令和8年10月1日から適用します。',
  },
  {
    url: ARTICLE_3,
    title: '児童福祉法施行規則の一部改正(案)に関する意見募集',
    body: '意見募集は令和8年9月30日までです。提出方法は別紙のとおりです。',
  },
];

/** JST の時刻 → UTC の ISO(JST 2026-09-13 のスケジュールを再現するため)。 */
const AT_COLLECT = '2026-09-12T21:00:00.000Z'; // JST 09-13 06:00
const AT_SUMMARIZE = '2026-09-12T22:00:00.000Z'; // JST 09-13 07:00
const AT_DELIVER = '2026-09-12T22:30:00.000Z'; // JST 09-13 07:30
const DATE_JST = '2026-09-13';
const DIGEST_ID = `welfare_${DATE_JST}`;

function fakeSite(links = ARTICLES): FakeHttpClient {
  const http = createFakeHttp({
    lists: { [LIST_URL]: makeListHtml(links.map((a) => ({ href: a.url, text: a.title }))) },
  });
  for (const article of links) http.setArticle(article.url, article.body);
  return http;
}

function digestOf(ctx: TestContext, id: string = DIGEST_ID): Digest {
  const found = ctx.store.dump().digests.find((d) => d.id === id);
  if (found === undefined) throw new Error(`ダイジェストが見つかりません: ${id}`);
  return found;
}

/** 本文に含まれる URL をすべて取り出す。 */
function urlsIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s]+/g) ?? [];
}

describe('パイプライン通し実行: 通常の朝(FR-05 / FR-06 / FR-09 / FR-10)', () => {
  it('LINE 本文に全項目の出典 URL が載り、文字数上限を守る', async () => {
    const clock = mutableClock(AT_COLLECT);
    const ctx = makeContext({ clock, http: fakeSite() });

    const collectRun = await runCollect(ctx);
    expect(collectRun.counts.newItems).toBe(3);
    expect(collectRun.counts.classified).toBe(3);

    clock.set(AT_SUMMARIZE);
    const summarizeRun = await runSummarize(ctx);
    expect(summarizeRun.counts.digestsGenerated).toBe(1);

    clock.set(AT_DELIVER);
    const deliverRun = await runDeliver(ctx);
    expect(deliverRun.counts.sent).toBe(1);

    const text = ctx.line.lastText();
    const digest = digestOf(ctx);
    expect(digest.entries).toHaveLength(3);
    expect(ctx.line.calls).toHaveLength(1);

    // G2 / FR-06: 全項目に出典 URL が付き、本文に現れる。
    for (const entry of digest.entries) {
      expect(entry.sourceUrl).not.toBe('');
      expect(text).toContain(entry.headline);
      expect(text).toContain(entry.summary);
      expect(text).toContain(`出典: ${entry.sourceUrl}`);
    }
    for (const article of ARTICLES) {
      expect(text).toContain(article.url);
    }

    // FR-09: LINE の物理上限とチャネル設定の両方を満たす。
    const channel = ctx.config.channels[0];
    const length = [...text].length;
    expect(length).toBeLessThanOrEqual(5000);
    expect(length).toBeLessThanOrEqual(channel?.maxChars ?? 0);
    expect(text).toContain('※本まとめはAIが公的情報を要約したものです。');
  });

  it('出典 URL は AI に渡した入力に含まれていた URL だけ(幻覚が混ざらない)', async () => {
    const clock = mutableClock(AT_COLLECT);
    const ctx = makeContext({ clock, http: fakeSite() });

    await runCollect(ctx);
    clock.set(AT_SUMMARIZE);
    await runSummarize(ctx);
    clock.set(AT_DELIVER);
    await runDeliver(ctx);

    const inputUrls = new Set(ctx.ai.lastDigestInputUrls());
    expect(inputUrls.size).toBe(3);

    const delivered = urlsIn(ctx.line.lastText());
    expect(delivered).toHaveLength(3);
    for (const url of delivered) {
      expect(inputUrls.has(url)).toBe(true);
    }
  });

  it('全パイプラインを 2 周実行しても LINE 送信は 1 回だけ(FR-12)', async () => {
    const clock = mutableClock(AT_COLLECT);
    const ctx = makeContext({ clock, http: fakeSite() });

    await runCollect(ctx);
    clock.set(AT_SUMMARIZE);
    await runSummarize(ctx);
    clock.set(AT_DELIVER);
    await runDeliver(ctx);

    // 同じ JST 日付のうちに、もう一度 3 ジョブを流す(手動再実行・スケジューラの再試行)。
    clock.set('2026-09-13T03:00:00.000Z'); // JST 09-13 12:00
    const collectAgain = await runCollect(ctx);
    clock.set('2026-09-13T03:05:00.000Z');
    const summarizeAgain = await runSummarize(ctx);
    clock.set('2026-09-13T03:10:00.000Z');
    const deliverAgain = await runDeliver(ctx);

    expect(collectAgain.counts.newItems).toBe(0);
    expect(summarizeAgain.counts.skipped).toBe(1);
    expect(summarizeAgain.counts.digestsGenerated).toBe(0);
    expect(deliverAgain.counts.sent).toBe(0);
    expect(deliverAgain.counts.skipped).toBe(1);

    expect(ctx.line.calls).toHaveLength(1);
    expect(ctx.store.dump().items).toHaveLength(3);
    expect(ctx.store.dump().deliveries).toHaveLength(1);
  });
});

describe('パイプライン通し実行: 幻覚の遮断(品質ゲート Q1 / G4)', () => {
  it('AI が入力に無い URL を返した項目は配信本文に現れない', async () => {
    const clock = mutableClock(AT_COLLECT);
    const ctx = makeContext({ clock, http: fakeSite() });

    // 1 件だけ、入力に無い URL と見出しにすり替える AI。
    ctx.ai.setDigestEntries('welfare', (items) =>
      items.map((input) =>
        input.url === ARTICLE_2
          ? {
              itemId: input.id,
              headline: '架空の通知(出典を捏造した項目)',
              summary: '入力に存在しない URL を出典に付けた項目です。',
              affected: '事業所',
              dateNote: null,
              sourceUrl: 'https://www.example.com/not-in-input',
              importance: 'high' as const,
            }
          : {
              itemId: input.id,
              headline: input.title,
              summary: `${input.title}の内容が公表されました。`,
              affected: '事業所',
              dateNote: null,
              sourceUrl: input.url,
              importance: input.importance,
            },
      ),
    );

    await runCollect(ctx);
    clock.set(AT_SUMMARIZE);
    await runSummarize(ctx);
    clock.set(AT_DELIVER);
    await runDeliver(ctx);

    const text = ctx.line.lastText();
    const digest = digestOf(ctx);

    // 捏造項目は配信されない。
    expect(text).not.toContain('https://www.example.com/not-in-input');
    expect(text).not.toContain('架空の通知');
    expect(digest.entries.map((e) => e.sourceUrl)).not.toContain('https://www.example.com/not-in-input');

    // すり替えられた項目の出典(本来の URL)も配信されない。
    expect(text).not.toContain(ARTICLE_2);
    // 残り 2 件は通常どおり配信される。
    expect(digest.entries).toHaveLength(2);
    expect(text).toContain(ARTICLE_1);
    expect(text).toContain(ARTICLE_3);

    // 除外は黙って行わず、理由付きで記録・通知する。
    expect(digest.excluded).toHaveLength(1);
    expect(digest.excluded[0]?.check).toBe('Q1');
    expect(ctx.notifier.withTitle('品質ゲートで 1 件を除外しました')).toHaveLength(1);
    // 落とした分は「その他の新着 N 件」として受信者にも件数で伝える(FR-07)。
    expect(text).toContain('その他の新着 1 件は管理画面で確認できます。');
  });

  it('出典 URL に到達できない項目は配信されない(FR-08 / Q2)', async () => {
    const clock = mutableClock(AT_COLLECT);
    const http = fakeSite();
    // 記事は取得できたが、配信直前の到達確認で 404 になったページ。
    http.setReachable(ARTICLE_2, { ok: false, status: 404, error: null });
    const ctx = makeContext({ clock, http });

    await runCollect(ctx);
    clock.set(AT_SUMMARIZE);
    await runSummarize(ctx);
    clock.set(AT_DELIVER);
    await runDeliver(ctx);

    const text = ctx.line.lastText();
    const digest = digestOf(ctx);

    expect(text).not.toContain(ARTICLE_2);
    expect(text).toContain(ARTICLE_1);
    expect(text).toContain(ARTICLE_3);
    expect(digest.entries).toHaveLength(2);
    expect(digest.excluded).toHaveLength(1);
    expect(digest.excluded[0]?.check).toBe('Q2');
    expect(digest.excluded[0]?.sourceUrl).toBe(ARTICLE_2);
    expect(ctx.notifier.withTitle('品質ゲートで 1 件を除外しました')).toHaveLength(1);
  });
});

describe('パイプライン通し実行: 新着 0 件の日(FR-11)', () => {
  it('「本日の新着はありません」が巡回実績付きで配信される', async () => {
    const clock = mutableClock(AT_COLLECT);
    // 一覧に新着リンクが 1 件も無い日。
    const http = createFakeHttp({ lists: { [LIST_URL]: makeListHtml([]) } });
    const ctx = makeContext({ clock, http });

    const collectRun = await runCollect(ctx);
    expect(collectRun.counts.newItems).toBe(0);
    expect(collectRun.counts.sourcesSucceeded).toBe(1);

    clock.set(AT_SUMMARIZE);
    await runSummarize(ctx);
    clock.set(AT_DELIVER);
    const deliverRun = await runDeliver(ctx);

    const text = ctx.line.lastText();
    expect(deliverRun.counts.sent).toBe(1);
    expect(ctx.line.calls).toHaveLength(1);
    expect(text).toContain('本日の新着はありません。');
    // FR-11a: 監視は正常に行われたことを添える。
    expect(text).toContain('(本日 06:00 時点で 1 ソースを確認しました)');
    expect(text).toContain('※この配信が届かない日はシステム障害の可能性があります。');
    expect(digestOf(ctx).isEmpty).toBe(true);
    expect(urlsIn(text)).toEqual([]);
  });
});

describe('パイプライン通し実行: 日付境界(JST 07:00 カットオフ)', () => {
  it('07:00 直前に検知した記事は当日、直後の記事は翌日のダイジェストに入る', async () => {
    // 同じ store / HTTP / AI / LINE を、時刻だけ違う複数の実行コンテキストで共有する。
    const store = createTestStore();
    const http = fakeSite(ARTICLES.slice(0, 1));
    const ai = createFakeAi();
    const line = createFakeLine();
    const shared = { store, http, ai, line };

    // JST 09-13 06:55(カットオフ前)の巡回。
    const beforeCutoff = makeContext({ ...shared, clock: fixedClock('2026-09-12T21:55:00.000Z') });
    await runCollect(beforeCutoff);

    // JST 09-13 07:05(カットオフ後)の巡回で 2 件目が出現する。
    http.setList(LIST_URL, makeListHtml(ARTICLES.slice(0, 2).map((a) => ({ href: a.url, text: a.title }))));
    http.setArticle(ARTICLE_2, ARTICLES[1]?.body ?? '');
    const afterCutoff = makeContext({ ...shared, clock: fixedClock('2026-09-12T22:05:00.000Z') });
    await runCollect(afterCutoff);

    // JST 09-13 07:30 の配信。対象は 09-12 07:00 〜 09-13 07:00 の新着だけ。
    const today = makeContext({ ...shared, clock: fixedClock(AT_DELIVER) });
    await runSummarize(today);
    await runDeliver(today);

    const todayText = line.lastText();
    expect(todayText).toContain(ARTICLE_1);
    expect(todayText).not.toContain(ARTICLE_2);

    // 翌朝(JST 09-14 07:30)の配信で、カットオフ後の記事が届く。
    const tomorrow = makeContext({ ...shared, clock: fixedClock('2026-09-13T22:30:00.000Z') });
    await runSummarize(tomorrow);
    await runDeliver(tomorrow);

    const tomorrowText = line.lastText();
    expect(line.calls).toHaveLength(2);
    expect(tomorrowText).toContain(ARTICLE_2);
    expect(tomorrowText).not.toContain(ARTICLE_1);
    expect(
      store
        .dump()
        .digests.map((d) => d.id)
        .sort(),
    ).toEqual(['welfare_2026-09-13', 'welfare_2026-09-14']);
  });
});
