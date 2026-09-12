/**
 * 実行コンテキストの組み立て(依存性注入の一点集中)。
 *
 * CLI もパイプラインも「どの実装を使うか」を知らずに済むよう、Store / HttpClient /
 * AiClient / LineClient / Notifier の生成はここだけで行う。テストや結合テストからは
 * overrides で個別に差し替える(ネットワークにも Firestore にも触らせない)。
 *
 * 秘密情報の扱い(詳細設計書 §11 / NFR-03):
 *  - LINE チャネルアクセストークンは環境変数からのみ読む。値はログにも例外にも出さない。
 *  - channels.yaml の lineTokenSecret は「Secret Manager のリソース名」であってトークンではないが、
 *    リソース名も構成情報なのでエラーメッセージには出さない。
 */

import { randomUUID } from 'node:crypto';

import { createAiClient, createStubAiClient } from './ai/client.js';
import { DEFAULT_CONFIG_DIR, loadConfig, validateCrossReferences } from './config/load.js';
import { loadRuntimeConfig } from './config/runtime.js';
import { createLineClient } from './line/client.js';
import { createSlackNotifier } from './notify/slack.js';
import { createStore } from './store/index.js';
import { ConfigError } from './types.js';
import type {
  AiClient,
  AppConfig,
  AppContext,
  ChannelConfig,
  Clock,
  HttpClient,
  LineClient,
  Logger,
  Notifier,
  Store,
} from './types.js';
import { systemClock } from './util/clock.js';
import { createHttpClient } from './util/http.js';
import { createLogger } from './util/logger.js';

export interface ContextOverrides {
  config?: AppConfig;
  store?: Store;
  http?: HttpClient;
  ai?: AiClient;
  line?: LineClient;
  notifier?: Notifier;
  logger?: Logger;
  clock?: Clock;
}

/** LINE トークンを探す環境変数名。チャネル id を大文字化し、ハイフンは環境変数で使えないため _ に置換する。 */
function lineTokenEnvName(channelId: string): string {
  return `LINE_TOKEN_${channelId.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * 設定を読み込む。環境変数 → YAML → ファイル間整合性、の順に検証する。
 * 先に環境変数を見るのは、YAML の ${VAR} 展開より前の前提条件だからで、
 * 「環境変数が壊れているのに YAML のエラーが大量に出る」という読み違いを防ぐ。
 */
function loadAppConfig(): AppConfig {
  loadRuntimeConfig(process.env);
  const config = loadConfig(DEFAULT_CONFIG_DIR, process.env);

  const problems = validateCrossReferences(config.channels, config.sources);
  if (problems.length > 0) {
    throw new ConfigError(
      `設定の整合性に問題があります(${problems.length} 件)\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }
  return config;
}

/**
 * AppContext を作る。overrides に渡した依存だけが差し替わる。
 * overrides.config が与えられた場合、YAML の読み込みと検証は一切行わない(テスト用)。
 */
export async function createContext(overrides: ContextOverrides = {}): Promise<AppContext> {
  const logger = overrides.logger ?? createLogger();
  const clock = overrides.clock ?? systemClock;
  const config = overrides.config ?? loadAppConfig();
  const runtime = config.runtime;

  const store = overrides.store ?? createStore(runtime);
  const http = overrides.http ?? createHttpClient(runtime, logger);
  // ドライランでは実 API を呼ばない。誤って課金・レート消費しないための保険(NFR-04)。
  const ai = overrides.ai ?? (runtime.dryRun ? createStubAiClient(logger) : createAiClient(runtime, logger));
  const line = overrides.line ?? createLineClient(runtime, logger);
  const notifier = overrides.notifier ?? createSlackNotifier(runtime, logger);

  /**
   * LINE チャネルアクセストークンを解決する。
   * 1. ドライランならダミー(実送信されないため値は何でもよい)
   * 2. 環境変数 LINE_TOKEN_<ID大文字>(Cloud Run Jobs は Secret Manager の値をここへ注入する)
   * Secret Manager の SDK は依存に入れていないので、環境変数が無ければ対処法を添えて落とす。
   */
  function resolveLineToken(channel: ChannelConfig): Promise<string> {
    if (runtime.dryRun) return Promise.resolve('dry-run-token');

    const envName = lineTokenEnvName(channel.id);
    const value = process.env[envName];
    if (value !== undefined && value.trim() !== '') return Promise.resolve(value);

    // lineTokenSecret の値(Secret Manager のリソース名)はここに出さない。
    return Promise.reject(
      new ConfigError(
        `チャネル ${channel.id} の LINE アクセストークンが見つかりません。` +
          `環境変数 ${envName} を設定するか、Cloud Run Job の Secret 参照で注入してください(詳細設計書 §11)`,
      ),
    );
  }

  logger.debug('実行コンテキストを構築しました', {
    storeKind: runtime.storeKind,
    dryRun: runtime.dryRun,
    model: runtime.anthropicModel,
    channels: config.channels.length,
    sources: config.sources.length,
    enabledSources: config.sources.filter((source) => source.enabled).length,
  });

  return {
    config,
    store,
    http,
    ai,
    line,
    notifier,
    logger,
    clock,
    resolveLineToken,
    newId: randomUUID,
  };
}
