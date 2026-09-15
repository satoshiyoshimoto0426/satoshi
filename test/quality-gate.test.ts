/**
 * 品質ゲート(詳細設計書 §8 / 要件定義書 FR-08 / NFR-02)のテスト。
 *
 * このモジュールは「AI が生成した文面を公衆へ配信してよいか」を判定する最後の関門であり、
 * ここが緩むと実在しない出典を付けた配信がそのまま現場責任者へ届く。
 * よって境界(空白のみ / 全角スペースのみ / URL 内の紛らわしい文字列など)を厳密に検証する。
 *
 * 外部ネットワークには一切出ない。到達確認 (Q2) は ctx.http.checkReachable のスタブで検証する。
 */

import { describe, expect, it } from 'vitest';
import { BANNED_PATTERNS, applyQualityGate } from '../src/pipeline/quality-gate.js';
import type { AppContext, ChannelConfig, DigestEntry, Item, Logger } from '../src/types.js';

// ---------------------------------------------------------------------------
// 固定値とファクトリ
// ---------------------------------------------------------------------------

const U1 = 'https://www.mhlw.go.jp/stf/newpage_00001.html';
const U2 = 'https://www.mhlw.go.jp/stf/newpage_00002.html';
const U3 = 'https://public-comment.e-gov.go.jp/pcm1030.html';
/** 入力アイテムに存在しない URL(AI の幻覚を模したもの)。 */
const HALLUCINATED = 'https://www.mhlw.go.jp/stf/newpage_99999.html';

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

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

function makeItem(id: string, canonicalUrl: string): Item {
  return {
    id,
    sourceId: 'mhlw_news_rss',
    canonicalUrl,
    title: '報道発表資料',
    publishedAt: '2025-09-11T03:00:00.000Z',
    detectedAt: '2025-09-11T21:00:00.000Z',
    updatedAt: '2025-09-11T21:00:00.000Z',
    contentHash: 'a'.repeat(64),
    contentText: '本文',
    contentType: 'html',
    region: null,
    classification: null,
    classifiedAt: null,
    digestedIn: [],
    expiresAt: '2025-12-10T21:00:00.000Z',
  };
}

function makeEntry(over: Partial<DigestEntry> = {}): DigestEntry {
  return {
    itemId: 'i1',
    headline: '障害福祉サービス等報酬改定 Q&A(第3報)公表',
    summary: '専門的支援実施加算の算定要件が明確化された。',
    affected: '放課後等デイ / 児童発達支援',
    dateNote: null,
    sourceUrl: U1,
    importance: 'medium',
    ...over,
  };
}

interface Reach {
  ok: boolean;
  status: number | null;
  error: string | null;
}

const OK: Reach = { ok: true, status: 200, error: null };
const NG_404: Reach = { ok: false, status: 404, error: null };
const NG_503: Reach = { ok: false, status: 503, error: null };
const NG_NET: Reach = { ok: false, status: null, error: 'ECONNREFUSED' };

interface ReachCall {
  url: string;
  timeoutMs: number | undefined;
}

/**
 * quality-gate が必要とする最小限の AppContext を組み立てる。
 * checkReachable の呼び出しは全て記録し「呼ばれた / 呼ばれていない」も検証できるようにする。
 */
function createCtx(responder: (url: string, attempt: number) => Reach = () => OK): {
  ctx: AppContext;
  calls: ReachCall[];
} {
  const calls: ReachCall[] = [];
  const attempts = new Map<string, number>();

  const http = {
    get: (): Promise<never> =>
      Promise.reject(new Error('品質ゲートは http.get を使ってはいけません(到達確認のみ)')),
    checkReachable: (url: string, timeoutMs?: number): Promise<Reach> => {
      calls.push({ url, timeoutMs });
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return Promise.resolve(responder(url, attempt));
    },
  };

  const ctx = { http, logger: silentLogger() } as unknown as AppContext;
  return { ctx, calls };
}

/** テスト内で毎回書くには長いので短縮。 */
function gate(ctx: AppContext, entries: DigestEntry[], items: Item[]) {
  return applyQualityGate(ctx, { channel: CHANNEL, entries, items });
}

type TextField = 'headline' | 'summary' | 'affected' | 'dateNote';

/** i1 / U1 の正常な entry を作り、指定フィールドだけ差し替える。 */
function entryWith(field: TextField, value: string): DigestEntry {
  const base = makeEntry({ itemId: 'i1', sourceUrl: U1 });
  switch (field) {
    case 'headline':
      return { ...base, headline: value };
    case 'summary':
      return { ...base, summary: value };
    case 'affected':
      return { ...base, affected: value };
    default:
      return { ...base, dateNote: value };
  }
}

const JAPANESE_RE = /[ぁ-んァ-ヶ一-龥]/;

// ---------------------------------------------------------------------------
// Q1: 出典 URL の実在性(最重要)
// ---------------------------------------------------------------------------

describe('Q1: 入力アイテムに無い出典 URL(AI の幻覚)', () => {
  it('入力アイテムの canonicalUrl 集合に無い URL を持つ entry を除外する', async () => {
    const items = [makeItem('i1', U1)];
    const entries = [
      makeEntry({ itemId: 'i1', sourceUrl: U1 }),
      makeEntry({ itemId: 'i1', sourceUrl: HALLUCINATED }),
    ];

    const { ctx, calls } = createCtx();
    const out = await gate(ctx, entries, items);

    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.sourceUrl).toBe(U1);

    expect(out.excluded).toHaveLength(1);
    expect(out.excluded[0]?.check).toBe('Q1');
    expect(out.excluded[0]?.sourceUrl).toBe(HALLUCINATED);

    // 幻覚 URL に到達確認をしてはいけない(無駄な外部アクセスを避ける)。
    expect(calls.map((c) => c.url)).toEqual([U1]);
  });

  it('実在する URL でも「別アイテムの URL」を使い回した幻覚を止める(集合に無ければ除外)', async () => {
    // U2 は入力アイテムに含まれていないので、実在するかどうかに関わらず除外される。
    const items = [makeItem('i1', U1)];
    const entries = [makeEntry({ itemId: 'i1', sourceUrl: U2 })];

    const { ctx, calls } = createCtx();
    const out = await gate(ctx, entries, items);

    expect(out.entries).toHaveLength(0);
    expect(out.excluded[0]?.check).toBe('Q1');
    expect(calls).toHaveLength(0);
  });

  it('sourceUrl が空文字・空白のみでも除外する', async () => {
    const items = [makeItem('i1', U1)];
    for (const bad of ['', '   ', '　']) {
      const { ctx, calls } = createCtx();
      const out = await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: bad })], items);
      expect(out.entries).toHaveLength(0);
      expect(out.excluded[0]?.check).toBe('Q1');
      expect(calls).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Q2: 到達確認
// ---------------------------------------------------------------------------

describe('Q2: 出典 URL の到達確認', () => {
  it('robots.txt が禁じている URL は除外しない(存在は Q1/Q3 が担保。再試行もしない)', async () => {
    // 報道サイトは記事ページへのボットを robots.txt で拒否することが多い。
    // RSS から正当に得た URL をここで落とすと、報道だけのまとめが全滅して
    // status=failed で配信が止まる。拒否は「巡回するな」であって「存在しない」ではない。
    const NG_ROBOTS = {
      ok: false,
      status: null,
      error: 'robots.txt により取得が許可されていません: ' + U2,
      robotsDisallowed: true,
    };
    const items = [makeItem('i1', U1), makeItem('i2', U2)];
    const entries = [makeEntry({ itemId: 'i1', sourceUrl: U1 }), makeEntry({ itemId: 'i2', sourceUrl: U2 })];

    const { ctx, calls } = createCtx((url) => (url === U2 ? NG_ROBOTS : OK));
    const out = await gate(ctx, entries, items);

    expect(out.entries.map((e) => e.sourceUrl)).toEqual([U1, U2]);
    expect(out.excluded).toHaveLength(0);
    // 決定的な結果なので、ネットワーク障害のような再試行はしない。
    expect(calls.filter((c) => c.url === U2)).toHaveLength(1);
  });

  it('checkReachable が ok:false を返す URL を除外し、到達する URL は残す', async () => {
    const items = [makeItem('i1', U1), makeItem('i2', U2)];
    const entries = [makeEntry({ itemId: 'i1', sourceUrl: U1 }), makeEntry({ itemId: 'i2', sourceUrl: U2 })];

    const { ctx, calls } = createCtx((url) => (url === U2 ? NG_404 : OK));
    const out = await gate(ctx, entries, items);

    expect(out.entries.map((e) => e.sourceUrl)).toEqual([U1]);
    expect(out.excluded).toHaveLength(1);
    expect(out.excluded[0]?.check).toBe('Q2');
    expect(out.excluded[0]?.sourceUrl).toBe(U2);

    // 到達確認が実際に呼ばれていること。
    expect(calls.map((c) => c.url).sort()).toEqual([U1, U2].sort());
  });

  it('到達確認はタイムアウト 10 秒で呼ばれる(詳細設計書 §8)', async () => {
    const items = [makeItem('i1', U1)];
    const { ctx, calls } = createCtx();
    await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: U1 })], items);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(10_000);
  });

  it('ネットワーク起因の失敗は 1 回だけ再試行し、回復すれば通過させる', async () => {
    const items = [makeItem('i1', U1)];
    const { ctx, calls } = createCtx((_url, attempt) => (attempt === 1 ? NG_NET : OK));
    const out = await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: U1 })], items);

    expect(calls).toHaveLength(2);
    expect(out.entries).toHaveLength(1);
    expect(out.excluded).toHaveLength(0);
  });

  it('一時障害(5xx)は 1 回だけ再試行し、それでも駄目なら除外する', async () => {
    const items = [makeItem('i1', U1)];
    const { ctx, calls } = createCtx(() => NG_503);
    const out = await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: U1 })], items);

    // 初回 + リトライ 1 回 = 2 回。無制限に叩かない。
    expect(calls).toHaveLength(2);
    expect(out.entries).toHaveLength(0);
    expect(out.excluded[0]?.check).toBe('Q2');
    expect(out.excluded[0]?.reason).toContain('503');
  });

  it('静的検査(Q1/Q3/Q4/Q5/Q8)で落ちた entry には checkReachable を呼ばない', async () => {
    const items = [makeItem('i1', U1), makeItem('i2', U2)];
    const entries = [
      makeEntry({ itemId: 'i1', sourceUrl: U1 }), // 通過
      makeEntry({ itemId: 'i1', sourceUrl: HALLUCINATED }), // Q1
      makeEntry({ itemId: 'missing', sourceUrl: U2 }), // Q3
      makeEntry({ itemId: 'i2', sourceUrl: U2, headline: '   ' }), // Q4
      makeEntry({ itemId: 'i2', sourceUrl: U2, summary: '早めに申請すべきです。' }), // Q5
      makeEntry({ itemId: 'i1', sourceUrl: U1 }), // Q8(U1 の重複)
    ];

    const { ctx, calls } = createCtx();
    const out = await gate(ctx, entries, items);

    expect(out.entries).toHaveLength(1);
    expect(out.excluded.map((e) => e.check)).toEqual(['Q1', 'Q3', 'Q4', 'Q5', 'Q8']);

    // 通過した 1 件の分しか HTTP を出していないこと。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(U1);
  });
});

// ---------------------------------------------------------------------------
// Q3: itemId の実在と出典 URL の一致
// ---------------------------------------------------------------------------

describe('Q3: itemId とアイテムの対応', () => {
  it('itemId が入力アイテムに存在しなければ除外する', async () => {
    const items = [makeItem('i1', U1)];
    const { ctx, calls } = createCtx();
    const out = await gate(ctx, [makeEntry({ itemId: 'unknown-id', sourceUrl: U1 })], items);

    expect(out.entries).toHaveLength(0);
    expect(out.excluded).toHaveLength(1);
    expect(out.excluded[0]?.check).toBe('Q3');
    expect(out.excluded[0]?.itemId).toBe('unknown-id');
    expect(calls).toHaveLength(0);
  });

  it('itemId と sourceUrl が食い違えば除外する(記事の取り違え)', async () => {
    const items = [makeItem('i1', U1), makeItem('i2', U2)];
    // U2 は入力集合にあるので Q1 は通るが、i1 のアイテムの URL は U1 なので Q3 で落ちる。
    const { ctx, calls } = createCtx();
    const out = await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: U2 })], items);

    expect(out.entries).toHaveLength(0);
    expect(out.excluded).toHaveLength(1);
    expect(out.excluded[0]?.check).toBe('Q3');
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Q4: 必須項目が空でないこと
// ---------------------------------------------------------------------------

describe('Q4: 必須項目の空チェック', () => {
  const blanks: Array<{ label: string; value: string }> = [
    { label: '空文字', value: '' },
    { label: '半角スペースのみ', value: '   ' },
    { label: '全角スペースのみ', value: '　' },
    { label: '全角スペースと改行のみ', value: '　\n　' },
  ];

  for (const field of ['headline', 'summary'] as const) {
    for (const blank of blanks) {
      it(`${field} が ${blank.label} なら除外する`, async () => {
        const items = [makeItem('i1', U1)];
        const entry = entryWith(field, blank.value);

        const { ctx, calls } = createCtx();
        const out = await gate(ctx, [entry], items);

        expect(out.entries).toHaveLength(0);
        expect(out.excluded).toHaveLength(1);
        expect(out.excluded[0]?.check).toBe('Q4');
        expect(calls).toHaveLength(0);
      });
    }
  }

  // Q4a(詳細設計書 §8): affected は必須にしない。
  // パブリックコメントのように「影響を受ける対象」が原文から読み取れない情報があり、
  // 必須にすると AI に対象を推測させることになる(NFR-02 違反)。
  // 空の場合は line/format 側が「対象:」行ごと省略する。
  for (const blank of blanks) {
    it(`affected が ${blank.label} でも除外しない(Q4a)`, async () => {
      const items = [makeItem('i1', U1)];
      const entry = entryWith('affected', blank.value);

      const { ctx } = createCtx();
      const out = await gate(ctx, [entry], items);

      expect(out.excluded).toHaveLength(0);
      expect(out.entries).toHaveLength(1);
    });
  }

  it('sourceUrl が空文字なら Q1 で除外する(入力 URL 集合に無いため)', async () => {
    const items = [makeItem('i1', U1)];
    const { ctx } = createCtx();
    const out = await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: '' })], items);

    expect(out.entries).toHaveLength(0);
    expect(out.excluded).toHaveLength(1);
  });

  it('必須項目が埋まっていれば通過する(dateNote は必須ではない)', async () => {
    const items = [makeItem('i1', U1)];
    const { ctx } = createCtx();
    const out = await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: U1, dateNote: null })], items);

    expect(out.entries).toHaveLength(1);
    expect(out.excluded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Q5: 禁則語(助言・推測・断定)
// ---------------------------------------------------------------------------

describe('Q5: 禁則語', () => {
  const cases: Array<{ field: TextField; value: string }> = [
    { field: 'summary', value: '対象事業所は速やかに届出を提出すべきです。' },
    { field: 'summary', value: '早めの準備がおすすめです。' },
    { field: 'summary', value: '今後さらに拡充されるでしょう。' },
    { field: 'summary', value: '実務への影響は大きいと考えられます。' },
    { field: 'headline', value: '報酬改定への対応はこうすべき' },
    { field: 'headline', value: '【おすすめ】報酬改定の要点' },
    { field: 'affected', value: '全事業所が確認しましょう' },
    { field: 'dateNote', value: '10/1 施行。前倒しの可能性が高いです。' },
  ];

  for (const c of cases) {
    it(`${c.field} の「${c.value}」を除外する`, async () => {
      const items = [makeItem('i1', U1)];
      const entry = entryWith(c.field, c.value);

      const { ctx, calls } = createCtx();
      const out = await gate(ctx, [entry], items);

      expect(out.entries).toHaveLength(0);
      expect(out.excluded).toHaveLength(1);
      expect(out.excluded[0]?.check).toBe('Q5');
      expect(calls).toHaveLength(0);
    });
  }

  it('sourceUrl に禁則語のローマ字表記が含まれていても除外しない', async () => {
    const url = 'https://www.city.example.lg.jp/osusume/subsidy/2025.html';
    const items = [makeItem('i1', url)];
    const entry = makeEntry({ itemId: 'i1', sourceUrl: url });

    const { ctx, calls } = createCtx();
    const out = await gate(ctx, [entry], items);

    expect(out.excluded).toHaveLength(0);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.sourceUrl).toBe(url);
    expect(calls.map((c) => c.url)).toEqual([url]);
  });

  it('BANNED_PATTERNS は g フラグを持たない(lastIndex の持ち越しで取りこぼさないため)', () => {
    expect(BANNED_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of BANNED_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.global).toBe(false);
    }
    // 代表的な助言・推測表現は必ずいずれかにヒットすること。
    for (const word of ['すべき', 'おすすめ', 'でしょう']) {
      expect(BANNED_PATTERNS.some((p) => p.test(word))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Q5 の強化: 語尾を変えただけの助言・推測を素通りさせないこと
//
// 当初の禁則語は能動形の数語しか止めておらず、「減算となる可能性があります」
// 「返還リスクに注意が必要です」のような、現場責任者の実務判断を直接動かす表現が
// すべて通過していた。要件定義書 §2.2(法的助言は対象外)と NFR-02(推測しない)の
// 後段ガードとして機能させる。
// ---------------------------------------------------------------------------

describe('Q5: 語尾違いの助言・推測', () => {
  const shouldReject = [
    '算定要件が変更されたため、体制届の再提出が必要です。',
    '経過措置は3月末で終了するため、早めの準備が望ましいです。',
    '要件を満たさない場合は減算となる可能性があります。',
    '今回の改正で加算単位数は増える見込みです。',
    '運用の見直しが推奨されます。',
    '算定漏れによる返還リスクに注意が必要です。',
    '来年度はさらに厳格化されるとみられます。',
    '実質的には全事業所が対象になるだろう。',
  ];

  for (const summary of shouldReject) {
    it(`「${summary}」を除外する`, async () => {
      const items = [makeItem('i1', U1)];
      const { ctx } = createCtx();
      const out = await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: U1, summary })], items);

      expect(out.entries).toHaveLength(0);
      expect(out.excluded[0]?.check).toBe('Q5');
    });
  }

  const shouldPass = [
    '専門的支援実施加算の算定要件が明確化されました。',
    '意見募集は9月30日までです。',
    '令和8年4月1日から適用されます。',
    'アセスメント様式が変更されました。',
  ];

  for (const summary of shouldPass) {
    it(`事実の要約「${summary}」は通す`, async () => {
      const items = [makeItem('i1', U1)];
      const { ctx } = createCtx();
      const out = await gate(ctx, [makeEntry({ itemId: 'i1', sourceUrl: U1, summary })], items);

      expect(out.excluded).toHaveLength(0);
      expect(out.entries).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Q8: 出典 URL の重複
// ---------------------------------------------------------------------------

describe('Q8: 同一出典 URL の重複', () => {
  it('同じ sourceUrl の 2 件目以降を除外し、1 件目は残す', async () => {
    const items = [makeItem('i1', U1), makeItem('i2', U2)];
    const entries = [
      makeEntry({ itemId: 'i1', sourceUrl: U1, headline: '1 件目' }),
      makeEntry({ itemId: 'i2', sourceUrl: U2, headline: '別の記事' }),
      makeEntry({ itemId: 'i1', sourceUrl: U1, headline: '2 件目(重複)' }),
    ];

    const { ctx, calls } = createCtx();
    const out = await gate(ctx, entries, items);

    expect(out.entries.map((e) => e.headline)).toEqual(['1 件目', '別の記事']);
    expect(out.excluded).toHaveLength(1);
    expect(out.excluded[0]?.check).toBe('Q8');
    expect(out.excluded[0]?.headline).toBe('2 件目(重複)');

    // 重複分の到達確認は行わない。
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 除外記録と通過時の振る舞い
// ---------------------------------------------------------------------------

describe('ExcludedEntry の中身', () => {
  it('check は Q1..Q8、reason は日本語で埋まっている', async () => {
    const items = [makeItem('i1', U1), makeItem('i2', U2), makeItem('i3', U3)];
    const entries = [
      makeEntry({ itemId: 'i1', sourceUrl: HALLUCINATED }), // Q1
      makeEntry({ itemId: 'missing', sourceUrl: U2 }), // Q3
      makeEntry({ itemId: 'i2', sourceUrl: U2, headline: '　' }), // Q4
      makeEntry({ itemId: 'i3', sourceUrl: U3, summary: '申請すべきです。' }), // Q5
      makeEntry({ itemId: 'i1', sourceUrl: U1 }), // 通過 -> Q2 で落とす
      makeEntry({ itemId: 'i1', sourceUrl: U1 }), // Q8
    ];

    const { ctx } = createCtx(() => NG_404);
    const out = await gate(ctx, entries, items);

    expect(out.entries).toHaveLength(0);
    expect(out.excluded.map((e) => e.check)).toEqual(['Q1', 'Q3', 'Q4', 'Q5', 'Q2', 'Q8']);

    for (const ex of out.excluded) {
      expect(ex.check).toMatch(/^Q[1-8]$/);
      expect(ex.reason.trim()).not.toBe('');
      expect(ex.reason).toMatch(JAPANESE_RE);
      expect(typeof ex.itemId).toBe('string');
      expect(typeof ex.sourceUrl).toBe('string');
      // 見出しが空の項目でも運用者が特定できるよう、何かしら入っていること。
      expect(ex.headline.trim()).not.toBe('');
    }
  });

  it('除外一覧は入力順に並ぶ(本文と突き合わせやすくするため)', async () => {
    const items = [makeItem('i1', U1), makeItem('i2', U2)];
    const entries = [
      makeEntry({ itemId: 'i1', sourceUrl: U1, headline: 'A' }), // Q2 で落ちる
      makeEntry({ itemId: 'i1', sourceUrl: HALLUCINATED, headline: 'B' }), // Q1
      makeEntry({ itemId: 'i2', sourceUrl: U2, headline: 'C' }), // Q2 で落ちる
    ];

    const { ctx } = createCtx(() => NG_404);
    const out = await gate(ctx, entries, items);

    expect(out.excluded.map((e) => e.headline)).toEqual(['A', 'B', 'C']);
  });
});

describe('全件通過', () => {
  it('excluded が空で、entries の順序が入力順のまま保たれる', async () => {
    const items = [makeItem('i1', U1), makeItem('i2', U2), makeItem('i3', U3)];
    const entries = [
      makeEntry({ itemId: 'i2', sourceUrl: U2, headline: '中', importance: 'medium' }),
      makeEntry({ itemId: 'i3', sourceUrl: U3, headline: '低', importance: 'low' }),
      makeEntry({ itemId: 'i1', sourceUrl: U1, headline: '高', importance: 'high' }),
    ];

    const { ctx, calls } = createCtx();
    const out = await gate(ctx, entries, items);

    expect(out.excluded).toEqual([]);
    // 重要度順に並べ替えない。並び順は AI(summarize)側の責務。
    expect(out.entries.map((e) => e.headline)).toEqual(['中', '低', '高']);
    expect(out.entries).toEqual(entries);
    expect(calls).toHaveLength(3);
  });

  it('entries が空なら空の結果を返し、HTTP も発生しない', async () => {
    const { ctx, calls } = createCtx();
    const out = await gate(ctx, [], [makeItem('i1', U1)]);

    expect(out.entries).toEqual([]);
    expect(out.excluded).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
