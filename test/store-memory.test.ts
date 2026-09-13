/**
 * インメモリ Store(src/store/memory.ts / 詳細設計書 §5)の単体テスト。
 *
 * この実装はユニットテストとドライランの土台であり、ここが Firestore 実装と違う挙動をすると
 * 「テストでは通るのに本番で落ちる」が生まれる。よって並び順・境界・クローンの 3 点を厳密に見る。
 *
 * 特にクローンは重要で、返り値を呼び出し側が書き換えたときに内部状態が一緒に変わると、
 * パイプラインのテストが「実際には保存されていない値」を見て通ってしまう。
 */

import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/store/memory.js';
import type { Delivery, Digest, Item, Run, SourceState } from '../src/types.js';
import { makeClassification, makeItem } from './helpers/fakes.js';

// ---------------------------------------------------------------------------
// ファクトリ
// ---------------------------------------------------------------------------

/** URL から決定的に作る未分類アイテム。 */
function itemAt(suffix: string, detectedAt: string, over: Partial<Item> = {}): Item {
  return makeItem({
    canonicalUrl: `https://www.mhlw.go.jp/stf/newpage_${suffix}.html`,
    title: `お知らせ ${suffix}`,
    detectedAt,
    updatedAt: detectedAt,
    ...over,
  });
}

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'run-0001',
    job: 'collect',
    startedAt: '2026-09-13T00:00:00.000Z',
    finishedAt: null,
    status: 'running',
    counts: {
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
    },
    date: '2026-09-13',
    errors: [],
    expiresAt: '2026-12-12T00:00:00.000Z',
    ...over,
  };
}

function makeDigest(over: Partial<Digest> = {}): Digest {
  return {
    id: 'welfare_2026-09-13',
    channelId: 'welfare',
    date: '2026-09-13',
    entries: [],
    excluded: [],
    omittedCount: 0,
    isEmpty: false,
    coverage: { total: 3, succeeded: 3, lastCollectedAtJst: '06:10' },
    messageText: '本文',
    status: 'generated',
    model: 'claude-opus-5',
    prompt: 'prompt',
    rawResponse: '{}',
    usage: null,
    createdAt: '2026-09-12T22:00:00.000Z',
    updatedAt: '2026-09-12T22:00:00.000Z',
    expiresAt: '2026-12-11T22:00:00.000Z',
    ...over,
  };
}

function makeDelivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'welfare_2026-09-13',
    channelId: 'welfare',
    date: '2026-09-13',
    digestId: 'welfare_2026-09-13',
    lineRequestId: null,
    retryKey: 'retry-key-1',
    status: 'sent',
    attempts: 1,
    sentAt: '2026-09-12T22:30:00.000Z',
    error: null,
    updatedAt: '2026-09-12T22:30:00.000Z',
    expiresAt: '2026-12-11T22:30:00.000Z',
    ...over,
  };
}

function makeSourceState(over: Partial<SourceState> = {}): SourceState {
  return {
    sourceId: 'mhlw_news',
    lastFetchedAt: '2026-09-12T21:00:00.000Z',
    lastSuccessAt: '2026-09-12T21:00:00.000Z',
    consecutiveFailures: 0,
    etag: null,
    lastModified: null,
    lastError: null,
    lastNewCount: 0,
    lastCandidateCount: 5,
    consecutiveEmpty: 0,
    warnedAtFailureCount: 0,
    warnedAtEmptyCount: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// items: getItem / putItem / getItems
// ---------------------------------------------------------------------------

describe('items の取得と保存', () => {
  it('存在しない ID は null', async () => {
    const store = createMemoryStore();
    expect(await store.getItem('missing')).toBeNull();
  });

  it('put した内容がそのまま取り出せる', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');

    await store.putItem(item);

    expect(await store.getItem(item.id)).toEqual(item);
  });

  it('同じ ID の put は上書きになる', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    await store.putItem(item);
    await store.putItem({ ...item, title: '更新後' });

    expect((await store.getItem(item.id))?.title).toBe('更新後');
    expect(store.dump().items).toHaveLength(1);
  });

  it('getItems は引数の順序を保つ', async () => {
    const store = createMemoryStore();
    const a = itemAt('001', '2026-09-12T01:00:00.000Z');
    const b = itemAt('002', '2026-09-12T02:00:00.000Z');
    const c = itemAt('003', '2026-09-12T03:00:00.000Z');
    store.seed({ items: [a, b, c] });

    const got = await store.getItems([c.id, a.id, b.id]);

    expect(got.map((item) => item.id)).toEqual([c.id, a.id, b.id]);
  });

  it('getItems は重複 ID を 1 回だけ返す', async () => {
    const store = createMemoryStore();
    const a = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [a] });

    const got = await store.getItems([a.id, a.id, a.id]);

    expect(got.map((item) => item.id)).toEqual([a.id]);
  });

  it('getItems は存在しない ID を黙って飛ばす', async () => {
    const store = createMemoryStore();
    const a = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [a] });

    expect(await store.getItems(['missing', a.id, 'missing2'])).toHaveLength(1);
    expect(await store.getItems([])).toEqual([]);
    expect(await store.getItems(['missing'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listUnclassifiedItems
// ---------------------------------------------------------------------------

describe('listUnclassifiedItems', () => {
  it('classifiedAt が null のものだけを detectedAt 昇順で返す', async () => {
    const store = createMemoryStore();
    const pendingOld = itemAt('001', '2026-09-12T01:00:00.000Z', {
      classification: null,
      classifiedAt: null,
    });
    const pendingNew = itemAt('002', '2026-09-12T05:00:00.000Z', {
      classification: null,
      classifiedAt: null,
    });
    const classified = itemAt('003', '2026-09-12T02:00:00.000Z', {
      classifiedAt: '2026-09-12T02:30:00.000Z',
    });
    store.seed({ items: [pendingNew, classified, pendingOld] });

    const got = await store.listUnclassifiedItems(10);

    expect(got.map((item) => item.id)).toEqual([pendingOld.id, pendingNew.id]);
  });

  it('limit 件までしか返さない(古い順に切る)', async () => {
    const store = createMemoryStore();
    const items = ['001', '002', '003'].map((suffix, i) =>
      itemAt(suffix, `2026-09-12T0${i + 1}:00:00.000Z`, { classification: null, classifiedAt: null }),
    );
    store.seed({ items });

    const got = await store.listUnclassifiedItems(2);

    expect(got.map((item) => item.id)).toEqual([items[0]?.id, items[1]?.id]);
  });

  it('limit が 0 以下なら空配列(Firestore の limit(0) に揃える)', async () => {
    const store = createMemoryStore();
    store.seed({
      items: [itemAt('001', '2026-09-12T01:00:00.000Z', { classification: null, classifiedAt: null })],
    });

    expect(await store.listUnclassifiedItems(0)).toEqual([]);
    expect(await store.listUnclassifiedItems(-1)).toEqual([]);
  });

  it('detectedAt が同値なら id 昇順でタイブレークする(決定的)', async () => {
    const store = createMemoryStore();
    const same = '2026-09-12T01:00:00.000Z';
    const a = itemAt('001', same, { classification: null, classifiedAt: null });
    const b = itemAt('002', same, { classification: null, classifiedAt: null });
    store.seed({ items: [b, a] });

    const ids = (await store.listUnclassifiedItems(10)).map((item) => item.id);

    expect(ids).toEqual([...ids].sort());
  });

  it('未分類が無ければ空配列', async () => {
    const store = createMemoryStore();
    store.seed({ items: [itemAt('001', '2026-09-12T01:00:00.000Z')] });
    expect(await store.listUnclassifiedItems(10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listItemsInWindow
// ---------------------------------------------------------------------------

describe('listItemsInWindow', () => {
  const FROM = '2026-09-12T00:00:00.000Z';
  const TO = '2026-09-13T00:00:00.000Z';

  it('[from, to) の境界: from は含み、to は含まない', async () => {
    const store = createMemoryStore();
    const before = itemAt('001', '2026-09-11T23:59:59.999Z');
    const atFrom = itemAt('002', FROM);
    const inside = itemAt('003', '2026-09-12T12:00:00.000Z');
    const atTo = itemAt('004', TO);
    store.seed({ items: [before, atFrom, inside, atTo] });

    const got = await store.listItemsInWindow({ from: FROM, to: TO });

    expect(got.map((item) => item.id)).toEqual([atFrom.id, inside.id]);
  });

  it('既定の対象フィールドは detectedAt', async () => {
    const store = createMemoryStore();
    // detectedAt はウィンドウ外だが updatedAt はウィンドウ内、というアイテム。
    const updated = itemAt('001', '2026-09-10T00:00:00.000Z', {
      updatedAt: '2026-09-12T09:00:00.000Z',
    });
    store.seed({ items: [updated] });

    expect(await store.listItemsInWindow({ from: FROM, to: TO })).toEqual([]);
  });

  it("field: 'updatedAt' に切り替えると更新記事を拾える", async () => {
    const store = createMemoryStore();
    const updated = itemAt('001', '2026-09-10T00:00:00.000Z', {
      updatedAt: '2026-09-12T09:00:00.000Z',
    });
    const untouched = itemAt('002', '2026-09-10T00:00:00.000Z', {
      updatedAt: '2026-09-10T00:00:00.000Z',
    });
    store.seed({ items: [updated, untouched] });

    const got = await store.listItemsInWindow({ from: FROM, to: TO, field: 'updatedAt' });

    expect(got.map((item) => item.id)).toEqual([updated.id]);
  });

  it("field: 'detectedAt' を明示しても既定と同じ", async () => {
    const store = createMemoryStore();
    const inside = itemAt('001', '2026-09-12T12:00:00.000Z');
    store.seed({ items: [inside] });

    expect(await store.listItemsInWindow({ from: FROM, to: TO, field: 'detectedAt' })).toEqual(
      await store.listItemsInWindow({ from: FROM, to: TO }),
    );
  });

  it('対象フィールドの昇順で返す', async () => {
    const store = createMemoryStore();
    const a = itemAt('001', '2026-09-12T03:00:00.000Z');
    const b = itemAt('002', '2026-09-12T01:00:00.000Z');
    const c = itemAt('003', '2026-09-12T02:00:00.000Z');
    store.seed({ items: [a, b, c] });

    const got = await store.listItemsInWindow({ from: FROM, to: TO });

    expect(got.map((item) => item.detectedAt)).toEqual([
      '2026-09-12T01:00:00.000Z',
      '2026-09-12T02:00:00.000Z',
      '2026-09-12T03:00:00.000Z',
    ]);
  });

  it('from と to が同じなら空(空区間)', async () => {
    const store = createMemoryStore();
    store.seed({ items: [itemAt('001', FROM)] });
    expect(await store.listItemsInWindow({ from: FROM, to: FROM })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// markItemsDigested
// ---------------------------------------------------------------------------

describe('markItemsDigested', () => {
  it('digestedIn に digestId を追記する', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [item] });

    await store.markItemsDigested([item.id], 'welfare_2026-09-13');

    expect((await store.getItem(item.id))?.digestedIn).toEqual(['welfare_2026-09-13']);
  });

  it('同じ digestId を 2 回記録しない(冪等)', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [item] });

    await store.markItemsDigested([item.id], 'welfare_2026-09-13');
    await store.markItemsDigested([item.id], 'welfare_2026-09-13');
    await store.markItemsDigested([item.id, item.id], 'welfare_2026-09-13');

    expect((await store.getItem(item.id))?.digestedIn).toEqual(['welfare_2026-09-13']);
  });

  it('別の digestId は追記される', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [item] });

    await store.markItemsDigested([item.id], 'welfare_2026-09-13');
    await store.markItemsDigested([item.id], 'welfare_2026-09-14');

    expect((await store.getItem(item.id))?.digestedIn).toEqual(['welfare_2026-09-13', 'welfare_2026-09-14']);
  });

  it('存在しない ID は無視する(TTL で消えた後でも落とさない)', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [item] });

    await expect(
      store.markItemsDigested(['missing', item.id], 'welfare_2026-09-13'),
    ).resolves.toBeUndefined();

    expect(store.dump().items).toHaveLength(1);
    expect((await store.getItem(item.id))?.digestedIn).toEqual(['welfare_2026-09-13']);
  });

  it('空配列でも落ちない', async () => {
    const store = createMemoryStore();
    await expect(store.markItemsDigested([], 'welfare_2026-09-13')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// クローン(内部状態の隔離)
// ---------------------------------------------------------------------------

describe('返り値と引数のクローン', () => {
  it('put に渡したオブジェクトを後から書き換えても内部状態は変わらない', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    await store.putItem(item);

    item.title = '書き換え後';
    item.digestedIn.push('leaked');
    item.classification = makeClassification({ relevance: 0.1 });

    const stored = await store.getItem(item.id);
    expect(stored?.title).toBe('お知らせ 001');
    expect(stored?.digestedIn).toEqual([]);
    expect(stored?.classification?.relevance).toBe(0.9);
  });

  it('getItem の返り値を書き換えても内部状態は変わらない', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    await store.putItem(item);

    const first = await store.getItem(item.id);
    expect(first).not.toBeNull();
    if (first === null) return;
    first.title = '書き換え後';
    first.digestedIn.push('leaked');
    if (first.classification !== null) first.classification.channels.push('leaked_channel');

    const second = await store.getItem(item.id);
    expect(second?.title).toBe('お知らせ 001');
    expect(second?.digestedIn).toEqual([]);
    expect(second?.classification?.channels).toEqual(['welfare']);
  });

  it('getItems / listUnclassifiedItems / listItemsInWindow の返り値もクローン', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z', { classification: null, classifiedAt: null });
    store.seed({ items: [item] });

    (await store.getItems([item.id]))[0]?.digestedIn.push('a');
    (await store.listUnclassifiedItems(10))[0]?.digestedIn.push('b');
    (
      await store.listItemsInWindow({ from: '2026-09-12T00:00:00.000Z', to: '2026-09-13T00:00:00.000Z' })
    )[0]?.digestedIn.push('c');

    expect((await store.getItem(item.id))?.digestedIn).toEqual([]);
  });

  it('seed に渡した配列の要素を書き換えても内部状態は変わらない', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [item] });

    item.title = '書き換え後';

    expect((await store.getItem(item.id))?.title).toBe('お知らせ 001');
  });

  it('dump の返り値を書き換えても内部状態は変わらない', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [item] });

    const dumped = store.dump();
    dumped.items[0]?.digestedIn.push('leaked');
    dumped.items.push(itemAt('999', '2026-09-12T09:00:00.000Z'));

    expect(store.dump().items).toHaveLength(1);
    expect(store.dump().items[0]?.digestedIn).toEqual([]);
  });

  it('digest / delivery / sourceState / run も同様にクローンされる', async () => {
    const store = createMemoryStore();
    const digest = makeDigest();
    const delivery = makeDelivery();
    const state = makeSourceState();
    const run = makeRun();
    await store.putDigest(digest);
    await store.putDelivery(delivery);
    await store.putSourceState(state);
    await store.putRun(run);

    digest.messageText = '書き換え';
    delivery.status = 'failed';
    state.consecutiveFailures = 99;
    run.errors.push('leaked');

    expect((await store.getDigest(digest.id))?.messageText).toBe('本文');
    expect((await store.getDelivery(delivery.id))?.status).toBe('sent');
    expect((await store.getSourceState(state.sourceId))?.consecutiveFailures).toBe(0);
    expect(store.dump().runs[0]?.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// digests / deliveries / source_state
// ---------------------------------------------------------------------------

describe('digests / deliveries / source_state', () => {
  it('digest は id で出し入れでき、存在しなければ null', async () => {
    const store = createMemoryStore();
    const digest = makeDigest();
    await store.putDigest(digest);

    expect(await store.getDigest(digest.id)).toEqual(digest);
    expect(await store.getDigest('missing')).toBeNull();
  });

  it('delivery は id で出し入れでき、存在しなければ null', async () => {
    const store = createMemoryStore();
    const delivery = makeDelivery();
    await store.putDelivery(delivery);

    expect(await store.getDelivery(delivery.id)).toEqual(delivery);
    expect(await store.getDelivery('missing')).toBeNull();
  });

  it('source_state は sourceId で出し入れできる', async () => {
    const store = createMemoryStore();
    const state = makeSourceState();
    await store.putSourceState(state);

    expect(await store.getSourceState('mhlw_news')).toEqual(state);
    expect(await store.getSourceState('missing')).toBeNull();
  });

  it('listSourceStates は sourceId 昇順(Firestore の全件取得に揃える)', async () => {
    const store = createMemoryStore();
    store.seed({
      sourceStates: [
        makeSourceState({ sourceId: 'z_source' }),
        makeSourceState({ sourceId: 'a_source' }),
        makeSourceState({ sourceId: 'm_source' }),
      ],
    });

    expect((await store.listSourceStates()).map((state) => state.sourceId)).toEqual([
      'a_source',
      'm_source',
      'z_source',
    ]);
  });

  it('source_state が 1 件も無ければ空配列', async () => {
    const store = createMemoryStore();
    expect(await store.listSourceStates()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

describe('listRuns', () => {
  it('日付で絞り込む', async () => {
    const store = createMemoryStore();
    store.seed({
      runs: [
        makeRun({ id: 'run-1', date: '2026-09-13' }),
        makeRun({ id: 'run-2', date: '2026-09-12' }),
        makeRun({ id: 'run-3', date: '2026-09-13' }),
      ],
    });

    const got = await store.listRuns('2026-09-13');

    expect(got.map((run) => run.id).sort()).toEqual(['run-1', 'run-3']);
  });

  it('job を指定するとさらに絞り込む', async () => {
    const store = createMemoryStore();
    store.seed({
      runs: [
        makeRun({ id: 'run-1', job: 'collect' }),
        makeRun({ id: 'run-2', job: 'summarize' }),
        makeRun({ id: 'run-3', job: 'deliver' }),
      ],
    });

    expect((await store.listRuns('2026-09-13', 'summarize')).map((run) => run.id)).toEqual(['run-2']);
    expect(await store.listRuns('2026-09-13')).toHaveLength(3);
  });

  it('startedAt の降順(新しい順)で返す', async () => {
    const store = createMemoryStore();
    store.seed({
      runs: [
        makeRun({ id: 'run-1', startedAt: '2026-09-13T00:00:00.000Z' }),
        makeRun({ id: 'run-2', startedAt: '2026-09-13T09:00:00.000Z' }),
        makeRun({ id: 'run-3', startedAt: '2026-09-13T03:00:00.000Z' }),
      ],
    });

    expect((await store.listRuns('2026-09-13')).map((run) => run.id)).toEqual(['run-2', 'run-3', 'run-1']);
  });

  it('startedAt が同値なら id 降順でタイブレークする(決定的)', async () => {
    const store = createMemoryStore();
    const startedAt = '2026-09-13T00:00:00.000Z';
    store.seed({
      runs: [makeRun({ id: 'run-a', startedAt }), makeRun({ id: 'run-b', startedAt })],
    });

    expect((await store.listRuns('2026-09-13')).map((run) => run.id)).toEqual(['run-b', 'run-a']);
  });

  it('該当が無ければ空配列', async () => {
    const store = createMemoryStore();
    store.seed({ runs: [makeRun()] });

    expect(await store.listRuns('2026-01-01')).toEqual([]);
    expect(await store.listRuns('2026-09-13', 'deliver')).toEqual([]);
  });

  it('同じ id の putRun は上書きになる(running → succeeded)', async () => {
    const store = createMemoryStore();
    const run = makeRun();
    await store.putRun(run);
    await store.putRun({ ...run, status: 'succeeded', finishedAt: '2026-09-13T00:05:00.000Z' });

    const got = await store.listRuns('2026-09-13');
    expect(got).toHaveLength(1);
    expect(got[0]?.status).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// seed / dump
// ---------------------------------------------------------------------------

describe('seed と dump', () => {
  it('dump は書き込み順のスナップショットを返す', async () => {
    const store = createMemoryStore();
    const a = itemAt('001', '2026-09-12T05:00:00.000Z');
    const b = itemAt('002', '2026-09-12T01:00:00.000Z');
    await store.putItem(a);
    await store.putItem(b);

    expect(store.dump().items.map((item) => item.id)).toEqual([a.id, b.id]);
  });

  it('seed は指定したコレクションだけに作用する', () => {
    const store = createMemoryStore();
    store.seed({ items: [itemAt('001', '2026-09-12T01:00:00.000Z')] });
    store.seed({ runs: [makeRun()] });

    const dumped = store.dump();
    expect(dumped.items).toHaveLength(1);
    expect(dumped.runs).toHaveLength(1);
    expect(dumped.digests).toEqual([]);
    expect(dumped.deliveries).toEqual([]);
    expect(dumped.sourceStates).toEqual([]);
  });

  it('seed は同じキーの既存データを上書きする(putXxx と同じ意味)', async () => {
    const store = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');
    store.seed({ items: [item] });
    store.seed({ items: [{ ...item, title: '上書き後' }] });

    expect(store.dump().items).toHaveLength(1);
    expect((await store.getItem(item.id))?.title).toBe('上書き後');
  });

  it('空の seed は何も変えない', () => {
    const store = createMemoryStore();
    store.seed({ items: [itemAt('001', '2026-09-12T01:00:00.000Z')] });
    store.seed({});

    expect(store.dump().items).toHaveLength(1);
  });

  it('新しいストアの dump は全コレクションが空', () => {
    expect(createMemoryStore().dump()).toEqual({
      items: [],
      digests: [],
      deliveries: [],
      sourceStates: [],
      runs: [],
    });
  });

  it('seed した 5 コレクションすべてが dump に現れる', () => {
    const store = createMemoryStore();
    store.seed({
      items: [itemAt('001', '2026-09-12T01:00:00.000Z')],
      digests: [makeDigest()],
      deliveries: [makeDelivery()],
      sourceStates: [makeSourceState()],
      runs: [makeRun()],
    });

    const dumped = store.dump();
    expect(dumped.items).toHaveLength(1);
    expect(dumped.digests).toHaveLength(1);
    expect(dumped.deliveries).toHaveLength(1);
    expect(dumped.sourceStates).toHaveLength(1);
    expect(dumped.runs).toHaveLength(1);
  });

  it('ストア同士は独立している', async () => {
    const first = createMemoryStore();
    const second = createMemoryStore();
    const item = itemAt('001', '2026-09-12T01:00:00.000Z');

    await first.putItem(item);

    expect(await second.getItem(item.id)).toBeNull();
  });
});
