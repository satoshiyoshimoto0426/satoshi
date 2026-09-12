/**
 * LINE 配信本文の整形(詳細設計書 §9 / §9.1、要件定義書 FR-06 / FR-07 / FR-09 / FR-11 / FR-11a)のテスト。
 *
 * 受信者にとっては「毎朝まったく同じ体裁で届くこと」が信頼性そのものなので、
 * 期待文字列はテンプレートからベタ書きして toBe で完全一致を要求する。
 * インデントは全角スペース(U+3000)1 つ。ESLint の no-irregular-whitespace を避けるため、
 * 全角スペースは文字列リテラル内にだけ書き、テンプレートリテラルは使わない。
 */

import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER,
  EMPTY_NOTICE,
  LINE_TEXT_LIMIT,
  fitToLimit,
  formatDigestMessage,
  formatEmptyMessage,
} from '../src/line/format.js';
import type { ChannelConfig, CoverageSummary, DigestEntry, Importance } from '../src/types.js';

// ---------------------------------------------------------------------------
// 固定値とファクトリ
// ---------------------------------------------------------------------------

/** 2025-09-12 は金曜、2025-09-13 は土曜。要件定義書 §11 の例文と同じ曜日になる。 */
const DATE = '2025-09-12';
const DATE_EMPTY = '2025-09-13';

const CHANNEL: ChannelConfig = {
  id: 'welfare',
  name: '就労支援、放課後デイ情報局',
  lineTokenSecret: null,
  topics: '障害福祉サービス / 放課後等デイサービス',
  relevanceThreshold: 0.6,
  maxItems: 7,
  minItems: 3,
  maxChars: 1500,
  sendWhenEmpty: true,
  deliverAt: '07:30',
  requireApproval: false,
};

function channelWithMaxChars(maxChars: number): ChannelConfig {
  return { ...CHANNEL, maxChars };
}

function makeEntry(over: Partial<DigestEntry> = {}): DigestEntry {
  return {
    itemId: 'i1',
    headline: '見出し',
    summary: '要点。',
    affected: '対象事業所',
    dateNote: null,
    sourceUrl: 'https://www.mhlw.go.jp/stf/newpage_00001.html',
    importance: 'medium',
    ...over,
  };
}

/** 重要度を変えた長めの項目。fitToLimit の削除順を検証するために使う。 */
function longEntry(id: string, importance: Importance, filler: string): DigestEntry {
  return {
    itemId: id,
    headline: `見出し-${id}`,
    summary: filler.repeat(80),
    affected: `対象-${id}`,
    dateNote: null,
    sourceUrl: `https://www.mhlw.go.jp/stf/${id}.html`,
    importance,
  };
}

const codePoints = (text: string): number => [...text].length;

// ---------------------------------------------------------------------------
// §9 / 要件定義書 §11 のテンプレート
// ---------------------------------------------------------------------------

describe('formatDigestMessage: 詳細設計書 §9 / 要件定義書 §11 のテンプレート', () => {
  it('要件定義書 §11 の例文と完全に一致する', () => {
    const entries: DigestEntry[] = [
      {
        itemId: 'i1',
        headline: '令和8年度 障害福祉サービス等報酬改定 Q&A(第3報)公表',
        summary: '放課後等デイサービスの「専門的支援実施加算」の算定要件が明確化。',
        affected: '放課後等デイ / 児童発達支援',
        dateNote: null,
        sourceUrl: 'https://www.mhlw.go.jp/stf/qa03.html',
        importance: 'high',
      },
      {
        itemId: 'i2',
        headline: '就労選択支援 実施要綱の一部改正について(通知)',
        summary: 'アセスメント様式の変更。10/1 適用。',
        affected: '就労移行 / 就労継続B型',
        dateNote: null,
        sourceUrl: 'https://www.mhlw.go.jp/stf/youkou.html',
        importance: 'medium',
      },
      {
        itemId: 'i3',
        headline: 'パブコメ: 児童福祉法施行規則の一部改正(案)',
        summary: '意見募集は 9/30 まで。',
        affected: '',
        dateNote: null,
        sourceUrl: 'https://public-comment.e-gov.go.jp/pcm1030.html',
        importance: 'low',
      },
    ];

    const expected = [
      '【本日の制度・法改正まとめ】9/12(金)',
      '就労支援、放課後デイ情報局',
      '',
      '■1. 【重要】令和8年度 障害福祉サービス等報酬改定 Q&A(第3報)公表',
      '　放課後等デイサービスの「専門的支援実施加算」の算定要件が明確化。',
      '　対象: 放課後等デイ / 児童発達支援',
      '　出典: https://www.mhlw.go.jp/stf/qa03.html',
      '',
      '■2. 就労選択支援 実施要綱の一部改正について(通知)',
      '　アセスメント様式の変更。10/1 適用。',
      '　対象: 就労移行 / 就労継続B型',
      '　出典: https://www.mhlw.go.jp/stf/youkou.html',
      '',
      '■3. パブコメ: 児童福祉法施行規則の一部改正(案)',
      '　意見募集は 9/30 まで。',
      '　出典: https://public-comment.e-gov.go.jp/pcm1030.html',
      '',
      'その他の新着 2 件は管理画面で確認できます。',
      '',
      '※本まとめはAIが公的情報を要約したものです。正確な内容は必ず出典をご確認ください。',
    ].join('\n');

    expect(formatDigestMessage(CHANNEL, DATE, entries, 2)).toBe(expected);
  });

  it('dateNote がある項目は 対象 と 出典 の間に 1 行入る', () => {
    const entry = makeEntry({
      headline: '介護報酬改定の告示',
      summary: '加算要件を見直し。',
      affected: '訪問介護',
      dateNote: '2025/10/1 施行',
      sourceUrl: 'https://www.mhlw.go.jp/stf/kokuji.html',
      importance: 'medium',
    });

    const expected = [
      '【本日の制度・法改正まとめ】9/12(金)',
      '就労支援、放課後デイ情報局',
      '',
      '■1. 介護報酬改定の告示',
      '　加算要件を見直し。',
      '　対象: 訪問介護',
      '　2025/10/1 施行',
      '　出典: https://www.mhlw.go.jp/stf/kokuji.html',
      '',
      '※本まとめはAIが公的情報を要約したものです。正確な内容は必ず出典をご確認ください。',
    ].join('\n');

    expect(formatDigestMessage(CHANNEL, DATE, [entry], 0)).toBe(expected);
  });

  it('dateNote が null なら行ごと消える', () => {
    const text = formatDigestMessage(CHANNEL, DATE, [makeEntry({ dateNote: null })], 0);
    const lines = text.split('\n');

    // 項目のブロックは 見出し / 要点 / 対象 / 出典 の 4 行だけ。
    expect(lines.slice(3, 7)).toEqual([
      '■1. 見出し',
      '　要点。',
      '　対象: 対象事業所',
      '　出典: https://www.mhlw.go.jp/stf/newpage_00001.html',
    ]);
    expect(lines).toHaveLength(9);
  });

  it('affected が空なら 対象 の行ごと消える', () => {
    const text = formatDigestMessage(CHANNEL, DATE, [makeEntry({ affected: '' })], 0);

    expect(text).not.toContain('対象:');
    expect(text.split('\n').slice(3, 6)).toEqual([
      '■1. 見出し',
      '　要点。',
      '　出典: https://www.mhlw.go.jp/stf/newpage_00001.html',
    ]);
  });

  it('affected が全角スペースのみでも 対象 の行は出ない', () => {
    const text = formatDigestMessage(CHANNEL, DATE, [makeEntry({ affected: '　' })], 0);
    expect(text).not.toContain('対象:');
  });
});

describe('重要度マーク', () => {
  it('high には【重要】が付く', () => {
    const text = formatDigestMessage(CHANNEL, DATE, [makeEntry({ importance: 'high' })], 0);
    expect(text).toContain('■1. 【重要】見出し');
  });

  for (const importance of ['medium', 'low'] as const) {
    it(`${importance} には【重要】が付かない`, () => {
      const text = formatDigestMessage(CHANNEL, DATE, [makeEntry({ importance })], 0);
      expect(text).toContain('■1. 見出し');
      expect(text).not.toContain('【重要】');
    });
  }
});

describe('その他の新着 N 件(FR-07)', () => {
  it('omittedCount が 0 なら行そのものが出ない', () => {
    const text = formatDigestMessage(CHANNEL, DATE, [makeEntry()], 0);
    expect(text).not.toContain('その他の新着');
  });

  it('omittedCount が 1 以上のときだけ出る', () => {
    const text = formatDigestMessage(CHANNEL, DATE, [makeEntry()], 3);
    expect(text).toContain('その他の新着 3 件は管理画面で確認できます。');
  });
});

describe('免責文(FR-06 / 詳細設計書 §9)', () => {
  it('DISCLAIMER の文言が仕様どおり', () => {
    expect(DISCLAIMER).toBe(
      '※本まとめはAIが公的情報を要約したものです。正確な内容は必ず出典をご確認ください。',
    );
  });

  it('項目数や omittedCount によらず必ず末尾に入る', () => {
    for (const omitted of [0, 5]) {
      for (const entries of [[], [makeEntry()], [makeEntry(), makeEntry({ itemId: 'i2' })]]) {
        const text = formatDigestMessage(CHANNEL, DATE, entries, omitted);
        expect(text.endsWith(`\n\n${DISCLAIMER}`)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §9.1 新着なし文面
// ---------------------------------------------------------------------------

describe('formatEmptyMessage: 新着なし文面(詳細設計書 §9.1 / FR-11 / FR-11a)', () => {
  it('succeeded === total のとき要件定義書 §11 の例文と完全に一致する', () => {
    const coverage: CoverageSummary = { total: 38, succeeded: 38, lastCollectedAtJst: '06:00' };

    const expected = [
      '【本日の制度・法改正まとめ】9/13(土)',
      '就労支援、放課後デイ情報局',
      '',
      '本日の新着はありません。',
      '(本日 06:00 時点で 38 ソースを確認しました)',
      '',
      '※この配信が届かない日はシステム障害の可能性があります。管理者へご連絡ください。',
    ].join('\n');

    expect(formatEmptyMessage(CHANNEL, DATE_EMPTY, coverage)).toBe(expected);
  });

  it('succeeded < total のとき「N ソース中 M ソース」形式になる', () => {
    const coverage: CoverageSummary = { total: 38, succeeded: 30, lastCollectedAtJst: '06:00' };

    const expected = [
      '【本日の制度・法改正まとめ】9/13(土)',
      '就労支援、放課後デイ情報局',
      '',
      '本日の新着はありません。',
      '(本日 06:00 時点で 38 ソース中 30 ソースを確認しました)',
      '',
      '※この配信が届かない日はシステム障害の可能性があります。管理者へご連絡ください。',
    ].join('\n');

    expect(formatEmptyMessage(CHANNEL, DATE_EMPTY, coverage)).toBe(expected);
  });

  it('lastCollectedAtJst が null でも自然な日本語になる', () => {
    const coverage: CoverageSummary = { total: 38, succeeded: 38, lastCollectedAtJst: null };

    const expected = [
      '【本日の制度・法改正まとめ】9/13(土)',
      '就労支援、放課後デイ情報局',
      '',
      '本日の新着はありません。',
      '(本日 38 ソースを確認しました)',
      '',
      '※この配信が届かない日はシステム障害の可能性があります。管理者へご連絡ください。',
    ].join('\n');

    const text = formatEmptyMessage(CHANNEL, DATE_EMPTY, coverage);
    expect(text).toBe(expected);
    // 'null' や二重スペースが漏れないこと。
    expect(text).not.toContain('null');
    expect(text).not.toContain('  ');
  });

  it('EMPTY_NOTICE の文言が仕様どおりで、必ず末尾に入る', () => {
    expect(EMPTY_NOTICE).toBe(
      '※この配信が届かない日はシステム障害の可能性があります。管理者へご連絡ください。',
    );

    const coverage: CoverageSummary = { total: 1, succeeded: 0, lastCollectedAtJst: null };
    const text = formatEmptyMessage(CHANNEL, DATE_EMPTY, coverage);
    expect(text.endsWith(`\n\n${EMPTY_NOTICE}`)).toBe(true);
    expect(text).toContain('本日の新着はありません。');
    // 新着なし文面に通常の免責文は入らない(§9.1)。
    expect(text).not.toContain(DISCLAIMER);
  });
});

// ---------------------------------------------------------------------------
// fitToLimit(FR-09 / 品質ゲート Q7)
// ---------------------------------------------------------------------------

describe('fitToLimit: 文字数上限への収め方', () => {
  it('上限に収まっていれば何も削らない', () => {
    const entries = [makeEntry(), makeEntry({ itemId: 'i2', sourceUrl: 'https://example.go.jp/2' })];
    const expectedText = formatDigestMessage(CHANNEL, DATE, entries, 0);

    const result = fitToLimit(CHANNEL, DATE, entries, 0);

    expect(result.droppedCount).toBe(0);
    expect(result.entries).toEqual(entries);
    expect(result.text).toBe(expectedText);
  });

  it('maxChars をちょうど 1 文字超える入力で、最も重要度が低い項目が落ちる', () => {
    const a = longEntry('a', 'high', 'あ');
    const b = longEntry('b', 'low', 'い');
    const c = longEntry('c', 'medium', 'う');
    const entries = [a, b, c];

    const full = formatDigestMessage(CHANNEL, DATE, entries, 0);
    const channel = channelWithMaxChars(codePoints(full) - 1);

    const result = fitToLimit(channel, DATE, entries, 0);

    expect(result.droppedCount).toBe(1);
    expect(result.entries.map((e) => e.itemId)).toEqual(['a', 'c']);
    expect(codePoints(result.text)).toBeLessThanOrEqual(channel.maxChars);
    expect(result.text).not.toContain('見出し-b');
  });

  it('落ちた件数が droppedCount と omittedCount(本文の「その他の新着 N 件」)に反映される', () => {
    const entries = [
      longEntry('a', 'high', 'あ'),
      longEntry('b', 'low', 'い'),
      longEntry('c', 'medium', 'う'),
    ];

    const full = formatDigestMessage(CHANNEL, DATE, entries, 3);
    const channel = channelWithMaxChars(codePoints(full) - 1);

    const result = fitToLimit(channel, DATE, entries, 3);

    expect(result.droppedCount).toBe(1);
    // AI が落とした 3 件 + 文字数で落とした 1 件 = 4 件。
    expect(result.text).toContain('その他の新着 4 件は管理画面で確認できます。');
  });

  it('残る項目の順序は入力順のまま(重要度順に並べ替えない)', () => {
    const entries = [
      longEntry('m', 'medium', 'ま'),
      longEntry('h', 'high', 'は'),
      longEntry('l', 'low', 'ら'),
    ];

    const full = formatDigestMessage(CHANNEL, DATE, entries, 0);
    const channel = channelWithMaxChars(codePoints(full) - 1);

    const result = fitToLimit(channel, DATE, entries, 0);

    expect(result.entries.map((e) => e.itemId)).toEqual(['m', 'h']);
    expect(result.text.indexOf('見出し-m')).toBeLessThan(result.text.indexOf('見出し-h'));
  });

  it('重要度が同じなら末尾の項目から落とす', () => {
    const entries = [
      longEntry('first', 'medium', 'あ'),
      longEntry('second', 'medium', 'い'),
      longEntry('third', 'medium', 'う'),
    ];

    const full = formatDigestMessage(CHANNEL, DATE, entries, 0);
    const channel = channelWithMaxChars(codePoints(full) - 1);

    const result = fitToLimit(channel, DATE, entries, 0);

    expect(result.entries.map((e) => e.itemId)).toEqual(['first', 'second']);
  });

  it('1 件だけ残しても超える場合は summary を切り詰め、必ず上限内に収める', () => {
    const entry = makeEntry({ summary: 'あ'.repeat(400) });
    const channel = channelWithMaxChars(200);

    const result = fitToLimit(channel, DATE, [entry], 0);

    expect(result.entries).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
    expect(codePoints(result.text)).toBeLessThanOrEqual(200);
    expect(result.entries[0]?.summary.endsWith('…')).toBe(true);
    expect(codePoints(result.entries[0]?.summary ?? '')).toBeLessThan(400);
    // 本文と記録(entries)が食い違わないこと。
    expect(result.text).toContain(result.entries[0]?.summary ?? '');
    // 見出しと出典は削らない(出典を落とすと検証不能な配信になる)。
    expect(result.text).toContain('■1. 見出し');
    expect(result.text).toContain('出典: https://www.mhlw.go.jp/stf/newpage_00001.html');
  });

  it('maxChars が LINE の上限より大きくても 5,000 文字を超えない', () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      longEntry(`e${i}`, i % 3 === 0 ? 'high' : i % 3 === 1 ? 'medium' : 'low', 'か'),
    );
    const channel = channelWithMaxChars(100_000);

    const result = fitToLimit(channel, DATE, entries, 0);

    expect(LINE_TEXT_LIMIT).toBe(5000);
    expect(codePoints(result.text)).toBeLessThanOrEqual(LINE_TEXT_LIMIT);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.entries.length).toBe(entries.length - result.droppedCount);
  });

  it('文字数はコードポイント数で数える(サロゲートペアを含む本文で過大評価しない)', () => {
    // 絵文字は UTF-16 では 2 コードユニット、コードポイントでは 1 文字。
    const entry = makeEntry({ summary: '😀'.repeat(60) });
    const text = formatDigestMessage(CHANNEL, DATE, [entry], 0);

    // 前提: String.length とコードポイント数がずれている本文であること。
    expect(text.length).toBeGreaterThan(codePoints(text));

    const channel = channelWithMaxChars(codePoints(text));
    const result = fitToLimit(channel, DATE, [entry], 0);

    // ちょうど上限。String.length で数えていれば切り詰められてしまう。
    expect(result.droppedCount).toBe(0);
    expect(result.entries).toEqual([entry]);
    expect(result.text).toBe(text);
  });

  it('コードポイント上限ちょうどで切り詰めてもサロゲートペアを割らない', () => {
    const entry = makeEntry({ summary: '😀'.repeat(200) });
    const channel = channelWithMaxChars(150);

    const result = fitToLimit(channel, DATE, [entry], 0);

    expect(codePoints(result.text)).toBeLessThanOrEqual(150);
    // 壊れたサロゲート(U+FFFD になる単独サロゲート)が残っていないこと。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result.text)).toBe(
      false,
    );
  });
});
