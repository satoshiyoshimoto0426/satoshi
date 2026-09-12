/**
 * collect ジョブ(詳細設計書 §6.1 / FR-02・FR-03 / NFR-06・NFR-07)。
 *
 * 1 日 4 回(06:00 / 12:00 / 18:00 / 23:00 JST)全ソースを巡回し、
 * 新着・更新を items に取り込んで最後に分類(§7.1)を回す。
 *
 * 設計上の要点:
 * 1. **ホスト単位で直列、ホスト間だけ並列**(p-limit(runtime.hostConcurrency))。
 *    HttpClient 側でも同一ホストの直列化と 2 秒間隔(NFR-07)は保証されるが、
 *    ここでもホスト単位にまとめておくと「1 ホストの遅いソースが並列枠を占有し続ける」
 *    状態を避けられ、待ち行列の長さも見積もれる。
 * 2. **1 ソースの失敗は他ソースを止めない**。公的機関のサイトは日常的に落ちる。
 *    例外は必ずソース単位で捕まえ、source_state に記録して次のソースへ進む。
 * 3. **実行痕跡を先に残す**。開始時点で status='running' の Run を書き込み、
 *    終了時に上書きする。途中でコンテナが落ちても「走ったが終わらなかった」ことが残る(NFR-06)。
 * 4. **黙って捨てない**。1 ソースの新規上限を超えた分、失敗したソース、分類の失敗は
 *    すべて件数か理由を Run とログに残す。
 */

import pLimit from 'p-limit';

import type {
  AppContext,
  Classification,
  FetchResult,
  Item,
  Run,
  RunCounts,
  RunStatus,
  SourceConfig,
  SourceState,
} from '../types.js';
import { RobotsDisallowedError } from '../types.js';
import { extractContent } from '../fetchers/extract.js';
import { fetchSource } from '../fetchers/index.js';
import { itemIdFor, sha256 } from '../util/hash.js';
import { addDays, isoOf, toJstDateString } from '../util/time.js';
import { canonicalizeUrl, hostOf } from '../util/url.js';
import { classifyPending } from './classify.js';

export interface CollectOptions {
  /** 対象ソース ID。未指定なら有効な全ソース。 */
  sourceIds?: string[];
  /** 初回登録モード: 本文を取らず「既知」として登録し、翌朝のダイジェストに流さない。 */
  bootstrap?: boolean;
  /** 収集だけ行い、分類(§7.1)を呼ばない。 */
  skipClassify?: boolean;
}

/** 連続失敗がこの回数以上になったら Slack 警告(詳細設計書 §12)。 */
const FAILURE_WARN_THRESHOLD = 3;

/** source_state.lastError / 通知に載せるメッセージの長さ上限(ログ肥大の防止)。 */
const ERROR_TEXT_MAX = 300;

/** 正規化済みの候補リンク 1 件。 */
interface NormalizedCandidate {
  id: string;
  canonicalUrl: string;
  title: string;
  publishedAt: string | null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function emptyCounts(): RunCounts {
  return {
    sourcesTotal: 0,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    fetched: 0,
    newItems: 0,
    updatedItems: 0,
    classified: 0,
    digestsGenerated: 0,
    excluded: 0,
    sent: 0,
    skipped: 0,
  };
}

/**
 * bootstrap 時に付ける「既知化」用の分類。
 * relevance 0 / channels 空なので summarize の対象条件(§6.2)に一致せず、
 * 初回登録で拾った過去記事が翌朝のダイジェストに流れ込まない。
 */
function bootstrapClassification(): Classification {
  return {
    channels: [],
    relevance: 0,
    importance: 'low',
    kind: 'other',
    isDuplicateOfNational: false,
    effectiveDate: null,
    deadline: null,
    reason: '初回登録時の既知化(bootstrap)',
  };
}

/**
 * 並列制御のグループキー。
 * egov は url が null なので endpoint のホストを使う(契約)。
 * ホストが取れない設定ミスは他ソースと同居させず単独グループにして、
 * 巻き込みでの直列待ちを起こさない。
 */
function hostKeyOf(source: SourceConfig): string {
  const raw = source.type === 'egov' ? (source.egov?.endpoint ?? '') : (source.url ?? '');
  const host = hostOf(raw);
  return host !== '' ? host : `source:${source.id}`;
}

/** 通知・ログ用の参照先 URL(公開情報のみ。秘密情報は含まない)。 */
function displayUrlOf(source: SourceConfig): string {
  const raw = source.type === 'egov' ? (source.egov?.endpoint ?? '') : (source.url ?? '');
  return raw === '' ? '(未設定)' : raw;
}

/**
 * 保存するタイトルを決める。
 * 一覧側の見出しを最優先(そのソースの文脈が載っているため)、
 * 空なら本文から得たタイトル、それも無ければ URL を入れる
 * (空タイトルのまま配信すると LINE 文面の行が消えてしまう)。
 */
function pickTitle(listTitle: string, bodyTitle: string | null, canonicalUrl: string): string {
  const fromList = listTitle.trim();
  if (fromList !== '') return fromList;
  const fromBody = (bodyTitle ?? '').trim();
  if (fromBody !== '') return fromBody;
  return canonicalUrl;
}

/** 本文ハッシュ。本文が取れていないソースでもタイトル変化で更新を検知できるようにする(§6.1 手順 6)。 */
function contentHashOf(contentText: string, title: string): string {
  return sha256(contentText !== '' ? contentText : title);
}

/**
 * 全ソースを巡回して items を更新し、分類まで行う。
 *
 * @returns この実行の Run(store にも保存済み)。
 * @throws 巡回ループの外側で想定外の例外が起きた場合。その場合も status='failed' の Run は保存する。
 */
export async function runCollect(ctx: AppContext, opts?: CollectOptions): Promise<Run> {
  const runId = ctx.newId();
  const logger = ctx.logger.child({ job: 'collect', runId });
  const { runtime } = ctx.config;
  const bootstrap = opts?.bootstrap === true;

  const startedAtDate = ctx.clock.now();
  const startedAt = isoOf(startedAtDate);
  const counts = emptyCounts();
  const errors: string[] = [];

  // --- 対象ソースの決定 ----------------------------------------------------
  const requested = opts?.sourceIds;
  const requestedSet = requested === undefined || requested.length === 0 ? null : new Set(requested);
  const targets = ctx.config.sources.filter(
    (source) => source.enabled && (requestedSet === null || requestedSet.has(source.id)),
  );
  if (requestedSet !== null) {
    const found = new Set(targets.map((source) => source.id));
    const missing = [...requestedSet].filter((id) => !found.has(id));
    if (missing.length > 0) {
      // 指定ミス(typo)と無効化済みソースの指定を黙って無視すると、
      // 「実行したのに何も起きない」で運用者が悩む。
      logger.warn('指定されたソースが見つからないか無効です', { sourceIds: missing });
    }
  }
  counts.sourcesTotal = targets.length;

  const run: Run = {
    id: runId,
    job: 'collect',
    startedAt,
    finishedAt: null,
    status: 'running',
    counts: { ...counts },
    date: toJstDateString(startedAtDate),
    errors: [],
    expiresAt: addDays(startedAt, runtime.retentionDays),
  };

  /** Run の保存。ここでの失敗で巡回本体を落とさない(記録は目的ではなく手段)。 */
  async function saveRun(phase: string): Promise<void> {
    try {
      await ctx.store.putRun(run);
    } catch (e) {
      logger.warn('実行記録の保存に失敗しました', { phase, error: errorMessage(e) });
    }
  }

  /** 通知の失敗でジョブを落とさない(詳細設計書 §12)。 */
  async function notifySafe(level: 'info' | 'warn' | 'error', title: string, lines: string[]): Promise<void> {
    try {
      await ctx.notifier.notify(level, title, lines);
    } catch (e) {
      logger.warn('通知の送信に失敗しました', { error: errorMessage(e), title });
    }
  }

  // sourcesTotal を埋めてから書く。coverage(§9.1)は最新 run の sourcesTotal を読むため、
  // 実行中の run が 0 を返すと「確認したソース数」が実態より小さく見える。
  await saveRun('開始時');
  logger.info('巡回を開始します', {
    sources: targets.length,
    bootstrap,
    hostConcurrency: runtime.hostConcurrency,
  });

  // --- ソース 1 件の処理 ---------------------------------------------------

  /** 成功時の source_state 更新。etag / lastModified は 304 でも失わないよう前回値を引き継ぐ。 */
  async function saveSuccessState(
    source: SourceConfig,
    previous: SourceState | null,
    result: FetchResult,
    newCount: number,
  ): Promise<void> {
    const now = isoOf(ctx.clock.now());
    await ctx.store.putSourceState({
      sourceId: source.id,
      lastFetchedAt: now,
      lastSuccessAt: now,
      consecutiveFailures: 0,
      etag: result.etag ?? previous?.etag ?? null,
      lastModified: result.lastModified ?? previous?.lastModified ?? null,
      lastError: null,
      lastNewCount: newCount,
      // 復旧したら警告の抑止も解除する。次に 3 回連続で失敗したら再び通知したいため。
      warnedAtFailureCount: 0,
    });
  }

  /** 失敗時の記録。consecutiveFailures を進め、閾値を超えたら 1 度だけ通知する。 */
  async function recordFailure(
    source: SourceConfig,
    previous: SourceState | null,
    e: unknown,
  ): Promise<void> {
    const message = errorMessage(e).slice(0, ERROR_TEXT_MAX);
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const warnedAt = previous?.warnedAtFailureCount ?? 0;
    // 同じ失敗回数で二重に通知しないための条件(warnedAtFailureCount に現在の回数を記録する)。
    const shouldWarn = failures >= FAILURE_WARN_THRESHOLD && warnedAt < failures;

    counts.sourcesFailed += 1;
    errors.push(`ソース ${source.id}(${source.name})の巡回に失敗しました: ${message}`);
    logger.error('ソースの巡回に失敗しました', {
      sourceId: source.id,
      consecutiveFailures: failures,
      error: message,
    });

    try {
      await ctx.store.putSourceState({
        sourceId: source.id,
        lastFetchedAt: isoOf(ctx.clock.now()),
        // 成功時刻は「最後に成功した時刻」なので失敗では動かさない(§9.1 の数字の元になる)。
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        consecutiveFailures: failures,
        etag: previous?.etag ?? null,
        lastModified: previous?.lastModified ?? null,
        lastError: message,
        lastNewCount: previous?.lastNewCount ?? 0,
        warnedAtFailureCount: shouldWarn ? failures : warnedAt,
      });
    } catch (stateError) {
      logger.warn('source_state の保存に失敗しました', {
        sourceId: source.id,
        error: errorMessage(stateError),
      });
    }

    if (shouldWarn) {
      await notifySafe('warn', 'collect: ソースの連続失敗', [
        `${source.name}(${source.id})が ${failures} 回連続で失敗しています`,
        `URL: ${displayUrlOf(source)}`,
        `最後のエラー: ${message}`,
      ]);
    }
  }

  /** 新規アイテムを組み立てる。bootstrap では本文取得を省く。 */
  async function buildNewItem(
    source: SourceConfig,
    candidate: NormalizedCandidate,
    now: string,
    expiresAt: string,
  ): Promise<Item> {
    // bootstrap は「既知化」が目的なので本文は取らない。
    // 初回に数百ページへ本文取得をかけると相手サイトへの負荷が跳ね上がる(NFR-07)。
    const extracted = bootstrap
      ? null
      : await extractContent(candidate.canonicalUrl, ctx.http, runtime.maxContentChars);
    const title = pickTitle(candidate.title, extracted?.title ?? null, candidate.canonicalUrl);
    const contentText = extracted?.text ?? '';
    return {
      id: candidate.id,
      sourceId: source.id,
      canonicalUrl: candidate.canonicalUrl,
      title,
      publishedAt: candidate.publishedAt,
      detectedAt: now,
      updatedAt: now,
      contentHash: contentHashOf(contentText, title),
      contentText,
      contentType: extracted?.contentType ?? 'html',
      // 自治体ソースの地域はソース定義から引き継ぐ(FR-18)。
      region: source.region,
      classification: bootstrap ? bootstrapClassification() : null,
      classifiedAt: bootstrap ? now : null,
      digestedIn: [],
      expiresAt,
    };
  }

  /**
   * 既知 URL の更新検知(§6.1 手順 6)。
   *
   * なぜ「一覧の変化」を入口にするか:
   *   既知 URL を毎回本文取得すると、同一ホストへのアクセスが候補数分増える。
   *   NFR-07 の 2 秒間隔と掛け算になり、1 ソースの巡回が数分単位で伸びる。
   *   そこで一覧側の見出し・公開日が変わったものだけ本文を取り直し、
   *   contentHash を比べて本当に中身が変わったときだけ再分類対象に戻す。
   */
  async function updateKnownItem(
    source: SourceConfig,
    previous: Item,
    candidate: NormalizedCandidate,
    now: string,
    expiresAt: string,
  ): Promise<void> {
    const titleChanged = candidate.title !== '' && candidate.title !== previous.title;
    const publishedChanged = candidate.publishedAt !== null && candidate.publishedAt !== previous.publishedAt;
    if (!titleChanged && !publishedChanged) return;

    const extracted = await extractContent(candidate.canonicalUrl, ctx.http, runtime.maxContentChars);
    const title = pickTitle(candidate.title, extracted.title, candidate.canonicalUrl);
    const contentHash = contentHashOf(extracted.text, title);
    const contentChanged = contentHash !== previous.contentHash;

    await ctx.store.putItem({
      ...previous,
      title,
      publishedAt: candidate.publishedAt ?? previous.publishedAt,
      updatedAt: now,
      contentHash,
      contentText: extracted.text,
      contentType: extracted.contentType,
      region: source.region,
      // 本文が変わったときだけ分類をリセットして再分類の対象に戻す。
      // 見出しの表記ゆれだけで再分類すると AI 呼び出しが無駄に増える(NFR-04)。
      classification: contentChanged ? null : previous.classification,
      classifiedAt: contentChanged ? null : previous.classifiedAt,
      // digestedIn は消さない。同じ記事を再配信しないため(FR-03)。
      // detectedAt も初検知日時のまま保つ(§5.1 の定義)。
      expiresAt,
    });

    if (contentChanged) {
      counts.updatedItems += 1;
      logger.info('既知 URL の更新を検知しました', {
        sourceId: source.id,
        itemId: previous.id,
        url: previous.canonicalUrl,
      });
    } else {
      logger.debug('既知 URL の見出しのみ更新しました', { sourceId: source.id, itemId: previous.id });
    }
  }

  /** 候補リストを items に取り込む。戻り値は新規取り込み件数。 */
  async function ingest(source: SourceConfig, result: FetchResult): Promise<number> {
    const now = isoOf(ctx.clock.now());
    const expiresAt = addDays(now, runtime.retentionDays);

    // 1. URL 正規化 → ID 化(FR-03)。壊れた 1 件でソース全体を止めない。
    const normalized: NormalizedCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of result.candidates) {
      let canonicalUrl: string;
      try {
        canonicalUrl = canonicalizeUrl(candidate.url);
      } catch (e) {
        logger.debug('URL を正規化できないため候補から除外しました', {
          sourceId: source.id,
          url: candidate.url,
          error: errorMessage(e),
        });
        continue;
      }
      const id = itemIdFor(canonicalUrl);
      // 同じページへのリンクが一覧に複数あることは珍しくない。最初の 1 件だけ見る。
      if (seen.has(id)) continue;
      seen.add(id);
      normalized.push({
        id,
        canonicalUrl,
        title: candidate.title.trim(),
        publishedAt: candidate.publishedAt,
      });
    }
    if (normalized.length === 0) return 0;

    // 2. 既存 items をまとめて引く(1 件ずつ引くと Firestore 読み取りが候補数だけ増える)。
    const existingList = await ctx.store.getItems(normalized.map((n) => n.id));
    const existing = new Map(existingList.map((item) => [item.id, item]));

    // 3. 新規は 1 回の巡回で maxNewItemsPerSource 件まで(§6.1: 初回登録の大量取込防止)。
    const fresh = normalized.filter((n) => !existing.has(n.id));
    const capacity = Math.max(0, runtime.maxNewItemsPerSource);
    const accepted = fresh.slice(0, capacity);
    const deferred = fresh.length - accepted.length;
    if (deferred > 0) {
      // 黙って捨てない。次回の巡回でも一覧に残っていれば取り込まれる。
      const message =
        `ソース ${source.id}(${source.name}): 新規候補 ${fresh.length} 件のうち ` +
        `上限 ${capacity} 件を超えた ${deferred} 件を今回は取り込みませんでした(次回の巡回に繰り越します)`;
      counts.skipped += deferred;
      errors.push(message);
      logger.warn('新規候補が 1 回の上限を超えました', {
        sourceId: source.id,
        candidates: fresh.length,
        limit: capacity,
        deferred,
      });
    }

    let stored = 0;
    for (const candidate of accepted) {
      const item = await buildNewItem(source, candidate, now, expiresAt);
      await ctx.store.putItem(item);
      stored += 1;
      counts.newItems += 1;
    }

    // 4. 既知 URL の更新検知。bootstrap は「既知化」だけが目的なので行わない。
    if (!bootstrap) {
      for (const candidate of normalized) {
        const previous = existing.get(candidate.id);
        if (previous === undefined) continue;
        await updateKnownItem(source, previous, candidate, now, expiresAt);
      }
    }

    return stored;
  }

  /** ソース 1 件を巡回する。例外はここで閉じ込める。 */
  async function runSource(source: SourceConfig): Promise<void> {
    const startMs = ctx.clock.now().getTime();
    let state: SourceState | null = null;
    try {
      state = await ctx.store.getSourceState(source.id);
      const result = await fetchSource(source, ctx.http, state, ctx.clock);
      // fetched は「一覧から取り出した候補リンクの総数」。新規件数との差が
      // 「差分検知がどれだけ効いているか」の目安になる。
      counts.fetched += result.candidates.length;

      if (result.notModified) {
        // 304。新規 0 件の成功として扱い、etag / lastModified はそのまま保持する。
        await saveSuccessState(source, state, result, 0);
        counts.sourcesSucceeded += 1;
        logger.info('前回から更新がありません(304)', { sourceId: source.id });
        return;
      }

      const newCount = await ingest(source, result);
      await saveSuccessState(source, state, result, newCount);
      counts.sourcesSucceeded += 1;
      logger.info('ソースの巡回が完了しました', {
        sourceId: source.id,
        candidates: result.candidates.length,
        newItems: newCount,
        durationMs: ctx.clock.now().getTime() - startMs,
      });
    } catch (e) {
      if (e instanceof RobotsDisallowedError) {
        // robots.txt 不許可はこちらの設定の問題。スキップするが「取れていない」事実は
        // 失敗として数え、放置されないようにする(§6.1 手順 1)。
        logger.warn('robots.txt により取得が許可されていないためスキップします', {
          sourceId: source.id,
          url: displayUrlOf(source),
        });
      }
      await recordFailure(source, state, e);
    }
  }

  // --- 巡回本体 ------------------------------------------------------------
  try {
    // ホスト単位でグルーピングし、ホスト間だけ並列にする。
    const groups = new Map<string, SourceConfig[]>();
    for (const source of targets) {
      const key = hostKeyOf(source);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [source]);
      else group.push(source);
    }

    const limit = pLimit(Math.max(1, runtime.hostConcurrency));
    await Promise.all(
      [...groups.entries()].map(([host, group]) =>
        limit(async () => {
          // 同一ホストのソースは直列。HttpClient のアクセス間隔と二重の保険になる(NFR-07)。
          for (const source of group) {
            try {
              await runSource(source);
            } catch (e) {
              // runSource は例外を閉じ込める作りだが、記録処理自体が落ちる可能性に備える。
              // ここで止めると同じホストの後続ソースが巡回されない。
              counts.sourcesFailed += 1;
              errors.push(`ソース ${source.id} の処理中に想定外のエラーが発生しました: ${errorMessage(e)}`);
              logger.error('ソース処理で想定外のエラーが発生しました', {
                sourceId: source.id,
                host,
                error: errorMessage(e),
              });
            }
          }
        }),
      ),
    );

    // --- 分類(§7.1) -----------------------------------------------------
    if (opts?.skipClassify === true) {
      logger.info('分類をスキップしました(--skip-classify)');
    } else {
      try {
        const classifyResult = await classifyPending(ctx);
        counts.classified = classifyResult.classified;
        errors.push(...classifyResult.errors);
      } catch (e) {
        // 分類が丸ごと落ちても収集結果は残す。未分類アイテムは次回の collect で再試行される。
        const message = `分類処理でエラーが発生しました: ${errorMessage(e)}`;
        errors.push(message);
        logger.error('分類処理でエラーが発生しました', { error: errorMessage(e) });
      }
    }
  } catch (e) {
    // 巡回ループの外側(グルーピングや p-limit)で落ちた場合。実行痕跡を failed で確定させてから投げ直す。
    const message = errorMessage(e);
    errors.push(`collect が異常終了しました: ${message}`);
    logger.error('collect が異常終了しました', { error: message });
    run.finishedAt = isoOf(ctx.clock.now());
    run.status = 'failed';
    run.counts = { ...counts };
    run.errors = [...errors];
    await saveRun('異常終了時');
    await notifySafe('error', 'collect: ジョブが異常終了しました', [message]);
    // CLI / Cloud Run Jobs が失敗として扱えるよう、握りつぶさずに投げ直す。
    throw e;
  }

  // --- 結果の確定 ----------------------------------------------------------
  const status: RunStatus = ((): RunStatus => {
    if (counts.sourcesTotal > 0 && counts.sourcesFailed === counts.sourcesTotal) {
      // 全滅は「一部失敗」ではない。ネットワーク遮断や設定事故を partial に埋もれさせない。
      return 'failed';
    }
    if (counts.sourcesFailed > 0 || errors.length > 0) return 'partial';
    return 'succeeded';
  })();

  run.finishedAt = isoOf(ctx.clock.now());
  run.status = status;
  run.counts = { ...counts };
  run.errors = [...errors];
  await saveRun('終了時');

  if (counts.sourcesFailed > 0) {
    await notifySafe(status === 'failed' ? 'error' : 'warn', 'collect: 巡回に失敗したソースがあります', [
      `${counts.sourcesTotal} ソース中 ${counts.sourcesFailed} ソースが失敗しました`,
      ...errors,
    ]);
  }

  logger.info('巡回を終了しました', {
    status,
    sourcesTotal: counts.sourcesTotal,
    sourcesSucceeded: counts.sourcesSucceeded,
    sourcesFailed: counts.sourcesFailed,
    fetched: counts.fetched,
    newItems: counts.newItems,
    updatedItems: counts.updatedItems,
    classified: counts.classified,
    deferred: counts.skipped,
    durationMs: new Date(run.finishedAt).getTime() - startedAtDate.getTime(),
  });

  return run;
}
