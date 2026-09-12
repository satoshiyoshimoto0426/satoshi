/**
 * 未分類アイテムの AI 分類(詳細設計書 §7.1 / FR-04)。
 *
 * collect の最後に呼ばれるほか、分類だけ流し直したいときにも単独で使える。
 *
 * 設計上の判断:
 * 1. **20 件ずつのバッチ**で AI に投げる(§7.1)。1 件ずつ呼ぶとシステムプロンプト分の
 *    トークンが件数分かかり NFR-04(コスト目標)を守れない。逆に大きくしすぎると
 *    1 回の失敗で落ちる件数が増え、出力の JSON も長くなって max_tokens に当たりやすい。
 * 2. **バッチ間は直列**。AI 側のレート制限に当てないためと、失敗したバッチを
 *    「そのバッチだけ」の問題として切り分けられるようにするため。
 * 3. **1 バッチの失敗は他バッチを止めない**。分類は次回の巡回でも再試行できる
 *    (classifiedAt が null のまま残るため)。ここで例外を投げると、
 *    せっかく成功した他バッチの書き込みまで道連れになる。
 * 4. **応答に含まれない id はエラーにしない**。AI が一部のアイテムを落として返しても、
 *    そのアイテムは未分類のまま次回に回る。件数だけはログに残して、
 *    「毎回同じ件数が取りこぼされている」ことに運用者が気付けるようにする。
 */

import type { AppContext, ClassifyChannelInfo, ClassifyInputItem, Item } from '../types.js';
import { isoOf } from '../util/time.js';

/** 1 リクエストにまとめる件数(詳細設計書 §7.1)。 */
const BATCH_SIZE = 20;

/** 1 回の呼び出しで処理する未分類アイテムの既定上限。 */
const DEFAULT_LIMIT = 200;

/** AI に渡す本文の先頭文字数(詳細設計書 §7.1)。 */
const EXCERPT_CHARS = 1500;

/** 例外から人が読めるメッセージを取り出す(スタックはログの debug に留める)。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 未分類アイテムを AI で分類し、結果を items に書き戻す。
 *
 * @param limit 一度に処理する未分類アイテムの上限(既定 200)。
 * @returns 書き込めた件数と、バッチ単位の失敗理由(日本語)。例外は投げない。
 */
export async function classifyPending(
  ctx: AppContext,
  limit?: number,
): Promise<{ classified: number; errors: string[] }> {
  const logger = ctx.logger.child({ job: 'classify' });
  const errors: string[] = [];
  let classified = 0;

  const items = await ctx.store.listUnclassifiedItems(limit ?? DEFAULT_LIMIT);
  if (items.length === 0) {
    logger.info('未分類のアイテムはありません');
    return { classified, errors };
  }

  const channels: ClassifyChannelInfo[] = ctx.config.channels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    topics: channel.topics,
  }));
  if (channels.length === 0) {
    // チャネルが無いと AI は「どのチャネル向けか」を答えようがない。
    // 黙って 0 件成功にすると設定ミスに気付けないため、理由を返す。
    const message = 'チャネル定義が 0 件のため分類を実行できません(config/channels.yaml を確認してください)';
    logger.error(message, { pending: items.length });
    return { classified, errors: [message] };
  }

  /** ソース名は AI の判断材料(§7.1 の入力)。config から引く。 */
  const sourceNames = new Map(ctx.config.sources.map((source) => [source.id, source.name]));
  /** 設定にあるチャネル ID。AI が知らない ID を返していないかの検査に使う。 */
  const knownChannelIds = new Set(channels.map((channel) => channel.id));

  const batches: Item[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }
  logger.info('未分類アイテムの分類を開始します', { pending: items.length, batches: batches.length });

  for (const [index, batch] of batches.entries()) {
    const batchNo = index + 1;
    const blog = logger.child({ batch: batchNo, batchTotal: batches.length });
    try {
      const inputs: ClassifyInputItem[] = batch.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.canonicalUrl,
        // 本文が取れていないアイテム(PDF 抽出失敗・robots 不許可など)は空文字のまま渡し、
        // タイトルだけで判定させる。ここで捏造した文章を足すと NFR-02(正確性)に反する。
        excerpt: item.contentText.slice(0, EXCERPT_CHARS),
        region: item.region,
        sourceName: sourceNames.get(item.sourceId) ?? item.sourceId,
      }));

      const { results, meta } = await ctx.ai.classify(inputs, channels);
      const byId = new Map(results.map((result) => [result.id, result.classification]));

      let missing = 0;
      for (const item of batch) {
        const classification = byId.get(item.id);
        if (classification === undefined) {
          // 応答に含まれなかった = 今回は判定できなかっただけ。未分類のまま次回に回す。
          missing += 1;
          continue;
        }
        const unknown = classification.channels.filter((id) => !knownChannelIds.has(id));
        if (unknown.length > 0) {
          // 保存はする(監査のため AI の出力をそのまま残す)が、設定と食い違っている事実は残す。
          blog.warn('未知のチャネル ID を含む分類結果です', { itemId: item.id, channels: unknown });
        }
        const now = isoOf(ctx.clock.now());
        await ctx.store.putItem({ ...item, classification, classifiedAt: now, updatedAt: now });
        classified += 1;
      }

      if (missing > 0) {
        // エラーにはしないが、取りこぼしが常態化していないか運用者が見られるようにする。
        blog.warn('応答に含まれなかったアイテムがあります(次回の分類に回します)', {
          missing,
          requested: batch.length,
        });
      }
      blog.info('バッチの分類が完了しました', {
        requested: batch.length,
        applied: batch.length - missing,
        model: meta.model,
        inputTokens: meta.usage?.inputTokens ?? 0,
        outputTokens: meta.usage?.outputTokens ?? 0,
      });
    } catch (e) {
      // このバッチだけを失敗として記録し、残りのバッチは続行する。
      const message = `分類バッチ ${batchNo}/${batches.length}(${batch.length} 件)に失敗しました: ${errorMessage(e)}`;
      errors.push(message);
      blog.error('バッチの分類に失敗しました', { error: errorMessage(e), count: batch.length });
    }
  }

  logger.info('分類を終了しました', { classified, pending: items.length, errors: errors.length });
  return { classified, errors };
}
