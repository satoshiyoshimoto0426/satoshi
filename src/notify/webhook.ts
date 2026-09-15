/**
 * 運用通知(Slack / Discord の Incoming Webhook)。詳細設計書 §12。
 *
 * 方針:
 *  - 通知は「運用者への連絡手段」であって業務処理ではない。通知先が落ちていても
 *    配信ジョブを道連れにしないため、送信失敗は例外にせず logger.warn に留める。
 *  - Webhook URL は資格情報そのもの(知っていれば誰でも投稿できる)。値をログに出さない。
 *    URL 未設定 / dryRun のときは fetch を呼ばず、内容をログに出すだけにする。
 *  - **Slack と Discord のどちらでも使える。** 両者は「JSON を POST する」点は同じだが、
 *    本文のキー名(text / content)と装飾の書式が違うので、URL から判別して書き分ける。
 *    運用者に「うちは Discord です」と設定させる手間を増やさないため、既定は自動判別。
 */

import type { Logger, NotifyLevel, Notifier, RuntimeConfig } from '../types.js';

export interface WebhookNotifierDeps {
  /** テストで差し替える fetch。既定はグローバル fetch。 */
  fetchImpl?: typeof fetch;
}

/** 通知先の種別。`auto` は URL から判別する。 */
export type WebhookKind = 'slack' | 'discord';

/** 重大度の視覚化。通知一覧でも色で判別できるようにする。絵文字は両者で同じに出る。 */
const LEVEL_EMOJI: Record<NotifyLevel, string> = { info: '🟢', warn: '🟡', error: '🔴' };

/** 箇条書きの先頭記号。 */
const BULLET = '• ';

/** 1 通に載せる明細の上限。これを超えると読み手が追えなくなる。 */
const MAX_LINES = 20;

/**
 * 本文の最大文字数。
 * Discord は 2000 文字を超えると 400 で弾かれる。Slack はもっと長く入るが、
 * 通知として読める長さではないので同じ基準に揃える。
 */
const MAX_BODY_CHARS: Record<WebhookKind, number> = { slack: 3000, discord: 2000 };

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * 文字列から Webhook URL を伏せる。
 *
 * fetch の例外メッセージには宛先 URL がそのまま入ることがある
 *(例: `connect failed to https://discord.com/api/webhooks/.../<トークン>`)。
 * ロガー側でも URL の形を見て伏せているが、通知元でも落としておく。
 * 通知先が増えてロガーのパターンから漏れても、ここで確実に止まるようにするため。
 */
function stripWebhookUrl(text: string, url: string): string {
  if (url === '') return text;
  let out = text.split(url).join('[REDACTED]');
  // URL の末尾(トークン部分)だけが出るケースもあるので、それも落とす。
  const lastSegment = url.split('/').pop() ?? '';
  if (lastSegment.length >= 8) out = out.split(lastSegment).join('[REDACTED]');
  return out;
}

/**
 * URL から通知先の種別を判別する。
 * 判別できない場合は Slack 形式(`text`)にする。汎用の Webhook 受け口は
 * `text` を受け付けるものが多く、失敗しても通知が届かないだけで実害が小さいため。
 */
export function detectWebhookKind(url: string): WebhookKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'slack';
  }
  if (host === 'discord.com' || host.endsWith('.discord.com')) return 'discord';
  if (host === 'discordapp.com' || host.endsWith('.discordapp.com')) return 'discord';
  return 'slack';
}

/**
 * 本文を組み立てる。
 * 箇条書きは 1 行 1 項目なので、明細に改行が含まれていても潰して 1 行に収める。
 *
 * 太字の書式が違う: Slack の mrkdwn は `*太字*`、Discord の markdown は `**太字**`。
 * 逆を使うと記号がそのまま表示されるだけなので、種別ごとに書き分ける。
 */
export function buildBody(kind: WebhookKind, level: NotifyLevel, title: string, lines: string[]): string {
  const bold = kind === 'discord' ? '**' : '*';
  const head = `${LEVEL_EMOJI[level]} ${bold}${title.replace(/\s+/g, ' ').trim()}${bold}`;
  const shown = lines.slice(0, MAX_LINES).map((l) => `${BULLET}${l.replace(/\s+/g, ' ').trim()}`);
  const rest = lines.length - MAX_LINES;
  // 打ち切った事実を隠すと「全部で何件あったのか」が分からなくなるため件数だけ添える。
  if (rest > 0) shown.push(`ほか ${rest} 件`);

  const body = [head, ...shown].join('\n');
  const limit = MAX_BODY_CHARS[kind];
  // 文字数はコードポイントで数える(絵文字で上限判定がずれないように)。
  const chars = [...body];
  if (chars.length <= limit) return body;
  return `${chars.slice(0, limit - 1).join('')}…`;
}

/** 通知先ごとのリクエストボディ。キー名が違うだけで、どちらも JSON を POST する。 */
function buildPayload(kind: WebhookKind, body: string): string {
  return kind === 'discord' ? JSON.stringify({ content: body }) : JSON.stringify({ text: body });
}

export function createWebhookNotifier(
  runtime: RuntimeConfig,
  logger: Logger,
  deps?: WebhookNotifierDeps,
): Notifier {
  const fetchImpl = deps?.fetchImpl ?? fetch;

  async function notify(level: NotifyLevel, title: string, lines: string[]): Promise<void> {
    const webhookUrl = runtime.notifyWebhookUrl;

    // URL 未設定(ローカル開発)/ dryRun では送信しない。内容はログに残す。
    if (webhookUrl === null || webhookUrl === '' || runtime.dryRun) {
      const reason = runtime.dryRun ? 'dry-run' : 'webhook 未設定';
      const text = buildBody('slack', level, title, lines);
      logger[level]('通知(送信なし)', { reason, notifyLevel: level, title, text });
      return;
    }

    const kind = runtime.notifyWebhookKind ?? detectWebhookKind(webhookUrl);
    const body = buildBody(kind, level, title, lines);

    try {
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: buildPayload(kind, body),
        // 通知先の応答待ちでジョブを止めない。
        signal: AbortSignal.timeout(runtime.httpTimeoutMs),
      });
      // 失敗理由は本文に入ることがあるが、URL は出さない。
      const responseText = await res.text().catch(() => '');

      if (res.status < 200 || res.status >= 300) {
        logger.warn('通知の送信に失敗しました', {
          kind,
          status: res.status,
          response: stripWebhookUrl(responseText.slice(0, 200), webhookUrl),
          title,
        });
        return;
      }
      logger.debug('通知を送信しました', { kind, status: res.status, notifyLevel: level, title });
    } catch (e) {
      // 通知の失敗でジョブを落とさない(詳細設計書 §12)。
      logger.warn('通知の送信で例外が発生しました', {
        kind,
        error: stripWebhookUrl(errorMessage(e), webhookUrl),
        title,
      });
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
