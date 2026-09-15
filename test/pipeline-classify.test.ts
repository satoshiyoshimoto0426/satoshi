/**
 * 未分類アイテムの AI 分類(src/pipeline/classify.ts / 詳細設計書 §7.1 / FR-04)のテスト。
 *
 * この工程が静かに壊れると、収集はできているのに分類が付かず、
 * ダイジェストの対象が永久に 0 件になる(= 毎朝「新着なし」が配信され続ける)。
 * そのため「取りこぼしをエラーにしない」「1 バッチの失敗が他バッチを巻き込まない」という
 * 設計上の約束を、件数レベルで検証する。
 *
 * 外部ネットワークにも実 AI にも接続しない(AiClient はフェイク)。
 */

import { describe, expect, it } from 'vitest';
import { classifyPending } from '../src/pipeline/classify.js';
import type {
  AiCallMeta,
  ChannelConfig,
  Classification,
  ClassifyChannelInfo,
  ClassifyInputItem,
  ClassifyResult,
  Item,
} from '../src/types.js';
import {
  DEFAULT_NOW,
  createFakeAi,
  makeChannel,
  makeClassification,
  makeContext,
  makeItem,
  makeSource,
} from './helpers/fakes.js';
import type { FakeAiClient, TestContext } from './helpers/fakes.js';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

type ClassifyImpl = (
  items: ClassifyInputItem[],
  channels: ClassifyChannelInfo[],
) => Promise<{ results: ClassifyResult[]; meta: AiCallMeta }>;

const META: AiCallMeta = {
  model: 'claude-opus-5',
  prompt: '[test]',
  rawResponse: '{}',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
};

/** classify の実装だけ差し替えたフェイク AiClient。呼び出し内容は classifyCalls に残る。 */
function aiWith(impl: ClassifyImpl): FakeAiClient {
  const base = createFakeAi();
  return {
    ...base,
    async classify(items, channels) {
      base.classifyCalls.push({ items: structuredClone(items), channels: structuredClone(channels) });
      return impl(items, channels);
    },
  };
}

/** 渡された入力をそのまま分類して返す「素直な AI」。 */
function echoResults(items: ClassifyInputItem[], over: Partial<Classification> = {}): ClassifyResult[] {
  return items.map((item) => ({ id: item.id, classification: makeClassification(over) }));
}

/** 未分類アイテムを count 件作る。detectedAt は 1 分刻みで昇順。 */
function pendingItems(count: number, over: Partial<Item> = {}): Item[] {
  const base = Date.UTC(2026, 8, 12, 0, 0, 0);
  return Array.from({ length: count }, (_unused, i) => {
    const suffix = String(i + 1).padStart(3, '0');
    return makeItem({
      canonicalUrl: `https://www.mhlw.go.jp/stf/newpage_${suffix}.html`,
      title: `お知らせ ${suffix}`,
      detectedAt: new Date(base + i * 60_000).toISOString(),
      classification: null,
      classifiedAt: null,
      ...over,
    });
  });
}

/** 未分類アイテムを seed 済みのコンテキストを作る。 */
function contextWith(
  items: Item[],
  ai: FakeAiClient,
  channels: ChannelConfig[] = [makeChannel()],
): TestContext {
  const ctx = makeContext({ ai, channels });
  ctx.store.seed({ items });
  return ctx;
}

// ---------------------------------------------------------------------------
// バッチ分割
// ---------------------------------------------------------------------------

describe('バッチ分割', () => {
  it('25 件の未分類アイテムは 20 件 + 5 件の 2 バッチで AI に渡される', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const ctx = contextWith(pendingItems(25), ai);

    const result = await classifyPending(ctx);

    expect(ai.classifyCalls.map((call) => call.items.length)).toEqual([20, 5]);
    expect(result.classified).toBe(25);
    expect(result.errors).toEqual([]);
  });

  it('20 件ちょうどは 1 バッチ', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const ctx = contextWith(pendingItems(20), ai);

    await classifyPending(ctx);

    expect(ai.classifyCalls).toHaveLength(1);
  });

  it('未分類が 0 件なら AI を呼ばない', async () => {
    const ai = aiWith(async () => {
      throw new Error('AI を呼んではいけません');
    });
    const ctx = contextWith([], ai);

    const result = await classifyPending(ctx);

    expect(ai.classifyCalls).toHaveLength(0);
    expect(result).toEqual({ classified: 0, errors: [] });
  });

  it('分類済みのアイテムは対象にならない', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const pending = pendingItems(2);
    const done = makeItem({ canonicalUrl: 'https://www.mhlw.go.jp/stf/done.html' });
    const ctx = contextWith([...pending, done], ai);

    await classifyPending(ctx);

    const sent = ai.classifyCalls[0]?.items.map((item) => item.id) ?? [];
    expect(sent).toEqual(pending.map((item) => item.id));
  });

  it('detectedAt の昇順(古い順)で渡される', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const items = pendingItems(3);
    // 投入順を入れ替えても、取り出しは detectedAt 昇順になる。
    const ctx = contextWith([items[2] as Item, items[0] as Item, items[1] as Item], ai);

    await classifyPending(ctx);

    expect(ai.classifyCalls[0]?.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
  });
});

// ---------------------------------------------------------------------------
// 取りこぼし(応答に含まれない id)
// ---------------------------------------------------------------------------

describe('応答に含まれない id', () => {
  it('エラーにせず未分類のまま残し、件数をログに出す', async () => {
    // 5 件のうち先頭 3 件しか返さない AI。
    const ai = aiWith(async (items) => ({ results: echoResults(items.slice(0, 3)), meta: META }));
    const items = pendingItems(5);
    const ctx = contextWith(items, ai);

    const result = await classifyPending(ctx);

    expect(result.classified).toBe(3);
    expect(result.errors).toEqual([]);

    const stored = ctx.store.dump().items;
    const unclassified = stored.filter((item) => item.classifiedAt === null);
    expect(unclassified.map((item) => item.id).sort()).toEqual(
      items
        .slice(3)
        .map((item) => item.id)
        .sort(),
    );

    // 「毎回同じ件数が取りこぼされている」ことに運用者が気付けるよう、件数がログに残る。
    const warned = ctx.logger.records.filter(
      (record) => record.level === 'warn' && record.fields.missing === 2,
    );
    expect(warned).toHaveLength(1);
  });

  it('1 件も返ってこなくても例外にならない', async () => {
    const ai = aiWith(async () => ({ results: [], meta: META }));
    const ctx = contextWith(pendingItems(3), ai);

    const result = await classifyPending(ctx);

    expect(result).toEqual({ classified: 0, errors: [] });
    expect(ctx.store.dump().items.every((item) => item.classifiedAt === null)).toBe(true);
  });

  it('入力に無い id が返ってきても、その id のアイテムは作られない', async () => {
    const ai = aiWith(async (items) => ({
      results: [...echoResults(items), { id: 'ghost-item', classification: makeClassification() }],
      meta: META,
    }));
    const ctx = contextWith(pendingItems(2), ai);

    const result = await classifyPending(ctx);

    expect(result.classified).toBe(2);
    expect(ctx.store.dump().items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// バッチ単位の失敗の切り分け
// ---------------------------------------------------------------------------

describe('バッチの失敗', () => {
  it('1 バッチが例外を投げても他バッチの結果は保存され、errors に理由が積まれる', async () => {
    let call = 0;
    const ai = aiWith(async (items) => {
      call += 1;
      if (call === 1) throw new Error('AI API がタイムアウトしました');
      return { results: echoResults(items), meta: META };
    });
    const items = pendingItems(25);
    const ctx = contextWith(items, ai);

    const result = await classifyPending(ctx);

    // 2 バッチ目(5 件)は保存されている。
    expect(result.classified).toBe(5);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('AI API がタイムアウトしました');
    expect(result.errors[0]).toContain('1/2');

    const stored = ctx.store.dump().items;
    const classified = stored.filter((item) => item.classifiedAt !== null);
    expect(classified.map((item) => item.id).sort()).toEqual(
      items
        .slice(20)
        .map((item) => item.id)
        .sort(),
    );
    // 失敗したバッチのアイテムは未分類のまま次回に回る。
    expect(stored.filter((item) => item.classifiedAt === null)).toHaveLength(20);
  });

  it('全バッチが失敗しても例外は投げず errors にまとめる', async () => {
    const ai = aiWith(async () => {
      throw new Error('レート制限');
    });
    const ctx = contextWith(pendingItems(25), ai);

    const result = await classifyPending(ctx);

    expect(result.classified).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((message) => message.includes('レート制限'))).toBe(true);
  });

  it('チャネル定義が 0 件なら AI を呼ばず理由を返す', async () => {
    const ai = aiWith(async () => {
      throw new Error('AI を呼んではいけません');
    });
    const ctx = contextWith(pendingItems(3), ai, []);

    const result = await classifyPending(ctx);

    expect(ai.classifyCalls).toHaveLength(0);
    expect(result.classified).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('チャネル');
  });
});

// ---------------------------------------------------------------------------
// AI へ渡す入力(詳細設計書 §7.1)
// ---------------------------------------------------------------------------

describe('AI へ渡す入力', () => {
  it('excerpt は contentText の先頭 1500 文字', async () => {
    const longText = 'あ'.repeat(3000);
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const ctx = contextWith(pendingItems(1, { contentText: longText }), ai);

    await classifyPending(ctx);

    const excerpt = ai.classifyCalls[0]?.items[0]?.excerpt ?? '';
    expect(excerpt).toHaveLength(1500);
    expect(excerpt).toBe(longText.slice(0, 1500));
  });

  it('1500 文字以下の本文はそのまま渡す', async () => {
    const text = 'あ'.repeat(100);
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const ctx = contextWith(pendingItems(1, { contentText: text }), ai);

    await classifyPending(ctx);

    expect(ai.classifyCalls[0]?.items[0]?.excerpt).toBe(text);
  });

  it('contentText が空ならタイトルだけで渡す(捏造した本文を足さない)', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const ctx = contextWith(pendingItems(1, { contentText: '' }), ai);

    await classifyPending(ctx);

    const input = ai.classifyCalls[0]?.items[0];
    expect(input?.excerpt).toBe('');
    expect(input?.title).toBe('お知らせ 001');
  });

  it('url は canonicalUrl、region と sourceName も §7.1 の通り渡す', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const source = makeSource({ id: 'osaka_news', name: '大阪府 新着情報' });
    const ctx = makeContext({ ai, sources: [source] });
    ctx.store.seed({ items: pendingItems(1, { sourceId: 'osaka_news', region: '大阪府' }) });

    await classifyPending(ctx);

    const input = ai.classifyCalls[0]?.items[0];
    expect(input?.url).toBe('https://www.mhlw.go.jp/stf/newpage_001.html');
    expect(input?.region).toBe('大阪府');
    expect(input?.sourceName).toBe('大阪府 新着情報');
  });

  it('設定に無いソース ID は sourceId をそのまま名前として渡す', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const ctx = contextWith(pendingItems(1, { sourceId: 'removed_source' }), ai);

    await classifyPending(ctx);

    expect(ai.classifyCalls[0]?.items[0]?.sourceName).toBe('removed_source');
  });

  it('全チャネルの id / name / topics を渡す', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const channels = [
      makeChannel(),
      makeChannel({ id: 'ai_reskill', name: 'AI 局', topics: 'リスキリング' }),
    ];
    const ctx = contextWith(pendingItems(1), ai, channels);

    await classifyPending(ctx);

    expect(ai.classifyCalls[0]?.channels).toEqual(
      channels.map((channel) => ({ id: channel.id, name: channel.name, topics: channel.topics })),
    );
  });
});

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

describe('分類結果の保存', () => {
  it('classification と classifiedAt がアイテムに書き戻される', async () => {
    const classification = makeClassification({ relevance: 0.42, importance: 'high', kind: 'fee_revision' });
    const ai = aiWith(async (items) => ({
      results: items.map((item) => ({ id: item.id, classification })),
      meta: META,
    }));
    const items = pendingItems(1);
    const ctx = contextWith(items, ai);

    await classifyPending(ctx);

    const stored = await ctx.store.getItem(items[0]?.id ?? '');
    expect(stored?.classification).toEqual(classification);
    expect(stored?.classifiedAt).toBe(DEFAULT_NOW);
    // 更新時刻も Clock 由来で揃える(契約の原則 5)。
    expect(stored?.updatedAt).toBe(DEFAULT_NOW);
  });

  it('元のアイテムの他フィールドは変わらない', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const items = pendingItems(1);
    const original = items[0] as Item;
    const ctx = contextWith(items, ai);

    await classifyPending(ctx);

    const stored = await ctx.store.getItem(original.id);
    expect(stored?.canonicalUrl).toBe(original.canonicalUrl);
    expect(stored?.title).toBe(original.title);
    expect(stored?.detectedAt).toBe(original.detectedAt);
    expect(stored?.contentHash).toBe(original.contentHash);
    expect(stored?.digestedIn).toEqual([]);
    expect(stored?.expiresAt).toBe(original.expiresAt);
  });

  it('未知のチャネル ID を含む結果も保存するが、警告を残す(監査のため)', async () => {
    const ai = aiWith(async (items) => ({
      results: echoResults(items, { channels: ['welfare', 'unknown_channel'] }),
      meta: META,
    }));
    const items = pendingItems(1);
    const ctx = contextWith(items, ai);

    const result = await classifyPending(ctx);

    expect(result.classified).toBe(1);
    const stored = await ctx.store.getItem(items[0]?.id ?? '');
    expect(stored?.classification?.channels).toEqual(['welfare', 'unknown_channel']);
    expect(
      ctx.logger.records.some((record) => record.level === 'warn' && Array.isArray(record.fields.channels)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

describe('limit', () => {
  it('指定した件数までしか取らない', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const ctx = contextWith(pendingItems(30), ai);

    const result = await classifyPending(ctx, 5);

    expect(ai.classifyCalls).toHaveLength(1);
    expect(ai.classifyCalls[0]?.items).toHaveLength(5);
    expect(result.classified).toBe(5);
    expect(ctx.store.dump().items.filter((item) => item.classifiedAt === null)).toHaveLength(25);
  });

  it('limit がバッチサイズより大きければ分割される', async () => {
    const ai = aiWith(async (items) => ({ results: echoResults(items), meta: META }));
    const ctx = contextWith(pendingItems(30), ai);

    await classifyPending(ctx, 25);

    expect(ai.classifyCalls.map((call) => call.items.length)).toEqual([20, 5]);
  });

  it('limit が 0 なら 1 件も処理しない', async () => {
    const ai = aiWith(async () => {
      throw new Error('AI を呼んではいけません');
    });
    const ctx = contextWith(pendingItems(3), ai);

    const result = await classifyPending(ctx, 0);

    expect(result).toEqual({ classified: 0, errors: [] });
    expect(ai.classifyCalls).toHaveLength(0);
  });
});
