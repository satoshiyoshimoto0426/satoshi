/**
 * 手動操作 CLI(詳細設計書 §12 / 運用手順書 §2)。
 *
 * Cloud Run Jobs は同一イメージに引数違いで 3 ジョブを走らせるため、
 * スケジュール実行も運用者の手動実行もすべてこのファイルが入口になる。
 *
 * 方針:
 *  - 「運用者が読む表」は標準出力(console.log)へ、「機械が読む記録」は構造化ログへ出す。
 *    verify-sources の表を JSON ログに混ぜると、朝の障害対応でいちばん見たい情報が埋もれるため。
 *  - 例外は各コマンドの入口で捕まえ、メッセージだけを logger.error に出して exitCode=1 にする。
 *    スタックトレースは logger.debug(LOG_LEVEL=debug のときだけ出る)。
 *  - 現在時刻は必ず ctx.clock 経由(契約の原則 5)。
 */

import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import { Pair, Scalar, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { YAMLMap } from 'yaml';

import { DEFAULT_CONFIG_DIR, loadConfig, validateCrossReferences } from './config/load.js';
import { createContext } from './context.js';
import { fetchSource } from './fetchers/index.js';
import { runCollect } from './pipeline/collect.js';
import { diagnoseSource } from './pipeline/diagnose.js';
import { approveDigest, runDeliver } from './pipeline/deliver.js';
import { runSummarize } from './pipeline/summarize.js';
import { ConfigError } from './types.js';
import type { AppContext, ChannelConfig, Logger, Run, SourceConfig } from './types.js';
import { createLogger } from './util/logger.js';
import { sleep } from './util/retry.js';
import { isValidDateString, toJstDateString } from './util/time.js';

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

/**
 * `verify-sources --fix` を中止する NG 割合のしきい値。
 * これを超える一斉 NG は、個々のソースではなく実行環境側のネットワーク障害を疑う。
 */
const FIX_ABORT_RATIO = 0.5;

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * サブコマンドの共通ラッパ。
 * 失敗しても例外を投げっぱなしにせず(スタックトレースが運用者に読めないため)、
 * 日本語のメッセージ + 終了コード 1 に落とす。
 */
async function runCommand(name: string, body: (logger: Logger) => Promise<void>): Promise<void> {
  const logger = createLogger({ command: name });
  try {
    await body(logger);
  } catch (e) {
    logger.error(`${name} に失敗しました`, { error: errorMessage(e) });
    logger.debug('スタックトレース', { stack: e instanceof Error ? (e.stack ?? null) : null });
    process.exitCode = 1;
  }
}

/**
 * Run の結果を報告し、必要なら終了コードを立てる。
 *
 * `failOnPartial` は summarize / deliver で true にする。これらは再実行が冪等
 * (生成済みはスキップ、送信済みは送らない)なので、部分失敗を非ゼロ終了にして
 * Cloud Run Jobs のリトライに載せたほうが復旧が早い。
 * 逆に collect の partial(数十ソース中 1 件の失敗)は日常的に起きるため、
 * 全ソースの再巡回を誘発しないよう failed のときだけ非ゼロにする(NFR-07 の礼節)。
 */
function reportRun(logger: Logger, run: Run, failOnPartial: boolean): void {
  const fields = {
    runId: run.id,
    status: run.status,
    date: run.date,
    counts: run.counts,
    errors: run.errors,
  };
  if (run.status === 'succeeded') {
    logger.info(`${run.job} が完了しました`, fields);
  } else {
    logger.warn(`${run.job} が完了しました(要確認)`, fields);
  }
  if (run.status === 'failed' || (failOnPartial && run.status === 'partial')) {
    process.exitCode = 1;
  }
}

/** --date の解決。指定が無ければ実行時点の JST 日付。 */
function resolveDate(ctx: AppContext, input: string | undefined): string {
  const date = input ?? toJstDateString(ctx.clock.now());
  if (!isValidDateString(date)) {
    throw new Error(`--date は実在する 'YYYY-MM-DD' 形式の日付で指定してください(指定値: ${date})`);
  }
  return date;
}

/** --channel の解決。綴り間違いを黙って無視すると「やったつもり」になるので落とす。 */
function selectChannels(ctx: AppContext, ids: string[] | undefined): ChannelConfig[] {
  if (ids === undefined || ids.length === 0) return ctx.config.channels;
  const known = new Set(ctx.config.channels.map((channel) => channel.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`未知のチャネル id です: ${unknown.join(', ')}(設定にあるのは ${[...known].join(', ')})`);
  }
  return ctx.config.channels.filter((channel) => ids.includes(channel.id));
}

/** --source の解決。 */
function selectSources(ctx: AppContext, ids: string[] | undefined): SourceConfig[] {
  if (ids === undefined || ids.length === 0) return ctx.config.sources;
  const known = new Set(ctx.config.sources.map((source) => source.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`未知のソース id です: ${unknown.join(', ')}`);
  }
  return ctx.config.sources.filter((source) => ids.includes(source.id));
}

/** ソースの監視先 URL(egov は endpoint)。 */
function targetUrlOf(source: SourceConfig): string | null {
  if (source.type === 'egov') return source.egov?.endpoint ?? null;
  return source.url;
}

// ---------------------------------------------------------------------------
// verify-sources
// ---------------------------------------------------------------------------

interface VerifyRow {
  sourceId: string;
  enabled: boolean;
  ok: boolean;
  /** 表の status 列。HTTP ステータスや「候補 n 件」を入れる。 */
  status: string;
  url: string;
  /** NG の理由。--fix のコメントに書く。 */
  reason: string | null;
}

/**
 * ソース 1 件を検証する。
 *
 * 到達確認だけでは不十分で、html ソースは「到達はするが itemSelector が合っておらず
 * 永久に 0 件」という最も気づきにくい故障を起こす(運用手順書 §3.2 / §8)。
 * そのため実際に fetchSource まで回し、候補リンクが 1 件も取れなければ NG とする。
 */
async function verifySource(ctx: AppContext, source: SourceConfig): Promise<VerifyRow> {
  const url = targetUrlOf(source);
  if (url === null || url === '') {
    return {
      sourceId: source.id,
      enabled: source.enabled,
      ok: false,
      status: 'URL 未設定',
      url: '-',
      reason: 'url / egov.endpoint が設定されていません',
    };
  }

  // 一過性の通信断で NG 判定しない。--fix が暴発して全ソースを無効化すると、
  // 「監視していないのに正常に見える」最悪の状態が恒久化する。
  let reach = await ctx.http.checkReachable(url);
  if (!reach.ok && (reach.status === null || reach.status >= 500 || reach.status === 429)) {
    await sleep(2000);
    reach = await ctx.http.checkReachable(url);
  }
  if (!reach.ok) {
    const status = reach.status === null ? '到達不可' : String(reach.status);
    return {
      sourceId: source.id,
      enabled: source.enabled,
      ok: false,
      status,
      url,
      reason: reach.error ?? status,
    };
  }

  const statusText = String(reach.status ?? 200);
  if (source.type !== 'html') {
    return { sourceId: source.id, enabled: source.enabled, ok: true, status: statusText, url, reason: null };
  }

  // html はセレクタ検証まで行う。state を null で渡し、条件付き GET(304)で
  // 候補 0 件になるのを避ける ― ここで見たいのは「いま何件取れるか」なので。
  try {
    const result = await fetchSource(source, ctx.http, null, ctx.clock);
    const count = result.candidates.length;
    if (count === 0) {
      return {
        sourceId: source.id,
        enabled: source.enabled,
        ok: false,
        status: `${statusText} 候補 0 件`,
        url,
        reason: `候補 0 件(itemSelector '${source.html?.itemSelector ?? '?'}' が失効した可能性)`,
      };
    }
    return {
      sourceId: source.id,
      enabled: source.enabled,
      ok: true,
      status: `${statusText} 候補 ${count} 件`,
      url,
      reason: null,
    };
  } catch (e) {
    const message = errorMessage(e);
    return {
      sourceId: source.id,
      enabled: source.enabled,
      ok: false,
      status: `${statusText} 抽出失敗`,
      url,
      reason: `候補の抽出に失敗: ${message}`,
    };
  }
}

/** 表示幅をそろえるための padEnd(日本語は等幅にならないが、id / status は ASCII 主体なので実用上問題ない)。 */
function printVerifyTable(rows: VerifyRow[]): void {
  const idWidth = Math.max(...rows.map((row) => row.sourceId.length), 2);
  const statusWidth = Math.max(...rows.map((row) => row.status.length), 6);
  for (const row of rows) {
    const mark = row.ok ? 'OK' : 'NG';
    const id = `${row.sourceId}${row.enabled ? '' : ' *'}`.padEnd(idWidth + 2);
    console.log(`${mark}  ${id}  ${row.status.padEnd(statusWidth)}  ${row.url}`);
    if (!row.ok && row.reason !== null) console.log(`      理由: ${row.reason}`);
  }
}

/** commentBefore を組み立てる。以前の自動無効化コメントは重ねずに置き換える。 */
function mergeAutoDisableComment(existing: string | null | undefined, comment: string): string {
  const kept = (existing ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.includes('自動無効化:'));
  return [...kept, comment].join('\n');
}

/**
 * ソース 1 件のマップノードを `enabled: false` にする。
 * 値ノードだけを書き換えるのは、キーに付いている既存コメントを失わないため
 * (YAMLMap.set はペアごと差し替えてしまう)。
 * すでに false なら何もせず false を返す(同じコメントを毎回積み増さない)。
 */
function disableSourceNode(node: YAMLMap, reason: string, dateJst: string): boolean {
  const comment = ` 自動無効化: ${dateJst} 到達確認に失敗(${reason})`;
  const pair = node.items.find((item) => isScalar(item.key) && item.key.value === 'enabled');

  if (pair === undefined) {
    // enabled は既定 true なので YAML に書かれていないこともある。その場合は追記する。
    const key = new Scalar('enabled');
    key.commentBefore = comment;
    const added = new Pair(key, new Scalar(false));
    // 既存ファイルの並び(id/name/type/url/channels/priority/region/enabled/html/note)に合わせ、
    // 入れ子ブロックの手前に差し込む。末尾に足すと note の後ろに離れて読みづらくなる。
    const before = node.items.findIndex(
      (item) => isScalar(item.key) && ['html', 'egov', 'note'].includes(String(item.key.value)),
    );
    if (before >= 0) node.items.splice(before, 0, added);
    else node.items.push(added);
    return true;
  }

  if (isScalar(pair.value)) {
    if (pair.value.value === false) return false;
    pair.value.value = false;
  } else {
    pair.value = new Scalar(false);
  }
  if (isScalar(pair.key)) {
    pair.key.commentBefore = mergeAutoDisableComment(pair.key.commentBefore, comment);
  }
  return true;
}

/**
 * NG だったソースを YAML 上で無効化する(--fix)。
 *
 * 全体を再生成するとファイル冒頭の運用メモや `# 要検証:` コメントが消えてしまうため、
 * yaml の parseDocument でコメント付きの Document を読み、該当ノードだけを編集して書き戻す。
 * stringify のオプションは既存ファイル(prettier: printWidth 110・フロー配列は詰める)に
 * 近い体裁になるよう合わせてある。
 */
function applyFix(configDir: string, reasons: Map<string, string>, dateJst: string, logger: Logger): void {
  const sourcesDir = path.join(configDir, 'sources');
  const files = fs
    .readdirSync(sourcesDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();
  const pending = new Map(reasons);

  for (const name of files) {
    const filePath = path.join(sourcesDir, name);
    const doc = parseDocument(fs.readFileSync(filePath, 'utf8'));
    const seq = doc.get('sources');
    if (!isSeq(seq)) continue;

    let changed = false;
    for (const item of seq.items) {
      if (!isMap(item)) continue;
      const id = item.get('id');
      if (typeof id !== 'string') continue;
      const reason = pending.get(id);
      if (reason === undefined) continue;
      pending.delete(id);

      if (disableSourceNode(item, reason, dateJst)) {
        changed = true;
        console.log(`  無効化: ${id}(${name})`);
      } else {
        console.log(`  無効化済みのため変更なし: ${id}(${name})`);
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, doc.toString({ lineWidth: 110, flowCollectionPadding: false }), 'utf8');
      logger.info('ソース定義を書き換えました', { file: filePath });
    }
  }

  for (const id of pending.keys()) {
    logger.warn('該当するソース定義が見つかりませんでした', { sourceId: id });
  }
}

// ---------------------------------------------------------------------------
// コマンド定義
// ---------------------------------------------------------------------------

interface CollectCliOptions {
  source?: string[];
  bootstrap?: boolean;
  skipClassify?: boolean;
}
interface SummarizeCliOptions {
  date?: string;
  channel?: string[];
  force?: boolean;
}
interface DeliverCliOptions {
  date?: string;
  channel?: string[];
  dryRun?: boolean;
}
interface ApproveCliOptions {
  date: string;
  channel: string;
}
interface DiagnoseSourcesCliOptions {
  source?: string[];
  out?: string;
}

interface VerifySourcesCliOptions {
  source?: string[];
  fix?: boolean;
  forceFix?: boolean;
}
interface PreviewCliOptions {
  date?: string;
  channel?: string[];
}

const program = new Command();

program
  .name('seido-watch')
  .description('制度改正ウォッチ & 公式LINE毎朝配信システムの手動操作 CLI(運用手順書 §2)')
  .showHelpAfterError();

program
  .command('collect')
  .description('情報源を巡回して新着を取り込む(FR-02)')
  .option('--source <id...>', '対象ソース id。省略時は有効な全ソース')
  .option('--bootstrap', '既存記事を「既知」として取り込む。初回登録時は必ず付ける')
  .option('--skip-classify', 'AI 分類を行わない(取り込みだけ確認したいとき)')
  .action((options: CollectCliOptions) =>
    runCommand('collect', async (logger) => {
      const ctx = await createContext({ logger });
      const run = await runCollect(ctx, {
        sourceIds: options.source,
        bootstrap: options.bootstrap === true,
        skipClassify: options.skipClassify === true,
      });
      reportRun(logger, run, false);
    }),
  );

program
  .command('summarize')
  .description('チャネルごとの日次まとめを生成する(FR-05)')
  .option('--date <YYYY-MM-DD>', '対象の JST 日付。省略時は本日')
  .option('--channel <id...>', '対象チャネル id。省略時は全チャネル')
  .option('--force', '生成済みのまとめを作り直す')
  .action((options: SummarizeCliOptions) =>
    runCommand('summarize', async (logger) => {
      const ctx = await createContext({ logger });
      const run = await runSummarize(ctx, {
        date: resolveDate(ctx, options.date),
        channelIds: options.channel,
        force: options.force === true,
      });
      reportRun(logger, run, true);
    }),
  );

program
  .command('deliver')
  .description('生成済みのまとめを LINE へ配信する(FR-10 / 冪等)')
  .option('--date <YYYY-MM-DD>', '対象の JST 日付。省略時は本日')
  .option('--channel <id...>', '対象チャネル id。省略時は全チャネル')
  .option('--dry-run', '送信せず文面をログに出すだけ')
  .action((options: DeliverCliOptions) =>
    runCommand('deliver', async (logger) => {
      const ctx = await createContext({ logger });
      const run = await runDeliver(ctx, {
        date: resolveDate(ctx, options.date),
        channelIds: options.channel,
        dryRun: options.dryRun === true,
      });
      reportRun(logger, run, true);
    }),
  );

program
  .command('test-broadcast')
  .description('各チャネルへテスト配信を送る(疎通確認。タスク M0-05)')
  .option('--channel <id...>', '対象チャネル ID(省略時は全チャネル)')
  .option('--yes', '確認なしで実際に送信する(指定しないと本文を表示するだけ)')
  .action((options: { channel?: string[]; yes?: boolean }) =>
    runCommand('test-broadcast', async (logger) => {
      const ctx = await createContext({ logger });
      const channels =
        options.channel === undefined
          ? ctx.config.channels
          : ctx.config.channels.filter((c) => options.channel?.includes(c.id));

      const unknown = (options.channel ?? []).filter((id) => !ctx.config.channels.some((c) => c.id === id));
      if (unknown.length > 0) {
        throw new ConfigError(`存在しないチャネル ID です: ${unknown.join(', ')}`);
      }

      const nowJst = toJstDateString(ctx.clock.now());
      for (const channel of channels) {
        const text = [
          `【疎通確認】${channel.name}`,
          '',
          'このメッセージは配信基盤の疎通確認です。制度改正の情報ではありません。',
          `送信日(JST): ${nowJst}`,
          '',
          '毎朝 07:30 にこのアカウントから制度改正のまとめが届きます。',
          '届かない日はシステム障害の可能性があるため、管理者へご連絡ください。',
        ].join('\n');

        // 既定は「送らない」。疎通確認のつもりで友だち全員に誤送信する事故を防ぐ。
        if (options.yes !== true) {
          console.log(`--- ${channel.id}(未送信。送るには --yes を付けてください)---`);
          console.log(text);
          console.log('');
          continue;
        }

        const token = await ctx.resolveLineToken(channel);
        const result = await ctx.line.broadcast(token, text, ctx.newId());
        console.log(`送信しました: ${channel.id}(requestId=${result.requestId ?? '-'})`);
        logger.info('テスト配信を送信しました', {
          channelId: channel.id,
          status: result.status,
          requestId: result.requestId,
        });
      }
    }),
  );

program
  .command('approve')
  .description('承認モードのまとめを承認して配信可能にする(FR-15)')
  .requiredOption('--date <YYYY-MM-DD>', '対象の JST 日付')
  .requiredOption('--channel <id>', '対象チャネル id')
  .action((options: ApproveCliOptions) =>
    runCommand('approve', async (logger) => {
      const ctx = await createContext({ logger });
      const date = resolveDate(ctx, options.date);
      // 綴り間違いを早めに弾く。存在しないチャネルの digest を探しても見つからないだけで理由が分からない。
      const [channel] = selectChannels(ctx, [options.channel]);
      if (channel === undefined) throw new Error(`チャネル ${options.channel} が設定にありません。`);

      const digest = await approveDigest(ctx, channel.id, date);
      console.log(`承認しました: ${channel.name}(${channel.id}) ${date} / status=${digest.status}`);
      console.log(`文面の確認: pnpm cli preview --date ${date} --channel ${channel.id}`);
    }),
  );

program
  .command('validate-config')
  .description('設定 YAML を検証する(スキーマ + ファイル間の整合性)')
  .action(() =>
    runCommand('validate-config', (logger) => {
      // ここでは外部依存を一切作らない。設定だけを見たいのに Firestore 認証で落ちるのは筋が悪い。
      const config = loadConfig(DEFAULT_CONFIG_DIR, process.env);
      const enabled = config.sources.filter((source) => source.enabled);

      console.log(`設定ディレクトリ: ${DEFAULT_CONFIG_DIR}`);
      console.log(`チャネル: ${config.channels.length} 件(${config.channels.map((c) => c.id).join(', ')})`);
      console.log(
        `ソース: ${config.sources.length} 件(有効 ${enabled.length} 件 / 無効 ${config.sources.length - enabled.length} 件)`,
      );
      for (const type of ['rss', 'html', 'egov'] as const) {
        console.log(`  ${type}: ${config.sources.filter((source) => source.type === type).length} 件`);
      }

      const problems = validateCrossReferences(config.channels, config.sources);

      // 有効ソースが 0 件なのは「問題なし」ではない。
      // verify-sources --fix の暴発や一括無効化でこの状態になると、巡回対象が無いまま
      // 毎朝「本日の新着はありません」が配信され、監視していないことに誰も気づけない。
      if (enabled.length === 0) {
        problems.push(
          '有効なソースが 0 件です。この状態では新着を検知できず、毎朝「本日の新着はありません」が配信され続けます。' +
            'config/sources/*.yaml の enabled を確認してください。',
        );
      }

      if (problems.length === 0) {
        console.log('OK 設定に問題はありません。');
      } else {
        console.log(`NG 整合性の問題が ${problems.length} 件あります:`);
        for (const problem of problems) console.log(`  - ${problem}`);
        process.exitCode = 1;
      }
      logger.info('設定を検証しました', {
        channels: config.channels.length,
        sources: config.sources.length,
        problems: problems.length,
      });
      return Promise.resolve();
    }),
  );

program
  .command('verify-sources')
  .description('全ソースの到達確認とセレクタ検証(運用手順書 §8)')
  .option('--source <id...>', '対象ソース id。省略時は全ソース')
  .option('--fix', 'NG だったソースを enabled: false に書き換える')
  .option('--force-fix', 'NG の割合が高くても書き換える(自分側の障害でないと確認できている場合のみ)')
  .action((options: VerifySourcesCliOptions) =>
    runCommand('verify-sources', async (logger) => {
      const ctx = await createContext({ logger });
      const sources = selectSources(ctx, options.source);
      const dateJst = toJstDateString(ctx.clock.now());

      // 直列に回す。HttpClient がホスト単位で 2 秒間隔を守る(NFR-07)ので、
      // ここで並列にしても速くならず、出力の並びだけが不安定になる。
      const rows: VerifyRow[] = [];
      for (const source of sources) {
        rows.push(await verifySource(ctx, source));
      }

      printVerifyTable(rows);
      const ng = rows.filter((row) => !row.ok);
      console.log(`OK ${rows.length - ng.length}件 / NG ${ng.length}件`);
      if (rows.some((row) => !row.enabled)) {
        console.log('* は enabled: false(巡回していない)ソースです。');
      }

      if (options.fix === true && ng.length > 0) {
        // NG が多すぎるときは、ソース側ではなく自分側のネットワーク障害を疑う。
        // プロキシ断・DNS 障害・社内ネットワークの瞬断では全件が NG になり、
        // そのまま書き換えると全ソースが無効化される。そうなると巡回対象 0 件のまま
        // 毎朝「本日の新着はありません」が配信され続け、誰も異常に気づけない。
        const ngRatio = ng.length / rows.length;
        if (ngRatio > FIX_ABORT_RATIO && options.forceFix !== true) {
          console.log('');
          console.log(
            `--fix: NG が ${ng.length}/${rows.length} 件(${Math.round(ngRatio * 100)}%)と多いため、書き換えを中止しました。`,
          );
          console.log('これだけ一斉に失敗するのは、個々のソースではなく実行環境側の');
          console.log('ネットワーク障害(プロキシ・DNS・egress ポリシー)である可能性が高いためです。');
          console.log('ネットワークを確認し、復旧後にもう一度実行してください。');
          console.log(
            `本当に全件を無効化したい場合は --force-fix を付けてください(しきい値 ${Math.round(FIX_ABORT_RATIO * 100)}% を無視します)。`,
          );
          logger.error('NG の割合が高いため --fix を中止しました', {
            ng: ng.length,
            total: rows.length,
          });
        } else {
          console.log('--fix: NG のソースを無効化します。');
          const reasons = new Map(ng.map((row) => [row.sourceId, row.reason ?? row.status]));
          applyFix(DEFAULT_CONFIG_DIR, reasons, dateJst, logger);
          console.log(
            '無効化したソースは URL / itemSelector を直して必ず有効に戻してください(運用手順書 §3.2)。',
          );
        }
      }

      logger.info('ソースを検証しました', { total: rows.length, ng: ng.length, fixed: options.fix === true });
      // NG を放置すると「巡回しているのに何も取れない」状態になるため、必ず失敗として扱う。
      if (ng.length > 0) process.exitCode = 1;
    }),
  );

program
  .command('preview')
  .description('配信予定の文面を標準出力で確認する')
  .option('--date <YYYY-MM-DD>', '対象の JST 日付。省略時は本日')
  .option('--channel <id...>', '対象チャネル id。省略時は全チャネル')
  .action((options: PreviewCliOptions) =>
    runCommand('preview', async (logger) => {
      const ctx = await createContext({ logger });
      const date = resolveDate(ctx, options.date);

      for (const channel of selectChannels(ctx, options.channel)) {
        console.log(`===== ${channel.id} / ${channel.name} / ${date} =====`);
        const digest = await ctx.store.getDigest(`${channel.id}_${date}`);
        if (digest === null) {
          console.log(
            `(まとめがありません。pnpm cli summarize --date ${date} --channel ${channel.id} を実行してください)`,
          );
          console.log('');
          continue;
        }
        console.log(
          `status=${digest.status} / 項目 ${digest.entries.length} 件 / 除外 ${digest.excluded.length} 件 / ` +
            `${[...digest.messageText].length} 文字`,
        );
        console.log('');
        console.log(digest.messageText);
        console.log('');
      }
    }),
  );

program
  .command('diagnose-sources')
  .description('NG ソースの直し方を調べる。実ページからセレクタ候補を出す(何も書き換えない)')
  .option('--source <id...>', '対象ソース id。省略時は全ソース')
  .option('--out <path>', '結果の JSON 出力先', 'diagnose-report.json')
  .action((options: DiagnoseSourcesCliOptions) =>
    runCommand('diagnose-sources', async (logger) => {
      const ctx = await createContext({ logger });
      const sources = selectSources(ctx, options.source);

      // 直列に回す。HttpClient がホスト単位で 2 秒間隔を守る(NFR-07)。
      const rows = [];
      for (const source of sources) {
        rows.push(await diagnoseSource(ctx, source));
      }

      const outPath = path.resolve(options.out ?? 'diagnose-report.json');
      fs.writeFileSync(
        outPath,
        JSON.stringify({ generatedAt: ctx.clock.now().toISOString(), rows }, null, 2),
      );

      // 画面には要約だけ出す。詳細は JSON を見る(端末に流すと読めないため)。
      let ok = 0;
      let selectorNg = 0;
      let unreachable = 0;
      for (const row of rows) {
        const reachable = row.status !== null && row.status >= 200 && row.status < 300;
        if (!reachable) {
          unreachable += 1;
          console.log(`× ${row.sourceId}  ${row.error ?? `HTTP ${String(row.status)}`}  ${row.url ?? ''}`);
          continue;
        }
        if (row.currentLinks !== null && row.currentLinks === 0) {
          selectorNg += 1;
          const best = row.candidates[0];
          const hint = best === undefined ? '候補なし' : `候補: ${best.selector}(${String(best.links)}件)`;
          console.log(`! ${row.sourceId}  セレクタが当たっていません  ${hint}`);
          continue;
        }
        ok += 1;
      }

      console.log('');
      console.log(
        `到達かつ抽出できた: ${String(ok)}件 / セレクタ不一致: ${String(selectorNg)}件 / 到達不可: ${String(unreachable)}件`,
      );
      console.log(`詳細(セレクタ候補と実例)を書き出しました: ${outPath}`);
      logger.info('診断しました', { ok, selectorNg, unreachable, out: outPath });
    }),
  )

  .command('health')
  .description('異常のあるソースの一覧を出す(連続失敗 / 候補 0 件。運用手順書 §3.2)')
  .action(() =>
    runCommand('health', async (logger) => {
      const ctx = await createContext({ logger });
      const names = new Map(ctx.config.sources.map((source) => [source.id, source.name]));
      const states = await ctx.store.listSourceStates();

      const failing = states
        .filter((state) => state.consecutiveFailures >= 1)
        // 失敗回数の多い順。同数なら id 順で並びを安定させる。
        .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || (a.sourceId < b.sourceId ? -1 : 1));

      // HTTP は成功しているのに候補が 1 件も取れないソース(セレクタ失効の疑い)。
      // 失敗として記録されないため、ここで明示的に拾わないと誰も気づけない(要件 G5)。
      const silent = states
        .filter((state) => state.consecutiveFailures === 0 && state.consecutiveEmpty >= 1)
        .sort((a, b) => b.consecutiveEmpty - a.consecutiveEmpty || (a.sourceId < b.sourceId ? -1 : 1));

      if (failing.length === 0 && silent.length === 0) {
        console.log('異常のあるソースはありません。');
        logger.info('ソース状態は正常です', { failing: 0, silent: 0 });
        return;
      }

      if (failing.length > 0) {
        console.log(`連続失敗しているソース: ${failing.length} 件`);
        for (const state of failing) {
          console.log(
            `${String(state.consecutiveFailures).padStart(3)} 回  ${state.sourceId}  ` +
              `${names.get(state.sourceId) ?? '(設定に無いソース)'}`,
          );
          console.log(
            `        最終成功: ${state.lastSuccessAt ?? '記録なし'} / 直近エラー: ${state.lastError ?? '-'}`,
          );
        }
      }

      if (silent.length > 0) {
        if (failing.length > 0) console.log('');
        console.log(`候補 0 件が続いているソース(セレクタ失効の疑い): ${silent.length} 件`);
        for (const state of silent) {
          console.log(
            `${String(state.consecutiveEmpty).padStart(3)} 回  ${state.sourceId}  ` +
              `${names.get(state.sourceId) ?? '(設定に無いソース)'}`,
          );
          console.log(`        最終成功: ${state.lastSuccessAt ?? '記録なし'} / HTTP は成功、候補 0 件`);
        }
      }

      console.log('');
      console.log('対応手順: 運用手順書 §3.2(verify-sources で URL とセレクタを確認)');
      logger.warn('異常のあるソースがあります', { failing: failing.length, silent: silent.length });
      process.exitCode = 1;
    }),
  );

// トップレベル await で待つ。await を落とすと非同期の action が終わる前に
// プロセスが exit して「何も起きなかったように見える」事故になる。
await program.parseAsync(process.argv);
