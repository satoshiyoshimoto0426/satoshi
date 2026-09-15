/**
 * フェッチャーの入口。ソース種別ごとの実装へ振り分ける(詳細設計書 §6.1 の手順 3)。
 *
 * 呼び出し側(pipeline/collect, cli/verify-sources)が種別を意識しなくて済むよう、
 * 分岐はここ 1 か所に閉じる。戻り値の形(FetchResult)は 3 種別で共通。
 */

import type { Clock, FetchResult, HttpClient, SourceConfig, SourceState } from '../types.js';
import { ConfigError } from '../types.js';
import { fetchEgov } from './egov.js';
import { fetchHtml } from './html.js';
import { fetchRss } from './rss.js';

/**
 * ソース 1 件から候補リンクを取得する。
 *
 * @param state 前回の巡回状態。ETag / Last-Modified による条件付き GET に使う。
 * @param clock 現在時刻の取得口(egov の lookbackDays 判定で使う)。
 */
export async function fetchSource(
  source: SourceConfig,
  http: HttpClient,
  state: SourceState | null,
  clock: Clock,
): Promise<FetchResult> {
  switch (source.type) {
    case 'rss':
      return fetchRss(source, http, state);
    case 'html':
      return fetchHtml(source, http, state);
    case 'egov':
      return fetchEgov(source, http, state, clock);
    default: {
      // 型の上では到達しない。YAML スキーマを迂回した設定を握りつぶさないため明示的に落とす。
      const _exhaustive: never = source.type;
      throw new ConfigError(`未対応のソース種別です: ${String(_exhaustive)}`);
    }
  }
}
