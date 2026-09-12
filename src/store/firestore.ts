/**
 * Firestore Store 実装(詳細設計書 §5)。
 *
 * コレクション:
 *   items / digests / deliveries / source_state / runs
 * ドキュメント ID はドメイン側のキーをそのまま使う(items は itemId、digests と
 * deliveries は `${channelId}_${date}`、source_state は sourceId、runs は実行 UUID)。
 * こうすることで「同じキーで put すれば上書き」= 冪等(FR-12)になり、
 * 再実行しても重複ドキュメントが生えない。
 *
 * 設計上の注意:
 * - **Firestore クライアントの生成は createFirestoreStore の中で行う。**
 *   モジュールのトップレベルで `new Firestore()` すると、認証情報の無い環境
 *   (CI・ユニットテスト・ローカルのメモリモード)では import しただけで初期化が
 *   走ってしまう。store/index.ts は memory 分岐でもこのファイルを import するため、
 *   生成タイミングを遅らせておかないとテストが動かなくなる。
 * - 日時はすべて ISO8601 UTC の**文字列**として保存する(NFR-08)。Timestamp 型に
 *   しないのは、範囲クエリを文字列比較で素直に書け(ISO8601 は辞書順 = 時系列順)、
 *   ドメイン型 `Item` などとそのまま相互変換できるため。
 */
import { FieldValue, Firestore } from '@google-cloud/firestore';
import type { DocumentData, DocumentSnapshot, Query, Settings } from '@google-cloud/firestore';
import type { Delivery, Digest, Item, ItemQuery, JobName, Run, SourceState, Store } from '../types.js';

const COLLECTION_ITEMS = 'items';
const COLLECTION_DIGESTS = 'digests';
const COLLECTION_DELIVERIES = 'deliveries';
const COLLECTION_SOURCE_STATE = 'source_state';
const COLLECTION_RUNS = 'runs';

/**
 * 1 バッチあたりの書き込み上限。Firestore の上限は 500 だが、内部的な追加書き込み
 * (インデックス更新など)の余地を残して 400 で分割する。
 */
const BATCH_LIMIT = 400;

/**
 * getAll 1 回あたりの参照数上限。getAll は可変長引数で 10 件超も 1 往復で取れるが、
 * 数千件を一度に渡すと gRPC のメッセージサイズ上限に当たるため分割する。
 */
const GET_ALL_CHUNK = 300;

/** 配列を size 件ずつに分割する。 */
function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * 書き込み前に `undefined` を `null` へ正規化する。
 *
 * なぜ必要か: Firestore の `ignoreUndefinedProperties: true` は undefined の
 * フィールドを「書かない」だけで、null を書いてはくれない。たとえば
 * `publishedAt: undefined` のまま保存するとフィールドごと消え、読み戻したときに
 * `string | null` を期待している側が undefined を受け取る。さらに
 * `classifiedAt == null` の等値クエリ(未分類アイテムの抽出)はフィールドが
 * 存在しないドキュメントにヒットしないため、未分類アイテムが永久に拾われなく
 * なるという致命的な取りこぼしになる。
 * したがって「設定でエラーを避ける(保険)」と「値として null を書く(本命)」の
 * 両方を行う。
 */
function normalizeUndefined(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(normalizeUndefined);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      normalized[key] = normalizeUndefined(source[key]);
    }
    return normalized;
  }
  return value;
}

/** ドメインオブジェクトを書き込み可能なドキュメントデータへ変換する。 */
function toDocumentData(value: object): DocumentData {
  return normalizeUndefined(value) as DocumentData;
}

/** スナップショットをドメイン型へ戻す。存在しなければ null。 */
function fromSnapshot<T>(snapshot: DocumentSnapshot): T | null {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (data === undefined) return null;
  return data as T;
}

export function createFirestoreStore(projectId: string | null, databaseId: string): Store {
  const settings: Settings = {
    // 保険。正規化漏れがあっても例外で本番ジョブを落とさない(値の本命は normalizeUndefined)。
    ignoreUndefinedProperties: true,
    databaseId,
  };
  // projectId は未指定なら Application Default Credentials / メタデータサーバから解決させる。
  if (projectId !== null) settings.projectId = projectId;

  const db = new Firestore(settings);

  const itemsCol = db.collection(COLLECTION_ITEMS);
  const digestsCol = db.collection(COLLECTION_DIGESTS);
  const deliveriesCol = db.collection(COLLECTION_DELIVERIES);
  const sourceStateCol = db.collection(COLLECTION_SOURCE_STATE);
  const runsCol = db.collection(COLLECTION_RUNS);

  return {
    // ---------------------------------------------------------------- items
    async getItem(id: string): Promise<Item | null> {
      return fromSnapshot<Item>(await itemsCol.doc(id).get());
    },

    /**
     * 複数アイテムをまとめて取得する。
     * `in` クエリ(30 件上限)ではなく getAll を使うのは、件数の制約を受けずに
     * ID 指定で引けるため。ids が空のときは getAll を呼ばない
     * (getAll は参照を最低 1 つ要求し、空だとエラーになる)。
     */
    async getItems(ids: string[]): Promise<Item[]> {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) return [];

      const result: Item[] = [];
      for (const idChunk of chunk(uniqueIds, GET_ALL_CHUNK)) {
        const refs = idChunk.map((id) => itemsCol.doc(id));
        // getAll は可変長引数。返りは渡した参照と同じ並びなので、10 件超でも順序は保たれる。
        const snapshots = await db.getAll(...refs);
        for (const snapshot of snapshots) {
          const item = fromSnapshot<Item>(snapshot);
          // 存在しない ID は結果から落とす(呼び出し側で件数差分を見て判断する)。
          if (item !== null) result.push(item);
        }
      }
      return result;
    },

    async putItem(item: Item): Promise<void> {
      await itemsCol.doc(item.id).set(toDocumentData(item));
    },

    async listUnclassifiedItems(limit: number): Promise<Item[]> {
      // limit <= 0 のクエリは Firestore がエラーにするため、呼ぶ前に空で返す。
      if (limit <= 0) return [];
      const snapshot = await itemsCol
        .where('classifiedAt', '==', null)
        .orderBy('detectedAt')
        .limit(limit)
        .get();
      return snapshot.docs.map((doc) => doc.data() as Item);
    },

    async listItemsInWindow(query: ItemQuery): Promise<Item[]> {
      // detectedAt は ISO8601 UTC 文字列。辞書順 = 時系列順なので文字列の範囲比較で正しい。
      // 区間は [from, to)。境界を含めないことで、日次ウィンドウを連結しても
      // 同じアイテムが 2 日分のダイジェストに入らない。
      const snapshot = await itemsCol
        .where('detectedAt', '>=', query.from)
        .where('detectedAt', '<', query.to)
        .orderBy('detectedAt')
        .get();
      return snapshot.docs.map((doc) => doc.data() as Item);
    },

    /**
     * digestedIn に digestId を追記する。
     * arrayUnion は「既に入っていれば何もしない」ため、再実行しても重複しない(冪等)。
     * 読み取り→書き込みをしないので、並行実行しても互いの追記を消さない。
     */
    async markItemsDigested(itemIds: string[], digestId: string): Promise<void> {
      const uniqueIds = [...new Set(itemIds)];
      if (uniqueIds.length === 0) return;

      for (const idChunk of chunk(uniqueIds, BATCH_LIMIT)) {
        const batch = db.batch();
        for (const id of idChunk) {
          batch.update(itemsCol.doc(id), { digestedIn: FieldValue.arrayUnion(digestId) });
        }
        await batch.commit();
      }
    },

    // -------------------------------------------------------------- digests
    async getDigest(id: string): Promise<Digest | null> {
      return fromSnapshot<Digest>(await digestsCol.doc(id).get());
    },

    async putDigest(digest: Digest): Promise<void> {
      await digestsCol.doc(digest.id).set(toDocumentData(digest));
    },

    // ----------------------------------------------------------- deliveries
    async getDelivery(id: string): Promise<Delivery | null> {
      return fromSnapshot<Delivery>(await deliveriesCol.doc(id).get());
    },

    async putDelivery(delivery: Delivery): Promise<void> {
      await deliveriesCol.doc(delivery.id).set(toDocumentData(delivery));
    },

    // --------------------------------------------------------- source state
    async getSourceState(sourceId: string): Promise<SourceState | null> {
      return fromSnapshot<SourceState>(await sourceStateCol.doc(sourceId).get());
    },

    async putSourceState(state: SourceState): Promise<void> {
      await sourceStateCol.doc(state.sourceId).set(toDocumentData(state));
    },

    async listSourceStates(): Promise<SourceState[]> {
      // ソース数は数十件規模(詳細設計書 §4)なので全件取得でよい。
      const snapshot = await sourceStateCol.get();
      return snapshot.docs.map((doc) => doc.data() as SourceState);
    },

    // ----------------------------------------------------------------- runs
    async putRun(run: Run): Promise<void> {
      await runsCol.doc(run.id).set(toDocumentData(run));
    },

    async listRuns(date: string, job?: JobName): Promise<Run[]> {
      // date(JST 日付)で絞り、job が指定されていればさらに絞る。
      // 新しい順に返す契約なので startedAt 降順。
      // 必要な複合インデックス:
      //   (date ASC, job ASC, startedAt DESC) … job 指定あり。infra/terraform に定義済み。
      //   (date ASC, startedAt DESC)          … job 指定なし。等価条件と別フィールドの
      //     並び替えの組み合わせは自動単一フィールドインデックスでは賄えないため、
      //     job を省略して呼ぶ運用を始める際はインデックス追加が必要。
      let query: Query<DocumentData, DocumentData> = runsCol.where('date', '==', date);
      if (job !== undefined) query = query.where('job', '==', job);
      const snapshot = await query.orderBy('startedAt', 'desc').get();
      return snapshot.docs.map((doc) => doc.data() as Run);
    },
  };
}
