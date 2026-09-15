/**
 * Firestore Store(src/store/firestore.ts / 詳細設計書 §5)の単体テスト。
 *
 * **実 Firestore には一切接続しない。** `@google-cloud/firestore` を丸ごとモックし、
 * 「このストアが Firestore に対して何を渡すか」だけを検証する。
 *
 * ここで守りたい事故は 3 つ。
 * 1. `expiresAt` が Timestamp 型で書かれないと Firestore の TTL が 1 件も効かず、
 *    監査データが無限に残る(FR-16 / M3-05)。文字列のままでも書き込みは成功するので、
 *    テストでしか検知できない。
 * 2. `classifiedAt` が undefined のまま書かれるとフィールドごと消え、
 *    `classifiedAt == null` のクエリにヒットしなくなる。未分類アイテムが永久に拾われず、
 *    「収集はできているのに毎朝新着なし」という静かな停止になる。
 * 3. モジュールを import しただけで Firestore クライアントが生成されると、
 *    認証情報の無い環境(CI・メモリモード)で import しただけで落ちる。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// @google-cloud/firestore のモック
// ---------------------------------------------------------------------------

const fs = vi.hoisted(() => {
  type DocData = Record<string, unknown>;

  interface QueryRecord {
    collection: string;
    where: Array<[string, string, unknown]>;
    orderBy: Array<[string, string]>;
    limit: number | null;
    executed: boolean;
  }

  interface WriteRecord {
    collection: string;
    id: string;
    data: DocData;
  }

  interface BatchRecord {
    updates: WriteRecord[];
    committed: boolean;
  }

  /** Firestore の Timestamp 相当。TTL は「Timestamp 型のフィールド」しか見ない。 */
  class Timestamp {
    private readonly millis: number;
    constructor(millis: number) {
      this.millis = millis;
    }
    static fromDate(date: Date): Timestamp {
      return new Timestamp(date.getTime());
    }
    toDate(): Date {
      return new Date(this.millis);
    }
  }

  /** FieldValue.arrayUnion のセンチネル。 */
  class ArrayUnionSentinel {
    readonly values: unknown[];
    constructor(values: unknown[]) {
      this.values = values;
    }
  }

  const FieldValue = {
    arrayUnion(...values: unknown[]): ArrayUnionSentinel {
      return new ArrayUnionSentinel(values);
    },
  };

  // ---- 記録と保存データ ----
  const record = {
    constructed: [] as unknown[],
    queries: [] as QueryRecord[],
    sets: [] as WriteRecord[],
    docGets: [] as Array<{ collection: string; id: string }>,
    getAllCalls: [] as string[][],
    batches: [] as BatchRecord[],
  };

  const store = new Map<string, Map<string, DocData>>();

  function collectionData(name: string): Map<string, DocData> {
    let found = store.get(name);
    if (found === undefined) {
      found = new Map<string, DocData>();
      store.set(name, found);
    }
    return found;
  }

  function compare(left: unknown, op: string, right: unknown): boolean {
    if (op === '==') return left === right;
    if (left === undefined) return false;
    const a = String(left);
    const b = String(right);
    if (op === '>=') return a >= b;
    if (op === '>') return a > b;
    if (op === '<=') return a <= b;
    if (op === '<') return a < b;
    throw new Error(`未対応の演算子です: ${op}`);
  }

  class FakeQuery {
    protected readonly rec: QueryRecord;
    constructor(rec: QueryRecord) {
      this.rec = rec;
    }
    where(field: string, op: string, value: unknown): FakeQuery {
      this.rec.where.push([field, op, value]);
      return this;
    }
    orderBy(field: string, direction = 'asc'): FakeQuery {
      this.rec.orderBy.push([field, direction]);
      return this;
    }
    limit(count: number): FakeQuery {
      this.rec.limit = count;
      return this;
    }
    async get(): Promise<{ docs: Array<{ id: string; data(): DocData }> }> {
      this.rec.executed = true;
      let rows = [...collectionData(this.rec.collection).entries()];
      for (const [field, op, value] of this.rec.where) {
        rows = rows.filter(([, data]) => compare(data[field], op, value));
      }
      for (const [field, direction] of this.rec.orderBy) {
        // Firestore は orderBy 対象フィールドを持たないドキュメントを返さない。
        rows = rows.filter(([, data]) => data[field] !== undefined);
        rows.sort(([, a], [, b]) => {
          const left = String(a[field]);
          const right = String(b[field]);
          const sign = left < right ? -1 : left > right ? 1 : 0;
          return direction === 'desc' ? -sign : sign;
        });
      }
      if (this.rec.limit !== null) rows = rows.slice(0, this.rec.limit);
      return { docs: rows.map(([id, data]) => ({ id, data: () => data })) };
    }
  }

  class FakeDocRef {
    readonly collectionName: string;
    readonly id: string;
    constructor(collectionName: string, id: string) {
      this.collectionName = collectionName;
      this.id = id;
    }
    async set(data: DocData): Promise<void> {
      record.sets.push({ collection: this.collectionName, id: this.id, data });
      collectionData(this.collectionName).set(this.id, data);
    }
    async get(): Promise<{ exists: boolean; id: string; data(): DocData | undefined }> {
      record.docGets.push({ collection: this.collectionName, id: this.id });
      const data = collectionData(this.collectionName).get(this.id);
      return { exists: data !== undefined, id: this.id, data: () => data };
    }
  }

  class FakeCollection extends FakeQuery {
    private readonly collectionName: string;
    constructor(name: string) {
      super({ collection: name, where: [], orderBy: [], limit: null, executed: false });
      this.collectionName = name;
    }
    doc(id: string): FakeDocRef {
      return new FakeDocRef(this.collectionName, id);
    }
    private fresh(): FakeQuery {
      const rec: QueryRecord = {
        collection: this.collectionName,
        where: [],
        orderBy: [],
        limit: null,
        executed: false,
      };
      record.queries.push(rec);
      return new FakeQuery(rec);
    }
    override where(field: string, op: string, value: unknown): FakeQuery {
      return this.fresh().where(field, op, value);
    }
    override orderBy(field: string, direction = 'asc'): FakeQuery {
      return this.fresh().orderBy(field, direction);
    }
    override limit(count: number): FakeQuery {
      return this.fresh().limit(count);
    }
    override async get(): Promise<{ docs: Array<{ id: string; data(): DocData }> }> {
      return this.fresh().get();
    }
  }

  class Firestore {
    constructor(settings: unknown) {
      record.constructed.push(settings);
    }
    collection(name: string): FakeCollection {
      return new FakeCollection(name);
    }
    async getAll(
      ...refs: FakeDocRef[]
    ): Promise<Array<{ exists: boolean; id: string; data(): DocData | undefined }>> {
      record.getAllCalls.push(refs.map((ref) => ref.id));
      return Promise.all(refs.map((ref) => ref.get()));
    }
    batch(): { update(ref: FakeDocRef, data: DocData): void; commit(): Promise<void> } {
      const batch: BatchRecord = { updates: [], committed: false };
      record.batches.push(batch);
      return {
        update(ref: FakeDocRef, data: DocData): void {
          batch.updates.push({ collection: ref.collectionName, id: ref.id, data });
        },
        async commit(): Promise<void> {
          batch.committed = true;
        },
      };
    }
  }

  function reset(): void {
    record.constructed.length = 0;
    record.queries.length = 0;
    record.sets.length = 0;
    record.docGets.length = 0;
    record.getAllCalls.length = 0;
    record.batches.length = 0;
    store.clear();
  }

  return {
    module: { Firestore, FieldValue, Timestamp },
    Timestamp,
    ArrayUnionSentinel,
    record,
    reset,
  };
});

vi.mock('@google-cloud/firestore', () => fs.module);

import { createFirestoreStore } from '../src/store/firestore.js';
import type { Delivery, Digest, Item, Run, SourceState, Store } from '../src/types.js';

// ---------------------------------------------------------------------------
// ファクトリ
// ---------------------------------------------------------------------------

const EXPIRES_AT = '2026-12-11T00:00:00.000Z';

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: 'item-001',
    sourceId: 'mhlw_news',
    canonicalUrl: 'https://www.mhlw.go.jp/stf/newpage_00001.html',
    title: '障害福祉サービス等報酬改定について',
    publishedAt: null,
    detectedAt: '2026-09-12T01:00:00.000Z',
    updatedAt: '2026-09-12T01:00:00.000Z',
    contentHash: 'a'.repeat(64),
    contentText: '本文',
    contentType: 'html',
    region: null,
    classification: null,
    classifiedAt: null,
    digestedIn: [],
    expiresAt: EXPIRES_AT,
    ...over,
  };
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
    expiresAt: EXPIRES_AT,
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
    expiresAt: EXPIRES_AT,
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
    expiresAt: EXPIRES_AT,
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

function newStore(projectId: string | null = 'test-project', databaseId = '(default)'): Store {
  return createFirestoreStore(projectId, databaseId);
}

/** 直近に書き込まれたドキュメントデータ。 */
function lastSet(): Record<string, unknown> {
  const write = fs.record.sets[fs.record.sets.length - 1];
  if (write === undefined) throw new Error('書き込みが記録されていません');
  return write.data;
}

/** 実行されたクエリ(collection 名で絞る)。 */
function queriesFor(collection: string): Array<{
  collection: string;
  where: Array<[string, string, unknown]>;
  orderBy: Array<[string, string]>;
  limit: number | null;
  executed: boolean;
}> {
  return fs.record.queries.filter((query) => query.collection === collection);
}

afterEach(() => {
  fs.reset();
});

// ---------------------------------------------------------------------------
// クライアント生成
// ---------------------------------------------------------------------------

describe('Firestore クライアントの生成', () => {
  it('モジュールを import しただけではクライアントを生成しない(認証情報が無くても落ちない)', async () => {
    fs.reset();
    vi.resetModules();

    await import('../src/store/firestore.js');

    expect(fs.record.constructed).toHaveLength(0);
  });

  it('ignoreUndefinedProperties: true と databaseId を設定する', () => {
    newStore('my-project', 'seido');

    expect(fs.record.constructed).toHaveLength(1);
    expect(fs.record.constructed[0]).toEqual({
      ignoreUndefinedProperties: true,
      databaseId: 'seido',
      projectId: 'my-project',
    });
  });

  it('projectId が null なら設定に含めない(ADC / メタデータサーバに解決させる)', () => {
    newStore(null, '(default)');

    expect(fs.record.constructed[0]).toEqual({
      ignoreUndefinedProperties: true,
      databaseId: '(default)',
    });
  });
});

// ---------------------------------------------------------------------------
// expiresAt(TTL)
// ---------------------------------------------------------------------------

describe('expiresAt の TTL 対応', () => {
  it('items の expiresAt は Timestamp 型として書き込まれる', async () => {
    await newStore().putItem(makeItem());

    const data = lastSet();
    expect(data.expiresAt).toBeInstanceOf(fs.Timestamp);
    expect((data.expiresAt as InstanceType<typeof fs.Timestamp>).toDate().toISOString()).toBe(EXPIRES_AT);
    // 他の日時は文字列のまま(範囲クエリを辞書順で行うため)。
    expect(data.detectedAt).toBe('2026-09-12T01:00:00.000Z');
    expect(typeof data.updatedAt).toBe('string');
  });

  it('digests / deliveries / runs / source_state でも同じ変換をする', async () => {
    const store = newStore();

    await store.putDigest(makeDigest());
    expect(lastSet().expiresAt).toBeInstanceOf(fs.Timestamp);

    await store.putDelivery(makeDelivery());
    expect(lastSet().expiresAt).toBeInstanceOf(fs.Timestamp);

    await store.putRun(makeRun());
    expect(lastSet().expiresAt).toBeInstanceOf(fs.Timestamp);

    // source_state には expiresAt が無い(TTL 対象外)。変換対象が無くても落ちない。
    await store.putSourceState(makeSourceState());
    expect(lastSet().expiresAt).toBeUndefined();
    expect(lastSet().sourceId).toBe('mhlw_news');
  });

  it('読み戻すと ISO8601 文字列に戻る', async () => {
    const store = newStore();
    await store.putItem(makeItem());

    const read = await store.getItem('item-001');

    expect(read?.expiresAt).toBe(EXPIRES_AT);
    expect(typeof read?.expiresAt).toBe('string');
  });

  it('クエリ経由の読み戻しでも ISO8601 文字列に戻る', async () => {
    const store = newStore();
    await store.putItem(makeItem());

    const inWindow = await store.listItemsInWindow({
      from: '2026-09-12T00:00:00.000Z',
      to: '2026-09-13T00:00:00.000Z',
    });
    expect(inWindow[0]?.expiresAt).toBe(EXPIRES_AT);

    const unclassified = await store.listUnclassifiedItems(10);
    expect(unclassified[0]?.expiresAt).toBe(EXPIRES_AT);
  });

  it('壊れた日付は Timestamp にせず、書き込み全体も落とさない', async () => {
    await newStore().putItem(makeItem({ expiresAt: 'not-a-date' }));

    expect(lastSet().expiresAt).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// undefined の正規化
// ---------------------------------------------------------------------------

describe('undefined の正規化', () => {
  it('classifiedAt が undefined でも null として書き込む(未分類クエリに乗せるため)', async () => {
    // 型上は string | null だが、実行時に undefined が紛れ込む経路がある。
    const broken = makeItem() as unknown as Record<string, unknown>;
    broken.classifiedAt = undefined;

    await newStore().putItem(broken as unknown as Item);

    const data = lastSet();
    expect('classifiedAt' in data).toBe(true);
    expect(data.classifiedAt).toBeNull();
  });

  it('null はそのまま null で書き込む', async () => {
    await newStore().putItem(makeItem({ classifiedAt: null, publishedAt: null, region: null }));

    const data = lastSet();
    expect(data.classifiedAt).toBeNull();
    expect(data.publishedAt).toBeNull();
    expect(data.region).toBeNull();
  });

  it('入れ子のオブジェクトと配列の undefined も null にする', async () => {
    const broken = makeItem() as unknown as Record<string, unknown>;
    broken.classification = {
      channels: ['welfare'],
      relevance: 0.8,
      importance: 'high',
      kind: 'notice',
      isDuplicateOfNational: false,
      effectiveDate: undefined,
      deadline: undefined,
      reason: '理由',
    };
    broken.digestedIn = ['a', undefined];

    await newStore().putItem(broken as unknown as Item);

    const data = lastSet();
    const classification = data.classification as Record<string, unknown>;
    expect(classification.effectiveDate).toBeNull();
    expect(classification.deadline).toBeNull();
    expect(data.digestedIn).toEqual(['a', null]);
  });

  it('正規化は元のオブジェクトを壊さない', async () => {
    const item = makeItem();
    await newStore().putItem(item);

    expect(item.expiresAt).toBe(EXPIRES_AT);
    expect(typeof item.expiresAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// クエリの組み立て
// ---------------------------------------------------------------------------

describe('listItemsInWindow', () => {
  it("where(field,'>=',from).where(field,'<',to).orderBy(field) を組む", async () => {
    await newStore().listItemsInWindow({
      from: '2026-09-12T00:00:00.000Z',
      to: '2026-09-13T00:00:00.000Z',
    });

    const queries = queriesFor('items');
    expect(queries).toHaveLength(1);
    expect(queries[0]?.where).toEqual([
      ['detectedAt', '>=', '2026-09-12T00:00:00.000Z'],
      ['detectedAt', '<', '2026-09-13T00:00:00.000Z'],
    ]);
    expect(queries[0]?.orderBy).toEqual([['detectedAt', 'asc']]);
    expect(queries[0]?.limit).toBeNull();
    expect(queries[0]?.executed).toBe(true);
  });

  it("field に 'updatedAt' を指定すると全ての条件が updatedAt に切り替わる", async () => {
    await newStore().listItemsInWindow({
      from: '2026-09-12T00:00:00.000Z',
      to: '2026-09-13T00:00:00.000Z',
      field: 'updatedAt',
    });

    const query = queriesFor('items')[0];
    expect(query?.where).toEqual([
      ['updatedAt', '>=', '2026-09-12T00:00:00.000Z'],
      ['updatedAt', '<', '2026-09-13T00:00:00.000Z'],
    ]);
    expect(query?.orderBy).toEqual([['updatedAt', 'asc']]);
  });

  it('[from, to) の境界どおりに絞り込まれる', async () => {
    const store = newStore();
    await store.putItem(makeItem({ id: 'a', detectedAt: '2026-09-11T23:59:59.999Z' }));
    await store.putItem(makeItem({ id: 'b', detectedAt: '2026-09-12T00:00:00.000Z' }));
    await store.putItem(makeItem({ id: 'c', detectedAt: '2026-09-13T00:00:00.000Z' }));

    const got = await store.listItemsInWindow({
      from: '2026-09-12T00:00:00.000Z',
      to: '2026-09-13T00:00:00.000Z',
    });

    expect(got.map((item) => item.id)).toEqual(['b']);
  });
});

describe('listUnclassifiedItems', () => {
  it("where('classifiedAt','==',null).orderBy('detectedAt').limit(n) を組む", async () => {
    await newStore().listUnclassifiedItems(50);

    const query = queriesFor('items')[0];
    expect(query?.where).toEqual([['classifiedAt', '==', null]]);
    expect(query?.orderBy).toEqual([['detectedAt', 'asc']]);
    expect(query?.limit).toBe(50);
  });

  it('limit が 0 以下ならクエリを投げない(Firestore がエラーにするため)', async () => {
    const store = newStore();

    expect(await store.listUnclassifiedItems(0)).toEqual([]);
    expect(await store.listUnclassifiedItems(-5)).toEqual([]);
    expect(queriesFor('items')).toHaveLength(0);
  });

  it('classifiedAt が入っているアイテムは拾わない', async () => {
    const store = newStore();
    await store.putItem(makeItem({ id: 'pending', classifiedAt: null }));
    await store.putItem(makeItem({ id: 'done', classifiedAt: '2026-09-12T02:00:00.000Z' }));

    const got = await store.listUnclassifiedItems(10);

    expect(got.map((item) => item.id)).toEqual(['pending']);
  });
});

describe('listRuns', () => {
  it("where('date','==',date).orderBy('startedAt','desc') を組む", async () => {
    await newStore().listRuns('2026-09-13');

    const query = queriesFor('runs')[0];
    expect(query?.where).toEqual([['date', '==', '2026-09-13']]);
    expect(query?.orderBy).toEqual([['startedAt', 'desc']]);
  });

  it('job を指定すると条件が 1 つ増える', async () => {
    await newStore().listRuns('2026-09-13', 'summarize');

    const query = queriesFor('runs')[0];
    expect(query?.where).toEqual([
      ['date', '==', '2026-09-13'],
      ['job', '==', 'summarize'],
    ]);
    expect(query?.orderBy).toEqual([['startedAt', 'desc']]);
  });

  it('新しい順に返る', async () => {
    const store = newStore();
    await store.putRun(makeRun({ id: 'run-1', startedAt: '2026-09-13T00:00:00.000Z' }));
    await store.putRun(makeRun({ id: 'run-2', startedAt: '2026-09-13T09:00:00.000Z' }));

    expect((await store.listRuns('2026-09-13')).map((run) => run.id)).toEqual(['run-2', 'run-1']);
  });
});

// ---------------------------------------------------------------------------
// getItems
// ---------------------------------------------------------------------------

describe('getItems', () => {
  it('ids が空なら getAll を呼ばない(参照 0 件は Firestore がエラーにする)', async () => {
    const got = await newStore().getItems([]);

    expect(got).toEqual([]);
    expect(fs.record.getAllCalls).toHaveLength(0);
  });

  it('重複 ID は 1 回だけ引き、引数の順序を保つ', async () => {
    const store = newStore();
    await store.putItem(makeItem({ id: 'a' }));
    await store.putItem(makeItem({ id: 'b' }));

    const got = await store.getItems(['b', 'a', 'b']);

    expect(fs.record.getAllCalls).toEqual([['b', 'a']]);
    expect(got.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('存在しない ID は結果から落とす', async () => {
    const store = newStore();
    await store.putItem(makeItem({ id: 'a' }));

    const got = await store.getItems(['missing', 'a']);

    expect(got.map((item) => item.id)).toEqual(['a']);
  });

  it('300 件を超えると getAll を分割する', async () => {
    const ids = Array.from({ length: 301 }, (_unused, i) => `id-${i}`);

    await newStore().getItems(ids);

    expect(fs.record.getAllCalls.map((call) => call.length)).toEqual([300, 1]);
  });
});

// ---------------------------------------------------------------------------
// markItemsDigested
// ---------------------------------------------------------------------------

describe('markItemsDigested', () => {
  it('FieldValue.arrayUnion をバッチで使う', async () => {
    await newStore().markItemsDigested(['a', 'b'], 'welfare_2026-09-13');

    expect(fs.record.batches).toHaveLength(1);
    const batch = fs.record.batches[0];
    expect(batch?.committed).toBe(true);
    expect(batch?.updates.map((update) => update.id)).toEqual(['a', 'b']);
    for (const update of batch?.updates ?? []) {
      expect(update.collection).toBe('items');
      expect(Object.keys(update.data)).toEqual(['digestedIn']);
      const sentinel = update.data.digestedIn;
      expect(sentinel).toBeInstanceOf(fs.ArrayUnionSentinel);
      expect((sentinel as InstanceType<typeof fs.ArrayUnionSentinel>).values).toEqual(['welfare_2026-09-13']);
    }
  });

  it('400 件を超えるとバッチを分割する', async () => {
    const ids = Array.from({ length: 401 }, (_unused, i) => `id-${i}`);

    await newStore().markItemsDigested(ids, 'welfare_2026-09-13');

    expect(fs.record.batches.map((batch) => batch.updates.length)).toEqual([400, 1]);
    expect(fs.record.batches.every((batch) => batch.committed)).toBe(true);
  });

  it('ちょうど 400 件なら 1 バッチ', async () => {
    const ids = Array.from({ length: 400 }, (_unused, i) => `id-${i}`);

    await newStore().markItemsDigested(ids, 'welfare_2026-09-13');

    expect(fs.record.batches).toHaveLength(1);
  });

  it('重複 ID は畳んでから分割する(同一ドキュメントを 1 バッチで 2 回更新しない)', async () => {
    await newStore().markItemsDigested(['a', 'a', 'b'], 'welfare_2026-09-13');

    expect(fs.record.batches[0]?.updates.map((update) => update.id)).toEqual(['a', 'b']);
  });

  it('ids が空ならバッチを作らない', async () => {
    await newStore().markItemsDigested([], 'welfare_2026-09-13');

    expect(fs.record.batches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// コレクション名とドキュメント ID
// ---------------------------------------------------------------------------

describe('コレクションとドキュメント ID', () => {
  it('各コレクションへドメイン側のキーで書き込む', async () => {
    const store = newStore();

    await store.putItem(makeItem({ id: 'item-001' }));
    await store.putDigest(makeDigest());
    await store.putDelivery(makeDelivery());
    await store.putSourceState(makeSourceState());
    await store.putRun(makeRun());

    expect(fs.record.sets.map((write) => [write.collection, write.id])).toEqual([
      ['items', 'item-001'],
      ['digests', 'welfare_2026-09-13'],
      ['deliveries', 'welfare_2026-09-13'],
      ['source_state', 'mhlw_news'],
      ['runs', 'run-0001'],
    ]);
  });

  it('存在しないドキュメントは null を返す', async () => {
    const store = newStore();

    expect(await store.getItem('missing')).toBeNull();
    expect(await store.getDigest('missing')).toBeNull();
    expect(await store.getDelivery('missing')).toBeNull();
    expect(await store.getSourceState('missing')).toBeNull();
  });

  it('書いたものが読み戻せる', async () => {
    const store = newStore();
    const digest = makeDigest();
    const delivery = makeDelivery();
    const state = makeSourceState();

    await store.putDigest(digest);
    await store.putDelivery(delivery);
    await store.putSourceState(state);

    expect(await store.getDigest(digest.id)).toEqual(digest);
    expect(await store.getDelivery(delivery.id)).toEqual(delivery);
    expect(await store.getSourceState(state.sourceId)).toEqual(state);
  });

  it('listSourceStates は source_state コレクションを全件取得する', async () => {
    const store = newStore();
    await store.putSourceState(makeSourceState({ sourceId: 'a_source' }));
    await store.putSourceState(makeSourceState({ sourceId: 'b_source' }));

    const got = await store.listSourceStates();

    expect(got.map((state) => state.sourceId)).toEqual(['a_source', 'b_source']);
    const queries = queriesFor('source_state');
    expect(queries).toHaveLength(1);
    expect(queries[0]?.where).toEqual([]);
  });
});
