/**
 * 運用通知(Slack Incoming Webhook)。詳細設計書 §12。
 *
 * 方針:
 *  - 通知は「運用者への連絡手段」であって業務処理ではない。Slack が落ちていても
 *    配信ジョブを道連れにしないため、送信失敗は例外にせず logger.warn に留める。
 *  - Webhook URL は資格情報そのもの(知っていれば誰でも投稿できる)。値をログに出さない。
 *    URL 未設定 / dryRun のときは fetch を呼ばず、内容をログに出すだけにする。
 *  - 本文は Slack mrkdwn。タイトルを `*太字*`、明細を箇条書きにして
 *    モバイル通知のプレビューでも「何が起きたか」が読めるようにする。
 */

import type { Logger, NotifyLevel, Notifier, RuntimeConfig } from '../types.js';

export interface SlackNotifierDeps {
  /** テストで差し替える fetch。既定はグローバル fetch。 */
  fetchImpl?: typeof fetch;
}

/** 重大度の視覚化。Slack の通知一覧でも色で判別できるようにする。 */
const LEVEL_EMOJI: Record<NotifyLevel, string> = { info: '🟢', warn: '🟡', error: '🔴' };

/** 箇条書きの先頭記号。 */
const BULLET = '• ';

/** 1 通に載せる明細の上限。これを超えると Slack 側で折り畳まれて読めなくなる。 */
const MAX_LINES = 20;

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Slack mrkdwn の本文を組み立てる。
 * 箇条書きは 1 行 1 項目なので、明細に改行が含まれていても潰して 1 行に収める。
 */
function buildSlackText(level: NotifyLevel, title: string, lines: string[]): string {
  const head = `${LEVEL_EMOJI[level]} *${title.replace(/\s+/g, ' ').trim()}*`;
  const shown = lines.slice(0, MAX_LINES).map((l) => `${BULLET}${l.replace(/\s+/g, ' ').trim()}`);
  const rest = lines.length - MAX_LINES;
  // 打ち切った事実を隠すと「全部で何件あったのか」が分からなくなるため件数だけ添える。
  if (rest > 0) shown.push(`ほか ${rest} 件`);
  return [head, ...shown].join('\n');
}

export function createSlackNotifier(
  runtime: RuntimeConfig,
  logger: Logger,
  deps?: SlackNotifierDeps,
): Notifier {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  async function notify(level: NotifyLevel, title: string, lines: string[]): Promise<void> {
    const text = buildSlackText(level, title, lines);
    const webhookUrl = runtime.slackWebhookUrl;

    // URL 未設定(ローカル開発)/ dryRun では送信しない。内容はログに残す。
    if (webhookUrl === null || webhookUrl === '' || runtime.dryRun) {
      const reason = runtime.dryRun ? 'dry-run' : 'webhook 未設定';
      logger[level]('通知(Slack 送信なし)', { reason, notifyLevel: level, title, text });
      return;
    }

    try {
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        // Slack の応答待ちでジョブを止めない。
        signal: AbortSignal.timeout(runtime.httpTimeoutMs),
      });
      // Slack は成功時に 'ok' を返す。失敗理由は本文に入るが URL は出さない。
      const bodyText = await res.text().catch(() => '');

      if (res.status < 200 || res.status >= 300) {
        logger.warn('Slack 通知に失敗しました', {
          status: res.status,
          response: bodyText.slice(0, 200),
          title,
        });
        return;
      }
      logger.debug('Slack 通知を送信しました', { status: res.status, notifyLevel: level, title });
    } catch (e) {
      // 通知の失敗でジョブを落とさない(詳細設計書 §12)。
      logger.warn('Slack 通知の送信で例外が発生しました', { error: errorMessage(e), title });
    }
  }

  return { notify };
}

/** 通知を行わない Notifier。テストや通知不要な実行経路で使う。 */
export function createNoopNotifier(logger: Logger): Notifier {
  return {
    notify(level: NotifyLevel, title: string, lines: string[]): Promise<void> {
      logger.debug('通知(no-op)', { notifyLevel: level, title, lines });
      return Promise.resolve();
    },
  };
}
