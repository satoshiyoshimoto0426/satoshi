/**
 * src/fetchers/egov.ts のテスト(詳細設計書 §13「フェッチャー」層)。
 *
 * 検証の軸は契約 §src/fetchers/egov.ts:
 *   - JSON 形状 / XML 形状のどちらからも候補が取れること
 *   - キー名のゆれ(law_id / lawId / LawId、law_name / LawName)を吸収すること
 *   - 想定外の形状でも例外を投げず空の candidates を返すこと
 *   - lookbackDays より古い改正は除外し、日付が取れないものは残すこと
 *   - URL は https://laws.e-gov.go.jp/law/{lawId} を組み立てること
 *
 * 外部ネットワークには一切出ない。HttpClient はこのファイル内のスタブを注入する。
 */

import { describe, expect, it } from 'vitest';

import { fetchEgov } from '../src/fetchers/egov.js';
import type { HttpClient, HttpGetOptions, HttpResponse, SourceConfig, SourceState } from '../src/types.js';
import { fixedClock } from '../src/util/clock.js';

const ENDPOINT = 'https://laws.e-gov.go.jp/api/2/law_revisions';

/** 「今日」。lookbackDays の境界がテスト内で読めるよう固定する。 */
const NOW = fixedClock('2026-04-10T03:00:00.000Z');

interface StubResponse {
  status?: number;
  text?: string;
  headers?: Record<string, string>;
}

interface StubHttp {
  http: HttpClient;
  calls: { url: string; options: HttpGetOptions | undefined }[];
}

function stubHttp(stub: StubResponse): StubHttp {
  const calls: { url: string; options: HttpGetOptions | undefined }[] = [];
  const http: HttpClient = {
    get(url: string, options?: HttpGetOptions): Promise<HttpResponse> {
      calls.push({ url, options });
      const text = stub.text ?? '';
      const response: HttpResponse = {
        status: stub.status ?? 200,
        text,
        body: new TextEncoder().encode(text),
        headers: stub.headers ?? { 'content-type': 'application/json' },
        finalUrl: url,
      };
      return Promise.resolve(response);
    },
    checkReachable(): Promise<{ ok: boolean; status: number | null; error: string | null }> {
      throw new Error('このテストでは checkReachable を呼びません');
    },
  };
  return { http, calls };
}

function egovSource(lookbackDays = 3, overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'common_egov_laws',
    name: 'e-Gov 法令検索(法令改正 API)',
    type: 'egov',
    url: null,
    channels: ['ai_reskill', 'welfare'],
    priority: 'high',
    region: null,
    enabled: true,
    html: null,
    egov: { endpoint: ENDPOINT, lookbackDays },
    note: null,
    ...overrides,
  };
}

function sourceState(overrides: Partial<SourceState> = {}): SourceState {
  return {
    sourceId: 'common_egov_laws',
    lastFetchedAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    etag: null,
    lastModified: null,
    lastError: null,
    lastNewCount: 0,
    lastCandidateCount: 0,
    consecutiveEmpty: 0,
    warnedAtFailureCount: 0,
    warnedAtEmptyCount: 0,
    ...overrides,
  };
}

/** 本文を与えて 1 回 fetchEgov する。 */
async function fetchPayload(text: string, lookbackDays = 3, contentType = 'application/json') {
  const { http } = stubHttp({ text, headers: { 'content-type': contentType } });
  return fetchEgov(egovSource(lookbackDays), http, null, NOW);
}

describe('fetchEgov: JSON 形状', () => {
  const payload = JSON.stringify({
    law_revisions: [
      {
        law_id: '324AC0000000283',
        law_name: '障害者の日常生活及び社会生活を総合的に支援するための法律',
        law_num: '平成十七年法律第百二十三号',
        amendment_date: '2026-04-09',
      },
      {
        law_id: '322AC0000000164',
        law_name: '児童福祉法',
        amendment_date: '2026-04-08',
      },
    ],
  });

  it('候補を取り出す', async () => {
    const result = await fetchPayload(payload);
    expect(result.notModified).toBe(false);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.title).toBe('障害者の日常生活及び社会生活を総合的に支援するための法律');
    expect(result.candidates[1]?.title).toBe('児童福祉法');
  });

  it('URL は https://laws.e-gov.go.jp/law/{lawId} を組み立てる', async () => {
    const result = await fetchPayload(payload);
    expect(result.candidates[0]?.url).toBe('https://laws.e-gov.go.jp/law/324AC0000000283');
    expect(result.candidates[1]?.url).toBe('https://laws.e-gov.go.jp/law/322AC0000000164');
  });

  it('改正日を JST 00:00 の ISO8601 UTC にする', async () => {
    const result = await fetchPayload(payload);
    expect(result.candidates[0]?.publishedAt).toBe('2026-04-08T15:00:00.000Z');
  });

  it('入れ子(law_info / revision_info)に分かれていても 1 件として拾う', async () => {
    const nested = JSON.stringify({
      laws: [
        {
          law_info: { law_id: '405AC0000000088', law_num: '平成五年法律第八十八号' },
          revision_info: { law_title: '行政手続法', amendment_date: '2026-04-09' },
        },
      ],
    });
    const result = await fetchPayload(nested);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.title).toBe('行政手続法');
    expect(result.candidates[0]?.url).toBe('https://laws.e-gov.go.jp/law/405AC0000000088');
  });
});

describe('fetchEgov: キー名のゆれ', () => {
  it('law_id / lawId / LawId と law_name / lawName / LawName を同じものとして扱う', async () => {
    const payload = JSON.stringify({
      results: [
        { law_id: '324AC0000000283', law_name: 'スネークケースの法令', amendment_date: '2026-04-09' },
        { lawId: '322AC0000000164', lawName: 'キャメルケースの法令', amendmentDate: '2026-04-09' },
        { LawId: '345AC0000000116', LawName: 'パスカルケースの法令', AmendmentDate: '2026-04-09' },
      ],
    });
    const result = await fetchPayload(payload);
    expect(result.candidates.map((c) => c.title)).toEqual([
      'スネークケースの法令',
      'キャメルケースの法令',
      'パスカルケースの法令',
    ]);
    expect(result.candidates.map((c) => c.url)).toEqual([
      'https://laws.e-gov.go.jp/law/324AC0000000283',
      'https://laws.e-gov.go.jp/law/322AC0000000164',
      'https://laws.e-gov.go.jp/law/345AC0000000116',
    ]);
  });

  it('law_title / LawTitle も法令名として扱う', async () => {
    const payload = JSON.stringify({
      items: [{ lawId: '415AC0000000057', lawTitle: '個人情報の保護に関する法律', updated: '2026-04-09' }],
    });
    const result = await fetchPayload(payload);
    expect(result.candidates[0]?.title).toBe('個人情報の保護に関する法律');
  });
});

describe('fetchEgov: XML 形状', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DataRoot>',
    '  <Result><Code>0</Code><Message></Message></Result>',
    '  <ApplData>',
    '    <LawNameListInfo>',
    '      <LawId>324AC0000000283</LawId>',
    '      <LawName>障害者総合支援法</LawName>',
    '      <LawNo>平成十七年法律第百二十三号</LawNo>',
    '      <PromulgationDate>2026-04-09</PromulgationDate>',
    '    </LawNameListInfo>',
    '    <LawNameListInfo>',
    '      <LawId>322AC0000000164</LawId>',
    '      <LawName>児童福祉法</LawName>',
    '      <PromulgationDate>2026-04-08</PromulgationDate>',
    '    </LawNameListInfo>',
    '  </ApplData>',
    '</DataRoot>',
  ].join('\n');

  it('XML でも候補を取り出す', async () => {
    const result = await fetchPayload(xml, 3, 'application/xml');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.title)).toEqual(['障害者総合支援法', '児童福祉法']);
    expect(result.candidates[0]?.url).toBe('https://laws.e-gov.go.jp/law/324AC0000000283');
  });

  it('XML が 1 件だけ(配列にならない)でも取りこぼさない', async () => {
    const single = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<DataRoot><ApplData><LawNameListInfo>',
      '  <LawId>405AC0000000088</LawId>',
      '  <LawName>唯一の法令</LawName>',
      '  <PromulgationDate>2026-04-09</PromulgationDate>',
      '</LawNameListInfo></ApplData></DataRoot>',
    ].join('\n');
    const result = await fetchPayload(single, 3, 'application/xml');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.title).toBe('唯一の法令');
  });
});

describe('fetchEgov: lookbackDays', () => {
  const payload = JSON.stringify({
    laws: [
      { law_id: 'NEW00000000001', law_name: '直近の改正', amendment_date: '2026-04-09' },
      { law_id: 'OLD00000000001', law_name: '古い改正', amendment_date: '2026-01-05' },
      { law_id: 'NODATE00000001', law_name: '日付が取れない改正' },
    ],
  });

  it('lookbackDays より古い改正を除外し、日付が取れないものは残す', async () => {
    const result = await fetchPayload(payload, 3);
    expect(result.candidates.map((c) => c.title)).toEqual(['直近の改正', '日付が取れない改正']);
    expect(result.candidates[1]?.publishedAt).toBeNull();
  });

  it('lookbackDays を広げれば古い改正も残る', async () => {
    const result = await fetchPayload(payload, 365);
    expect(result.candidates.map((c) => c.title)).toEqual(['直近の改正', '古い改正', '日付が取れない改正']);
  });

  it('lookbackDays の境界(ちょうど cutoff 直後)は残る', async () => {
    // 固定時刻 2026-04-10T03:00:00Z / lookbackDays=3 → cutoff は 2026-04-07T03:00:00Z。
    // 2026-04-08 の JST 00:00 = 2026-04-07T15:00:00Z なので cutoff より後。
    const boundary = JSON.stringify({
      laws: [
        { law_id: 'KEEP0000000001', law_name: '境界の内側', amendment_date: '2026-04-08' },
        { law_id: 'DROP0000000001', law_name: '境界の外側', amendment_date: '2026-04-06' },
      ],
    });
    const result = await fetchPayload(boundary, 3);
    expect(result.candidates.map((c) => c.title)).toEqual(['境界の内側']);
  });
});

describe('fetchEgov: 想定外の形状でも落ちない', () => {
  const cases: { label: string; body: string }[] = [
    { label: '空オブジェクト', body: '{}' },
    { label: '空配列', body: '[]' },
    { label: 'null', body: 'null' },
    { label: '数値だけ', body: '123' },
    { label: '文字列だけ', body: '"ただの文字列"' },
    { label: '壊れた文字列', body: '<<<これは JSON でも XML でもない' },
    { label: '途中で切れた JSON', body: '{"laws": [{"law_id": "324AC000' },
    { label: '空ボディ', body: '' },
    {
      label: '深い入れ子(法令情報なし)',
      body: JSON.stringify({
        a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: { n: '底' } } } } } } } } } } } } },
      }),
    },
    {
      label: '配列の中身が想定外',
      body: JSON.stringify({ laws: [null, 1, 'x', [], {}] }),
    },
  ];

  for (const { label, body } of cases) {
    it(`${label} でも例外を投げず空配列を返す`, async () => {
      const result = await fetchPayload(body);
      expect(result.candidates).toEqual([]);
      expect(result.notModified).toBe(false);
    });
  }
});

describe('fetchEgov: 条件付き GET', () => {
  it('endpoint に対して条件付き GET を行う', async () => {
    const { http, calls } = stubHttp({ text: '{}' });
    await fetchEgov(egovSource(), http, sourceState({ etag: '"egovetag"' }), NOW);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(calls[0]?.options?.etag).toBe('"egovetag"');
  });

  it('304 のとき notModified: true で etag が保持される', async () => {
    const { http } = stubHttp({ status: 304, text: '', headers: {} });
    const state = sourceState({ etag: '"egovetag"', lastModified: 'Wed, 01 Apr 2026 00:00:00 GMT' });
    const result = await fetchEgov(egovSource(), http, state, NOW);

    expect(result.notModified).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.etag).toBe('"egovetag"');
    expect(result.lastModified).toBe('Wed, 01 Apr 2026 00:00:00 GMT');
  });
});
