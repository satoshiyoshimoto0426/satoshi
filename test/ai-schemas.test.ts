/**
 * AI 構造化出力スキーマ(詳細設計書 §7.1 / §7.2)のテスト。
 *
 * このモジュールは「AI が返した JSON をドメイン型として受け入れてよいか」を決める関所であり、
 * JSON Schema(API 側の強制)と zod(受信側の二重検証)の両方が同じ制約を表現していないと
 * 検証が素通りする穴になる。よって両方を個別に検証する。
 *
 * 外部ネットワークには一切出ない(純粋な関数とスキーマのみを扱う)。
 */

import { describe, expect, it } from 'vitest';
import {
  ClassifyResponseSchema,
  DIGEST_JSON_SCHEMA,
  DigestResponseSchema,
  buildClassifyJsonSchema,
} from '../src/ai/schemas.js';
import { ConfigError } from '../src/types.js';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** JSON Schema(Record<string, unknown>)をドット区切りのパスで辿る。 */
function at(schema: Record<string, unknown>, path: string): unknown {
  let current: unknown = schema;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 詳細設計書 §7.1 の分類結果 1 件の必須項目。 */
const CLASSIFY_REQUIRED = [
  'id',
  'channels',
  'relevance',
  'importance',
  'kind',
  'isDuplicateOfNational',
  'effectiveDate',
  'deadline',
  'reason',
];

/** 詳細設計書 §7.2 のダイジェスト 1 項目の必須項目。 */
const DIGEST_ENTRY_REQUIRED = [
  'itemId',
  'headline',
  'summary',
  'affected',
  'dateNote',
  'sourceUrl',
  'importance',
];

const ITEM_KINDS = ['law_amendment', 'fee_revision', 'notice', 'public_comment', 'budget', 'event', 'other'];

const IMPORTANCE_LEVELS = ['high', 'medium', 'low'];

/** zod 検証を通す正しい分類応答 1 件。 */
function validClassifyResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    channels: ['welfare'],
    relevance: 0.8,
    importance: 'high',
    kind: 'fee_revision',
    isDuplicateOfNational: false,
    effectiveDate: '2026-04-01',
    deadline: null,
    reason: '報酬改定の告示であり、事業所の請求実務に直接影響するため。',
    ...over,
  };
}

/** zod 検証を通す正しいダイジェスト 1 項目。 */
function validDigestEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: 'item-1',
    headline: '障害福祉サービス等報酬改定の告示が公布',
    summary: '基本報酬の単位数が改定され、2026 年 4 月 1 日から適用される。',
    affected: '就労継続支援 B 型事業所',
    dateNote: '2026-04-01 施行',
    sourceUrl: 'https://www.mhlw.go.jp/stf/newpage_00001.html',
    importance: 'high',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildClassifyJsonSchema
// ---------------------------------------------------------------------------

describe('buildClassifyJsonSchema', () => {
  it('channels の enum に渡したチャネル ID がそのまま入る', () => {
    const schema = buildClassifyJsonSchema(['a', 'b']);
    expect(at(schema, 'properties.results.items.properties.channels.items.enum')).toEqual(['a', 'b']);
  });

  it('チャネル ID が空配列なら ConfigError を投げる(設定不備を早期に落とす)', () => {
    expect(() => buildClassifyJsonSchema([])).toThrow(ConfigError);
    expect(() => buildClassifyJsonSchema([])).toThrow(/チャネル ID/);
  });

  it('重複したチャネル ID は畳まれ、設定ファイルの並び順が保たれる', () => {
    const schema = buildClassifyJsonSchema(['welfare', 'ai_reskill', 'welfare', 'ai_reskill']);
    expect(at(schema, 'properties.results.items.properties.channels.items.enum')).toEqual([
      'welfare',
      'ai_reskill',
    ]);
  });

  it('ルートと結果 1 件の両方に additionalProperties: false が付く', () => {
    const schema = buildClassifyJsonSchema(['welfare']);
    expect(schema.additionalProperties).toBe(false);
    expect(at(schema, 'properties.results.items.additionalProperties')).toBe(false);
  });

  it('required に §7.1 の全項目が並ぶ', () => {
    const schema = buildClassifyJsonSchema(['welfare']);
    expect(schema.required).toEqual(['results']);
    expect(at(schema, 'properties.results.items.required')).toEqual(CLASSIFY_REQUIRED);
  });

  it('relevance は 0..1 の数値、importance と kind はドメイン型と同じ enum', () => {
    const schema = buildClassifyJsonSchema(['welfare']);
    expect(at(schema, 'properties.results.items.properties.relevance')).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 1,
    });
    expect(at(schema, 'properties.results.items.properties.importance.enum')).toEqual(IMPORTANCE_LEVELS);
    expect(at(schema, 'properties.results.items.properties.kind.enum')).toEqual(ITEM_KINDS);
  });

  it('日付項目は string か null を許し、reason には 200 文字の上限が付く', () => {
    const schema = buildClassifyJsonSchema(['welfare']);
    expect(at(schema, 'properties.results.items.properties.effectiveDate.type')).toEqual(['string', 'null']);
    expect(at(schema, 'properties.results.items.properties.deadline.type')).toEqual(['string', 'null']);
    expect(at(schema, 'properties.results.items.properties.reason.maxLength')).toBe(200);
  });

  it('properties の集合は required と一致する(定義漏れ・余剰が無い)', () => {
    const schema = buildClassifyJsonSchema(['welfare']);
    const properties = at(schema, 'properties.results.items.properties') as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([...CLASSIFY_REQUIRED].sort());
  });

  it('呼び出しごとに独立したオブジェクトを返す(呼び出し側の変更が次回に漏れない)', () => {
    const first = buildClassifyJsonSchema(['welfare']);
    first.additionalProperties = true;
    const second = buildClassifyJsonSchema(['welfare']);
    expect(second.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DIGEST_JSON_SCHEMA
// ---------------------------------------------------------------------------

describe('DIGEST_JSON_SCHEMA', () => {
  it('ルートと entries 1 件の両方に additionalProperties: false が付く', () => {
    expect(DIGEST_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(at(DIGEST_JSON_SCHEMA, 'properties.entries.items.additionalProperties')).toBe(false);
  });

  it('required に §7.2 の全項目が並ぶ', () => {
    expect(DIGEST_JSON_SCHEMA.required).toEqual(['entries', 'omittedCount']);
    expect(at(DIGEST_JSON_SCHEMA, 'properties.entries.items.required')).toEqual(DIGEST_ENTRY_REQUIRED);
  });

  it('properties の集合は required と一致する', () => {
    const properties = at(DIGEST_JSON_SCHEMA, 'properties.entries.items.properties') as Record<
      string,
      unknown
    >;
    expect(Object.keys(properties).sort()).toEqual([...DIGEST_ENTRY_REQUIRED].sort());
  });

  it('各文字列項目に §7.2 の maxLength が付く', () => {
    const base = 'properties.entries.items.properties';
    expect(at(DIGEST_JSON_SCHEMA, `${base}.headline.maxLength`)).toBe(60);
    expect(at(DIGEST_JSON_SCHEMA, `${base}.summary.maxLength`)).toBe(140);
    expect(at(DIGEST_JSON_SCHEMA, `${base}.affected.maxLength`)).toBe(40);
    expect(at(DIGEST_JSON_SCHEMA, `${base}.dateNote.maxLength`)).toBe(40);
  });

  it('dateNote は string か null、importance はドメイン型と同じ enum', () => {
    const base = 'properties.entries.items.properties';
    expect(at(DIGEST_JSON_SCHEMA, `${base}.dateNote.type`)).toEqual(['string', 'null']);
    expect(at(DIGEST_JSON_SCHEMA, `${base}.importance.enum`)).toEqual(IMPORTANCE_LEVELS);
  });

  it('omittedCount は 0 以上の整数', () => {
    expect(at(DIGEST_JSON_SCHEMA, 'properties.omittedCount')).toEqual({ type: 'integer', minimum: 0 });
  });
});

// ---------------------------------------------------------------------------
// ClassifyResponseSchema(zod)
// ---------------------------------------------------------------------------

describe('ClassifyResponseSchema', () => {
  it('正しい応答を通す', () => {
    const parsed = ClassifyResponseSchema.parse({ results: [validClassifyResult()] });
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.id).toBe('item-1');
  });

  it('results が空配列でも通す(該当なしは正常な応答)', () => {
    expect(ClassifyResponseSchema.safeParse({ results: [] }).success).toBe(true);
  });

  it('relevance が 0..1 の範囲外なら弾く', () => {
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ relevance: 1.5 })] }).success,
    ).toBe(false);
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ relevance: -0.1 })] }).success,
    ).toBe(false);
  });

  it('relevance が数値でなければ弾く', () => {
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ relevance: '0.8' })] }).success,
    ).toBe(false);
  });

  it('importance が enum 外なら弾く', () => {
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ importance: 'urgent' })] }).success,
    ).toBe(false);
  });

  it('kind が enum 外なら弾く', () => {
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ kind: 'law_change' })] }).success,
    ).toBe(false);
  });

  it('必須項目が欠けていれば弾く', () => {
    for (const key of CLASSIFY_REQUIRED) {
      const result = validClassifyResult();
      delete result[key];
      expect(
        ClassifyResponseSchema.safeParse({ results: [result] }).success,
        `${key} の欠落が検出されていません`,
      ).toBe(false);
    }
  });

  it('余分なキーがあれば弾く(strict)', () => {
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ confidence: 0.5 })] }).success,
    ).toBe(false);
    expect(ClassifyResponseSchema.safeParse({ results: [], note: 'extra' }).success).toBe(false);
  });

  it('reason が 200 文字を超えたら弾く', () => {
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ reason: 'あ'.repeat(201) })] })
        .success,
    ).toBe(false);
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ reason: 'あ'.repeat(200) })] })
        .success,
    ).toBe(true);
  });

  it('channels は文字列配列(未知の ID は client 側が突き合わせる)', () => {
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ channels: ['unknown_channel'] })] })
        .success,
    ).toBe(true);
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ channels: [1] })] }).success,
    ).toBe(false);
  });

  it('日付は文字列か null のみ受け付ける', () => {
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ effectiveDate: null })] }).success,
    ).toBe(true);
    expect(
      ClassifyResponseSchema.safeParse({ results: [validClassifyResult({ deadline: 20260401 })] }).success,
    ).toBe(false);
  });

  it('results 自体が無ければ弾く', () => {
    expect(ClassifyResponseSchema.safeParse({}).success).toBe(false);
    expect(ClassifyResponseSchema.safeParse([validClassifyResult()]).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DigestResponseSchema(zod)
// ---------------------------------------------------------------------------

describe('DigestResponseSchema', () => {
  it('正しい応答を通す', () => {
    const parsed = DigestResponseSchema.parse({ entries: [validDigestEntry()], omittedCount: 2 });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.omittedCount).toBe(2);
  });

  it('entries が空でも通す(入力 0 件の場合)', () => {
    expect(DigestResponseSchema.safeParse({ entries: [], omittedCount: 0 }).success).toBe(true);
  });

  it('必須項目が欠けていれば弾く', () => {
    for (const key of DIGEST_ENTRY_REQUIRED) {
      const entry = validDigestEntry();
      delete entry[key];
      expect(
        DigestResponseSchema.safeParse({ entries: [entry], omittedCount: 0 }).success,
        `${key} の欠落が検出されていません`,
      ).toBe(false);
    }
    expect(DigestResponseSchema.safeParse({ entries: [] }).success).toBe(false);
  });

  it('余分なキーがあれば弾く(strict)', () => {
    expect(
      DigestResponseSchema.safeParse({ entries: [validDigestEntry({ score: 1 })], omittedCount: 0 }).success,
    ).toBe(false);
    expect(DigestResponseSchema.safeParse({ entries: [], omittedCount: 0, note: 'x' }).success).toBe(false);
  });

  it('importance が enum 外なら弾く', () => {
    expect(
      DigestResponseSchema.safeParse({
        entries: [validDigestEntry({ importance: 'critical' })],
        omittedCount: 0,
      }).success,
    ).toBe(false);
  });

  it('文字数上限を超えた項目は弾く', () => {
    const cases: Array<[string, number]> = [
      ['headline', 60],
      ['summary', 140],
      ['affected', 40],
      ['dateNote', 40],
    ];
    for (const [field, max] of cases) {
      expect(
        DigestResponseSchema.safeParse({
          entries: [validDigestEntry({ [field]: 'あ'.repeat(max + 1) })],
          omittedCount: 0,
        }).success,
        `${field} の文字数超過が検出されていません`,
      ).toBe(false);
      expect(
        DigestResponseSchema.safeParse({
          entries: [validDigestEntry({ [field]: 'あ'.repeat(max) })],
          omittedCount: 0,
        }).success,
        `${field} の上限ちょうどが弾かれています`,
      ).toBe(true);
    }
  });

  it('affected は空文字を許す(Q4a: 原文から読み取れない対象を推測させない)', () => {
    expect(
      DigestResponseSchema.safeParse({ entries: [validDigestEntry({ affected: '' })], omittedCount: 0 })
        .success,
    ).toBe(true);
  });

  it('dateNote は null を許す', () => {
    expect(
      DigestResponseSchema.safeParse({ entries: [validDigestEntry({ dateNote: null })], omittedCount: 0 })
        .success,
    ).toBe(true);
  });

  it('omittedCount が負数・小数・非数値なら弾く', () => {
    expect(DigestResponseSchema.safeParse({ entries: [], omittedCount: -1 }).success).toBe(false);
    expect(DigestResponseSchema.safeParse({ entries: [], omittedCount: 1.5 }).success).toBe(false);
    expect(DigestResponseSchema.safeParse({ entries: [], omittedCount: '0' }).success).toBe(false);
  });
});
