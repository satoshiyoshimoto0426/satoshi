/**
 * インメモリ Store 実装(詳細設計書 §5 のデータモデル)。
 *
 * 用途:
 *   - ユニットテスト(Firestore エミュレータ不要で決定的に回せる)
 *   - ローカルのドライラン(STORE_KIND=memory)
 *
 * 設計方針:
 * 1. **完全に決定的**。同じ操作列からは必ず同じ結果が返る。
 *    そのため「取得結果の並び順」は Firestore 実装と同じ規則で明示的にソートする。
 *    Firestore は orderBy を付けたクエリに対して、最後の orderBy と同じ向きの
 *    `__name__`(ドキュメント ID)を暗黙の最終ソートキーとして足す。ここでも
 *    同じ規則(昇順クエリなら id 昇順、降順クエリなら id 降順)でタイブレークし、
 *    「メモリでは通るのに本番で並びが違う」を防ぐ。
 * 2. **外部と内部状態を共有しない**。put で受け取ったオブジェクトも、返すオブジェクトも
 *    必ず structuredClone する。テストが返り値を書き換えてストアの中身が壊れる、
 *    逆にテストが作った配列を後から変更してストアが変わる、という事故を断つ。
 *    Firestore 実装は「シリアライズして送受信する」ため実質ディープコピーであり、
 *    その挙動に揃える意味もある。
 * 3. **現在時刻を参照しない**。updatedAt などの更新は呼び出し側の責務(契約の原則 5)。
 */
import type { Delivery, Digest, Item, ItemQuery, JobName, Run, SourceState, Store } from '../types.js';

/** テストから中身を丸ごと覗ける / 流し込めるインメモリ Store。 */
export interface MemoryStore extends Store {
  /** 現在の全データのスナップショット(すべてクローン済み)。 */
  dump(): {
    items: Item[];
    digests: Digest[];
    deliveries: Delivery[];
    sourceStates: SourceState[];
    runs: Run[];
  };
  /**
   * テストの前提データを流し込む。
   * 指定したコレクションだけに作用し、同じキーの既存データは上書きする
   * (= putXxx を順に呼んだのと同じ意味)。指定しなかったコレクションは触らない。
   */
  seed(
    data: Partial<{
      items: Item[];
      digests: Digest[];
      deliveries: Delivery[];
      sourceStates: SourceState[];
      runs: Run[];
    }>,
  ): void;
}

/**
 * 内部保持用・返却用のディープコピー。
 * structuredClone は Node 22 の標準機能で、ドメイン型(プレーンオブジェクト・配列・
 * 文字列・数値・null)はすべて安全に複製できる。
 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** 昇順クエリのタイブレーク(Firestore の暗黙 `__name__` 昇順に合わせる)。 */
function compareAsc(aKey: string, bKey: string, aId: string, bId: string): number {
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

/** 降順クエリのタイブレーク(Firestore の暗黙 `__name__` 降順に合わせる)。 */
function compareDesc(aKey: string, bKey: string, aId: string, bId: string): number {
  return -compareAsc(aKey, bKey, aId, bId);
}

export function createMemoryStore(): MemoryStore {
  // Map は挿入順を保つ。dump() の並びが「書き込んだ順」で安定するのはこの性質による。
  const items = new Map<string, Item>();
  const digests = new Map<string, Digest>();
  const deliveries = new Map<string, Delivery>();
  const sourceStates = new Map<string, SourceState>();
  const runs = new Map<string, Run>();

  /** Map から 1 件取り出してクローンを返す(無ければ null)。 */
  function getCloned<T>(map: Map<string, T>, id: string): T | null {
    const found = map.get(id);
    return found === undefined ? null : clone(found);
  }

  return {
    // ---------------------------------------------------------------- items
    async getItem(id: string): Promise<Item | null> {
      return getCloned(items, id);
    },

    /**
     * 指定 ID のアイテムをまとめて取得する。
     * 並びは引数 ids の順(重複は最初の 1 回だけ)、存在しない ID は黙って飛ばす。
     * Firestore の getAll も「渡した参照の順に返す / 無い分は exists=false」なので、
     * 両実装で呼び出し側のコードが同じ前提で書けるように揃えている。
     */
    async getItems(ids: string[]): Promise<Item[]> {
      const result: Item[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const found = items.get(id);
        if (found !== undefined) result.push(clone(found));
      }
      return result;
    },

    async putItem(item: Item): Promise<void> {
      // 呼び出し側が後からこのオブジェクトを書き換えても内部状態が動かないようにする。
      items.set(item.id, clone(item));
    },

    async listUnclassifiedItems(limit: number): Promise<Item[]> {
      // limit <= 0 は「0 件要求」とみなす(Firestore の limit(0) と同じ挙動)。
      if (limit <= 0) return [];
      return [...items.values()]
        .filter((item) => item.classifiedAt === null)
        .sort((a, b) => compareAsc(a.detectedAt, b.detectedAt, a.id, b.id))
        .slice(0, limit)
        .map(clone);
    },

    async listItemsInWindow(query: ItemQuery): Promise<Item[]> {
      // ISO8601 UTC 文字列は辞書順 = 時系列順なので文字列比較でよい。
      // 区間は [from, to)。境界の to を含めないのは、日次ウィンドウを連結したときに
      // 同じアイテムが 2 日分のダイジェストに入るのを防ぐため。
      const field = query.field ?? 'detectedAt';
      return [...items.values()]
        .filter((item) => item[field] >= query.from && item[field] < query.to)
        .sort((a, b) => compareAsc(a[field], b[field], a.id, b.id))
        .map(clone);
    },

    async markItemsDigested(itemIds: string[], digestId: string): Promise<void> {
      for (const id of itemIds) {
        const found = items.get(id);
        // 存在しない ID は無視する。ダイジェスト生成後にアイテムが TTL で消えた場合でも
        // 配信処理全体を落とさないため。
        if (found === undefined) continue;
        // 同じダイジェストを 2 回記録しない(再実行しても冪等に保つ)。
        if (found.digestedIn.includes(digestId)) continue;
        found.digestedIn.push(digestId);
      }
    },

    async unmarkItemsDigested(itemIds: string[], digestId: string): Promise<void> {
      for (const id of itemIds) {
        const found = items.get(id);
        if (found === undefined) continue;
        found.digestedIn = found.digestedIn.filter((d) => d !== digestId);
      }
    },

    // -------------------------------------------------------------- digests
    async getDigest(id: string): Promise<Digest | null> {
      return getCloned(digests, id);
    },

    async putDigest(digest: Digest): Promise<void> {
      digests.set(digest.id, clone(digest));
    },

    // ----------------------------------------------------------- deliveries
    async getDelivery(id: string): Promise<Delivery | null> {
      return getCloned(deliveries, id);
    },

    async putDelivery(delivery: Delivery): Promise<void> {
      deliveries.set(delivery.id, clone(delivery));
    },

    // --------------------------------------------------------- source state
    async getSourceState(sourceId: string): Promise<SourceState | null> {
      return getCloned(sourceStates, sourceId);
    },

    async putSourceState(state: SourceState): Promise<void> {
      sourceStates.set(state.sourceId, clone(state));
    },

    async listSourceStates(): Promise<SourceState[]> {
      // Firestore のコレクション全件取得はドキュメント ID(= sourceId)昇順で返るため、
      // それに合わせる。
      return [...sourceStates.values()]
        .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))
        .map(clone);
    },

    // ----------------------------------------------------------------- runs
    async putRun(run: Run): Promise<void> {
      runs.set(run.id, clone(run));
    },

    async listRuns(date: string, job?: JobName): Promise<Run[]> {
      return [...runs.values()]
        .filter((run) => run.date === date && (job === undefined || run.job === job))
        .sort((a, b) => compareDesc(a.startedAt, b.startedAt, a.id, b.id))
        .map(clone);
    },

    // ------------------------------------------------------------ テスト用
    dump() {
      return {
        items: [...items.values()].map(clone),
        digests: [...digests.values()].map(clone),
        deliveries: [...deliveries.values()].map(clone),
        sourceStates: [...sourceStates.values()].map(clone),
        runs: [...runs.values()].map(clone),
      };
    },

    seed(data) {
      for (const item of data.items ?? []) items.set(item.id, clone(item));
      for (const digest of data.digests ?? []) digests.set(digest.id, clone(digest));
      for (const delivery of data.deliveries ?? []) deliveries.set(delivery.id, clone(delivery));
      for (const state of data.sourceStates ?? []) sourceStates.set(state.sourceId, clone(state));
      for (const run of data.runs ?? []) runs.set(run.id, clone(run));
    },
  };
}
