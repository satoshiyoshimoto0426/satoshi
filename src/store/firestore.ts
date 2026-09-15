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
 * - **例外は `expiresAt` のみ。** Firestore の TTL ポリシーは Timestamp 型の
 *   フィールドしか削除対象にしない。文字列のままだと 1 件も消えず、監査データが
 *   無限に残る(FR-16 の 90 日保持と M3-05 に反する)。そのため書き込み時に
 *   Timestamp へ変換し、読み戻し時に ISO 文字列へ戻す。
 *   `expiresAt` で範囲クエリはしないので、文字列比較の利点は失われない。
 */
import { FieldValue, Firestore, Timestamp } from '@google-cloud/firestore';
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

/**
 * Firestore の NOT_FOUND(gRPC code 5)か。
 * batch.update は対象が無いとバッチ全体を落とすため、個別に読み飛ばす判定に使う。
 */
function isNotFound(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (code === 5) return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('NOT_FOUND');
}

/** TTL 対象フィールド名。Terraform の google_firestore_field と一致させること。 */
const TTL_FIELD = 'expiresAt';

/**
 * ドメインオブジェクトを書き込み可能なドキュメントデータへ変換する。
 * `expiresAt` だけは Firestore の TTL が効くよう Timestamp に変換する。
 */
function toDocumentData(value: object): DocumentData {
  const data = normalizeUndefined(value) as DocumentData;
  const expires = data[TTL_FIELD];
  if (typeof expires === 'string' && expires !== '') {
    const parsed = new Date(expires);
    // 壊れた日付で書き込み全体を落とさない。その場合は TTL が効かないだけに留める。
    if (!Number.isNaN(parsed.getTime())) {
      data[TTL_FIELD] = Timestamp.fromDate(parsed);
    }
  }
  return data;
}

/** 読み戻し時に Timestamp の `expiresAt` を ISO8601 文字列へ戻す。 */
function fromDocumentData<T>(data: DocumentData): T {
  const expires = data[TTL_FIELD];
  if (expires instanceof Timestamp) {
    return { ...data, [TTL_FIELD]: expires.toDate().toISOString() } as T;
  }
  return data as T;
}

/** スナップショットをドメイン型へ戻す。存在しなければ null。 */
function fromSnapshot<T>(snapshot: DocumentSnapshot): T | null {
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (data === undefined) return null;
  return fromDocumentData<T>(data);
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
      return snapshot.docs.map((doc) => fromDocumentData<Item>(doc.data()));
    },

    async listItemsInWindow(query: ItemQuery): Promise<Item[]> {
      // ISO8601 UTC 文字列は辞書順 = 時系列順なので文字列の範囲比較で正しい。
      // 区間は [from, to)。境界を含めないことで、日次ウィンドウを連結しても
      // 同じアイテムが 2 日分のダイジェストに入らない。
      // field は単一フィールドの範囲クエリなので、Firestore の自動インデックスで賄える
      // (複合インデックスの追加は不要)。
      const field = query.field ?? 'detectedAt';
      const snapshot = await itemsCol
        .where(field, '>=', query.from)
        .where(field, '<', query.to)
        .orderBy(field)
        .get();
      return snapshot.docs.map((doc) => fromDocumentData<Item>(doc.data()));
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
        try {
          await batch.commit();
        } catch (e) {
          // batch.update は対象ドキュメントが存在しないとバッチ全体を NOT_FOUND で落とす。
          // TTL(90 日)で消えたアイテムが 1 件混ざっただけで、他の印付けまで巻き添えになる。
          // 印が付かないまま digest が配信されると、翌日の繰り越しが同じ記事を拾い
          // 二重配信になる(FR-03 違反)。memory 実装は存在しない ID を無視する仕様なので、
          // 挙動を揃えるために 1 件ずつ再試行し、NOT_FOUND だけを読み飛ばす。
          if (!isNotFound(e)) throw e;
          for (const id of idChunk) {
            try {
              await itemsCol.doc(id).update({ digestedIn: FieldValue.arrayUnion(digestId) });
            } catch (inner) {
              if (!isNotFound(inner)) throw inner;
            }
          }
        }
      }
    },

    /**
     * digestedIn から digestId を取り除く(`summarize --force` の作り直し用)。
     * markItemsDigested と同じ理由で NOT_FOUND は読み飛ばす。
     */
    async unmarkItemsDigested(itemIds: string[], digestId: string): Promise<void> {
      const uniqueIds = [...new Set(itemIds)];
      if (uniqueIds.length === 0) return;

      for (const idChunk of chunk(uniqueIds, BATCH_LIMIT)) {
        const batch = db.batch();
        for (const id of idChunk) {
          batch.update(itemsCol.doc(id), { digestedIn: FieldValue.arrayRemove(digestId) });
        }
        try {
          await batch.commit();
        } catch (e) {
          if (!isNotFound(e)) throw e;
          for (const id of idChunk) {
            try {
              await itemsCol.doc(id).update({ digestedIn: FieldValue.arrayRemove(digestId) });
            } catch (inner) {
              if (!isNotFound(inner)) throw inner;
            }
          }
        }
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
      return snapshot.docs.map((doc) => fromDocumentData<SourceState>(doc.data()));
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
      return snapshot.docs.map((doc) => fromDocumentData<Run>(doc.data()));
    },
  };
}
