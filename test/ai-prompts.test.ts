/**
 * AI プロンプト(詳細設計書 §7.1 / §7.2)のテスト。
 *
 * 検証の狙いは 2 つ。
 * 1. **システムプロンプトが固定文字列であること。** 日付や件数などの可変値が紛れ込むと
 *    リクエストの先頭が毎回変わり、プロンプトキャッシュ(cache_control: ephemeral)が
 *    毎回ミスして NFR-04(コスト)を守れなくなる。
 * 2. **設計書の「システムプロンプト要点」が全て入っていること。** 特に幻覚防止の 3 項目
 *    (入力に無い URL を出さない / 本文に無い事実を補わない / 助言・評価を書かない)は
 *    品質ゲート(§8)と二重のガードになっており、片方が欠けると NFR-02 が崩れる。
 *
 * 外部ネットワークには一切出ない(文字列の組み立てのみを扱う)。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFY_SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  buildClassifyUserMessage,
  buildDigestUserMessage,
} from '../src/ai/prompts.js';
import type { ClassifyChannelInfo, ClassifyInputItem, DigestInputItem } from '../src/types.js';
import { makeChannel } from './helpers/fakes.js';

// ---------------------------------------------------------------------------
// 固定値とヘルパー
// ---------------------------------------------------------------------------

/** 幻覚防止の 3 項目(要件定義書 NFR-02)。両システムプロンプトに必ず入る。 */
const ANTI_HALLUCINATION_RULES = [
  '入力に含まれない URL を出力してはなりません',
  '本文に書かれていない事実を補ってはなりません',
  '助言・評価・推奨を書きません',
];

/** 現在時刻から作った「可変値らしき文字列」。プロンプトに含まれていてはならない。 */
function nowDerivedStrings(): string[] {
  const out: string[] = [];
  const base = Date.now();
  // 当日だけでなく前後 1 日も見る(JST/UTC のずれで日付が 1 日前後するため)。
  for (const offsetDays of [-1, 0, 1]) {
    const d = new Date(base + offsetDays * 86_400_000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const mm = String(m).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    out.push(`${y}-${mm}-${dd}`, `${y}/${mm}/${dd}`, `${y}/${m}/${day}`, `${y}年${m}月${day}日`);
  }
  return out;
}

function makeClassifyItem(over: Partial<ClassifyInputItem> = {}): ClassifyInputItem {
  return {
    id: 'item-1',
    title: '障害福祉サービス等報酬改定について',
    url: 'https://www.mhlw.go.jp/stf/newpage_00001.html',
    excerpt: '本文の先頭部分です。',
    region: null,
    sourceName: '厚生労働省 新着情報',
    ...over,
  };
}

function makeDigestItem(over: Partial<DigestInputItem> = {}): DigestInputItem {
  return {
    id: 'item-1',
    title: '障害福祉サービス等報酬改定について',
    url: 'https://www.mhlw.go.jp/stf/newpage_00001.html',
    kind: 'fee_revision',
    importance: 'high',
    effectiveDate: '2026-04-01',
    deadline: null,
    region: null,
    sourceName: '厚生労働省 新着情報',
    excerpt: '基本報酬の単位数が改定されます。',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 固定文字列であること
// ---------------------------------------------------------------------------

describe('システムプロンプトは固定文字列である', () => {
  it('モジュールを読み込み直しても同一の文字列になる(生成時刻に依存しない)', async () => {
    vi.resetModules();
    const reloaded = await import('../src/ai/prompts.js');
    expect(reloaded.CLASSIFY_SYSTEM_PROMPT).toBe(CLASSIFY_SYSTEM_PROMPT);
    expect(reloaded.DIGEST_SYSTEM_PROMPT).toBe(DIGEST_SYSTEM_PROMPT);
  });

  it('同じ定数を 2 回読んでも同一である', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toBe(CLASSIFY_SYSTEM_PROMPT);
    expect(DIGEST_SYSTEM_PROMPT).toBe(DIGEST_SYSTEM_PROMPT);
    expect(typeof CLASSIFY_SYSTEM_PROMPT).toBe('string');
    expect(typeof DIGEST_SYSTEM_PROMPT).toBe('string');
  });

  it('new Date() 由来の日付文字列を含まない', () => {
    for (const candidate of nowDerivedStrings()) {
      expect(CLASSIFY_SYSTEM_PROMPT, `分類プロンプトに ${candidate} が含まれています`).not.toContain(
        candidate,
      );
      expect(DIGEST_SYSTEM_PROMPT, `要約プロンプトに ${candidate} が含まれています`).not.toContain(candidate);
    }
  });

  it('チャネル設定由来の可変値を埋め込まず、user メッセージ側の constraints を参照する', () => {
    const channel = makeChannel();
    // 件数・文字数の「具体値」が system に入っているとキャッシュが毎回ミスする。
    expect(DIGEST_SYSTEM_PROMPT).toContain('constraints.minItems');
    expect(DIGEST_SYSTEM_PROMPT).toContain('constraints.maxItems');
    expect(DIGEST_SYSTEM_PROMPT).toContain('constraints.maxChars');
    expect(DIGEST_SYSTEM_PROMPT).not.toContain(channel.name);
    expect(DIGEST_SYSTEM_PROMPT).not.toContain(channel.topics);
    expect(CLASSIFY_SYSTEM_PROMPT).not.toContain(channel.name);
    expect(CLASSIFY_SYSTEM_PROMPT).not.toContain(channel.topics);
  });
});

// ---------------------------------------------------------------------------
// 設計書 §7.1 の要点
// ---------------------------------------------------------------------------

describe('分類システムプロンプト(詳細設計書 §7.1)', () => {
  it('「本文に書かれている事実だけで判断する」が明示されている', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('書かれている事実だけで判断');
  });

  it('「日付は明記されている場合のみ埋め、推測しない」が明示されている', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('明記されている場合のみ');
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('推測しません');
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('YYYY-MM-DD');
  });

  it('relevance の付け方(イベント告知は低く、制度・報酬・基準・給付要件・期限は高く)が書かれている', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('イベント告知');
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('一般ニュース');
    expect(CLASSIFY_SYSTEM_PROMPT).toContain(
      '制度・報酬・基準・給付要件・期限に直接影響するものを高くします',
    );
  });

  it('reason が「運用者が判定を監査するための一文」であると書かれている', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('運用者が判定を監査するための一文');
  });

  it('region と isDuplicateOfNational の扱い(国の通知の転載)が書かれている', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('region');
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('isDuplicateOfNational');
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('転載');
  });

  it('出力する id は入力の id のコピーであると書かれている', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toContain('id は入力の id をそのままコピー');
  });

  it('幻覚防止の 3 項目がすべて明示されている', () => {
    for (const rule of ANTI_HALLUCINATION_RULES) {
      expect(CLASSIFY_SYSTEM_PROMPT, `分類プロンプトに「${rule}」がありません`).toContain(rule);
    }
  });
});

// ---------------------------------------------------------------------------
// 設計書 §7.2 の要点
// ---------------------------------------------------------------------------

describe('要約システムプロンプト(詳細設計書 §7.2)', () => {
  it('読者像と分量(現場責任者 / 毎朝 1 分)が書かれている', () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain('現場責任者');
    expect(DIGEST_SYSTEM_PROMPT).toContain('1 分');
  });

  it('minItems〜maxItems に絞り、重要度順に並べることが書かれている', () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain('constraints.minItems');
    expect(DIGEST_SYSTEM_PROMPT).toContain('constraints.maxItems');
    expect(DIGEST_SYSTEM_PROMPT).toContain('重要度');
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/高い順に並べ/);
  });

  it('sourceUrl は入力アイテムの url をそのまま使うと書かれている', () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain('sourceUrl は入力アイテムの url');
    expect(DIGEST_SYSTEM_PROMPT).toContain('canonicalUrl');
  });

  it('summary は本文の事実のみ・数値と日付は原文どおりと書かれている', () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain('事実のみ');
    expect(DIGEST_SYSTEM_PROMPT).toContain('原文どおり');
  });

  it('同じ制度の複数記事は 1 項目に統合し、一次情報に近い URL を出典にすると書かれている', () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain('1 項目に統合します');
    expect(DIGEST_SYSTEM_PROMPT).toContain('一次情報に近い URL');
  });

  it('region を持つアイテムは affected に地域名を含めると書かれている', () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain('affected に地域名を含めます');
  });

  it('入力が 0 件なら entries を空にすると書かれている', () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain('0 件のときは entries を空配列');
  });

  it('各項目の文字数上限(60 / 140 / 40)が書かれている', () => {
    expect(DIGEST_SYSTEM_PROMPT).toContain('headline は 60 文字以内');
    expect(DIGEST_SYSTEM_PROMPT).toContain('summary は 140 文字以内');
    expect(DIGEST_SYSTEM_PROMPT).toContain('affected は 40 文字以内');
  });

  it('幻覚防止の 3 項目がすべて明示されている', () => {
    for (const rule of ANTI_HALLUCINATION_RULES) {
      expect(DIGEST_SYSTEM_PROMPT, `要約プロンプトに「${rule}」がありません`).toContain(rule);
    }
  });
});

// ---------------------------------------------------------------------------
// buildClassifyUserMessage
// ---------------------------------------------------------------------------

describe('buildClassifyUserMessage', () => {
  const channels: ClassifyChannelInfo[] = [
    { id: 'welfare', name: '福祉チャネル', topics: '障害福祉サービス' },
    { id: 'ai_reskill', name: 'AI チャネル', topics: 'リスキリング' },
  ];

  it('JSON として parse でき、チャネル情報が全件入る', () => {
    const message = buildClassifyUserMessage([makeClassifyItem()], channels);
    const payload = JSON.parse(message) as {
      channels: Array<{ id: string; name: string; topics: string }>;
    };
    expect(payload.channels).toEqual(channels);
  });

  it('各アイテムの id / title / url / region / sourceName / excerpt を渡す', () => {
    const items = [
      makeClassifyItem(),
      makeClassifyItem({
        id: 'item-2',
        url: 'https://www.pref.osaka.lg.jp/page/00002.html',
        region: '大阪府',
        sourceName: '大阪府 新着',
        excerpt: '府独自の上乗せについて。',
      }),
    ];
    const payload = JSON.parse(buildClassifyUserMessage(items, channels)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toEqual({
      id: 'item-1',
      title: '障害福祉サービス等報酬改定について',
      url: 'https://www.mhlw.go.jp/stf/newpage_00001.html',
      region: null,
      sourceName: '厚生労働省 新着情報',
      excerpt: '本文の先頭部分です。',
    });
    expect(payload.items[1]?.region).toBe('大阪府');
  });

  it('items が 0 件でも JSON として成立する', () => {
    const payload = JSON.parse(buildClassifyUserMessage([], channels)) as { items: unknown[] };
    expect(payload.items).toEqual([]);
  });

  it('同じ入力からは同じ文字列になる(決定的)', () => {
    const items = [makeClassifyItem()];
    expect(buildClassifyUserMessage(items, channels)).toBe(buildClassifyUserMessage(items, channels));
  });
});

// ---------------------------------------------------------------------------
// buildDigestUserMessage
// ---------------------------------------------------------------------------

describe('buildDigestUserMessage', () => {
  const channel = makeChannel({ minItems: 3, maxItems: 7, maxChars: 1500 });
  const dateJst = '2026-09-13';

  it('JSON として parse できる', () => {
    const message = buildDigestUserMessage(channel, dateJst, [makeDigestItem()]);
    expect(() => JSON.parse(message)).not.toThrow();
  });

  it('constraints に minItems / maxItems / maxChars が入る', () => {
    const payload = JSON.parse(buildDigestUserMessage(channel, dateJst, [makeDigestItem()])) as {
      constraints: { minItems: number; maxItems: number; maxChars: number };
    };
    expect(payload.constraints).toEqual({ minItems: 3, maxItems: 7, maxChars: 1500 });
  });

  it('当日日付(JST)が入る', () => {
    const payload = JSON.parse(buildDigestUserMessage(channel, dateJst, [])) as { dateJst: string };
    expect(payload.dateJst).toBe(dateJst);
  });

  it('チャネルの id / name / topics が入る', () => {
    const payload = JSON.parse(buildDigestUserMessage(channel, dateJst, [])) as {
      channel: { id: string; name: string; topics: string };
    };
    expect(payload.channel).toEqual({ id: channel.id, name: channel.name, topics: channel.topics });
  });

  it('各アイテムの id / url / excerpt を含む §7.2 の入力項目が渡る', () => {
    const items = [
      makeDigestItem(),
      makeDigestItem({ id: 'item-2', region: '大阪府', deadline: '2026-05-31' }),
    ];
    const payload = JSON.parse(buildDigestUserMessage(channel, dateJst, items)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(payload.items).toHaveLength(2);
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(
      [
        'id',
        'title',
        'url',
        'kind',
        'importance',
        'effectiveDate',
        'deadline',
        'region',
        'sourceName',
        'excerpt',
      ].sort(),
    );
    expect(payload.items[0]?.id).toBe('item-1');
    expect(payload.items[0]?.url).toBe('https://www.mhlw.go.jp/stf/newpage_00001.html');
    expect(payload.items[0]?.excerpt).toBe('基本報酬の単位数が改定されます。');
    expect(payload.items[1]?.region).toBe('大阪府');
    expect(payload.items[1]?.deadline).toBe('2026-05-31');
  });

  it('チャネルごとに constraints が変わる(値は user メッセージ側にある)', () => {
    const other = makeChannel({ id: 'ai_reskill', minItems: 1, maxItems: 5, maxChars: 900 });
    const payload = JSON.parse(buildDigestUserMessage(other, dateJst, [])) as {
      constraints: { minItems: number; maxItems: number; maxChars: number };
    };
    expect(payload.constraints).toEqual({ minItems: 1, maxItems: 5, maxChars: 900 });
  });

  it('同じ入力からは同じ文字列になる(決定的)', () => {
    const items = [makeDigestItem()];
    expect(buildDigestUserMessage(channel, dateJst, items)).toBe(
      buildDigestUserMessage(channel, dateJst, items),
    );
  });
});
