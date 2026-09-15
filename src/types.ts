/**
 * 全モジュール共通のドメイン型。
 * 詳細設計書 §5(データモデル)/ §7(AI 設計)/ §8(品質ゲート)に対応する。
 *
 * このファイルは各モジュール間の「契約」であり、実装より先に固定される。
 * 変更する場合は詳細設計書も同時に更新すること。
 */

// ---------------------------------------------------------------------------
// 設定(詳細設計書 §4)
// ---------------------------------------------------------------------------

/** 配信チャネル(= LINE 公式アカウント 1 つ)。 */
export interface ChannelConfig {
  /** チャネル ID。`ai_reskill` / `welfare` など。 */
  id: string;
  /** LINE 公式アカウント名。メッセージ 2 行目に出る。 */
  name: string;
  /**
   * LINE チャネルアクセストークンの Secret Manager リソース名。
   * 環境変数 `LINE_TOKEN_<ID大文字>` が設定されていればそちらを優先する。
   */
  lineTokenSecret: string | null;
  /** このチャネルが扱う話題領域。AI 分類・要約プロンプトに渡す。 */
  topics: string;
  /** ダイジェスト採用の関連度しきい値(0..1)。 */
  relevanceThreshold: number;
  /** ダイジェスト最大項目数(FR-07)。 */
  maxItems: number;
  /** ダイジェスト目標最小項目数。下回っても配信はする(品質ゲート Q6)。 */
  minItems: number;
  /** 整形後メッセージの目標最大文字数(FR-09)。 */
  maxChars: number;
  /** 0 件の日も「新着なし」を配信するか(FR-11)。既定 true。 */
  sendWhenEmpty: boolean;
  /** 配信時刻(JST, "HH:MM")。Scheduler 設定との突き合わせ用の記録値。 */
  deliverAt: string;
  /** 承認モード(FR-15)。true なら `approved` の digest のみ配信する。 */
  requireApproval: boolean;
}

export type SourceType = 'rss' | 'html' | 'egov';
export type SourcePriority = 'high' | 'medium' | 'low';

/** HTML 差分監視の抽出設定。 */
export interface HtmlSourceOptions {
  /** 新着リンクを列挙する CSS セレクタ。`a` 要素、または `a` を内包する要素。 */
  itemSelector: string;
  /** リンク文字列の取得元。既定 'text'。 */
  titleFrom: 'text' | 'title' | 'aria-label';
  /** リンク先の取得元属性。既定 'href'。 */
  hrefFrom: string;
  /** 日付テキストのセレクタ(itemSelector 要素からの相対、または親要素内)。null 可。 */
  dateSelector: string | null;
  /** 候補リンクを絞り込む URL 部分一致文字列。空配列なら絞り込まない。 */
  includeUrlPatterns: string[];
  /** 除外する URL 部分一致文字列。 */
  excludeUrlPatterns: string[];
}

/** e-Gov 法令 API の設定。 */
export interface EgovSourceOptions {
  endpoint: string;
  /** 何日前まで遡って改正を拾うか。 */
  lookbackDays: number;
}

/** 監視対象 1 件。 */
export interface SourceConfig {
  id: string;
  name: string;
  type: SourceType;
  /** type='egov' の場合は null(endpoint を使う)。 */
  url: string | null;
  /** 紐付けるチャネル ID の配列。 */
  channels: string[];
  priority: SourcePriority;
  /** 自治体ソースの地域名(例: '大阪府')。国のソースは null(FR-18)。 */
  region: string | null;
  enabled: boolean;
  html: HtmlSourceOptions | null;
  egov: EgovSourceOptions | null;
  /** このソース由来のアイテムに付ける補足メモ。AI 入力に含める。 */
  note: string | null;
}

/** 実行時設定(環境変数由来)。 */
export interface RuntimeConfig {
  gcpProjectId: string | null;
  firestoreDatabaseId: string;
  /** 'firestore' | 'memory'。テストとドライランでは memory。 */
  storeKind: 'firestore' | 'memory';
  anthropicModel: string;
  userAgent: string;
  /** 同一ホストへの最小アクセス間隔(ms)。NFR-07。 */
  hostDelayMs: number;
  /** 異なるホスト間の並列数。 */
  hostConcurrency: number;
  httpTimeoutMs: number;
  /** 1 ソースあたりの 1 回の巡回で取り込む新規アイテム上限。 */
  maxNewItemsPerSource: number;
  /**
   * 1 ソースあたり 1 回の巡回で「本文を取り直す既知アイテム」の上限。
   *
   * 一覧のリンク文字列が変わらないまま本文だけ差し替わるページ
   * (「◯◯について」に Q&A 第3報が追記される等)は、一覧の変化を見るだけでは
   * 永久に検知できない。かといって既知 URL を毎回全件取り直すと、
   * 同一ホスト 2 秒間隔(NFR-07)と掛け算になって巡回が終わらない。
   * そこで毎回少数だけ、最後に更新を確認してから最も時間が経ったものから取り直す。
   */
  recheckPerSource: number;
  /** items.contentText の最大保存文字数。 */
  maxContentChars: number;
  /** 監査データの保持日数(FR-16)。 */
  retentionDays: number;
  /**
   * 運用通知の送信先 Webhook URL。Slack でも Discord でも使える。
   * null なら通知は送らずログ出力のみ。
   */
  notifyWebhookUrl: string | null;
  /**
   * 通知先の種別。null なら URL から自動判別する。
   * 自動判別で困る場合(独自の中継サーバ経由など)にだけ明示する。
   */
  notifyWebhookKind: 'slack' | 'discord' | null;
  /** true なら LINE 送信と運用通知を行わず内容をログ出力する。 */
  dryRun: boolean;
}

export interface AppConfig {
  channels: ChannelConfig[];
  sources: SourceConfig[];
  runtime: RuntimeConfig;
}

// ---------------------------------------------------------------------------
// ドメインモデル(詳細設計書 §5)
// ---------------------------------------------------------------------------

export type ItemContentType = 'html' | 'pdf' | 'text';

export type ItemKind =
  'law_amendment' | 'fee_revision' | 'notice' | 'public_comment' | 'budget' | 'event' | 'other';

export type Importance = 'high' | 'medium' | 'low';

/** AI 分類結果(詳細設計書 §7.1)。 */
export interface Classification {
  channels: string[];
  relevance: number;
  importance: Importance;
  kind: ItemKind;
  /** 自治体ページが国の通知を転載しただけなら true。 */
  isDuplicateOfNational: boolean;
  /** YYYY-MM-DD。原文に明記がある場合のみ。 */
  effectiveDate: string | null;
  deadline: string | null;
  reason: string;
}

/** 収集アイテム(Firestore `items`)。日時は ISO8601 UTC 文字列で保持する(NFR-08)。 */
export interface Item {
  id: string;
  sourceId: string;
  canonicalUrl: string;
  title: string;
  publishedAt: string | null;
  detectedAt: string;
  updatedAt: string;
  contentHash: string;
  contentText: string;
  contentType: ItemContentType;
  region: string | null;
  classification: Classification | null;
  classifiedAt: string | null;
  /** 使用済みダイジェスト ID の配列。再利用防止。 */
  digestedIn: string[];
  /** TTL(ISO8601)。Firestore の TTL ポリシー対象フィールド。 */
  expiresAt: string;
}

/** ダイジェスト 1 項目(詳細設計書 §7.2 の AI 出力 + 検証済み)。 */
export interface DigestEntry {
  itemId: string;
  headline: string;
  summary: string;
  affected: string;
  dateNote: string | null;
  sourceUrl: string;
  importance: Importance;
}

/** 品質ゲートで除外された項目とその理由(詳細設計書 §8)。 */
export interface ExcludedEntry {
  itemId: string;
  headline: string;
  sourceUrl: string;
  /** 'Q1'..'Q8' */
  check: string;
  reason: string;
}

export type DigestStatus = 'generated' | 'approved' | 'delivered' | 'skipped' | 'failed';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 巡回状況のサマリ。「新着なし」文面(詳細設計書 §9.1)に使う。 */
export interface CoverageSummary {
  /** 当日巡回対象だったソース数。 */
  total: number;
  /** うち巡回に成功したソース数。 */
  succeeded: number;
  /** 最終巡回時刻(JST "HH:MM")。巡回記録が無ければ null。 */
  lastCollectedAtJst: string | null;
}

/** 生成済みまとめ(Firestore `digests`)。 */
export interface Digest {
  id: string;
  channelId: string;
  /** JST 日付 YYYY-MM-DD。 */
  date: string;
  entries: DigestEntry[];
  excluded: ExcludedEntry[];
  /** AI が絞り込みで落とした件数 + 品質ゲート除外件数。 */
  omittedCount: number;
  /** 対象アイテムが 0 件だった(= 新着なし配信)。 */
  isEmpty: boolean;
  coverage: CoverageSummary;
  messageText: string;
  status: DigestStatus;
  model: string;
  prompt: string;
  rawResponse: string;
  usage: TokenUsage | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type DeliveryStatus = 'sent' | 'failed';

/** 配信記録(Firestore `deliveries`)。id が冪等キー(FR-12)。 */
export interface Delivery {
  id: string;
  channelId: string;
  date: string;
  digestId: string;
  lineRequestId: string | null;
  retryKey: string;
  status: DeliveryStatus;
  attempts: number;
  sentAt: string | null;
  error: string | null;
  updatedAt: string;
  expiresAt: string;
}

/** ソースごとの巡回状態(Firestore `source_state`)。 */
export interface SourceState {
  sourceId: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  etag: string | null;
  lastModified: string | null;
  lastError: string | null;
  /** 直近の巡回で検知した新規件数。 */
  lastNewCount: number;
  /** 直近の巡回で一覧から取れた候補リンク数。0 が続くならセレクタ失効を疑う。 */
  lastCandidateCount: number;
  /**
   * 候補リンクが 0 件だった巡回が何回続いているか。
   * HTTP は 200 を返すのにセレクタが失効している「静かな故障」を検知するための指標。
   * これが無いと、サイト改修でリンクが一切取れなくなっても巡回は成功扱いになり、
   * 受信者には「正常に監視した結果、新着なし」と配信されてしまう(要件 G5)。
   */
  consecutiveEmpty: number;
  /** 連続失敗の警告を既に通知した回数(重複通知防止)。 */
  warnedAtFailureCount: number;
  /** 候補 0 件の警告を既に通知した回数(重複通知防止)。 */
  warnedAtEmptyCount: number;
}

export type JobName = 'collect' | 'summarize' | 'deliver';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'partial';

export interface RunCounts {
  sourcesTotal: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  fetched: number;
  newItems: number;
  updatedItems: number;
  classified: number;
  digestsGenerated: number;
  excluded: number;
  sent: number;
  skipped: number;
}

/** ジョブ実行記録(Firestore `runs`)。 */
export interface Run {
  id: string;
  job: JobName;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  counts: RunCounts;
  /** 当日 JST 日付。 */
  date: string;
  errors: string[];
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// フェッチャー(詳細設計書 §6.1)
// ---------------------------------------------------------------------------

/** ソースから抽出した「候補リンク」1 件。本文はまだ取得していない。 */
export interface SourceCandidate {
  /** 絶対 URL(正規化前)。 */
  url: string;
  title: string;
  /** ISO8601。取得できなければ null。 */
  publishedAt: string | null;
}

/** フェッチャーの戻り値。 */
export interface FetchResult {
  candidates: SourceCandidate[];
  /** 条件付き GET が 304 を返した場合 true。candidates は空。 */
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
}

/** 本文抽出結果。 */
export interface ExtractedContent {
  text: string;
  contentType: ItemContentType;
  /** 本文から得られたより良いタイトル。無ければ null。 */
  title: string | null;
}

// ---------------------------------------------------------------------------
// HTTP(詳細設計書 §6.1 / NFR-07)
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  /** 文字コードを判定して UTF-8 に変換済みの本文。バイナリの場合は空文字。 */
  text: string;
  /** 生バイト列。PDF など。 */
  body: Uint8Array;
  headers: Record<string, string>;
  finalUrl: string;
}

export interface HttpGetOptions {
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  /** robots.txt チェックを省略する(LINE/Anthropic など API 呼び出し用)。 */
  skipRobots?: boolean;
  /** 既定 2 回。 */
  retries?: number;
  accept?: string;
}

export interface HttpClient {
  /** 条件付き GET。robots.txt 不許可なら RobotsDisallowedError を投げる。 */
  get(url: string, options?: HttpGetOptions): Promise<HttpResponse>;
  /**
   * 到達確認(品質ゲート Q2)。2xx/3xx なら true。
   *
   * robotsDisallowed は「robots.txt が巡回を禁じているため確かめられなかった」印。
   * ok は false のままにする(ソース設定の検証では NG として扱うのが正しい)が、
   * Q2 はこれを「存在しない」とは解釈しない ― 存在は Q1/Q3 が担保しており、
   * robots の拒否は「巡回するな」であって「無い」ではないため。
   */
  checkReachable(
    url: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; status: number | null; error: string | null; robotsDisallowed?: boolean }>;
}

// ---------------------------------------------------------------------------
// ストア(詳細設計書 §5)
// ---------------------------------------------------------------------------

export interface ItemQuery {
  /** 対象フィールド >= from(ISO8601 UTC)。 */
  from: string;
  /** 対象フィールド < to(ISO8601 UTC)。 */
  to: string;
  /**
   * 範囲を判定するフィールド。既定は 'detectedAt'(初検知)。
   * 'updatedAt' は「既知 URL の内容が更新された」ものを拾うために使う。
   * detectedAt は初検知時刻のまま据え置かれるため、更新記事は detectedAt では拾えない。
   */
  field?: 'detectedAt' | 'updatedAt';
}

export interface Store {
  // items
  getItem(id: string): Promise<Item | null>;
  getItems(ids: string[]): Promise<Item[]>;
  putItem(item: Item): Promise<void>;
  /** 分類がまだ付いていないアイテムを古い順に取得。 */
  listUnclassifiedItems(limit: number): Promise<Item[]>;
  /** query.field(既定 detectedAt)が [from, to) のアイテムを取得。 */
  listItemsInWindow(query: ItemQuery): Promise<Item[]>;
  /** digestedIn に digestId を追記する。 */
  markItemsDigested(itemIds: string[], digestId: string): Promise<void>;
  /**
   * digestedIn から digestId を取り除く。
   * `summarize --force` の作り直しで、前回は載ったが今回は載らなかった項目を
   * 「未配信」に戻すために使う。戻さないと、その項目は配信されていないのに
   * 配信済みと見なされ、繰り越しの対象からも外れて永久に埋もれる。
   */
  unmarkItemsDigested(itemIds: string[], digestId: string): Promise<void>;

  // digests
  getDigest(id: string): Promise<Digest | null>;
  putDigest(digest: Digest): Promise<void>;

  // deliveries
  getDelivery(id: string): Promise<Delivery | null>;
  putDelivery(delivery: Delivery): Promise<void>;

  // source state
  getSourceState(sourceId: string): Promise<SourceState | null>;
  putSourceState(state: SourceState): Promise<void>;
  listSourceStates(): Promise<SourceState[]>;

  // runs
  putRun(run: Run): Promise<void>;
  /** 指定 JST 日付・ジョブの実行記録を新しい順に取得。 */
  listRuns(date: string, job?: JobName): Promise<Run[]>;
}

// ---------------------------------------------------------------------------
// AI(詳細設計書 §7)
// ---------------------------------------------------------------------------

/** 分類の入力 1 件。 */
export interface ClassifyInputItem {
  id: string;
  title: string;
  url: string;
  /** 先頭 1,500 文字。 */
  excerpt: string;
  region: string | null;
  sourceName: string;
}

export interface ClassifyChannelInfo {
  id: string;
  name: string;
  topics: string;
}

export interface ClassifyResult {
  id: string;
  classification: Classification;
}

/** ダイジェスト生成の入力 1 件。 */
export interface DigestInputItem {
  id: string;
  title: string;
  url: string;
  kind: ItemKind;
  importance: Importance;
  effectiveDate: string | null;
  deadline: string | null;
  region: string | null;
  sourceName: string;
  /** 先頭 3,000 文字。 */
  excerpt: string;
}

/** AI が返した生のダイジェスト(検証前)。 */
export interface RawDigest {
  entries: DigestEntry[];
  omittedCount: number;
}

export interface AiCallMeta {
  model: string;
  prompt: string;
  rawResponse: string;
  usage: TokenUsage | null;
}

export interface AiClient {
  classify(
    items: ClassifyInputItem[],
    channels: ClassifyChannelInfo[],
  ): Promise<{ results: ClassifyResult[]; meta: AiCallMeta }>;

  generateDigest(
    channel: ChannelConfig,
    dateJst: string,
    items: DigestInputItem[],
  ): Promise<{ digest: RawDigest; meta: AiCallMeta }>;
}

// ---------------------------------------------------------------------------
// LINE(詳細設計書 §9)
// ---------------------------------------------------------------------------

export interface BroadcastResult {
  requestId: string | null;
  status: number;
}

export interface LineClient {
  /** 全友だちへテキスト 1 通を配信する。 */
  broadcast(token: string, text: string, retryKey: string): Promise<BroadcastResult>;
}

// ---------------------------------------------------------------------------
// 通知(詳細設計書 §12)
// ---------------------------------------------------------------------------

export type NotifyLevel = 'info' | 'warn' | 'error';

export interface Notifier {
  notify(level: NotifyLevel, title: string, lines: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// ロガー / 時計
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** テスト容易性のため現在時刻は必ずこの経路で取得する。 */
export interface Clock {
  now(): Date;
}

// ---------------------------------------------------------------------------
// 実行コンテキスト
// ---------------------------------------------------------------------------

export interface AppContext {
  config: AppConfig;
  store: Store;
  http: HttpClient;
  ai: AiClient;
  line: LineClient;
  notifier: Notifier;
  logger: Logger;
  clock: Clock;
  /** LINE チャネルアクセストークンを解決する。dryRun 時はダミーを返してよい。 */
  resolveLineToken(channel: ChannelConfig): Promise<string>;
  /** UUID v4。 */
  newId(): string;
}

// ---------------------------------------------------------------------------
// エラー型
// ---------------------------------------------------------------------------

export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string) {
    super(`robots.txt により取得が許可されていません: ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}: ${url}`);
    this.name = 'HttpError';
  }
}

export class AiError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export class LineApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LineApiError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
