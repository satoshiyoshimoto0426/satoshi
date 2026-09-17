/**
 * Anthropic API クライアント(詳細設計書 §7.3 / モジュール契約 src/ai/client.ts)のテスト。
 *
 * **実 API には一切接続しない。** `AiClientDeps.anthropic` に偽のクライアントを注入し、
 * 「何を送るか」と「返ってきたものをどう扱うか」だけを検証する。
 *
 * 特に重要なのはリクエストボディの形。このモデル世代では `budget_tokens` /
 * `temperature` / `top_p` を送ると 400 になるため、回帰で混入したら即座に落とす。
 * また system ブロックの `cache_control` が外れるとプロンプトキャッシュが効かなくなり、
 * コスト(NFR-04)が跳ね上がるが API は成功し続けるので、テストでしか検知できない。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiClient, createStubAiClient } from '../src/ai/client.js';
import {
  CLASSIFY_SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  buildClassifyUserMessage,
  buildDigestUserMessage,
} from '../src/ai/prompts.js';
import { DIGEST_JSON_SCHEMA, buildClassifyJsonSchema } from '../src/ai/schemas.js';
import { AiError } from '../src/types.js';
import type {
  AiCallMeta,
  ClassifyChannelInfo,
  ClassifyInputItem,
  DigestInputItem,
  RuntimeConfig,
} from '../src/types.js';
import { createFakeLogger, makeChannel, makeRuntime } from './helpers/fakes.js';
import type { FakeLogger } from './helpers/fakes.js';

// ---------------------------------------------------------------------------
// 偽 Anthropic クライアント
// ---------------------------------------------------------------------------

type StreamBody = Record<string, unknown>;

/** finalMessage() が返す値を決める関数。例外を投げると SDK の失敗を模せる。 */
type Responder = (index: number, body: StreamBody) => unknown;

interface FakeAnthropic {
  /** 送信されたリクエストボディ(呼び出し順)。 */
  bodies: StreamBody[];
  /** createAiClient に渡す偽クライアント。 */
  anthropic: unknown;
}

function createFakeAnthropic(responder: Responder): FakeAnthropic {
  const bodies: StreamBody[] = [];
  const anthropic = {
    messages: {
      stream(body: StreamBody) {
        bodies.push(body);
        const index = bodies.length - 1;
        return {
          async finalMessage(): Promise<unknown> {
            return responder(index, body);
          },
        };
      },
    },
  };
  return { bodies, anthropic };
}

/** 応答メッセージ(SDK の Message 形)を組み立てる。 */
function makeMessage(text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 入力データ
// ---------------------------------------------------------------------------

const CHANNELS: ClassifyChannelInfo[] = [
  { id: 'welfare', name: '福祉チャネル', topics: '障害福祉サービス' },
  { id: 'ai_reskill', name: 'AI チャネル', topics: 'リスキリング' },
];

const CHANNEL_IDS = CHANNELS.map((channel) => channel.id);

function makeClassifyItems(count: number): ClassifyInputItem[] {
  return Array.from({ length: count }, (_unused, i) => ({
    id: `item-${String(i + 1).padStart(3, '0')}`,
    title: `お知らせ ${i + 1}`,
    url: `https://www.mhlw.go.jp/stf/newpage_${String(i + 1).padStart(5, '0')}.html`,
    excerpt: '本文の先頭部分です。',
    region: null,
    sourceName: '厚生労働省 新着情報',
  }));
}

function makeDigestItems(count: number): DigestInputItem[] {
  return Array.from({ length: count }, (_unused, i) => ({
    id: `item-${String(i + 1).padStart(3, '0')}`,
    title: `お知らせ ${i + 1}`,
    url: `https://www.mhlw.go.jp/stf/newpage_${String(i + 1).padStart(5, '0')}.html`,
    kind: 'notice' as const,
    importance: 'medium' as const,
    effectiveDate: null,
    deadline: null,
    region: null,
    sourceName: '厚生労働省 新着情報',
    excerpt: '本文の先頭部分です。',
  }));
}

/** 1 件分の正しい分類結果。 */
function classifyResultJson(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    channels: ['welfare'],
    relevance: 0.8,
    importance: 'medium',
    kind: 'notice',
    isDuplicateOfNational: false,
    effectiveDate: null,
    deadline: null,
    reason: 'テスト用の判定理由。',
    ...over,
  };
}

function classifyResponseJson(ids: string[]): string {
  return JSON.stringify({ results: ids.map((id) => classifyResultJson(id)) });
}

/** リクエストの user メッセージから入力アイテムの id を取り出す。 */
function requestedIds(body: StreamBody): string[] {
  const messages = body.messages;
  if (!Array.isArray(messages)) throw new Error('messages がありません');
  const first = messages[0] as { content?: unknown } | undefined;
  if (first === undefined || typeof first.content !== 'string')
    throw new Error('user メッセージがありません');
  const payload = JSON.parse(first.content) as { items?: Array<{ id: string }> };
  return (payload.items ?? []).map((item) => item.id);
}

/** 入力の id をそのまま返す「素直な AI」。 */
function echoClassifyResponder(index: number, body: StreamBody): unknown {
  void index;
  return makeMessage(classifyResponseJson(requestedIds(body)));
}

/** 正しいダイジェスト応答。 */
function digestResponseJson(items: DigestInputItem[], omittedCount = 0): string {
  return JSON.stringify({
    entries: items.map((item) => ({
      itemId: item.id,
      headline: item.title,
      summary: `${item.title}の内容が公表されました。`,
      affected: '事業所',
      dateNote: null,
      sourceUrl: item.url,
      importance: item.importance,
    })),
    omittedCount,
  });
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

const RUNTIME: RuntimeConfig = makeRuntime();

function setup(responder: Responder): {
  client: ReturnType<typeof createAiClient>;
  fake: FakeAnthropic;
  logger: FakeLogger;
} {
  const fake = createFakeAnthropic(responder);
  const logger = createFakeLogger();
  const client = createAiClient(RUNTIME, logger, { anthropic: fake.anthropic });
  return { client, fake, logger };
}

/** オブジェクトツリーに現れる全てのキー名を集める(禁止キーの混入検査用)。 */
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) collectKeys(element, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/**
 * バックオフの実待機を消費せずに Promise を解決する。
 * リトライ間隔は 2000ms → 4000ms(契約)なので、実時間で待つとテストが遅くなる。
 */
async function withFakeTimers<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const settled = start().then(
      (value) => () => value,
      (error: unknown) => () => {
        throw error;
      },
    );
    await vi.advanceTimersByTimeAsync(120_000);
    return (await settled)();
  } finally {
    vi.useRealTimers();
  }
}

/** 例外を AiError として取り出す。 */
async function catchAiError(run: () => Promise<unknown>): Promise<AiError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof AiError) return e;
    throw new Error(`AiError ではありません: ${String(e)}`);
  }
  throw new Error('例外が投げられませんでした');
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// リクエストボディの形(詳細設計書 §7.3 / モジュール契約)
// ---------------------------------------------------------------------------

describe('リクエストボディの形', () => {
  it('分類のキー集合は model / max_tokens / thinking / output_config / system / messages だけ', async () => {
    const { client, fake } = setup(echoClassifyResponder);
    await client.classify(makeClassifyItems(2), CHANNELS);

    expect(fake.bodies).toHaveLength(1);
    const body = fake.bodies[0] as StreamBody;
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
      'thinking',
    ]);
  });

  it('ダイジェストのキー集合も同じ', async () => {
    const items = makeDigestItems(2);
    const { client, fake } = setup(() => makeMessage(digestResponseJson(items)));
    await client.generateDigest(makeChannel(), '2026-09-13', items);

    const body = fake.bodies[0] as StreamBody;
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
      'system',
      'thinking',
    ]);
  });

  it('budget_tokens / temperature / top_p をボディのどの階層にも含まない(400 回避)', async () => {
    const items = makeDigestItems(1);
    const { client, fake } = setup((index, body) =>
      index === 0 ? echoClassifyResponder(index, body) : makeMessage(digestResponseJson(items)),
    );
    await client.classify(makeClassifyItems(1), CHANNELS);
    await client.generateDigest(makeChannel(), '2026-09-13', items);

    expect(fake.bodies).toHaveLength(2);
    for (const body of fake.bodies) {
      const keys = collectKeys(body);
      expect(keys.has('budget_tokens'), 'budget_tokens が混入しています').toBe(false);
      expect(keys.has('temperature'), 'temperature が混入しています').toBe(false);
      expect(keys.has('top_p'), 'top_p が混入しています').toBe(false);
      // assistant プレフィル(messages の最後が assistant)も 400 の原因になる。
      const messages = body.messages as Array<{ role: string }>;
      expect(messages.every((message) => message.role === 'user')).toBe(true);
    }
  });

  it('model と max_tokens が契約どおり', async () => {
    const { client, fake } = setup(echoClassifyResponder);
    await client.classify(makeClassifyItems(1), CHANNELS);

    const body = fake.bodies[0] as StreamBody;
    expect(body.model).toBe(RUNTIME.anthropicModel);
    expect(body.max_tokens).toBe(16000);
  });

  it('thinking は { type: "adaptive" } のみ', async () => {
    const { client, fake } = setup(echoClassifyResponder);
    await client.classify(makeClassifyItems(1), CHANNELS);

    expect((fake.bodies[0] as StreamBody).thinking).toEqual({ type: 'adaptive' });
  });

  it('分類は output_config.effort が low、schema は §7.1 のもの', async () => {
    const { client, fake } = setup(echoClassifyResponder);
    await client.classify(makeClassifyItems(1), CHANNELS);

    const outputConfig = (fake.bodies[0] as StreamBody).output_config as Record<string, unknown>;
    expect(outputConfig.effort).toBe('low');
    const format = outputConfig.format as Record<string, unknown>;
    expect(format.type).toBe('json_schema');
    expect(format.schema).toEqual(buildClassifyJsonSchema(CHANNEL_IDS));
  });

  it('ダイジェストは output_config.effort が medium、schema は §7.2 のもの', async () => {
    const items = makeDigestItems(1);
    const { client, fake } = setup(() => makeMessage(digestResponseJson(items)));
    await client.generateDigest(makeChannel(), '2026-09-13', items);

    const outputConfig = (fake.bodies[0] as StreamBody).output_config as Record<string, unknown>;
    expect(outputConfig.effort).toBe('medium');
    const format = outputConfig.format as Record<string, unknown>;
    expect(format.type).toBe('json_schema');
    expect(format.schema).toEqual(DIGEST_JSON_SCHEMA);
  });

  it('system は cache_control: ephemeral 付きのブロック配列(プロンプトキャッシュ)', async () => {
    const { client, fake } = setup(echoClassifyResponder);
    await client.classify(makeClassifyItems(1), CHANNELS);

    expect((fake.bodies[0] as StreamBody).system).toEqual([
      { type: 'text', text: CLASSIFY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('ダイジェストの system も cache_control 付きの固定プロンプト', async () => {
    const items = makeDigestItems(1);
    const { client, fake } = setup(() => makeMessage(digestResponseJson(items)));
    await client.generateDigest(makeChannel(), '2026-09-13', items);

    expect((fake.bodies[0] as StreamBody).system).toEqual([
      { type: 'text', text: DIGEST_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('messages は user 1 通で、内容は build*UserMessage の出力そのもの', async () => {
    const classifyItems = makeClassifyItems(1);
    const digestItems = makeDigestItems(1);
    const channel = makeChannel();
    const { client, fake } = setup((index, body) =>
      index === 0 ? echoClassifyResponder(index, body) : makeMessage(digestResponseJson(digestItems)),
    );

    await client.classify(classifyItems, CHANNELS);
    await client.generateDigest(channel, '2026-09-13', digestItems);

    expect((fake.bodies[0] as StreamBody).messages).toEqual([
      { role: 'user', content: buildClassifyUserMessage(classifyItems, CHANNELS) },
    ]);
    expect((fake.bodies[1] as StreamBody).messages).toEqual([
      { role: 'user', content: buildDigestUserMessage(channel, '2026-09-13', digestItems) },
    ]);
  });
});

// ---------------------------------------------------------------------------
// バッチ分割
// ---------------------------------------------------------------------------

describe('分類のバッチ分割', () => {
  it('21 件は 20 件 + 1 件の 2 リクエストに分かれる', async () => {
    const { client, fake } = setup(echoClassifyResponder);
    const items = makeClassifyItems(21);

    const { results } = await client.classify(items, CHANNELS);

    expect(fake.bodies).toHaveLength(2);
    expect(requestedIds(fake.bodies[0] as StreamBody)).toHaveLength(20);
    expect(requestedIds(fake.bodies[1] as StreamBody)).toHaveLength(1);
    expect(results).toHaveLength(21);
    expect(results.map((result) => result.id)).toEqual(items.map((item) => item.id));
  });

  it('20 件ちょうどは 1 リクエスト', async () => {
    const { client, fake } = setup(echoClassifyResponder);
    await client.classify(makeClassifyItems(20), CHANNELS);
    expect(fake.bodies).toHaveLength(1);
  });

  it('45 件は 20 / 20 / 5 の 3 リクエスト', async () => {
    const { client, fake } = setup(echoClassifyResponder);
    const { results } = await client.classify(makeClassifyItems(45), CHANNELS);

    expect(fake.bodies.map((body) => requestedIds(body).length)).toEqual([20, 20, 5]);
    expect(results).toHaveLength(45);
  });

  it('usage がバッチ間で合算される', async () => {
    const { client } = setup(echoClassifyResponder);
    const { meta } = await client.classify(makeClassifyItems(21), CHANNELS);

    expect(meta.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 10,
    });
    expect(meta.model).toBe(RUNTIME.anthropicModel);
  });

  it('usage のフィールドが欠けていれば 0 として扱う', async () => {
    const { client } = setup(() => makeMessage(classifyResponseJson(['item-001']), { usage: {} }));
    const { meta } = await client.classify(makeClassifyItems(1), CHANNELS);

    expect(meta.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('生応答は全バッチ分が監査用に残る', async () => {
    const { client } = setup(echoClassifyResponder);
    const { meta } = await client.classify(makeClassifyItems(21), CHANNELS);

    expect(meta.rawResponse).toContain('item-001');
    expect(meta.rawResponse).toContain('item-021');
  });
});

// ---------------------------------------------------------------------------
// 0 件のときは API を呼ばない
// ---------------------------------------------------------------------------

describe('入力が 0 件のとき', () => {
  it('classify は API を呼ばずに空の結果を返す', async () => {
    const { client, fake } = setup(() => {
      throw new Error('API を呼んではいけません');
    });

    const { results, meta } = await client.classify([], CHANNELS);

    expect(fake.bodies).toHaveLength(0);
    expect(results).toEqual([]);
    expect(meta.usage).toBeNull();
    expect(meta.rawResponse).toBe('');
  });

  it('generateDigest は API を呼ばずに空のダイジェストを返す', async () => {
    const { client, fake } = setup(() => {
      throw new Error('API を呼んではいけません');
    });

    const { digest, meta } = await client.generateDigest(makeChannel(), '2026-09-13', []);

    expect(fake.bodies).toHaveLength(0);
    expect(digest).toEqual({ entries: [], omittedCount: 0 });
    expect(meta.usage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 応答の異常系
// ---------------------------------------------------------------------------

describe('stop_reason の異常', () => {
  it('refusal は retryable=false の AiError になり、category がメッセージに入る', async () => {
    const { client, fake } = setup(() =>
      makeMessage('', {
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: '説明文' },
      }),
    );

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('cyber');
    // 再試行しても拒否は変わらないので 1 回で諦める。
    expect(fake.bodies).toHaveLength(1);
  });

  it('stop_details が無い refusal でも落ちずにメッセージを作る', async () => {
    const { client } = setup(() => makeMessage('', { stop_reason: 'refusal', stop_details: null }));

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('不明');
  });

  it('max_tokens は retryable=false の AiError になる', async () => {
    const { client, fake } = setup(() => makeMessage('{"results":[', { stop_reason: 'max_tokens' }));

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('max_tokens');
    expect(fake.bodies).toHaveLength(1);
  });

  it('ダイジェストでも refusal は retryable=false になる', async () => {
    const items = makeDigestItems(1);
    const { client } = setup(() =>
      makeMessage('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' } }),
    );

    const error = await catchAiError(() => client.generateDigest(makeChannel(), '2026-09-13', items));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('bio');
  });
});

describe('応答内容の異常', () => {
  it('JSON として壊れていれば retryable=false になり、生応答が追える', async () => {
    const broken = 'これは JSON ではありません';
    const { client, fake } = setup(() => makeMessage(broken));

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    const meta = (error as AiError & { meta?: AiCallMeta }).meta;
    expect(meta?.rawResponse).toBe(broken);
    expect(meta?.model).toBe(RUNTIME.anthropicModel);
    expect(meta?.prompt).toContain('item-001');
    expect(fake.bodies).toHaveLength(1);
  });

  it('zod 検証で必須項目の欠落を弾き retryable=false になる', async () => {
    const withoutReason = classifyResultJson('item-001');
    delete withoutReason.reason;
    const { client } = setup(() => makeMessage(JSON.stringify({ results: [withoutReason] })));

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('reason');
  });

  it('zod 検証で enum 外の値を弾き retryable=false になる', async () => {
    const { client } = setup(() =>
      makeMessage(JSON.stringify({ results: [classifyResultJson('item-001', { importance: '最重要' })] })),
    );

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('importance');
  });

  it('zod 検証で範囲外の relevance を弾く', async () => {
    const { client } = setup(() =>
      makeMessage(JSON.stringify({ results: [classifyResultJson('item-001', { relevance: 3 })] })),
    );

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('relevance');
  });

  it('ダイジェスト応答の必須項目欠落も retryable=false で弾く', async () => {
    const items = makeDigestItems(1);
    const { client } = setup(() =>
      makeMessage(
        JSON.stringify({
          entries: [{ itemId: items[0]?.id, headline: '見出し', summary: '要約', importance: 'high' }],
          omittedCount: 0,
        }),
      ),
    );

    const error = await catchAiError(() => client.generateDigest(makeChannel(), '2026-09-13', items));

    expect(error.retryable).toBe(false);
    const meta = (error as AiError & { meta?: AiCallMeta }).meta;
    expect(meta?.rawResponse).toContain('見出し');
  });
});

// ---------------------------------------------------------------------------
// リトライ(429 / 5xx / 接続エラー)
// ---------------------------------------------------------------------------

describe('一時的な失敗のリトライ', () => {
  it('429 は再試行され、成功したら結果を返す', async () => {
    let calls = 0;
    const { client, fake } = setup((index, body) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
      return echoClassifyResponder(index, body);
    });

    const { results } = await withFakeTimers(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(results).toHaveLength(1);
    expect(fake.bodies).toHaveLength(2);
  });

  it('5xx は再試行される', async () => {
    let calls = 0;
    const { client, fake } = setup((index, body) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('bad gateway'), { status: 502 });
      return echoClassifyResponder(index, body);
    });

    const { results } = await withFakeTimers(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(results).toHaveLength(1);
    expect(fake.bodies).toHaveLength(3);
  });

  it('接続エラーは再試行される', async () => {
    let calls = 0;
    const { client, fake } = setup((index, body) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return echoClassifyResponder(index, body);
    });

    const { results } = await withFakeTimers(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(results).toHaveLength(1);
    expect(fake.bodies).toHaveLength(2);
  });

  it('cause にぶら下がった接続エラーも拾う', async () => {
    let calls = 0;
    const { client } = setup((index, body) => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      }
      return echoClassifyResponder(index, body);
    });

    const { results } = await withFakeTimers(() => client.classify(makeClassifyItems(1), CHANNELS));
    expect(results).toHaveLength(1);
  });

  it('リトライ上限(2 回 = 計 3 試行)を超えたら retryable=true の AiError で失敗する', async () => {
    const { client, fake } = setup(() => {
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    });

    const error = await catchAiError(() =>
      withFakeTimers(() => client.classify(makeClassifyItems(1), CHANNELS)),
    );

    expect(error.retryable).toBe(true);
    expect(error.message).toContain('503');
    expect(fake.bodies).toHaveLength(3);
  });

  it('429 以外の 4xx は再試行せず retryable=false で即座に失敗する', async () => {
    const { client, fake } = setup(() => {
      throw Object.assign(new Error('invalid request'), { status: 400 });
    });

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('400');
    expect(fake.bodies).toHaveLength(1);
  });

  it('残高不足(400)は日本語で購入先を示し、retryable=false になる', async () => {
    // 実運用で起きた形(2026-09-17)。英語の生エラーだけでは運用者が「壊れたのか」と
    // 受け取ってしまうため、取るべき行動(購入 → summarize --force)を添える。
    const { client, fake } = setup(() => {
      throw Object.assign(
        new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
        ),
        { status: 400 },
      );
    });

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain('残高が不足');
    expect(error.message).toContain('console.anthropic.com/settings/billing');
    expect(error.message).toContain('summarize --force');
    // 元のエラーも追えるようにしておく(原因の裏取り用)。
    expect(error.message).toContain('credit balance');
    expect(fake.bodies).toHaveLength(1);
  });

  it('再試行のたびに警告ログを出す(運用者が頻度に気付けるように)', async () => {
    let calls = 0;
    const { client, logger } = setup((index, body) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
      return echoClassifyResponder(index, body);
    });

    await withFakeTimers(() => client.classify(makeClassifyItems(1), CHANNELS));

    const warnings = logger.records.filter((record) => record.level === 'warn');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((record) => record.fields.attempt === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 秘密情報(NFR-03 / 契約の原則 7)
// ---------------------------------------------------------------------------

describe('API キーの秘匿', () => {
  /** 本物ではないが形だけ本物に似せたキー。 */
  const FAKE_KEY = 'sk-ant-api03-TESTKEYTESTKEYTESTKEY';

  it('壊れた応答にキーが混ざっても、例外メッセージにもログにも出さない', async () => {
    const { client, logger } = setup(() => makeMessage(`${FAKE_KEY} これは JSON ではありません`));

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.message).not.toContain('sk-ant-');
    expect(JSON.stringify(logger.records)).not.toContain('sk-ant-');
  });

  it('SDK の例外メッセージにキーが混ざっても伏せる', async () => {
    const { client, logger } = setup(() => {
      throw Object.assign(new Error(`401 unauthorized: x-api-key ${FAKE_KEY}`), { status: 401 });
    });

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.message).not.toContain('sk-ant-');
    expect(error.message).toContain('[REDACTED]');
    expect(JSON.stringify(logger.records)).not.toContain('sk-ant-');
  });

  it('スキーマ違反の応答にキーが混ざっても伏せる', async () => {
    const { client, logger } = setup(() =>
      makeMessage(
        JSON.stringify({ results: [classifyResultJson('item-001', { reason: FAKE_KEY, kind: 'x' })] }),
      ),
    );

    const error = await catchAiError(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(error.message).not.toContain('sk-ant-');
    expect(JSON.stringify(logger.records)).not.toContain('sk-ant-');
  });

  it('再試行ログにもキーを出さない', async () => {
    let calls = 0;
    const { client, logger } = setup((index, body) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error(`429 too many requests (key=${FAKE_KEY})`), { status: 429 });
      }
      return echoClassifyResponder(index, body);
    });

    await withFakeTimers(() => client.classify(makeClassifyItems(1), CHANNELS));

    expect(JSON.stringify(logger.records)).not.toContain('sk-ant-');
  });
});

// ---------------------------------------------------------------------------
// 応答の正規化
// ---------------------------------------------------------------------------

describe('応答の正規化', () => {
  it('入力に無い id は捨てる(AI の創作を取り込まない)', async () => {
    const { client, logger } = setup(() => makeMessage(classifyResponseJson(['item-001', 'item-999'])));

    const { results } = await client.classify(makeClassifyItems(1), CHANNELS);

    expect(results.map((result) => result.id)).toEqual(['item-001']);
    expect(logger.records.some((record) => record.level === 'warn' && record.fields.id === 'item-999')).toBe(
      true,
    );
  });

  it('未知のチャネル ID は落とし、重複は畳む', async () => {
    const { client } = setup(() =>
      makeMessage(
        JSON.stringify({
          results: [classifyResultJson('item-001', { channels: ['welfare', 'welfare', 'unknown'] })],
        }),
      ),
    );

    const { results } = await client.classify(makeClassifyItems(1), CHANNELS);

    expect(results[0]?.classification.channels).toEqual(['welfare']);
  });

  it('書式の崩れた日付は null にする(推測で埋めない)', async () => {
    const { client } = setup(() =>
      makeMessage(
        JSON.stringify({
          results: [
            classifyResultJson('item-001', { effectiveDate: '令和8年4月1日', deadline: '2026-02-30' }),
          ],
        }),
      ),
    );

    const { results } = await client.classify(makeClassifyItems(1), CHANNELS);

    expect(results[0]?.classification.effectiveDate).toBeNull();
    expect(results[0]?.classification.deadline).toBeNull();
  });

  it('正しい書式の日付はそのまま残す', async () => {
    const { client } = setup(() =>
      makeMessage(
        JSON.stringify({
          results: [
            classifyResultJson('item-001', { effectiveDate: ' 2026-04-01 ', deadline: '2026-05-31' }),
          ],
        }),
      ),
    );

    const { results } = await client.classify(makeClassifyItems(1), CHANNELS);

    expect(results[0]?.classification.effectiveDate).toBe('2026-04-01');
    expect(results[0]?.classification.deadline).toBe('2026-05-31');
  });

  it('text 以外のブロック(thinking)は連結せず、text だけを JSON として読む', async () => {
    const json = classifyResponseJson(['item-001']);
    const { client } = setup(() =>
      makeMessage('', {
        content: [
          { type: 'thinking', thinking: '考え中', signature: 'sig' },
          { type: 'text', text: json },
        ],
      }),
    );

    const { results, meta } = await client.classify(makeClassifyItems(1), CHANNELS);

    expect(results).toHaveLength(1);
    expect(meta.rawResponse).toBe(json);
  });

  it('ダイジェストは 20 件を超える入力を切り詰め、溢れた分を omittedCount に足す', async () => {
    const items = makeDigestItems(23);
    const { client, fake } = setup(() => makeMessage(digestResponseJson(items.slice(0, 20), 0)));

    const { digest } = await client.generateDigest(makeChannel(), '2026-09-13', items);

    expect(requestedIds(fake.bodies[0] as StreamBody)).toHaveLength(20);
    expect(digest.omittedCount).toBe(3);
  });

  it('AI 申告の omittedCount が入力件数を超えたら丸める', async () => {
    const items = makeDigestItems(2);
    const { client } = setup(() => makeMessage(digestResponseJson(items, 99)));

    const { digest } = await client.generateDigest(makeChannel(), '2026-09-13', items);

    expect(digest.omittedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// スタブクライアント
// ---------------------------------------------------------------------------

describe('createStubAiClient', () => {
  it('同じ入力からは同じ結果を返す(決定的)', async () => {
    const stub = createStubAiClient(createFakeLogger());
    const items = makeClassifyItems(3);

    const first = await stub.classify(items, CHANNELS);
    const second = await stub.classify(items, CHANNELS);

    expect(first).toEqual(second);
    expect(first.results.map((result) => result.id)).toEqual(items.map((item) => item.id));
  });

  it('ダイジェストの sourceUrl は入力 url のコピーになる(品質ゲート Q1 を通す)', async () => {
    const stub = createStubAiClient(createFakeLogger());
    const items = makeDigestItems(3);

    const { digest } = await stub.generateDigest(makeChannel(), '2026-09-13', items);

    expect(digest.entries.map((entry) => entry.sourceUrl)).toEqual(items.map((item) => item.url));
    expect(digest.entries.map((entry) => entry.itemId)).toEqual(items.map((item) => item.id));
  });

  it('ダイジェストも決定的で、maxItems を超えた分は omittedCount に入る', async () => {
    const stub = createStubAiClient(createFakeLogger());
    const channel = makeChannel({ maxItems: 2 });
    const items = makeDigestItems(5);

    const first = await stub.generateDigest(channel, '2026-09-13', items);
    const second = await stub.generateDigest(channel, '2026-09-13', items);

    expect(first).toEqual(second);
    expect(first.digest.entries).toHaveLength(2);
    expect(first.digest.omittedCount).toBe(3);
  });

  it('入力が 0 件なら entries も 0 件', async () => {
    const stub = createStubAiClient(createFakeLogger());
    const { digest } = await stub.generateDigest(makeChannel(), '2026-09-13', []);
    expect(digest).toEqual({ entries: [], omittedCount: 0 });
  });
});
