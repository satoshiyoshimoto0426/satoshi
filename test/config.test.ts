/**
 * src/config/*.ts の単体テスト(詳細設計書 §13「ユニット: YAML スキーマ」)。
 *
 * 設定の書き間違いは「巡回しているのに永久に 0 件」「配信されない」といった
 * 最も気づきにくい故障になる(詳細設計書 §4)。したがって
 *  - 未知フィールドは必ずエラー
 *  - 必須欠落は「どのファイルの・どのフィールドか」が分かるメッセージ
 *  - 1 件目で止めず全件まとめて報告
 * を契約として検証する。
 *
 * テスト用 YAML は mkdtemp で作った一時ディレクトリに書き出す。
 * リポジトリの config/ は読み取り専用として扱い、末尾で本番設定の回帰テストに使う。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { ChannelConfig, SourceConfig } from '../src/types.js';
import { ConfigError } from '../src/types.js';
import { DEFAULT_CONFIG_DIR, loadConfig, validateCrossReferences } from '../src/config/load.js';

/** リポジトリ同梱の本番設定ディレクトリ(読み取り専用)。 */
const REPO_CONFIG_DIR = fileURLToPath(new URL('../config', import.meta.url));

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** channels.yaml と sources/*.yaml を持つ一時設定ディレクトリを作る。 */
function writeConfigDir(channelsYaml: string | null, sourceFiles: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seido-config-'));
  createdDirs.push(dir);
  if (channelsYaml !== null) {
    fs.writeFileSync(path.join(dir, 'channels.yaml'), channelsYaml, 'utf8');
  }
  const sourcesDir = path.join(dir, 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  for (const [name, body] of Object.entries(sourceFiles)) {
    fs.writeFileSync(path.join(sourcesDir, name), body, 'utf8');
  }
  return dir;
}

/** ConfigError になることを確かめ、メッセージを返す。 */
function loadAndExpectError(dir: string, env: NodeJS.ProcessEnv = {}): string {
  let caught: unknown;
  try {
    loadConfig(dir, env);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as Error).message;
}

const VALID_CHANNELS = `channels:
  - id: welfare
    name: 就労支援、放課後デイ情報局
    topics: 障害福祉サービス等報酬改定、就労移行支援
`;

const VALID_SOURCES = `sources:
  - id: mhlw_news_rss
    name: 厚生労働省 新着情報
    type: rss
    url: https://www.mhlw.go.jp/stf/news.rdf
    channels: [welfare]
`;

// ---------------------------------------------------------------------------
// 正常系
// ---------------------------------------------------------------------------

describe('loadConfig: 正常な YAML', () => {
  it('チャネルとソースを読み込める', () => {
    const dir = writeConfigDir(VALID_CHANNELS, { 'a.yaml': VALID_SOURCES });
    const config = loadConfig(dir, {});

    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]?.id).toBe('welfare');
    expect(config.channels[0]?.name).toBe('就労支援、放課後デイ情報局');
    expect(config.channels[0]?.topics).toContain('障害福祉サービス等報酬改定');

    expect(config.sources).toHaveLength(1);
    expect(config.sources[0]?.id).toBe('mhlw_news_rss');
    expect(config.sources[0]?.type).toBe('rss');
    expect(config.sources[0]?.url).toBe('https://www.mhlw.go.jp/stf/news.rdf');
    expect(config.sources[0]?.channels).toEqual(['welfare']);
  });

  it('sources ディレクトリ内の複数ファイルをファイル名順に読み込む', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'b.yaml': `sources:
  - id: second
    name: 2 番目
    type: rss
    url: https://example.jp/2.rdf
    channels: [welfare]
`,
      'a.yml': `sources:
  - id: first
    name: 1 番目
    type: rss
    url: https://example.jp/1.rdf
    channels: [welfare]
`,
    });

    const config = loadConfig(dir, {});
    expect(config.sources.map((source) => source.id)).toEqual(['first', 'second']);
  });

  it('runtime(環境変数由来の設定)も一緒に返る', () => {
    const dir = writeConfigDir(VALID_CHANNELS, { 'a.yaml': VALID_SOURCES });
    const config = loadConfig(dir, { HOST_DELAY_MS: '3000', DRY_RUN: 'true' });

    expect(config.runtime.hostDelayMs).toBe(3000);
    expect(config.runtime.dryRun).toBe(true);
    expect(config.runtime.userAgent).toBe('SeidoWatchBot/1.0 (+mailto:ops@example.com)');
  });
});

// ---------------------------------------------------------------------------
// 既定値(モジュール契約 §src/config/schema.ts)
// ---------------------------------------------------------------------------

describe('既定値', () => {
  it('チャネルの既定値が契約どおり入る', () => {
    const dir = writeConfigDir(VALID_CHANNELS, { 'a.yaml': VALID_SOURCES });
    const channel = loadConfig(dir, {}).channels[0];

    expect(channel).toBeDefined();
    expect(channel?.lineTokenSecret).toBeNull();
    expect(channel?.relevanceThreshold).toBe(0.6);
    expect(channel?.maxItems).toBe(7);
    expect(channel?.minItems).toBe(3);
    expect(channel?.maxChars).toBe(1500);
    expect(channel?.deliverAt).toBe('07:30');
    expect(channel?.requireApproval).toBe(false);
  });

  it('sendWhenEmpty の既定は true(FR-11: 0 件の日も「新着なし」を配信する)', () => {
    const dir = writeConfigDir(VALID_CHANNELS, { 'a.yaml': VALID_SOURCES });
    expect(loadConfig(dir, {}).channels[0]?.sendWhenEmpty).toBe(true);
  });

  it('sendWhenEmpty は明示指定で false にできる', () => {
    const dir = writeConfigDir(
      `channels:
  - id: welfare
    name: 福祉
    topics: 話題
    sendWhenEmpty: false
`,
      { 'a.yaml': VALID_SOURCES },
    );
    expect(loadConfig(dir, {}).channels[0]?.sendWhenEmpty).toBe(false);
  });

  it('ソースの既定値が契約どおり入る', () => {
    const dir = writeConfigDir(VALID_CHANNELS, { 'a.yaml': VALID_SOURCES });
    const source = loadConfig(dir, {}).sources[0];

    expect(source?.priority).toBe('medium');
    expect(source?.region).toBeNull();
    expect(source?.enabled).toBe(true);
    expect(source?.html).toBeNull();
    expect(source?.egov).toBeNull();
    expect(source?.note).toBeNull();
  });

  it('html ブロックの既定値が契約どおり入る', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'a.yaml': `sources:
  - id: mhlw_page
    name: 厚労省 新着一覧
    type: html
    url: https://www.mhlw.go.jp/stf/newpage.html
    channels: [welfare]
    html:
      itemSelector: "ul.m-listLink li a"
`,
    });

    const html = loadConfig(dir, {}).sources[0]?.html;
    expect(html).toBeDefined();
    expect(html?.titleFrom).toBe('text');
    expect(html?.hrefFrom).toBe('href');
    expect(html?.dateSelector).toBeNull();
    expect(html?.includeUrlPatterns).toEqual([]);
    expect(html?.excludeUrlPatterns).toEqual([]);
  });

  it('明示した値は既定値を上書きする', () => {
    const dir = writeConfigDir(
      `channels:
  - id: welfare
    name: 福祉
    topics: 話題
    relevanceThreshold: 0.8
    maxItems: 5
    minItems: 1
    maxChars: 900
    deliverAt: "06:15"
    requireApproval: true
    lineTokenSecret: projects/p/secrets/s/versions/latest
`,
      {
        'a.yaml': `sources:
  - id: mu_osaka
    name: 大阪府 障がい福祉室
    type: html
    url: https://www.pref.osaka.lg.jp/example
    channels: [welfare]
    priority: high
    region: 大阪府
    enabled: false
    note: 自治体ソース
    html:
      itemSelector: "div.news li a"
      titleFrom: title
      hrefFrom: data-href
      dateSelector: "span.date"
      includeUrlPatterns: ["/shogai/"]
      excludeUrlPatterns: ["#", ".css"]
`,
      },
    );

    const config = loadConfig(dir, {});
    const channel = config.channels[0];
    expect(channel?.relevanceThreshold).toBe(0.8);
    expect(channel?.maxItems).toBe(5);
    expect(channel?.minItems).toBe(1);
    expect(channel?.maxChars).toBe(900);
    expect(channel?.deliverAt).toBe('06:15');
    expect(channel?.requireApproval).toBe(true);
    expect(channel?.lineTokenSecret).toBe('projects/p/secrets/s/versions/latest');

    const source = config.sources[0];
    expect(source?.priority).toBe('high');
    expect(source?.region).toBe('大阪府');
    expect(source?.enabled).toBe(false);
    expect(source?.note).toBe('自治体ソース');
    expect(source?.html?.titleFrom).toBe('title');
    expect(source?.html?.hrefFrom).toBe('data-href');
    expect(source?.html?.dateSelector).toBe('span.date');
    expect(source?.html?.includeUrlPatterns).toEqual(['/shogai/']);
    expect(source?.html?.excludeUrlPatterns).toEqual(['#', '.css']);
  });
});

// ---------------------------------------------------------------------------
// strict(未知フィールド)
// ---------------------------------------------------------------------------

describe('スキーマの strict: 未知フィールドはエラー', () => {
  it('チャネルの未知フィールドでエラーになり、キー名がメッセージに出る', () => {
    const dir = writeConfigDir(
      `channels:
  - id: welfare
    name: 福祉
    topics: 話題
    sendWhenEmpy: true
`,
      { 'a.yaml': VALID_SOURCES },
    );

    const message = loadAndExpectError(dir);
    expect(message).toContain('sendWhenEmpy');
    expect(message).toContain('channels.yaml');
  });

  it('ソースの未知フィールドでエラーになる', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'a.yaml': `sources:
  - id: mhlw_news_rss
    name: 厚労省
    type: rss
    url: https://www.mhlw.go.jp/stf/news.rdf
    channels: [welfare]
    interval: 3600
`,
    });

    const message = loadAndExpectError(dir);
    expect(message).toContain('interval');
    expect(message).toContain('a.yaml');
  });

  it('html ブロック内の綴り間違い(itemSelecter)もエラーになる', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'a.yaml': `sources:
  - id: mhlw_page
    name: 厚労省
    type: html
    url: https://www.mhlw.go.jp/stf/newpage.html
    channels: [welfare]
    html:
      itemSelector: "li a"
      itemSelecter: "li a"
`,
    });

    const message = loadAndExpectError(dir);
    expect(message).toContain('itemSelecter');
  });

  it('トップレベルの未知フィールドもエラーになる', () => {
    const dir = writeConfigDir(`${VALID_CHANNELS}defaults:\n  maxItems: 7\n`, { 'a.yaml': VALID_SOURCES });

    const message = loadAndExpectError(dir);
    expect(message).toContain('defaults');
  });
});

// ---------------------------------------------------------------------------
// 必須欠落とメッセージ品質
// ---------------------------------------------------------------------------

describe('必須フィールドの欠落', () => {
  it('チャネルの必須欠落はフィールド名とファイル名を含むメッセージになる', () => {
    const dir = writeConfigDir(
      `channels:
  - id: welfare
    name: 福祉
`,
      { 'a.yaml': VALID_SOURCES },
    );

    const message = loadAndExpectError(dir);
    expect(message).toContain('topics');
    expect(message).toContain('channels.yaml');
    expect(message).toContain('必須');
  });

  it('ソースの必須欠落もフィールド名とファイル名を含む', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'municipal.yaml': `sources:
  - id: mu_osaka
    type: rss
    url: https://example.jp/a.rdf
    channels: [welfare]
`,
    });

    const message = loadAndExpectError(dir);
    expect(message).toContain('name');
    expect(message).toContain('municipal.yaml');
  });

  it('channels.yaml が無ければエラーになる', () => {
    const dir = writeConfigDir(null, { 'a.yaml': VALID_SOURCES });
    expect(loadAndExpectError(dir)).toContain('channels.yaml');
  });

  it('sources ディレクトリに YAML が 1 つも無ければエラーになる', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {});
    expect(loadAndExpectError(dir)).toContain('sources');
  });

  it('channels が空配列ならエラーになる', () => {
    const dir = writeConfigDir('channels: []\n', { 'a.yaml': VALID_SOURCES });
    expect(loadAndExpectError(dir)).toContain('channels');
  });

  it('YAML の構文エラーはファイル名付きで報告される', () => {
    const dir = writeConfigDir(VALID_CHANNELS, { 'broken.yaml': 'sources:\n  - id: a\n   name: ずれた\n' });
    const message = loadAndExpectError(dir);
    expect(message).toContain('broken.yaml');
  });
});

describe('複数のエラーは 1 件目で止まらず全件まとめて報告される', () => {
  it('チャネル 2 件・ソース 2 件の誤りが 1 つの ConfigError にまとまる', () => {
    const dir = writeConfigDir(
      `channels:
  - id: welfare
    name: 福祉
    topics: 話題
    unknownField: true
  - id: BAD_ID
    name: 二番目
    topics: 話題
`,
      {
        'a.yaml': `sources:
  - id: s_one
    name: URL 欠落
    type: rss
    channels: [welfare]
  - id: s_two
    name: html 欠落
    type: html
    url: https://example.jp/
    channels: [welfare]
`,
      },
    );

    const message = loadAndExpectError(dir);

    expect(message).toContain('(4 件)');
    expect(message).toContain('unknownField');
    expect(message).toContain('BAD_ID');
    expect(message).toContain("type='rss' のソースには url が必須です");
    expect(message).toContain("type='html' のソースには html");
  });

  it('複数のソースファイルをまたいだエラーもまとめて報告される', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'a.yaml': `sources:
  - id: s_a
    name: A
    type: rss
    channels: [welfare]
`,
      'b.yaml': `sources:
  - id: s_b
    name: B
    type: egov
    channels: [welfare]
`,
    });

    const message = loadAndExpectError(dir);
    expect(message).toContain('(2 件)');
    expect(message).toContain('a.yaml');
    expect(message).toContain('b.yaml');
  });
});

// ---------------------------------------------------------------------------
// 環境変数展開
// ---------------------------------------------------------------------------

describe('${VAR} の環境変数展開', () => {
  it('定義されていれば値に展開される', () => {
    const dir = writeConfigDir(
      `channels:
  - id: welfare
    name: 福祉
    topics: 話題
    lineTokenSecret: 'projects/\${TEST_PROJECT}/secrets/line-token-welfare/versions/latest'
`,
      { 'a.yaml': VALID_SOURCES },
    );

    const config = loadConfig(dir, { TEST_PROJECT: 'seido-watch-prod' });
    expect(config.channels[0]?.lineTokenSecret).toBe(
      'projects/seido-watch-prod/secrets/line-token-welfare/versions/latest',
    );
  });

  it('未定義なら空文字に展開される', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'a.yaml': `sources:
  - id: mhlw_news_rss
    name: 厚労省
    type: rss
    url: https://www.mhlw.go.jp/stf/news.rdf
    channels: [welfare]
    note: 'メモ[\${UNDEFINED_VARIABLE_FOR_TEST}]'
`,
    });

    const config = loadConfig(dir, {});
    expect(config.sources[0]?.note).toBe('メモ[]');
  });

  it('複数の ${VAR} を 1 行で展開できる', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'a.yaml': `sources:
  - id: mhlw_news_rss
    name: 厚労省
    type: rss
    url: 'https://\${HOST_VAR}/\${PATH_VAR}'
    channels: [welfare]
`,
    });

    const config = loadConfig(dir, { HOST_VAR: 'www.mhlw.go.jp', PATH_VAR: 'stf/news.rdf' });
    expect(config.sources[0]?.url).toBe('https://www.mhlw.go.jp/stf/news.rdf');
  });
});

// ---------------------------------------------------------------------------
// type ごとの必須条件
// ---------------------------------------------------------------------------

describe('type ごとの必須条件', () => {
  function sourcesYaml(body: string): Record<string, string> {
    return { 'a.yaml': `sources:\n${body}` };
  }

  it("type='html' は html と url の両方が必須", () => {
    const noHtml = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_html
    name: HTML
    type: html
    url: https://example.jp/
    channels: [welfare]
`),
    );
    expect(loadAndExpectError(noHtml)).toContain("type='html' のソースには html");

    const noUrl = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_html
    name: HTML
    type: html
    channels: [welfare]
    html:
      itemSelector: "li a"
`),
    );
    expect(loadAndExpectError(noUrl)).toContain("type='html' のソースには url が必須です");
  });

  it("type='html' で html と url が揃っていれば通る", () => {
    const dir = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_html
    name: HTML
    type: html
    url: https://example.jp/
    channels: [welfare]
    html:
      itemSelector: "li a"
`),
    );
    expect(loadConfig(dir, {}).sources[0]?.html?.itemSelector).toBe('li a');
  });

  it("type='rss' は url が必須", () => {
    const dir = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_rss
    name: RSS
    type: rss
    channels: [welfare]
`),
    );
    expect(loadAndExpectError(dir)).toContain("type='rss' のソースには url が必須です");
  });

  it("type='egov' は egov が必須(url は不要)", () => {
    const missing = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_egov
    name: e-Gov
    type: egov
    channels: [welfare]
`),
    );
    expect(loadAndExpectError(missing)).toContain("type='egov' のソースには egov");

    const ok = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_egov
    name: e-Gov
    type: egov
    channels: [welfare]
    egov:
      endpoint: https://laws.e-gov.go.jp/api/2/law_revisions
      lookbackDays: 3
`),
    );
    const source = loadConfig(ok, {}).sources[0];
    expect(source?.url).toBeNull();
    expect(source?.egov?.endpoint).toBe('https://laws.e-gov.go.jp/api/2/law_revisions');
    expect(source?.egov?.lookbackDays).toBe(3);
  });

  it('type と一致しない設定ブロックが残っているとエラーになる(黙って無視しない)', () => {
    const dir = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_rss
    name: RSS
    type: rss
    url: https://example.jp/a.rdf
    channels: [welfare]
    html:
      itemSelector: "li a"
`),
    );
    expect(loadAndExpectError(dir)).toContain("html は type='html'");
  });

  it('未知の type はエラーになる', () => {
    const dir = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_x
    name: X
    type: atom
    url: https://example.jp/a
    channels: [welfare]
`),
    );
    expect(loadAndExpectError(dir)).toContain('type');
  });

  it('channels が空配列のソースはエラーになる', () => {
    const dir = writeConfigDir(
      VALID_CHANNELS,
      sourcesYaml(`  - id: s_rss
    name: RSS
    type: rss
    url: https://example.jp/a.rdf
    channels: []
`),
    );
    expect(loadAndExpectError(dir)).toContain('channels');
  });
});

// ---------------------------------------------------------------------------
// 値の範囲・形式
// ---------------------------------------------------------------------------

describe('値の範囲・形式', () => {
  function channelsYaml(extra: string): string {
    return `channels:
  - id: welfare
    name: 福祉
    topics: 話題
${extra}`;
  }

  it('minItems <= maxItems であること', () => {
    const bad = writeConfigDir(channelsYaml('    minItems: 9\n    maxItems: 3\n'), {
      'a.yaml': VALID_SOURCES,
    });
    const message = loadAndExpectError(bad);
    expect(message).toContain('minItems');
    expect(message).toContain('maxItems');

    const ok = writeConfigDir(channelsYaml('    minItems: 3\n    maxItems: 3\n'), {
      'a.yaml': VALID_SOURCES,
    });
    expect(loadConfig(ok, {}).channels[0]?.minItems).toBe(3);
  });

  it('relevanceThreshold は 0..1 の範囲', () => {
    for (const value of ['-0.1', '1.1', '2']) {
      const dir = writeConfigDir(channelsYaml(`    relevanceThreshold: ${value}\n`), {
        'a.yaml': VALID_SOURCES,
      });
      expect(loadAndExpectError(dir)).toContain('relevanceThreshold');
    }

    for (const value of ['0', '0.5', '1']) {
      const dir = writeConfigDir(channelsYaml(`    relevanceThreshold: ${value}\n`), {
        'a.yaml': VALID_SOURCES,
      });
      expect(loadConfig(dir, {}).channels[0]?.relevanceThreshold).toBe(Number(value));
    }
  });

  it('id は ^[a-z0-9_]+$ に一致すること', () => {
    for (const badId of ['Welfare', 'wel-fare', 'wel fare', 'welfare!', '福祉', '']) {
      const dir = writeConfigDir(
        `channels:
  - id: "${badId}"
    name: 福祉
    topics: 話題
`,
        { 'a.yaml': VALID_SOURCES },
      );
      expect(loadAndExpectError(dir)).toContain('id');
    }

    const ok = writeConfigDir(
      `channels:
  - id: welfare_2026
    name: 福祉
    topics: 話題
`,
      {
        'a.yaml': `sources:
  - id: mhlw_news_rss
    name: 厚労省
    type: rss
    url: https://www.mhlw.go.jp/stf/news.rdf
    channels: [welfare_2026]
`,
      },
    );
    expect(loadConfig(ok, {}).channels[0]?.id).toBe('welfare_2026');
  });

  it('ソース id も ^[a-z0-9_]+$ に一致すること', () => {
    const dir = writeConfigDir(VALID_CHANNELS, {
      'a.yaml': `sources:
  - id: MHLW-News
    name: 厚労省
    type: rss
    url: https://www.mhlw.go.jp/stf/news.rdf
    channels: [welfare]
`,
    });
    expect(loadAndExpectError(dir)).toContain('id');
  });

  it('deliverAt は "HH:MM" 形式であること', () => {
    const dir = writeConfigDir(channelsYaml('    deliverAt: "7:30"\n'), { 'a.yaml': VALID_SOURCES });
    expect(loadAndExpectError(dir)).toContain('deliverAt');
  });

  it('maxChars は LINE の上限 5000 を超えられない', () => {
    const dir = writeConfigDir(channelsYaml('    maxChars: 6000\n'), { 'a.yaml': VALID_SOURCES });
    expect(loadAndExpectError(dir)).toContain('maxChars');
  });

  it('型違い(数値であるべき所に文字列)はエラーになる', () => {
    const dir = writeConfigDir(channelsYaml('    maxItems: "たくさん"\n'), { 'a.yaml': VALID_SOURCES });
    expect(loadAndExpectError(dir)).toContain('maxItems');
  });
});

// ---------------------------------------------------------------------------
// validateCrossReferences
// ---------------------------------------------------------------------------

function channelOf(id: string): ChannelConfig {
  return {
    id,
    name: `${id} チャネル`,
    lineTokenSecret: null,
    topics: '話題',
    relevanceThreshold: 0.6,
    maxItems: 7,
    minItems: 3,
    maxChars: 1500,
    sendWhenEmpty: true,
    deliverAt: '07:30',
    requireApproval: false,
  };
}

function sourceOf(id: string, channels: string[]): SourceConfig {
  return {
    id,
    name: `${id} ソース`,
    type: 'rss',
    url: `https://example.jp/${id}.rdf`,
    channels,
    priority: 'medium',
    region: null,
    enabled: true,
    html: null,
    egov: null,
    note: null,
  };
}

describe('validateCrossReferences', () => {
  it('整合していれば空配列を返す', () => {
    const channels = [channelOf('welfare'), channelOf('ai_reskill')];
    const sources = [sourceOf('s1', ['welfare']), sourceOf('s2', ['ai_reskill', 'welfare'])];
    expect(validateCrossReferences(channels, sources)).toEqual([]);
  });

  it('ソース id の重複を検出する', () => {
    const messages = validateCrossReferences(
      [channelOf('welfare')],
      [sourceOf('dup', ['welfare']), sourceOf('dup', ['welfare'])],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('dup');
    expect(messages[0]).toContain('重複');
  });

  it('チャネル id の重複を検出する', () => {
    const messages = validateCrossReferences(
      [channelOf('welfare'), channelOf('welfare')],
      [sourceOf('s1', ['welfare'])],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('welfare');
    expect(messages[0]).toContain('重複');
  });

  it('未定義チャネルを参照するソースを検出する', () => {
    const messages = validateCrossReferences(
      [channelOf('welfare')],
      [sourceOf('s1', ['welfare', 'typo_channel'])],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('s1');
    expect(messages[0]).toContain('typo_channel');
  });

  it('どのソースからも参照されないチャネルを検出する', () => {
    const messages = validateCrossReferences(
      [channelOf('welfare'), channelOf('orphan')],
      [sourceOf('s1', ['welfare'])],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('orphan');
  });

  it('4 種類の不整合を同時に検出する', () => {
    const channels = [channelOf('welfare'), channelOf('welfare'), channelOf('orphan')];
    const sources = [
      sourceOf('dup', ['welfare']),
      sourceOf('dup', ['welfare']),
      sourceOf('s3', ['missing_channel']),
    ];

    const messages = validateCrossReferences(channels, sources);
    const joined = messages.join('\n');

    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(joined).toContain("ソース id 'dup'");
    expect(joined).toContain("チャネル id 'welfare'");
    expect(joined).toContain('missing_channel');
    expect(joined).toContain('orphan');
  });

  it('チャネルもソースも空なら空配列(検出対象が無い)', () => {
    expect(validateCrossReferences([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 本番設定の回帰テスト
// ---------------------------------------------------------------------------

describe('本番設定(リポジトリの config/)', () => {
  it('読み込めて、チャネルとソースが 1 件以上ある', () => {
    const config = loadConfig(REPO_CONFIG_DIR, { GCP_PROJECT_ID: 'test-project' });

    expect(config.channels.length).toBeGreaterThan(0);
    expect(config.sources.length).toBeGreaterThan(0);
  });

  it('validateCrossReferences が 0 件である', () => {
    const config = loadConfig(REPO_CONFIG_DIR, { GCP_PROJECT_ID: 'test-project' });
    expect(validateCrossReferences(config.channels, config.sources)).toEqual([]);
  });

  it('全ソースの id が一意で、type ごとの必須設定が揃っている', () => {
    const config = loadConfig(REPO_CONFIG_DIR, { GCP_PROJECT_ID: 'test-project' });

    expect(new Set(config.sources.map((source) => source.id)).size).toBe(config.sources.length);
    for (const source of config.sources) {
      if (source.type === 'html') {
        expect(source.html, source.id).not.toBeNull();
        expect(source.url, source.id).not.toBeNull();
      }
      if (source.type === 'rss') expect(source.url, source.id).not.toBeNull();
      if (source.type === 'egov') expect(source.egov, source.id).not.toBeNull();
    }
  });

  it('全チャネルの sendWhenEmpty が true(FR-11 の運用決定)', () => {
    const config = loadConfig(REPO_CONFIG_DIR, { GCP_PROJECT_ID: 'test-project' });
    for (const channel of config.channels) {
      expect(channel.sendWhenEmpty, channel.id).toBe(true);
    }
  });
});

describe('DEFAULT_CONFIG_DIR', () => {
  it("CONFIG_DIR 環境変数、無ければ 'config'", () => {
    expect(DEFAULT_CONFIG_DIR).toBe(process.env.CONFIG_DIR ?? 'config');
  });
});
