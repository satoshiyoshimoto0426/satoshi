/**
 * Anthropic API クライアント(詳細設計書 §7.3)。
 *
 * 役割は 2 つだけ:
 *  1. 分類(classify)と要約(generateDigest)のリクエストを組み立てて投げる。
 *  2. 返ってきた JSON を zod で二重検証し、ドメイン型に正規化する(NFR-02)。
 *
 * 設計意図:
 * - リクエストの形は詳細設計書 §7.3 とモジュール契約で固定されている。SDK の型定義が
 *   新しい API 形状(adaptive thinking / output_config)に追いついていない場合があるため
 *   `as never` で型検査を迂回するが、**実行時に送る形は必ず契約どおり**にする。
 *   特に budget_tokens / temperature / top_p / assistant プレフィルは
 *   この世代のモデルでは 400 エラーになるので絶対に付けない。
 * - 一時的な失敗(429 / 5xx / 接続断)だけを retryable として withRetry に任せる。
 *   応答が壊れている場合(JSON パース失敗・zod 失敗・stop_reason 異常)は
 *   何度投げても同じなので retryable=false にして即座に諦め、生応答をログに残す。
 * - API キーは環境変数(ANTHROPIC_API_KEY)から SDK が読む。値には一切触れず、
 *   ログにも例外メッセージにも出さない(NFR-03)。
 */
import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { AiError } from '../types.js';
import type {
  AiCallMeta,
  AiClient,
  ChannelConfig,
  Classification,
  ClassifyResult,
  DigestEntry,
  DigestInputItem,
  Logger,
  RawDigest,
  RuntimeConfig,
  TokenUsage,
} from '../types.js';
import { withRetry } from '../util/retry.js';
import { isValidDateString } from '../util/time.js';
import {
  CLASSIFY_SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  buildClassifyUserMessage,
  buildDigestUserMessage,
} from './prompts.js';
import {
  ClassifyResponseSchema,
  DIGEST_JSON_SCHEMA,
  DigestResponseSchema,
  buildClassifyJsonSchema,
} from './schemas.js';

/** 応答の上限トークン。契約で固定(詳細設計書 §7.3)。 */
const MAX_TOKENS = 16000;

/** 1 リクエストで判定する最大件数(詳細設計書 §7.1)。超過分は分割して複数回呼ぶ。 */
const CLASSIFY_BATCH_SIZE = 20;

/** 1 回の要約に渡す最大アイテム数(詳細設計書 §7.2)。 */
const DIGEST_MAX_ITEMS = 20;

/** リトライ方針(モジュール契約): 2 回・初回待機 2000ms の指数バックオフ。 */
const RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2000;

/** 生応答をログに残すときの最大文字数。壊れた応答は長大なことがあるため切り詰める。 */
const RAW_RESPONSE_LOG_CHARS = 2000;

/** 例外メッセージに万一混入した API キーらしき文字列を伏せる(NFR-03 の保険)。 */
const API_KEY_LIKE = /sk-ant-[A-Za-z0-9_-]+/g;

/** 接続系エラーとみなす Node / undici のエラーコード。 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** 接続系エラーとみなす例外名(SDK の型が使えないモック経由でも拾えるように名前でも判定する)。 */
const CONNECTION_ERROR_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'SocketError',
  'FetchError',
]);

/** SDK の Message 型。応答の読み取りは SDK の型定義に従う。 */
type AiMessage = Anthropic.Message;

/**
 * このモジュールが SDK に要求する最小の形。
 * 新 API 形状のリクエストを `as never` で通すため、body の型はあえて never にしている。
 */
interface AnthropicLike {
  messages: {
    stream(body: never): { finalMessage(): Promise<AiMessage> };
  };
}

/** 1 回の API 呼び出しに必要な可変部分。 */
interface ModelRequest {
  system: string;
  userMessage: string;
  schema: Record<string, unknown>;
  /** 分類は 'low'、ダイジェストは 'medium'(詳細設計書 §7.1 / §7.2)。 */
  effort: 'low' | 'medium';
  /** ログ用のラベル。 */
  label: string;
}

export interface AiClientDeps {
  /** テストで差し替えるための Anthropic クライアント。未指定なら SDK 既定の設定で生成する。 */
  anthropic?: unknown;
}

// ---------------------------------------------------------------------------
// 小さなユーティリティ
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * API キーらしき文字列を伏せる(NFR-03 / モジュール契約の原則 7)。
 *
 * 生応答は「モデルが書いた文字列」であって信用できる入力ではない。
 * 認証エラーの本文をそのまま引用してくるなど、キーが紛れ込む経路は実在する。
 * ログは Cloud Logging に長期保存されるため、出力する直前に必ずここを通す。
 */
function redactSecrets(text: string): string {
  return text.replace(API_KEY_LIKE, '[REDACTED]');
}

/** 秘密情報が混ざらないように整形した、人間向けのエラー説明。 */
function describeError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return redactSecrets(text);
}

/** HTTP ステータスを取り出す。SDK の APIError だけでなく、素朴なモックの `{ status }` も拾う。 */
function httpStatusOf(e: unknown): number | null {
  if (e instanceof APIError && typeof e.status === 'number') return e.status;
  const record = asRecord(e);
  if (!record) return null;
  if (typeof record.status === 'number') return record.status;
  const response = asRecord(record.response);
  if (response && typeof response.status === 'number') return response.status;
  return null;
}

/** ネットワーク断・タイムアウトなど、時間をおけば直る可能性のある失敗か。 */
function isConnectionError(e: unknown, depth = 0): boolean {
  // 利用者が明示的に中断した場合は「待てば直る」ものではないので再試行しない。
  if (e instanceof APIUserAbortError) return false;
  if (e instanceof APIConnectionError) return true;
  const record = asRecord(e);
  if (!record) return false;
  if (typeof record.name === 'string' && CONNECTION_ERROR_NAMES.has(record.name)) return true;
  if (typeof record.code === 'string' && CONNECTION_ERROR_CODES.has(record.code)) return true;
  // undici は本当の原因を cause にぶら下げる(例: TypeError: fetch failed → ECONNRESET)。
  if (depth < 3 && 'cause' in record) return isConnectionError(record.cause, depth + 1);
  return false;
}

/** SDK / ネットワークの例外を AiError に写す。retryable の判定はここに集約する。 */
function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const detail = describeError(e);
  const status = httpStatusOf(e);
  if (status !== null) {
    if (status === 429) {
      return new AiError(`AI API がレート制限を返しました(HTTP 429): ${detail}`, true);
    }
    if (status >= 500) {
      return new AiError(`AI API がサーバエラーを返しました(HTTP ${status}): ${detail}`, true);
    }
    // 残高不足は 400 で返る。英語の生エラーだけでは運用者が何をすべきか読み取れず、
    // 実際に「壊れたのか」と問い合わせが来た(2026-09-17)。取るべき行動を日本語で添える。
    if (/credit balance|billing/i.test(detail)) {
      return new AiError(
        'Anthropic API の残高が不足しています。https://console.anthropic.com/settings/billing で' +
          `クレジットを購入してください。購入後に summarize --force で再実行できます(元のエラー: ${detail})`,
        false,
      );
    }
    // 400 番台(429 を除く)はリクエストそのものが誤っている。再試行しても同じ。
    return new AiError(`AI API がエラーを返しました(HTTP ${status}): ${detail}`, false);
  }
  if (isConnectionError(e)) {
    return new AiError(`AI API への接続に失敗しました: ${detail}`, true);
  }
  return new AiError(`AI 呼び出しに失敗しました: ${detail}`, false);
}

/**
 * 生応答を添えた AiError を作る。
 * `AiError`(src/types.ts)は読み取り専用で meta を持たないため、監査用に動的付与する。
 * 列挙不可にしてあるのは、ログの JSON 化で巨大な生応答が混入するのを避けるため。
 * 参照するときは `(e as { meta?: AiCallMeta }).meta` で取り出す。
 */
function aiErrorWithMeta(message: string, meta: AiCallMeta): AiError {
  const error = new AiError(message, false);
  Object.defineProperty(error, 'meta', { value: meta, enumerable: false });
  return error;
}

/** usage を TokenUsage に写す。欠けているフィールドは 0 にする(契約)。 */
function toTokenUsage(usage: unknown): TokenUsage {
  const u = asRecord(usage);
  return {
    inputTokens: numberOrZero(u?.input_tokens),
    outputTokens: numberOrZero(u?.output_tokens),
    cacheReadInputTokens: numberOrZero(u?.cache_read_input_tokens),
    cacheCreationInputTokens: numberOrZero(u?.cache_creation_input_tokens),
  };
}

/** text ブロックだけを連結する。thinking ブロックは JSON ではないので混ぜない。 */
function extractText(message: AiMessage): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** 配列を size 件ずつに分割する。 */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** 空白を畳んで max 文字に切り詰める(スタブ用)。 */
function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max);
}

/** 複数バッチの呼び出し結果を 1 つの AiCallMeta にまとめる。 */
function mergeMeta(model: string, parts: AiCallMeta[]): AiCallMeta {
  const usages = parts.map((part) => part.usage).filter((usage): usage is TokenUsage => usage !== null);
  const usage =
    usages.length === 0
      ? null
      : usages.reduce(
          (acc, cur) => ({
            inputTokens: acc.inputTokens + cur.inputTokens,
            outputTokens: acc.outputTokens + cur.outputTokens,
            cacheReadInputTokens: acc.cacheReadInputTokens + cur.cacheReadInputTokens,
            cacheCreationInputTokens: acc.cacheCreationInputTokens + cur.cacheCreationInputTokens,
          }),
          { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        );
  return {
    model,
    prompt: parts.map((part) => part.prompt).join('\n---\n'),
    rawResponse: parts.map((part) => part.rawResponse).join('\n---\n'),
    usage,
  };
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export function createAiClient(runtime: RuntimeConfig, logger: Logger, deps?: AiClientDeps): AiClient {
  const log = logger.child({ module: 'ai' });

  // SDK クライアントは初回呼び出しまで生成しない。
  // 生成時に環境変数を読むため、AI を使わないコマンド(validate-config など)で
  // 余計な前提を持ち込まないようにする。
  let cached: AnthropicLike | null = null;
  const getClient = (): AnthropicLike => {
    if (deps?.anthropic !== undefined) {
      return deps.anthropic as AnthropicLike;
    }
    if (cached === null) {
      // API キーは SDK が ANTHROPIC_API_KEY から読む。ここでは値に触れない(NFR-03)。
      cached = new Anthropic() as unknown as AnthropicLike;
    }
    return cached;
  };

  /** 1 回だけ API を叩く。SDK 由来の失敗は AiError に写して投げ直す。 */
  const invokeOnce = async (request: ModelRequest): Promise<AiMessage> => {
    try {
      const client = getClient();
      // ここが契約で固定されたリクエスト形。
      // budget_tokens / temperature / top_p / assistant プレフィルは 400 になるため付けない。
      const stream = client.messages.stream({
        model: runtime.anthropicModel,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: request.effort,
          format: { type: 'json_schema', schema: request.schema },
        },
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: request.userMessage }],
      } as never);
      return await stream.finalMessage();
    } catch (e) {
      throw toAiError(e);
    }
  };

  /**
   * API を呼び、応答テキストを取り出して検証まで行う。
   * 検証関数は zod の safeParse を包んだもので、失敗時は生応答付きの AiError を投げる。
   */
  const callModel = async <T>(
    request: ModelRequest,
    validate: (parsed: unknown, meta: AiCallMeta) => T,
  ): Promise<{ value: T; meta: AiCallMeta }> => {
    const message = await withRetry(() => invokeOnce(request), {
      retries: RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      // retryable=false(4xx・応答の壊れ)は即座に諦める。無駄に待たせないため。
      shouldRetry: (e) => e instanceof AiError && e.retryable,
      onRetry: (e, attempt, delayMs) => {
        log.warn('AI 呼び出しを再試行します', {
          label: request.label,
          attempt,
          delayMs,
          error: describeError(e),
        });
      },
    });

    const rawResponse = extractText(message);
    const meta: AiCallMeta = {
      model: runtime.anthropicModel,
      // system プロンプトは固定文字列なのでコード側にある。可変部分(user メッセージ)だけを監査用に残す。
      prompt: request.userMessage,
      rawResponse,
      usage: toTokenUsage(message.usage),
    };

    // stop_reason を先に見る。途中で切れた応答を JSON.parse すると
    // 「なぜか毎回パースに失敗する」という分かりにくい失敗になるため。
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? '不明';
      const explanation = message.stop_details?.explanation;
      throw aiErrorWithMeta(
        `AI が応答を拒否しました(category=${category}${explanation ? `, 説明=${explanation}` : ''})`,
        meta,
      );
    }
    if (message.stop_reason !== 'end_turn') {
      throw aiErrorWithMeta(
        `AI の応答が正常に終了しませんでした(stop_reason=${message.stop_reason ?? 'null'})`,
        meta,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawResponse);
    } catch (e) {
      log.error('AI 応答の JSON パースに失敗しました', {
        label: request.label,
        error: describeError(e),
        rawResponse: redactSecrets(rawResponse.slice(0, RAW_RESPONSE_LOG_CHARS)),
      });
      throw aiErrorWithMeta(`AI 応答を JSON として解釈できませんでした: ${describeError(e)}`, meta);
    }

    return { value: validate(parsed, meta), meta };
  };

  /** zod 検証。失敗したら生応答を残して retryable=false で落とす。 */
  const validateWith = <T>(
    schema: {
      safeParse(
        value: unknown,
      ):
        | { success: true; data: T }
        | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
    },
    parsed: unknown,
    meta: AiCallMeta,
    label: string,
  ): T => {
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    // zod のメッセージは受け取った値を引用することがあるため、組み立てた時点で伏せる。
    const detail = redactSecrets(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join(' / '),
    );
    log.error('AI 応答がスキーマに適合しませんでした', {
      label,
      detail,
      rawResponse: redactSecrets(meta.rawResponse.slice(0, RAW_RESPONSE_LOG_CHARS)),
    });
    throw aiErrorWithMeta(`AI 応答がスキーマに適合しませんでした: ${detail}`, meta);
  };

  /** 原文に明記された日付だけを残す。書式が崩れていれば null(NFR-02 / 幻覚防止)。 */
  const normalizeDate = (value: string | null, itemId: string, field: string): string | null => {
    if (value === null) return null;
    const trimmed = value.trim();
    if (isValidDateString(trimmed)) return trimmed;
    log.debug('AI が返した日付の書式が不正なため null にしました', { itemId, field, value: trimmed });
    return null;
  };

  return {
    async classify(items, channels) {
      const knownChannelIds = new Set(channels.map((channel) => channel.id));

      // 0 件なら呼ぶ必要がない。無駄なトークン消費を避ける(NFR-04)。
      if (items.length === 0) {
        return {
          results: [],
          meta: { model: runtime.anthropicModel, prompt: '', rawResponse: '', usage: null },
        };
      }

      const schema = buildClassifyJsonSchema(channels.map((channel) => channel.id));
      const batches = chunk(items, CLASSIFY_BATCH_SIZE);
      if (batches.length > 1) {
        log.info('分類対象が多いためバッチ分割します', {
          total: items.length,
          batches: batches.length,
          batchSize: CLASSIFY_BATCH_SIZE,
        });
      }

      const results: ClassifyResult[] = [];
      const metas: AiCallMeta[] = [];

      for (const batch of batches) {
        const batchIds = new Set(batch.map((item) => item.id));
        const userMessage = buildClassifyUserMessage(batch, channels);
        const { value, meta } = await callModel(
          {
            system: CLASSIFY_SYSTEM_PROMPT,
            userMessage,
            schema,
            effort: 'low',
            label: 'classify',
          },
          (parsed, callMeta) => validateWith(ClassifyResponseSchema, parsed, callMeta, 'classify'),
        );
        metas.push(meta);

        for (const raw of value.results) {
          // 入力に無い id は AI の創作。取り込むと存在しないアイテムを更新しようとするので捨てる。
          if (!batchIds.has(raw.id)) {
            log.warn('入力に無い id が返されたため無視します', { id: raw.id });
            continue;
          }
          // 実在しないチャネル ID も同様に落とす(JSON Schema の enum と二重のガード)。
          const channelIds = [...new Set(raw.channels)].filter((id) => {
            if (knownChannelIds.has(id)) return true;
            log.warn('未知のチャネル ID が返されたため無視します', { id: raw.id, channelId: id });
            return false;
          });
          const classification: Classification = {
            channels: channelIds,
            relevance: raw.relevance,
            importance: raw.importance,
            kind: raw.kind,
            isDuplicateOfNational: raw.isDuplicateOfNational,
            effectiveDate: normalizeDate(raw.effectiveDate, raw.id, 'effectiveDate'),
            deadline: normalizeDate(raw.deadline, raw.id, 'deadline'),
            reason: raw.reason,
          };
          results.push({ id: raw.id, classification });
        }
      }

      log.info('AI 分類が完了しました', { requested: items.length, classified: results.length });
      return { results, meta: mergeMeta(runtime.anthropicModel, metas) };
    },

    async generateDigest(channel, dateJst, items) {
      // 0 件なら AI を呼ばずに空のダイジェストを返す。
      // 「新着なし」の文面は呼び出し側(pipeline/summarize)が組み立てる。
      if (items.length === 0) {
        return {
          digest: { entries: [], omittedCount: 0 },
          meta: { model: runtime.anthropicModel, prompt: '', rawResponse: '', usage: null },
        };
      }

      // 1 回に渡すのは 20 件まで(詳細設計書 §7.2)。溢れた分は omittedCount に加算して
      // 「他 N 件」として読者に伝わるようにする(黙って消さない)。
      const targetItems = items.slice(0, DIGEST_MAX_ITEMS);
      const droppedByCap = items.length - targetItems.length;
      if (droppedByCap > 0) {
        log.warn('要約対象が上限を超えたため切り詰めました', {
          channelId: channel.id,
          requested: items.length,
          used: targetItems.length,
        });
      }

      const userMessage = buildDigestUserMessage(channel, dateJst, targetItems);
      const { value, meta } = await callModel(
        {
          system: DIGEST_SYSTEM_PROMPT,
          userMessage,
          schema: DIGEST_JSON_SCHEMA,
          effort: 'medium',
          label: 'digest',
        },
        (parsed, callMeta) => validateWith(DigestResponseSchema, parsed, callMeta, 'digest'),
      );

      // itemId / sourceUrl の実在確認は品質ゲート(詳細設計書 §8 の Q1・Q3)が
      // 除外理由付きで記録する担当なので、ここでは落とさずそのまま渡す。
      const entries: DigestEntry[] = value.entries.map((entry) => ({
        itemId: entry.itemId,
        headline: entry.headline,
        summary: entry.summary,
        affected: entry.affected,
        dateNote: entry.dateNote,
        sourceUrl: entry.sourceUrl,
        importance: entry.importance,
      }));

      // AI 申告の omittedCount は信用しすぎない。渡した件数を超える値は破綻しているので丸める。
      const reportedOmitted = Math.min(Math.max(value.omittedCount, 0), targetItems.length);
      const digest: RawDigest = { entries, omittedCount: reportedOmitted + droppedByCap };

      log.info('AI 要約が完了しました', {
        channelId: channel.id,
        date: dateJst,
        entries: entries.length,
        omittedCount: digest.omittedCount,
      });
      return { digest, meta };
    },
  };
}

// ---------------------------------------------------------------------------
// スタブ(DRY_RUN / 結合テスト用)
// ---------------------------------------------------------------------------

/** スタブが返す分類の固定値。 */
const STUB_RELEVANCE = 0.8;
const STUB_MODEL = 'stub';
const STUB_HEADLINE_MAX = 60;
const STUB_SUMMARY_MAX = 140;
const STUB_AFFECTED_MAX = 40;
const STUB_DATE_NOTE_MAX = 40;

/**
 * API を呼ばず決定的な結果を返すクライアント。
 * DRY_RUN と結合テストで「AI 以外の配線」を検証するために使う。
 * 乱数も現在時刻も使わないので、同じ入力からは必ず同じ出力になる。
 */
export function createStubAiClient(logger: Logger): AiClient {
  const log = logger.child({ module: 'ai', stub: true });

  return {
    async classify(items, channels) {
      const channelIds = channels.map((channel) => channel.id);
      const results: ClassifyResult[] = items.map((item) => ({
        id: item.id,
        classification: {
          channels: channelIds,
          relevance: STUB_RELEVANCE,
          importance: 'medium',
          kind: 'notice',
          isDuplicateOfNational: false,
          effectiveDate: null,
          deadline: null,
          reason: 'スタブ AI による固定の分類結果です(実際の判定は行っていません)。',
        },
      }));
      const prompt = buildClassifyUserMessage(items, channels);
      const rawResponse = JSON.stringify({
        results: results.map((result) => ({ id: result.id, ...result.classification })),
      });
      log.info('スタブ AI で分類しました', { count: results.length });
      return { results, meta: { model: STUB_MODEL, prompt, rawResponse, usage: null } };
    },

    async generateDigest(channel: ChannelConfig, dateJst: string, items: DigestInputItem[]) {
      const used = items.slice(0, channel.maxItems);
      const entries: DigestEntry[] = used.map((item) => {
        const headline = truncate(item.title, STUB_HEADLINE_MAX) || '(タイトルなし)';
        const summary = truncate(item.excerpt, STUB_SUMMARY_MAX) || headline;
        const affected = truncate(item.region ?? '全国', STUB_AFFECTED_MAX);
        const dateNote =
          item.effectiveDate !== null
            ? truncate(`${item.effectiveDate} 施行`, STUB_DATE_NOTE_MAX)
            : item.deadline !== null
              ? truncate(`${item.deadline} 期限`, STUB_DATE_NOTE_MAX)
              : null;
        return {
          itemId: item.id,
          headline,
          summary,
          affected,
          dateNote,
          // 出典 URL は必ず入力の url をそのままコピーする(品質ゲート Q1 を通すため)。
          sourceUrl: item.url,
          importance: item.importance,
        };
      });
      const digest: RawDigest = { entries, omittedCount: items.length - entries.length };
      const prompt = buildDigestUserMessage(channel, dateJst, used);
      log.info('スタブ AI で要約しました', {
        channelId: channel.id,
        date: dateJst,
        entries: entries.length,
      });
      return {
        digest,
        meta: { model: STUB_MODEL, prompt, rawResponse: JSON.stringify(digest), usage: null },
      };
    },
  };
}
