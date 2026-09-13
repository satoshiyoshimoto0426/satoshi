/**
 * 巡回カバレッジの算出(詳細設計書 §9.1 / FR-11a)。
 *
 * ここで出した数字は「新着なし」配信の
 *   (本日 {最終巡回時刻} 時点で {巡回成功ソース数} ソースを確認しました)
 * という一文にそのまま載る。受信者はこの一文だけで
 * 「本当に見張った上で新着が無かったのか」を判断するため、
 * **実態より良く見せない**ことを最優先にする:
 *   - 数えられないものは 0 / null にする(推測で埋めない)
 *   - succeeded は total を超えさせない
 *   - 巡回記録が無い日は source_state から実績のあるソースだけを数える
 */

import type { AppContext, CoverageSummary, Run, SourceState } from '../types.js';
import { toJstDateString, toJstTimeString } from '../util/time.js';

/**
 * 候補 0 件が何回続いたら「そのソースは確認できていない」とみなすか。
 * collect は 1 日 4 回走るので 4 = まる 1 日 1 件も抽出できていない状態。
 * この閾値は collect の警告と「新着なし」文面の件数の両方で使う。
 * 両者がずれると「Slack には警告が出ているのに配信では全ソース確認済みと表示される」
 * という食い違いが起きるため、1 か所で定義する。
 */
export const EMPTY_WARN_THRESHOLD = 4;

/**
 * ISO8601 文字列を JST の 'HH:MM' に変換する。解釈できなければ null。
 * 壊れた 1 件の日時で配信全体を落とさないための保険。
 */
function jstTimeOrNull(iso: string | null): string | null {
  if (iso === null || iso === '') return null;
  try {
    return toJstTimeString(new Date(iso));
  } catch {
    return null;
  }
}

/** ISO8601 文字列が指定の JST 日付に属するか。解釈できなければ false(甘く数えない)。 */
function isOnJstDate(iso: string | null, dateJst: string): boolean {
  if (iso === null || iso === '') return false;
  try {
    return toJstDateString(new Date(iso)) === dateJst;
  } catch {
    return false;
  }
}

/** runs(当日・collect)から算出する。 */
function fromRuns(runs: Run[], latest: Run, silent: number): CoverageSummary {
  // total は「最新の巡回が対象としたソース数」。設定変更で対象が増減しても、
  // 直近の実行が見た数を出すのが受信者にとって一番正直。
  const total = latest.counts.sourcesTotal;

  // succeeded は当日の全 run の最大値。1 日 4 回巡回するうち 1 回でも成功していれば
  // そのソースは「確認できた」と言えるため、回数をまたいだ最良値を採る。
  // ただし total を超えては見せない(設定変更直後に total < 過去の成功数となり得る)。
  let best = 0;
  for (const run of runs) {
    if (run.counts.sourcesSucceeded > best) best = run.counts.sourcesSucceeded;
  }
  const succeeded = Math.min(best, total);

  // HTTP は成功しているのに候補が 1 件も取れないソースは「確認できた」に数えない。
  // ここで数えてしまうと、セレクタ失効で全滅している日でも
  // 「45 ソースを確認しました。本日の新着はありません」と配信され、
  // 受信者が「監視は正常」と誤解する(要件 G5 / FR-11a)。
  // 終了時刻が無い(= 実行中 / 途中でクラッシュした)場合は開始時刻で代用する。
  return {
    total,
    succeeded: Math.max(0, succeeded - silent),
    lastCollectedAtJst: jstTimeOrNull(latest.finishedAt ?? latest.startedAt),
  };
}

/** runs が 1 件も無いときのフォールバック。source_state の実績から数える。 */
function fromSourceStates(
  states: SourceState[],
  enabledIds: Set<string>,
  dateJst: string,
  silent: number,
): CoverageSummary {
  // 対象は「現在有効なソース」。無効化済みソースの過去の成功を数えると
  // succeeded が total を超え、実態より良く見えてしまう。
  const succeededStates = states.filter(
    (state) => enabledIds.has(state.sourceId) && isOnJstDate(state.lastSuccessAt, dateJst),
  );

  let latestSuccessAt: string | null = null;
  for (const state of succeededStates) {
    // ISO8601 UTC 文字列は辞書順 = 時系列順。
    if (state.lastSuccessAt !== null && (latestSuccessAt === null || state.lastSuccessAt > latestSuccessAt)) {
      latestSuccessAt = state.lastSuccessAt;
    }
  }

  return {
    total: enabledIds.size,
    succeeded: Math.max(0, Math.min(succeededStates.length, enabledIds.size) - silent),
    lastCollectedAtJst: jstTimeOrNull(latestSuccessAt),
  };
}

/**
 * 指定 JST 日付の巡回カバレッジを求める。
 *
 * @param dateJst 'YYYY-MM-DD'(JST)。
 */
export async function computeCoverage(ctx: AppContext, dateJst: string): Promise<CoverageSummary> {
  const logger = ctx.logger.child({ job: 'coverage', date: dateJst });

  // 静かに壊れているソース数を先に数える。runs の有無に関わらず差し引く。
  const silent = await countSilentSources(ctx);
  if (silent > 0) {
    logger.warn('候補 0 件が続いているソースを「確認できた」から除外します', { silent });
  }

  // listRuns は新しい順(startedAt 降順)で返る契約。
  const runs = await ctx.store.listRuns(dateJst, 'collect');
  const latest = runs[0];

  if (latest !== undefined) {
    const summary = fromRuns(runs, latest, silent);
    logger.debug('巡回記録からカバレッジを算出しました', {
      runs: runs.length,
      total: summary.total,
      succeeded: summary.succeeded,
      silent,
      lastCollectedAtJst: summary.lastCollectedAtJst,
    });
    return summary;
  }

  // 当日の巡回記録が無い(runs の TTL 切れ / 別プロジェクトからの移行直後など)。
  // 配信文面の数字を空にするより、source_state の実績から数えた方が実態に近い。
  const enabledIds = new Set(
    ctx.config.sources.filter((source) => source.enabled).map((source) => source.id),
  );
  const states = await ctx.store.listSourceStates();
  const summary = fromSourceStates(states, enabledIds, dateJst, silent);
  logger.warn('当日の collect 実行記録が無いため source_state からカバレッジを算出しました', {
    total: summary.total,
    succeeded: summary.succeeded,
    lastCollectedAtJst: summary.lastCollectedAtJst,
  });
  return summary;
}

/**
 * 「静かに壊れている」ソース数。
 * HTTP は成功しているが候補リンクを 1 件も抽出できない状態が
 * EMPTY_WARN_THRESHOLD 回以上続いているものを数える。
 */
async function countSilentSources(ctx: AppContext): Promise<number> {
  try {
    const states = await ctx.store.listSourceStates();
    const enabled = new Set(ctx.config.sources.filter((s) => s.enabled).map((s) => s.id));
    return states.filter(
      (state) =>
        enabled.has(state.sourceId) &&
        state.consecutiveFailures === 0 &&
        state.consecutiveEmpty >= EMPTY_WARN_THRESHOLD,
    ).length;
  } catch {
    // 状態が読めない場合は 0 とする。配信を止めるほどの情報ではない。
    return 0;
  }
}
