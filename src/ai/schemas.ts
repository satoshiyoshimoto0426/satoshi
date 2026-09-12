/**
 * AI 構造化出力のスキーマ定義(詳細設計書 §7.1 / §7.2)。
 *
 * 設計意図(要件定義書 NFR-02「正確性」):
 * - AI には JSON Schema(`output_config.format`)で形を強制し、さらに受信側で
 *   zod による二重検証を行う。API 側の保証が将来変わっても、必須項目の欠落や
 *   想定外の値がそのままドメイン型に流れ込まないようにするため。
 * - JSON Schema と zod は「同じ制約の二重表現」である。片方だけを直すと
 *   検証が素通りする穴になるので、必ず両方を同時に更新すること。
 * - すべてのオブジェクトに `additionalProperties: false`(zod では `.strict()`)と
 *   `required` 全項目を付ける。欠落や余剰フィールドを黙って受け入れないため。
 */
import { z } from 'zod';
import { ConfigError } from '../types.js';
import type { Classification, DigestEntry } from '../types.js';

/** アイテム種別。src/types.ts の `ItemKind` と 1 対 1 で対応させる。 */
const ITEM_KINDS = [
  'law_amendment',
  'fee_revision',
  'notice',
  'public_comment',
  'budget',
  'event',
  'other',
] as const;

/** 重要度。src/types.ts の `Importance` と 1 対 1 で対応させる。 */
const IMPORTANCE_LEVELS = ['high', 'medium', 'low'] as const;

/** 各文字列項目の上限(詳細設計書 §7.1 / §7.2 の maxLength)。 */
const REASON_MAX_CHARS = 200;
const HEADLINE_MAX_CHARS = 60;
const SUMMARY_MAX_CHARS = 140;
const AFFECTED_MAX_CHARS = 40;
const DATE_NOTE_MAX_CHARS = 40;

/**
 * 分類(classify)用の JSON Schema を組み立てる(詳細設計書 §7.1)。
 *
 * `channels` の `items.enum` だけは設定(config/channels.yaml)由来で可変なので、
 * ここで与えられた ID 列を埋め込む。enum にしておくことで、存在しないチャネル ID を
 * AI が創作すること自体を API 側で防げる(幻覚防止の一次ガード)。
 */
export function buildClassifyJsonSchema(channelIds: string[]): Record<string, unknown> {
  // 重複した ID は enum としては無意味なので畳む。順序は設定ファイルの並びを保つ。
  const uniqueChannelIds = [...new Set(channelIds)];
  if (uniqueChannelIds.length === 0) {
    // 空の enum はどの値にも一致しないスキーマになり、AI 側が必ず失敗する。
    // 「なぜか毎回分類に失敗する」より、設定不備として早期に落とすほうが原因に辿り着きやすい。
    throw new ConfigError(
      '分類用の JSON Schema にはチャネル ID が 1 件以上必要です(config/channels.yaml を確認してください)',
    );
  }

  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            channels: { type: 'array', items: { enum: uniqueChannelIds } },
            relevance: { type: 'number', minimum: 0, maximum: 1 },
            importance: { enum: [...IMPORTANCE_LEVELS] },
            kind: { enum: [...ITEM_KINDS] },
            isDuplicateOfNational: {
              type: 'boolean',
              description: '自治体ページが国の通知を転載しただけの場合 true',
            },
            effectiveDate: {
              type: ['string', 'null'],
              description: 'YYYY-MM-DD。原文に明記がある場合のみ',
            },
            deadline: { type: ['string', 'null'] },
            reason: { type: 'string', maxLength: REASON_MAX_CHARS },
          },
          required: [
            'id',
            'channels',
            'relevance',
            'importance',
            'kind',
            'isDuplicateOfNational',
            'effectiveDate',
            'deadline',
            'reason',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['results'],
    additionalProperties: false,
  };
}

/**
 * ダイジェスト生成(summarize)用の JSON Schema(詳細設計書 §7.2)。
 *
 * 固定文字列としてモジュール定数に置く。日付などの可変値を混ぜないことで
 * リクエストの先頭(system + スキーマ)が毎回同一になり、プロンプトキャッシュが効く。
 */
export const DIGEST_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          headline: { type: 'string', maxLength: HEADLINE_MAX_CHARS },
          summary: { type: 'string', maxLength: SUMMARY_MAX_CHARS },
          affected: { type: 'string', maxLength: AFFECTED_MAX_CHARS },
          dateNote: { type: ['string', 'null'], maxLength: DATE_NOTE_MAX_CHARS },
          sourceUrl: { type: 'string' },
          importance: { enum: [...IMPORTANCE_LEVELS] },
        },
        required: ['itemId', 'headline', 'summary', 'affected', 'dateNote', 'sourceUrl', 'importance'],
        additionalProperties: false,
      },
    },
    omittedCount: { type: 'integer', minimum: 0 },
  },
  required: ['entries', 'omittedCount'],
  additionalProperties: false,
};

/**
 * 分類応答の zod スキーマ(AI 応答の二重検証用)。
 *
 * `channels` の要素は「文字列」までしか見ない。実在するチャネル ID かどうかは
 * 呼び出し側(src/ai/client.ts)が設定と突き合わせて弾く。ここを固定 enum にすると
 * チャネル追加のたびにコード変更が必要になり、YAML だけで増やせる設計(NFR-09)と矛盾するため。
 *
 * 日付は「文字列 or null」までの検証にとどめる。JSON Schema 側にも書式の制約は無く、
 * 書式が崩れた 1 件のためにバッチ全体を失敗させるのは損失が大きい。
 * `YYYY-MM-DD` として妥当かどうかは client.ts が個別に見て、不正なら null に落とす。
 */
export const ClassifyResponseSchema = z
  .object({
    results: z.array(
      z
        .object({
          id: z.string(),
          channels: z.array(z.string()),
          relevance: z.number().min(0).max(1),
          importance: z.enum(IMPORTANCE_LEVELS),
          kind: z.enum(ITEM_KINDS),
          isDuplicateOfNational: z.boolean(),
          effectiveDate: z.string().nullable(),
          deadline: z.string().nullable(),
          reason: z.string().max(REASON_MAX_CHARS),
        })
        .strict(),
    ),
  })
  .strict();

/** ダイジェスト応答の zod スキーマ(AI 応答の二重検証用)。 */
export const DigestResponseSchema = z
  .object({
    entries: z.array(
      z
        .object({
          itemId: z.string(),
          headline: z.string().max(HEADLINE_MAX_CHARS),
          summary: z.string().max(SUMMARY_MAX_CHARS),
          affected: z.string().max(AFFECTED_MAX_CHARS),
          dateNote: z.string().max(DATE_NOTE_MAX_CHARS).nullable(),
          sourceUrl: z.string(),
          importance: z.enum(IMPORTANCE_LEVELS),
        })
        .strict(),
    ),
    omittedCount: z.number().int().min(0),
  })
  .strict();

/** zod の出力型。client.ts が正規化してドメイン型へ写す。 */
export type ClassifyResponse = z.infer<typeof ClassifyResponseSchema>;
export type DigestResponse = z.infer<typeof DigestResponseSchema>;

// ---------------------------------------------------------------------------
// 型ずれのコンパイル時アサーション。
// スキーマと src/types.ts のドメイン型がずれたらここでビルドが落ちる。
// ---------------------------------------------------------------------------

/** 分類 1 件は `id` を除けば `Classification` そのものでなければならない。 */
type _ClassifyResultMatchesDomain =
  Omit<ClassifyResponse['results'][number], 'id'> extends Classification ? true : never;
type _DomainMatchesClassifyResult =
  Classification extends Omit<ClassifyResponse['results'][number], 'id'> ? true : never;

/** ダイジェスト 1 項目は `DigestEntry` そのものでなければならない。 */
type _DigestEntryMatchesDomain = DigestResponse['entries'][number] extends DigestEntry ? true : never;
type _DomainMatchesDigestEntry = DigestEntry extends DigestResponse['entries'][number] ? true : never;
