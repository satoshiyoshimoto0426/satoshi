/**
 * 設定ファイル(`config/channels.yaml` / `config/sources/*.yaml`)の読み込みと検証。
 * 詳細設計書 §4、要件定義書 FR-01 / NFR-05 に対応する。
 *
 * 設計意図:
 * - 情報源の追加は YAML 1 ブロックの追記で完了させたい(NFR-05)ので、
 *   書き間違いは「どのファイルの・何番目の・どのフィールドが・なぜ駄目か」まで日本語で示す。
 * - 1 件目のエラーで止めず全件をまとめて 1 つの ConfigError にする。
 *   YAML を 1 箇所直しては再実行…を繰り返させないため
 *   (詳細設計書 §6.1 の「1 件の失敗で全体を止めない」と同じ思想)。
 * - `${VAR}` は YAML を parse する前のテキスト置換で展開する。
 *   parse 後の値だけを置換対象にすると、`${VAR}` を含む行が YAML の構文を壊す書き方に対応できないため。
 */
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';

import { ConfigError } from '../types.js';
import type { AppConfig, ChannelConfig, SourceConfig } from '../types.js';
import { ChannelsFileSchema, SourcesFileSchema } from './schema.js';
import { loadRuntimeConfig } from './runtime.js';

/** 設定ディレクトリの既定値。CONFIG_DIR で差し替えられる。 */
export const DEFAULT_CONFIG_DIR: string = process.env.CONFIG_DIR ?? 'config';

/** チャネル定義ファイル名(詳細設計書 §3 のリポジトリ構成)。 */
const CHANNELS_FILE = 'channels.yaml';
/** ソース定義ディレクトリ名。 */
const SOURCES_DIR = 'sources';

const YAML_EXTENSION = /\.ya?ml$/i;

/** `${VAR}` 形式のプレースホルダ。環境変数名に使える文字だけを対象にする。 */
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** エラーメッセージに値を出してはいけないフィールド名(NFR-03)。 */
const SENSITIVE_KEY = /token|key|secret|authorization|webhook|password/i;

type ZodIssue = z.ZodError['issues'][number];

/**
 * zod のエラーメッセージを日本語にする。
 * グローバル設定(z.config)は他モジュールのスキーマにも影響するため、
 * 副作用を避けて parse 呼び出しごとに渡す。
 */
const PARSE_CONTEXT = {
  error: z.locales.ja().localeError,
  // 「未記入」と「型違い」を区別してメッセージを出し分けるために入力値を受け取る。
  // 受け取った値を表示してよいかは describeInput() で秘匿判定する。
  reportInput: true,
} as const;

/**
 * YAML テキスト中の `${VAR}` を環境変数へ展開する。未定義の変数は空文字にする。
 * 置換に関数を使うので、環境変数の値に `$&` などが含まれても特殊解釈されない。
 */
function expandEnvVars(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(ENV_PLACEHOLDER, (_match, name: string) => env[name] ?? '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 文字位置から行・列(1 始まり)を求める。YAML 構文エラーの場所を示すために使う。 */
function lineColOf(text: string, offset: number): { line: number; col: number } {
  const head = text.slice(0, Math.max(0, offset));
  const lines = head.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  return { line: lines.length, col: lastLine.length + 1 };
}

/**
 * YAML を 1 ファイル読んで素の JS 値に変換する。
 * 失敗したら problems に日本語メッセージを積んで undefined を返す(他ファイルの検証は続行する)。
 */
function readYamlFile(file: string, env: NodeJS.ProcessEnv, problems: string[]): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    problems.push(`${file}: ファイルを読み込めませんでした: ${messageOf(error)}`);
    return undefined;
  }

  const expanded = expandEnvVars(text, env);
  try {
    // prettyErrors を無効にするのは、エラーメッセージに展開後の本文断片が混ざるのを避けるため。
    // `${VAR}` の展開結果に秘密情報が入り得るので、位置は自前で計算して示す(NFR-03)。
    return parseYaml(expanded, { prettyErrors: false });
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const pos = lineColOf(expanded, error.pos[0]);
      problems.push(
        `${file}: YAML の構文エラー(${pos.line} 行 ${pos.col} 列 / ${error.code}): ${error.message}`,
      );
    } else {
      problems.push(`${file}: YAML を解析できませんでした: ${messageOf(error)}`);
    }
    return undefined;
  }
}

/** `sources[2].html.itemSelector` のような、YAML を見て辿れるパス文字列にする。 */
function formatPath(issuePath: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of issuePath) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      const name = String(segment);
      out += out === '' ? name : `.${name}`;
    }
  }
  return out === '' ? 'ファイル全体' : out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * エラー箇所の配列要素が持つ id を拾う。
 * 「sources[7]」だけだと YAML のどのブロックか数えないと分からないため、id を添えて探しやすくする。
 */
function ownerLabel(raw: unknown, issuePath: readonly PropertyKey[]): string {
  const rootKey = issuePath[0];
  const index = issuePath[1];
  if (typeof rootKey !== 'string' || typeof index !== 'number') return '';
  if (!isRecord(raw)) return '';
  const list = raw[rootKey];
  if (!Array.isArray(list)) return '';
  const entry: unknown = list[index];
  if (!isRecord(entry)) return '';
  const id = entry['id'];
  return typeof id === 'string' && id !== '' ? `(id: ${id})` : '';
}

/**
 * 実際に書かれていた値を短く示す。
 * 秘密情報になり得るフィールドと、長い値・オブジェクトは出さない(NFR-03)。
 */
function describeInput(issue: ZodIssue): string {
  const last = issue.path[issue.path.length - 1];
  if (typeof last === 'string' && SENSITIVE_KEY.test(last)) return '';
  const input: unknown = issue.input;
  if (input === null) return '(実際の値: null)';
  if (typeof input === 'string') {
    return input.length <= 40 ? `(実際の値: '${input}')` : '';
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return `(実際の値: ${String(input)})`;
  }
  return '';
}

/** zod が期待した型を日本語にする。運用者は zod の用語を知らないため。 */
const EXPECTED_TYPE_LABEL: Record<string, string> = {
  string: '文字列',
  number: '数値',
  int: '整数',
  boolean: '真偽値(true / false)',
  array: '配列',
  object: 'マッピング(key: value の並び)',
  null: 'null',
};

/** 実際に書かれていた値の型を日本語にする。 */
function actualTypeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '未記入';
  if (Array.isArray(value)) return '配列';
  switch (typeof value) {
    case 'string':
      return '文字列';
    case 'number':
      return '数値';
    case 'boolean':
      return '真偽値';
    case 'object':
      return 'マッピング';
    default:
      return typeof value;
  }
}

function issueMessage(issue: ZodIssue): string {
  // 必須項目の未記入は「型が違う」より「書き忘れ」として伝えたほうが直しやすい。
  if (issue.code === 'invalid_type' && issue.input === undefined) {
    return '必須項目がありません';
  }
  if (issue.code === 'invalid_type') {
    const expected = EXPECTED_TYPE_LABEL[issue.expected] ?? issue.expected;
    const actual = actualTypeLabel(issue.input);
    // ルート自体の型違いは「ファイルが空」「トップレベルのキーを書き忘れた」が典型。
    if (issue.path.length === 0) {
      return `トップレベルは${expected}である必要があります(実際: ${actual})。ファイルが空、または全体がコメントアウトされていませんか。`;
    }
    return `${expected}で指定してください(実際: ${actual})`;
  }
  if (issue.code === 'unrecognized_keys') {
    return `未知のフィールドです: ${issue.keys.join(' / ')}(綴り間違い、またはスキーマに無い項目です)`;
  }
  if (issue.code === 'invalid_value' || issue.code === 'invalid_format') {
    const received = describeInput(issue);
    return received === '' ? issue.message : `${issue.message} ${received}`;
  }
  return issue.message;
}

function describeIssue(file: string, raw: unknown, issue: ZodIssue): string {
  return `${file}: ${formatPath(issue.path)}${ownerLabel(raw, issue.path)}: ${issueMessage(issue)}`;
}

function readChannels(configDir: string, env: NodeJS.ProcessEnv, problems: string[]): ChannelConfig[] {
  const file = path.join(configDir, CHANNELS_FILE);
  if (!fs.existsSync(file)) {
    problems.push(`チャネル定義ファイルが見つかりません: ${file}(詳細設計書 §4.1 の形式で作成してください)`);
    return [];
  }

  const raw = readYamlFile(file, env, problems);
  if (raw === undefined) return [];

  const parsed = ChannelsFileSchema.safeParse(raw, PARSE_CONTEXT);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(describeIssue(file, raw, issue));
    return [];
  }
  return parsed.data.channels;
}

function readSources(configDir: string, env: NodeJS.ProcessEnv, problems: string[]): SourceConfig[] {
  const dir = path.join(configDir, SOURCES_DIR);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    problems.push(
      `ソース定義ディレクトリが見つかりません: ${dir}` +
        `(このディレクトリを作成し、詳細設計書 §4.2 の形式で .yaml を配置してください)`,
    );
    return [];
  }

  // 読み込み順を OS のディレクトリ順に委ねると、重複 id の検出順などが環境で変わる。名前順に固定する。
  const files = entries
    .filter((entry) => entry.isFile() && YAML_EXTENSION.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    problems.push(`${dir} に YAML ファイルが 1 つもありません(監視対象ソースを 1 件以上定義してください)`);
    return [];
  }

  const sources: SourceConfig[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const raw = readYamlFile(file, env, problems);
    // 1 ファイルの失敗で他のファイルの検証を打ち切らない。まとめて報告するため。
    if (raw === undefined) continue;

    const parsed = SourcesFileSchema.safeParse(raw, PARSE_CONTEXT);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(describeIssue(file, raw, issue));
      continue;
    }
    sources.push(...parsed.data.sources);
  }
  return sources;
}

/**
 * 設定一式を読み込む。
 * 検証に失敗した場合は、見つかった問題を全件まとめた ConfigError を投げる。
 */
export function loadConfig(configDir: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  // 環境変数は設定ファイル以前の前提なので先に確定させる(不正ならここで ConfigError)。
  const runtime = loadRuntimeConfig(env);

  const problems: string[] = [];
  const channels = readChannels(configDir, env, problems);
  const sources = readSources(configDir, env, problems);

  if (problems.length > 0) {
    throw new ConfigError(
      `設定の検証に失敗しました(${problems.length} 件) [設定ディレクトリ: ${configDir}]\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }

  return { channels, sources, runtime };
}

/** 値の出現回数を出現順に数える。 */
function countById(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/**
 * ファイルをまたぐ整合性を検証し、問題の日本語メッセージを返す(空配列なら問題なし)。
 * ここでは例外を投げない。`validate-config` が全件を一覧表示できるようにするため。
 */
export function validateCrossReferences(channels: ChannelConfig[], sources: SourceConfig[]): string[] {
  const messages: string[] = [];

  // 1. ソース id の重複。id は source_state のキーになるので、重複すると巡回状態が混ざる。
  for (const [id, count] of countById(sources.map((source) => source.id))) {
    if (count > 1) {
      messages.push(
        `ソース id '${id}' が ${count} 件重複しています。config/${SOURCES_DIR}/*.yaml 全体で一意にしてください。`,
      );
    }
  }

  // 2. チャネル id の重複。digest / delivery の冪等キーになるため重複は致命的(FR-12)。
  for (const [id, count] of countById(channels.map((channel) => channel.id))) {
    if (count > 1) {
      messages.push(
        `チャネル id '${id}' が ${count} 件重複しています。${CHANNELS_FILE} 内で一意にしてください。`,
      );
    }
  }

  // 3. 未定義チャネルを参照するソース。綴り間違いだと「集めているのに配信されない」になる。
  const knownChannelIds = new Set(channels.map((channel) => channel.id));
  const reported = new Set<string>();
  for (const source of sources) {
    for (const channelId of source.channels) {
      if (knownChannelIds.has(channelId)) continue;
      const key = `${source.id} -> ${channelId}`;
      if (reported.has(key)) continue;
      reported.add(key);
      messages.push(
        `ソース '${source.id}' が未定義のチャネル '${channelId}' を参照しています。` +
          `${CHANNELS_FILE} に定義するか、参照名を修正してください。`,
      );
    }
  }

  // 4. どのソースからも参照されないチャネル。毎朝「新着なし」しか配信されない状態になる(FR-11)。
  const referencedChannelIds = new Set(sources.flatMap((source) => source.channels));
  for (const channel of channels) {
    if (referencedChannelIds.has(channel.id)) continue;
    messages.push(
      `チャネル '${channel.id}' はどのソースからも参照されていません。` +
        `config/${SOURCES_DIR}/*.yaml のいずれかで channels に '${channel.id}' を追加してください。`,
    );
  }

  return messages;
}
