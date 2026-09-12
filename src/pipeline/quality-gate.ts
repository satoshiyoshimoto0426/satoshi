/**
 * 品質ゲート(詳細設計書 §8 / 要件定義書 FR-08 / NFR-02)。
 *
 * このモジュールは「AI が生成した文面を、そのまま公衆へ配信してよいか」を判定する最後の関門である。
 * 読者は現場責任者であり、届いた文面を根拠に実務判断をする。したがって次の 2 点を最優先にする。
 *
 *  1. **存在しない出典を配信しない**(Q1 / Q3 / Q2)。
 *     生成 AI は、もっともらしいが実在しない URL を出力しうる。出典が踏めない、あるいは
 *     要約した記事とは別のページを指している配信は、誤情報そのものよりも質が悪い
 *     (読者は「出典付きだから確認済み」と受け取るため)。
 *     そこで「入力アイテムの canonicalUrl 集合に無い URL は無条件で捨てる」を最重要ガードに置く。
 *  2. **助言・推測・断定を配信しない**(Q5)。
 *     本システムは公的情報の要約であって、社会保険労務士や行政書士の業務にあたる助言はしない
 *     (要件定義書 §2.2 / NFR-02)。「〜すべき」「〜でしょう」の一言が、責任範囲を越えさせる。
 *
 * 除外は黙って行わず、必ず `ExcludedEntry`(どのチェックで・なぜ)として呼び出し側へ返す。
 * 運用者が Slack で理由を読めることが、AI の挙動を継続的に監査する唯一の手段になる。
 *
 * 現在時刻は使わない(判定は入力のみに依存する = 同じ入力なら常に同じ結果)。
 */

import pLimit from 'p-limit';
import type { AppContext, ChannelConfig, DigestEntry, ExcludedEntry, Item } from '../types.js';

/**
 * 禁則表現(Q5)。助言・推測・断定にあたる日本語表現を対象にする。
 *
 * - `g` フラグは付けない。`lastIndex` が持ち越されて 2 回目以降の判定を取りこぼすため。
 * - 「推奨します」のように述語込みで書くのは、原文引用(例:「厚生労働省が推奨する取組」)を
 *   誤って落とさないため。ゲートは厳しすぎても事故(配信すべき情報の欠落)になる。
 * - 判定対象は headline / summary / affected / dateNote のみ。sourceUrl は対象外
 *   (URL に 'osusume' 等が含まれていても本文の表現ではない)。
 */
export const BANNED_PATTERNS: RegExp[] = [
  /すべき/, // 「〜すべきです」— 助言
  /おすすめ/, // ひらがな表記の推奨
  /お勧め/, // 漢字表記の推奨
  /お薦め/, // 別表記の推奨
  /しましょう/, // 「必ず確認しましょう」— 行動の指示
  /と考えられ/, // 「〜と考えられます」— 推測
  /と思われ/, // 「〜と思われます」— 推測
  /でしょう/, // 「〜となるでしょう」— 推測・断定
  /可能性が高い/, // 根拠のない蓋然性の評価
  /有利です/, // 損得の評価(助言に直結する)
  /推奨します/, // 明確な助言
  /間違いありません/, // 断定
];

/** Q2 の到達確認タイムアウト(詳細設計書 §8: 10 秒)。 */
const REACHABILITY_TIMEOUT_MS = 10_000;

/**
 * Q2 の同時実行数。
 * `HttpClient` は同一ホストへは直列 + 2 秒間隔(NFR-07)を守るので、ここでの並列は
 * 「異なるホストを同時に叩く」ための上限にすぎない。相手は官公庁サイトなので控えめにする。
 */
const REACHABILITY_CONCURRENCY = 4;

/** Q2 の再試行回数(詳細設計書 §8: 1 回リトライ)。 */
const REACHABILITY_RETRIES = 1;

export interface GateInput {
  channel: ChannelConfig;
  entries: DigestEntry[];
  /** AI に渡した入力アイテム。Q1 / Q3 の正解集合になる。 */
  items: Item[];
}

export interface GateOutput {
  /** 通過した項目。**入力の順序を保つ**(並び順は AI の重要度順の責務)。 */
  entries: DigestEntry[];
  excluded: ExcludedEntry[];
}

/** 入力順を保ったまま合否を集計するための内部表現。 */
interface Judged {
  index: number;
  entry: DigestEntry;
}

interface Rejected {
  index: number;
  excluded: ExcludedEntry;
}

/**
 * 空白のみを「空」とみなす。
 * `String.prototype.trim()` は全角スペース(U+3000)も空白として扱うので、
 * 全角スペースだけで埋められた見出しも空として弾ける。
 */
function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

function toExcluded(entry: DigestEntry, check: string, reason: string): ExcludedEntry {
  return {
    itemId: entry.itemId,
    // 見出しが空でも運用者が項目を特定できるよう、必ず何かを入れる。
    headline: isBlank(entry.headline) ? '(見出しなし)' : entry.headline.trim(),
    sourceUrl: entry.sourceUrl,
    check,
    reason,
  };
}

/** Q5: 禁則表現を含む最初のフィールドと、一致した文字列を返す。 */
function findBannedExpression(entry: DigestEntry): { field: string; matched: string } | null {
  const targets: Array<{ field: string; value: string | null }> = [
    { field: '見出し', value: entry.headline },
    { field: '要点', value: entry.summary },
    { field: '対象', value: entry.affected },
    { field: '日付補足', value: entry.dateNote },
  ];

  for (const target of targets) {
    if (target.value === null) continue;
    for (const pattern of BANNED_PATTERNS) {
      const m = pattern.exec(target.value);
      if (m !== null) return { field: target.field, matched: m[0] };
    }
  }
  return null;
}

/**
 * HTTP を伴わない検査(Q1 / Q3 / Q4 / Q5 / Q8)。
 * ここを先に通し切ることで、落ちると分かっている項目に対する無駄な外部アクセスを避ける
 * (相手サイトへの礼節 = NFR-07、および実行時間の節約)。
 */
function applyStaticChecks(
  entries: DigestEntry[],
  items: Item[],
): { passed: Judged[]; rejected: Rejected[] } {
  const urlSet = new Set(items.map((item) => item.canonicalUrl));
  const itemById = new Map(items.map((item) => [item.id, item]));

  const passed: Judged[] = [];
  const rejected: Rejected[] = [];
  /** Q8: 既に採用済みの出典 URL。 */
  const seenUrls = new Set<string>();

  entries.forEach((entry, index) => {
    const reject = (check: string, reason: string): void => {
      rejected.push({ index, excluded: toExcluded(entry, check, reason) });
    };

    // --- Q1: 出典 URL が入力アイテムの canonicalUrl 集合に含まれるか ---------
    // 最重要ガード。AI が作り出した URL(幻覚)をここで必ず止める。
    if (isBlank(entry.sourceUrl) || !urlSet.has(entry.sourceUrl)) {
      reject(
        'Q1',
        `出典 URL が要約対象アイテムのいずれとも一致しません(実在しない URL を生成した疑い): ${entry.sourceUrl}`,
      );
      return;
    }

    // --- Q3: itemId が実在し、その canonicalUrl が出典 URL と一致するか -------
    // Q1 を通っても「A の記事を要約して B の URL を貼る」取り違えは起こりうる。
    const item = itemById.get(entry.itemId);
    if (item === undefined) {
      reject('Q3', `itemId が要約対象アイテムに存在しません: ${entry.itemId}`);
      return;
    }
    if (item.canonicalUrl !== entry.sourceUrl) {
      reject(
        'Q3',
        `itemId のアイテムと出典 URL が一致しません(アイテム側: ${item.canonicalUrl} / 出典: ${entry.sourceUrl})`,
      );
      return;
    }

    // --- Q4: 必須項目が空でないか -------------------------------------------
    // 空の見出しや要点は、読者から見れば「壊れた配信」でしかない。
    //
    // affected(対象)は意図的に必須にしない(Q4a)。パブリックコメントのように
    // 「影響を受ける対象」が原文から読み取れない種類の情報があり、必須にすると
    // AI に対象を推測させることになる。推測は NFR-02 に反する。
    // 空の場合は line/format 側が「対象:」行ごと省略する。
    const blankField = isBlank(entry.headline)
      ? '見出し'
      : isBlank(entry.summary)
        ? '要点'
        : isBlank(entry.sourceUrl)
          ? '出典 URL'
          : null;
    if (blankField !== null) {
      reject('Q4', `${blankField}が空です`);
      return;
    }

    // --- Q5: 禁則表現(助言・推測・断定)を含まないか -------------------------
    const banned = findBannedExpression(entry);
    if (banned !== null) {
      reject(
        'Q5',
        `${banned.field}に禁則表現「${banned.matched}」を含みます(助言・推測・断定は配信しません)`,
      );
      return;
    }

    // --- Q8: 同一出典 URL の重複(2 件目以降を除外) --------------------------
    if (seenUrls.has(entry.sourceUrl)) {
      reject('Q8', `同じ出典 URL の項目が既にあります(重複): ${entry.sourceUrl}`);
      return;
    }
    seenUrls.add(entry.sourceUrl);

    passed.push({ index, entry });
  });

  return { passed, rejected };
}

/**
 * Q2: 出典 URL の到達確認(要件定義書 FR-08)。
 * 一時的なネットワーク障害で正しい項目を落とさないよう、明らかな恒久的失敗(4xx)以外は 1 回だけ再試行する。
 */
async function checkReachability(
  ctx: AppContext,
  url: string,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  let last = await ctx.http.checkReachable(url, REACHABILITY_TIMEOUT_MS);

  for (let attempt = 0; attempt < REACHABILITY_RETRIES && !last.ok; attempt++) {
    // 404 / 403 など 4xx は何度試しても同じ。再試行はネットワーク起因(status=null)と
    // サーバ側の一時障害(5xx / 429)に限る。
    const transient = last.status === null || last.status >= 500 || last.status === 429;
    if (!transient) break;
    last = await ctx.http.checkReachable(url, REACHABILITY_TIMEOUT_MS);
  }

  return last;
}

/**
 * 品質ゲートを適用する(詳細設計書 §8 の Q1〜Q5・Q8、および Q2 の到達確認)。
 * Q6(件数)と Q7(文字数)は配信本文の組み立てに関わるため summarize / line.format 側が担当する。
 */
export async function applyQualityGate(ctx: AppContext, input: GateInput): Promise<GateOutput> {
  const log = ctx.logger.child({ module: 'quality-gate', channelId: input.channel.id });

  const { passed, rejected } = applyStaticChecks(input.entries, input.items);

  // Q2 は HTTP を伴うので、静的検査を通ったものだけに実施する。
  const limit = pLimit(REACHABILITY_CONCURRENCY);
  const reachability = await Promise.all(
    passed.map((judged) =>
      limit(async () => {
        const result = await checkReachability(ctx, judged.entry.sourceUrl);
        return { judged, result };
      }),
    ),
  );

  const survivors: Judged[] = [];
  for (const { judged, result } of reachability) {
    if (result.ok) {
      survivors.push(judged);
      continue;
    }
    // 到達しない出典は「確認できない情報」であり、配信してはいけない(FR-08)。
    const detail = result.status === null ? (result.error ?? '応答なし') : `status=${result.status}`;
    rejected.push({
      index: judged.index,
      excluded: toExcluded(
        judged.entry,
        'Q2',
        `出典 URL に到達できません(${detail}): ${judged.entry.sourceUrl}`,
      ),
    });
  }

  // 出力順は入力順を保つ。除外一覧も入力順に並べておくと、運用者が本文と突き合わせやすい。
  survivors.sort((a, b) => a.index - b.index);
  rejected.sort((a, b) => a.index - b.index);

  const output: GateOutput = {
    entries: survivors.map((judged) => judged.entry),
    excluded: rejected.map((r) => r.excluded),
  };

  log.info('品質ゲートを適用しました', {
    input: input.entries.length,
    passed: output.entries.length,
    excluded: output.excluded.length,
    // どのチェックで落ちたかの内訳。AI の挙動が変わったときに最初に気づける指標。
    breakdown: output.excluded.reduce<Record<string, number>>((acc, e) => {
      acc[e.check] = (acc[e.check] ?? 0) + 1;
      return acc;
    }, {}),
  });

  return output;
}
