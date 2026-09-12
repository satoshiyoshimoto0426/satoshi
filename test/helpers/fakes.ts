/**
 * パイプライン結合テスト用のフェイク実装とファクトリ(詳細設計書 §13「結合」)。
 *
 * 方針:
 *  - **外部ネットワークには一切出ない。** HttpClient / AiClient / LineClient / Notifier は
 *    すべてここで用意したフェイクを AppContext に注入する。実装(src/pipeline/*)は本物を使う。
 *  - **完全に決定的。** 時刻は Clock 経由の固定値、ID は連番。
 *  - **記録できること。** 何を送ったか・何回呼ばれたかをテストから検査できるよう、
 *    呼び出しはすべて配列に残す。通知や LINE 本文は「事故が起きていないこと」を
 *    確かめる唯一の手段なので、件数だけでなく引数そのものを保持する。
 */

import { createMemoryStore } from '../../src/store/memory.js';
import type { MemoryStore } from '../../src/store/memory.js';
import { HttpError } from '../../src/types.js';
import type {
  AiCallMeta,
  AiClient,
  AppConfig,
  AppContext,
  ChannelConfig,
  Classification,
  ClassifyChannelInfo,
  ClassifyInputItem,
  ClassifyResult,
  Clock,
  Delivery,
  Digest,
  DigestEntry,
  DigestInputItem,
  HttpClient,
  HttpGetOptions,
  HttpResponse,
  Item,
  LineClient,
  Logger,
  NotifyLevel,
  Notifier,
  RawDigest,
  Run,
  RuntimeConfig,
  SourceConfig,
  SourceState,
  Store,
} from '../../src/types.js';
import { fixedClock } from '../../src/util/clock.js';
import { itemIdFor, sha256 } from '../../src/util/hash.js';
import { addDays } from '../../src/util/time.js';
import { canonicalizeUrl } from '../../src/util/url.js';

/** 既定の固定時刻。UTC 2026-09-12 22:30 = JST 2026-09-13 07:30(配信時刻)。 */
export const DEFAULT_NOW = '2026-09-12T22:30:00.000Z';

/** 既定時刻での JST 日付。digestWindow はこの日付を基準に組む。 */
export const DEFAULT_DATE_JST = '2026-09-13';

function clone<T>(value: T): T {
  return structuredClone(value);
}

// ---------------------------------------------------------------------------
// 時計
// ---------------------------------------------------------------------------

/** 時刻を動かせる時計。更新検知や再送のように「時間が経つ」ことが本質の検証で使う。 */
export interface MutableClock extends Clock {
  set(iso: string): void;
  advance(ms: number): void;
}

export function mutableClock(iso: string = DEFAULT_NOW): MutableClock {
  let current = new Date(iso);
  if (Number.isNaN(current.getTime())) throw new TypeError(`mutableClock: 不正な日時です: ${iso}`);
  return {
    now: () => new Date(current.getTime()),
    set(next: string) {
      const parsed = new Date(next);
      if (Number.isNaN(parsed.getTime())) throw new TypeError(`mutableClock.set: 不正な日時です: ${next}`);
      current = parsed;
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

// ---------------------------------------------------------------------------
// ロガー
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  level: LogLevel;
  msg: string;
  fields: Record<string, unknown>;
}

export interface FakeLogger extends Logger {
  /** child() で作った子ロガーの記録も同じ配列に集まる。 */
  records: LogRecord[];
  /** レベルとメッセージの部分一致で絞り込む。 */
  find(level: LogLevel, substring: string): LogRecord[];
}

/** 標準出力を汚さず、記録だけ残すロガー。 */
export function createFakeLogger(base: Record<string, unknown> = {}, records: LogRecord[] = []): FakeLogger {
  const push = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    records.push({ level, msg, fields: { ...base, ...(fields ?? {}) } });
  };
  return {
    records,
    debug: (msg, fields) => push('debug', msg, fields),
    info: (msg, fields) => push('info', msg, fields),
    warn: (msg, fields) => push('warn', msg, fields),
    error: (msg, fields) => push('error', msg, fields),
    child: (fields) => createFakeLogger({ ...base, ...fields }, records),
    find: (level, substring) => records.filter((r) => r.level === level && r.msg.includes(substring)),
  };
}

// ---------------------------------------------------------------------------
// ストア(MemoryStore + 書き込み履歴)
// ---------------------------------------------------------------------------

/**
 * 本物の MemoryStore に「書き込みの履歴」を足したもの。
 * MemoryStore は同じ id を上書きするため、
 * 「Run が running と終了状態で 2 回書かれたか」は dump() では分からない。
 */
export interface TestStore extends MemoryStore {
  runWrites: Run[];
  itemWrites: Item[];
  digestWrites: Digest[];
  deliveryWrites: Delivery[];
  sourceStateWrites: SourceState[];
}

export function createTestStore(): TestStore {
  const base: Store = createMemoryStore();
  const memory = base as MemoryStore;
  const runWrites: Run[] = [];
  const itemWrites: Item[] = [];
  const digestWrites: Digest[] = [];
  const deliveryWrites: Delivery[] = [];
  const sourceStateWrites: SourceState[] = [];

  return {
    ...memory,
    runWrites,
    itemWrites,
    digestWrites,
    deliveryWrites,
    sourceStateWrites,
    async putRun(run: Run) {
      runWrites.push(clone(run));
      await memory.putRun(run);
    },
    async putItem(item: Item) {
      itemWrites.push(clone(item));
      await memory.putItem(item);
    },
    async putDigest(digest: Digest) {
      digestWrites.push(clone(digest));
      await memory.putDigest(digest);
    },
    async putDelivery(delivery: Delivery) {
      deliveryWrites.push(clone(delivery));
      await memory.putDelivery(delivery);
    },
    async putSourceState(state: SourceState) {
      sourceStateWrites.push(clone(state));
      await memory.putSourceState(state);
    },
  };
}

// ---------------------------------------------------------------------------
// HttpClient
// ---------------------------------------------------------------------------

export interface FakePage {
  /** 返す本文。省略時は空文字。 */
  html?: string;
  status?: number;
  etag?: string | null;
  lastModified?: string | null;
  contentType?: string;
  /** リダイレクト後の URL。相対 URL の解決基準になる。 */
  finalUrl?: string;
}

export interface ReachableResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface FakeHttpInit {
  /** 一覧ページ URL → HTML。 */
  lists?: Record<string, string | FakePage>;
  /** 記事ページ URL → 本文テキスト(または HTML / 詳細指定)。 */
  articles?: Record<string, string | FakePage>;
}

export interface FakeHttpClient extends HttpClient {
  getCalls: Array<{ url: string; options: HttpGetOptions | undefined }>;
  reachableCalls: string[];
  setList(url: string, page: string | FakePage): void;
  setArticle(url: string, page: string | FakePage): void;
  /** その URL への get を必ず失敗させる(robots 不許可・5xx の再現)。 */
  setError(url: string, error: Error | null): void;
  /** Q2 の到達確認結果を URL 単位で差し替える。既定は ok:true。 */
  setReachable(url: string, result: ReachableResult): void;
  /** その URL を何回 get したか。 */
  getCount(url: string): number;
}

const DEFAULT_REACHABLE: ReachableResult = { ok: true, status: 200, error: null };

function canonicalKey(url: string): string {
  try {
    return canonicalizeUrl(url);
  } catch {
    return url;
  }
}

/** URL の末尾パスから見出しらしき文字列を作る(本文ラップ用)。 */
function titleOf(url: string): string {
  const segments = url.split(/[?#]/)[0]?.split('/') ?? [];
  return segments[segments.length - 1] ?? url;
}

/** プレーンな本文テキストを最小限の HTML ページに包む(本物の抽出経路を通すため)。 */
export function makeArticleHtml(title: string, body: string): string {
  return [
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
    `<title>${title}</title></head><body>`,
    '<header>サイト内ナビゲーション</header>',
    `<main><article><h1>${title}</h1><p>${body}</p></article></main>`,
    '<footer>フッタ</footer></body></html>',
  ].join('');
}

/** 一覧ページの HTML を組み立てる(既定の itemSelector 'ul.news li a' に一致する形)。 */
export function makeListHtml(links: Array<{ href: string; text: string }>): string {
  const items = links.map((l) => `<li><a href="${l.href}">${l.text}</a></li>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>新着情報</title></head><body><ul class="news">${items}</ul></body></html>`;
}

export function createFakeHttp(init: FakeHttpInit = {}): FakeHttpClient {
  const pages = new Map<string, FakePage>();
  const errors = new Map<string, Error>();
  const reachable = new Map<string, ReachableResult>();
  const getCalls: Array<{ url: string; options: HttpGetOptions | undefined }> = [];
  const reachableCalls: string[] = [];
  const encoder = new TextEncoder();

  const store = (url: string, page: FakePage): void => {
    pages.set(url, page);
    pages.set(canonicalKey(url), page);
  };

  const asListPage = (value: string | FakePage): FakePage =>
    typeof value === 'string' ? { html: value } : value;

  const asArticlePage = (url: string, value: string | FakePage): FakePage => {
    if (typeof value !== 'string') return value;
    // '<' 始まりなら HTML そのもの。それ以外は本文テキストとみなして包む。
    const html = value.trimStart().startsWith('<') ? value : makeArticleHtml(titleOf(url), value);
    return { html };
  };

  for (const [url, value] of Object.entries(init.lists ?? {})) store(url, asListPage(value));
  for (const [url, value] of Object.entries(init.articles ?? {})) store(url, asArticlePage(url, value));

  const lookup = (url: string): FakePage | undefined => pages.get(url) ?? pages.get(canonicalKey(url));

  const headersOf = (page: FakePage): Record<string, string> => {
    const headers: Record<string, string> = {
      'content-type': page.contentType ?? 'text/html; charset=utf-8',
    };
    if (page.etag !== undefined && page.etag !== null) headers['etag'] = page.etag;
    if (page.lastModified !== undefined && page.lastModified !== null) {
      headers['last-modified'] = page.lastModified;
    }
    return headers;
  };

  return {
    getCalls,
    reachableCalls,

    async get(url: string, options?: HttpGetOptions): Promise<HttpResponse> {
      getCalls.push({ url, options });

      const failure = errors.get(url) ?? errors.get(canonicalKey(url));
      if (failure !== undefined) throw failure;

      const page = lookup(url);
      if (page === undefined) {
        // 未登録 URL は 404。本物の HttpClient と同じく 4xx は例外(契約 §src/util/http.ts)。
        throw new HttpError(404, url, `フェイク HttpClient に未登録の URL です: ${url}`);
      }

      // 条件付き GET。前回の ETag と一致したら 304(本文なし)を返す。
      if (page.etag !== undefined && page.etag !== null && options?.etag === page.etag) {
        return {
          status: 304,
          text: '',
          body: new Uint8Array(),
          headers: headersOf(page),
          finalUrl: page.finalUrl ?? url,
        };
      }

      const text = page.html ?? '';
      return {
        status: page.status ?? 200,
        text,
        body: encoder.encode(text),
        headers: headersOf(page),
        finalUrl: page.finalUrl ?? url,
      };
    },

    async checkReachable(url: string): Promise<ReachableResult> {
      reachableCalls.push(url);
      return reachable.get(url) ?? reachable.get(canonicalKey(url)) ?? { ...DEFAULT_REACHABLE };
    },

    setList(url, page) {
      store(url, asListPage(page));
    },
    setArticle(url, page) {
      store(url, asArticlePage(url, page));
    },
    setError(url, error) {
      if (error === null) {
        errors.delete(url);
        errors.delete(canonicalKey(url));
        return;
      }
      errors.set(url, error);
      errors.set(canonicalKey(url), error);
    },
    setReachable(url, result) {
      reachable.set(url, result);
      reachable.set(canonicalKey(url), result);
    },
    getCount(url) {
      const key = canonicalKey(url);
      return getCalls.filter((call) => call.url === url || canonicalKey(call.url) === key).length;
    },
  };
}

// ---------------------------------------------------------------------------
// AiClient
// ---------------------------------------------------------------------------

export interface FakeAiInit {
  model?: string;
  /** classify の既定結果。URL 単位の指定が無いアイテムに使う。 */
  defaultClassification?: Partial<Classification>;
}

export type DigestEntryBuilder = (items: DigestInputItem[], channel: ChannelConfig) => DigestEntry[];

export interface FakeAiClient extends AiClient {
  classifyCalls: Array<{ items: ClassifyInputItem[]; channels: ClassifyChannelInfo[] }>;
  digestCalls: Array<{ channelId: string; dateJst: string; items: DigestInputItem[] }>;
  /** URL 単位で分類結果を上書きする(関連度を下げる・自治体転載にする 等)。 */
  setClassification(url: string, patch: Partial<Classification>): void;
  /** classify を必ず失敗させる。 */
  setClassifyFailure(error: Error | null): void;
  /** 指定チャネルの generateDigest を必ず失敗させる。 */
  setDigestFailure(channelId: string, error: Error | null): void;
  /** 指定チャネルの生成結果を差し替える(幻覚 URL の再現など)。 */
  setDigestEntries(channelId: string, build: DigestEntryBuilder | null): void;
  /** 直近の generateDigest 入力に含まれていた URL 一覧。 */
  lastDigestInputUrls(): string[];
}

const FAKE_USAGE = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadInputTokens: 800,
  cacheCreationInputTokens: 0,
};

export function createFakeAi(init: FakeAiInit = {}): FakeAiClient {
  const model = init.model ?? 'claude-opus-5';
  const classifyCalls: FakeAiClient['classifyCalls'] = [];
  const digestCalls: FakeAiClient['digestCalls'] = [];
  const perUrl = new Map<string, Partial<Classification>>();
  const digestBuilders = new Map<string, DigestEntryBuilder>();
  const digestFailures = new Map<string, Error>();
  let classifyFailure: Error | null = null;

  const baseClassification = (channels: string[]): Classification => ({
    channels,
    relevance: 0.9,
    importance: 'medium',
    kind: 'notice',
    isDuplicateOfNational: false,
    effectiveDate: null,
    deadline: null,
    reason: 'テスト用フェイクの判定',
    ...(init.defaultClassification ?? {}),
  });

  const defaultEntries: DigestEntryBuilder = (items, channel) =>
    items.slice(0, channel.maxItems).map((item) => ({
      itemId: item.id,
      headline: item.title,
      summary: `${item.title}の内容が公表されました。`,
      affected: item.region === null ? '事業所' : `${item.region}内の事業所`,
      dateNote: item.effectiveDate === null ? null : `施行: ${item.effectiveDate}`,
      sourceUrl: item.url,
      importance: item.importance,
    }));

  return {
    classifyCalls,
    digestCalls,

    async classify(items, channels): Promise<{ results: ClassifyResult[]; meta: AiCallMeta }> {
      classifyCalls.push({ items: clone(items), channels: clone(channels) });
      if (classifyFailure !== null) throw classifyFailure;

      const channelIds = channels.map((channel) => channel.id);
      const results: ClassifyResult[] = items.map((item) => ({
        id: item.id,
        classification: {
          ...baseClassification(channelIds),
          ...(perUrl.get(item.url) ?? perUrl.get(canonicalKey(item.url)) ?? {}),
        },
      }));
      return {
        results,
        meta: {
          model,
          prompt: `[fake classify] items=${items.length}`,
          rawResponse: JSON.stringify({ results }),
          usage: { ...FAKE_USAGE },
        },
      };
    },

    async generateDigest(channel, dateJst, items): Promise<{ digest: RawDigest; meta: AiCallMeta }> {
      digestCalls.push({ channelId: channel.id, dateJst, items: clone(items) });

      const failure = digestFailures.get(channel.id);
      if (failure !== undefined) throw failure;

      const build = digestBuilders.get(channel.id) ?? defaultEntries;
      const entries = build(items, channel);
      const digest: RawDigest = {
        entries,
        omittedCount: Math.max(0, items.length - entries.length),
      };
      return {
        digest,
        meta: {
          model,
          prompt: `[fake digest] channel=${channel.id} date=${dateJst} items=${items.length}`,
          rawResponse: JSON.stringify(digest),
          usage: { ...FAKE_USAGE },
        },
      };
    },

    setClassification(url, patch) {
      perUrl.set(url, patch);
      perUrl.set(canonicalKey(url), patch);
    },
    setClassifyFailure(error) {
      classifyFailure = error;
    },
    setDigestFailure(channelId, error) {
      if (error === null) digestFailures.delete(channelId);
      else digestFailures.set(channelId, error);
    },
    setDigestEntries(channelId, build) {
      if (build === null) digestBuilders.delete(channelId);
      else digestBuilders.set(channelId, build);
    },
    lastDigestInputUrls() {
      const last = digestCalls[digestCalls.length - 1];
      return last === undefined ? [] : last.items.map((item) => item.url);
    },
  };
}

// ---------------------------------------------------------------------------
// LineClient
// ---------------------------------------------------------------------------

export interface FakeLineClient extends LineClient {
  /** 送信試行の記録(失敗した試行も残す。retryKey の再利用を検査するため)。 */
  calls: Array<{ token: string; text: string; retryKey: string }>;
  setFailure(error: Error | null): void;
  lastText(): string;
}

export function createFakeLine(): FakeLineClient {
  const calls: FakeLineClient['calls'] = [];
  let failure: Error | null = null;
  let requestSeq = 0;

  return {
    calls,
    async broadcast(token, text, retryKey) {
      calls.push({ token, text, retryKey });
      if (failure !== null) throw failure;
      requestSeq += 1;
      return { requestId: `line-request-${requestSeq}`, status: 200 };
    },
    setFailure(error) {
      failure = error;
    },
    lastText() {
      return calls[calls.length - 1]?.text ?? '';
    },
  };
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

export interface FakeNotifier extends Notifier {
  calls: Array<{ level: NotifyLevel; title: string; lines: string[] }>;
  /** タイトルの部分一致で絞り込む。 */
  withTitle(substring: string): Array<{ level: NotifyLevel; title: string; lines: string[] }>;
}

export function createFakeNotifier(): FakeNotifier {
  const calls: FakeNotifier['calls'] = [];
  return {
    calls,
    async notify(level, title, lines) {
      calls.push({ level, title, lines: [...lines] });
    },
    withTitle(substring) {
      return calls.filter((call) => call.title.includes(substring));
    },
  };
}

// ---------------------------------------------------------------------------
// ドメインオブジェクトのファクトリ
// ---------------------------------------------------------------------------

export function makeChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'welfare',
    name: '就労支援、放課後デイ情報局',
    lineTokenSecret: null,
    topics: '障害福祉サービス等報酬改定、就労移行支援、就労継続支援、放課後等デイサービス',
    relevanceThreshold: 0.6,
    maxItems: 7,
    minItems: 3,
    maxChars: 1500,
    sendWhenEmpty: true,
    deliverAt: '07:30',
    requireApproval: false,
    ...overrides,
  };
}

export function makeSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  const type = overrides.type ?? 'html';
  return {
    id: 'mhlw_news',
    name: '厚生労働省 新着情報',
    type,
    url: 'https://www.mhlw.go.jp/stf/news.html',
    channels: ['welfare'],
    priority: 'high',
    region: null,
    enabled: true,
    html:
      type === 'html'
        ? {
            itemSelector: 'ul.news li a',
            titleFrom: 'text',
            hrefFrom: 'href',
            dateSelector: null,
            includeUrlPatterns: [],
            excludeUrlPatterns: [],
          }
        : null,
    egov: null,
    note: null,
    ...overrides,
  };
}

export function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    channels: ['welfare'],
    relevance: 0.9,
    importance: 'medium',
    kind: 'notice',
    isDuplicateOfNational: false,
    effectiveDate: null,
    deadline: null,
    reason: 'テスト用の分類',
    ...overrides,
  };
}

export function makeItem(overrides: Partial<Item> = {}): Item {
  const canonicalUrl = overrides.canonicalUrl ?? 'https://www.mhlw.go.jp/stf/newpage_00001.html';
  const detectedAt = overrides.detectedAt ?? '2026-09-12T01:00:00.000Z';
  const contentText = overrides.contentText ?? '障害福祉サービス等報酬改定に関する通知の本文テキスト。';
  return {
    id: itemIdFor(canonicalUrl),
    sourceId: 'mhlw_news',
    canonicalUrl,
    title: '障害福祉サービス等報酬改定について',
    publishedAt: null,
    detectedAt,
    updatedAt: detectedAt,
    contentHash: sha256(contentText),
    contentText,
    contentType: 'html',
    region: null,
    classification: makeClassification(),
    classifiedAt: detectedAt,
    digestedIn: [],
    expiresAt: addDays(detectedAt, 90),
    ...overrides,
  };
}

export function makeRuntime(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    gcpProjectId: null,
    firestoreDatabaseId: '(default)',
    storeKind: 'memory',
    anthropicModel: 'claude-opus-5',
    userAgent: 'SeidoWatchBot/1.0 (+mailto:ops@example.com)',
    hostDelayMs: 0,
    hostConcurrency: 4,
    httpTimeoutMs: 20_000,
    maxNewItemsPerSource: 50,
    maxContentChars: 6000,
    retentionDays: 90,
    slackWebhookUrl: null,
    dryRun: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AppContext
// ---------------------------------------------------------------------------

export interface MakeContextOptions {
  clock?: Clock;
  channels?: ChannelConfig[];
  sources?: SourceConfig[];
  runtime?: Partial<RuntimeConfig>;
  store?: TestStore;
  http?: FakeHttpInit | FakeHttpClient;
  ai?: FakeAiInit | FakeAiClient;
  line?: FakeLineClient;
  notifier?: FakeNotifier;
  logger?: FakeLogger;
  resolveLineToken?: (channel: ChannelConfig) => Promise<string>;
}

/** フェイクを型付きで取り出せる AppContext。 */
export interface TestContext extends AppContext {
  config: AppConfig;
  store: TestStore;
  http: FakeHttpClient;
  ai: FakeAiClient;
  line: FakeLineClient;
  notifier: FakeNotifier;
  logger: FakeLogger;
}

function isFakeHttp(value: FakeHttpInit | FakeHttpClient): value is FakeHttpClient {
  return typeof (value as FakeHttpClient).get === 'function';
}

function isFakeAi(value: FakeAiInit | FakeAiClient): value is FakeAiClient {
  return typeof (value as FakeAiClient).classify === 'function';
}

/**
 * テスト用の AppContext を組み立てる。
 * 依存はすべてフェイク(= ネットワークにも Firestore にも触らない)、
 * パイプライン本体は本物の実装を使う。
 */
export function makeContext(options: MakeContextOptions = {}): TestContext {
  const channels = options.channels ?? [makeChannel()];
  const sources = options.sources ?? [makeSource()];
  const config: AppConfig = {
    channels,
    sources,
    runtime: makeRuntime(options.runtime),
  };

  const store = options.store ?? createTestStore();
  const http =
    options.http !== undefined && isFakeHttp(options.http)
      ? options.http
      : createFakeHttp(options.http ?? {});
  const ai = options.ai !== undefined && isFakeAi(options.ai) ? options.ai : createFakeAi(options.ai ?? {});
  const line = options.line ?? createFakeLine();
  const notifier = options.notifier ?? createFakeNotifier();
  const logger = options.logger ?? createFakeLogger();
  const clock = options.clock ?? fixedClock(DEFAULT_NOW);

  // ID は連番。retryKey や runId の同一性をテストから追えるようにするため。
  let seq = 0;

  return {
    config,
    store,
    http,
    ai,
    line,
    notifier,
    logger,
    clock,
    resolveLineToken:
      options.resolveLineToken ?? ((channel: ChannelConfig) => Promise.resolve(`test-token-${channel.id}`)),
    newId: () => {
      seq += 1;
      return `test-id-${String(seq).padStart(4, '0')}`;
    },
  };
}
