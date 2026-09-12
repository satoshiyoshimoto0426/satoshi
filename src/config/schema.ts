/**
 * 設定 YAML(`config/channels.yaml` / `config/sources/*.yaml`)の zod スキーマ。
 * 詳細設計書 §4「設定ファイル設計」に対応する。
 *
 * 設計意図:
 * - 情報源の追加・無効化を YAML だけで完結させる(FR-01 / NFR-05)ため、
 *   「書き間違いは起動時に必ず落とす」ことを最優先にしている。
 * - そのため全オブジェクトを `.strict()` にし、未知フィールドをエラーにする。
 *   フィールド名の綴り間違い(例: `itemSelecter`)を黙って無視すると、
 *   「巡回しているのに 0 件」という最も気づきにくい故障になるため。
 * - 出力型は `src/types.ts` の `ChannelConfig` / `SourceConfig` と構造的に一致させる。
 *   ずれを人間のレビューに頼らないよう、ファイル末尾で双方向のコンパイル時アサーションを置いている。
 */
import { z } from 'zod';
import type { ChannelConfig, EgovSourceOptions, HtmlSourceOptions, SourceConfig } from '../types.js';

/**
 * id は Firestore のドキュメント ID や環境変数名(`LINE_TOKEN_<ID大文字>`)の一部になるため、
 * 英小文字・数字・アンダースコアに限定する。
 */
const ID_PATTERN = /^[a-z0-9_]+$/;
const ID_MESSAGE = 'id は英小文字・数字・アンダースコア(_)のみ使用できます(例: mhlw_news_rss)';

/** 配信時刻(JST)。Cloud Scheduler の設定と突き合わせるための記録値(詳細設計書 §10)。 */
const HHMM_PATTERN = /^\d{2}:\d{2}$/;

/** LINE のテキストメッセージ 1 通の上限(FR-09)。これを超える目標値は設定ミス。 */
const LINE_TEXT_LIMIT = 5000;

/** チャネル ID の参照(ソース側の `channels`)。実在チャネルかは validateCrossReferences で見る。 */
const channelRefSchema = z.string().regex(ID_PATTERN, `channels に指定する${ID_MESSAGE}`);

/** HTML 差分監視の抽出設定(詳細設計書 §4.2)。 */
export const HtmlSourceOptionsSchema = z
  .object({
    itemSelector: z
      .string()
      .min(1, 'itemSelector は必須です(新着リンクを列挙する CSS セレクタ。例: "ul.m-listLink li a")'),
    titleFrom: z.enum(['text', 'title', 'aria-label']).default('text'),
    hrefFrom: z.string().min(1, 'hrefFrom は空にできません(既定は "href")').default('href'),
    // 「日付欄が無い」ことは空文字ではなく null で表す(取得できなければ検知日時を使うため)。
    dateSelector: z
      .string()
      .min(1, 'dateSelector は空文字ではなく null を指定してください')
      .nullable()
      .default(null),
    includeUrlPatterns: z.array(z.string()).default([]),
    excludeUrlPatterns: z.array(z.string()).default([]),
  })
  .strict();

/** e-Gov 法令 API の設定(詳細設計書 §4.2)。 */
export const EgovSourceOptionsSchema = z
  .object({
    endpoint: z
      .string()
      .regex(/^https?:\/\//i, 'endpoint は http:// または https:// で始まる URL を指定してください'),
    // lookbackDays に既定値は置かない。何日分を「新着」とみなすかは運用判断であり、
    // 黙って既定値で動くより YAML に明記させたほうが事故が少ないため。
    lookbackDays: z
      .number()
      .int('lookbackDays は整数(日数)で指定してください')
      .min(1, 'lookbackDays は 1 以上で指定してください')
      .max(365, 'lookbackDays は 365 以下で指定してください'),
  })
  .strict();

/** 配信チャネル 1 件(詳細設計書 §4.1)。 */
export const ChannelSchema = z
  .object({
    id: z.string().regex(ID_PATTERN, `チャネル ${ID_MESSAGE}`),
    name: z.string().min(1, 'name は必須です(LINE 公式アカウント名。メッセージ 2 行目に出る)'),
    // Secret Manager のリソース名。環境変数 LINE_TOKEN_<ID大文字> があればそちらが優先される。
    lineTokenSecret: z
      .string()
      .min(1, 'lineTokenSecret は空文字ではなく null を指定してください')
      .nullable()
      .default(null),
    topics: z.string().min(1, 'topics は必須です(AI の分類・要約に渡す話題領域)'),
    relevanceThreshold: z
      .number()
      .min(0, 'relevanceThreshold は 0 以上 1 以下で指定してください')
      .max(1, 'relevanceThreshold は 0 以上 1 以下で指定してください')
      .default(0.6),
    maxItems: z
      .number()
      .int('maxItems は整数で指定してください')
      .min(1, 'maxItems は 1 以上で指定してください')
      .default(7),
    minItems: z
      .number()
      .int('minItems は整数で指定してください')
      .min(0, 'minItems は 0 以上で指定してください')
      .default(3),
    maxChars: z
      .number()
      .int('maxChars は整数で指定してください')
      .min(1, 'maxChars は 1 以上で指定してください')
      .max(
        LINE_TEXT_LIMIT,
        `maxChars は LINE の 1 通あたり上限 ${LINE_TEXT_LIMIT} 文字以下で指定してください`,
      )
      .default(1500),
    // 0 件の日も配信する(FR-11)。受信者が「届かない = 障害」と判別できるようにするため既定 true。
    sendWhenEmpty: z.boolean().default(true),
    deliverAt: z
      .string()
      .regex(HHMM_PATTERN, 'deliverAt は "HH:MM" 形式で指定してください(例: "07:30")')
      .default('07:30'),
    requireApproval: z.boolean().default(false),
  })
  .strict()
  .superRefine((channel, ctx) => {
    // minItems > maxItems は「絞り込みが成立しない」設定ミス。単体では検出できないので横断で見る。
    if (channel.minItems > channel.maxItems) {
      ctx.addIssue({
        code: 'custom',
        path: ['minItems'],
        input: channel.minItems,
        message: `minItems(${channel.minItems})は maxItems(${channel.maxItems})以下である必要があります`,
      });
    }
  });

/** 監視対象ソース 1 件(詳細設計書 §4.2)。 */
export const SourceSchema = z
  .object({
    id: z.string().regex(ID_PATTERN, `ソース ${ID_MESSAGE}`),
    name: z.string().min(1, 'name は必須です(運用ログと通知に出る表示名)'),
    type: z.enum(['rss', 'html', 'egov']),
    // type='egov' は endpoint を使うため url は null。既定 null にして YAML から省略できるようにする。
    url: z.string().min(1, 'url は空文字ではなく null を指定してください').nullable().default(null),
    channels: z
      .array(channelRefSchema)
      .min(1, 'channels は最低 1 件必要です(どのチャネルにも紐付かないソースは巡回しても使われません)'),
    priority: z.enum(['high', 'medium', 'low']).default('medium'),
    // 自治体ソースの地域名(FR-18)。国のソースは null。
    region: z.string().min(1, 'region は空文字ではなく null を指定してください').nullable().default(null),
    enabled: z.boolean().default(true),
    html: HtmlSourceOptionsSchema.nullable().default(null),
    egov: EgovSourceOptionsSchema.nullable().default(null),
    note: z.string().min(1, 'note は空文字ではなく null を指定してください').nullable().default(null),
  })
  .strict()
  .superRefine((source, ctx) => {
    // type ごとに必要な設定が揃っているかを見る。
    // 揃っていないソースは巡回時に必ず失敗するので、起動時に落としたほうが早い。
    if (source.type === 'rss' || source.type === 'html') {
      if (source.url === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          input: source.url,
          message: `type='${source.type}' のソースには url が必須です`,
        });
      }
    }
    if (source.type === 'html' && source.html === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['html'],
        input: source.html,
        message: "type='html' のソースには html(itemSelector など)が必須です",
      });
    }
    if (source.type === 'egov' && source.egov === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['egov'],
        input: source.egov,
        message: "type='egov' のソースには egov(endpoint / lookbackDays)が必須です",
      });
    }
    // type を書き換えたのに古い設定ブロックが残っている場合、その設定は黙って無視される。
    // 「設定したのに効かない」事故を防ぐため明示的にエラーにする。
    if (source.type !== 'html' && source.html !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['html'],
        input: source.html,
        message: `html は type='html' のソースにのみ指定できます(このソースは type='${source.type}')`,
      });
    }
    if (source.type !== 'egov' && source.egov !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['egov'],
        input: source.egov,
        message: `egov は type='egov' のソースにのみ指定できます(このソースは type='${source.type}')`,
      });
    }
  });

/** `config/channels.yaml` のルート。 */
export const ChannelsFileSchema = z
  .object({
    channels: z.array(ChannelSchema).min(1, 'channels に最低 1 件のチャネルを定義してください'),
  })
  .strict();

/** `config/sources/*.yaml` のルート。ファイル単位では 0 件でもよい(複数ファイルに分割するため)。 */
export const SourcesFileSchema = z
  .object({
    sources: z.array(SourceSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// コンパイル時アサーション
// スキーマの出力型と src/types.ts のドメイン型が構造的に一致することを双方向に確認する。
// 片方向だけだと「フィールドの過不足」の一方を見逃すため、必ず両方向を書く。
// ---------------------------------------------------------------------------

type _AssertHtmlFromType = HtmlSourceOptions extends z.infer<typeof HtmlSourceOptionsSchema> ? true : never;
type _AssertHtmlFromSchema = z.infer<typeof HtmlSourceOptionsSchema> extends HtmlSourceOptions ? true : never;
const _htmlA: _AssertHtmlFromType = true;
const _htmlB: _AssertHtmlFromSchema = true;
void _htmlA;
void _htmlB;

type _AssertEgovFromType = EgovSourceOptions extends z.infer<typeof EgovSourceOptionsSchema> ? true : never;
type _AssertEgovFromSchema = z.infer<typeof EgovSourceOptionsSchema> extends EgovSourceOptions ? true : never;
const _egovA: _AssertEgovFromType = true;
const _egovB: _AssertEgovFromSchema = true;
void _egovA;
void _egovB;

type _AssertChannel = ChannelConfig extends z.infer<typeof ChannelSchema> ? true : never;
type _AssertChannelReverse = z.infer<typeof ChannelSchema> extends ChannelConfig ? true : never;
const _channelA: _AssertChannel = true;
const _channelB: _AssertChannelReverse = true;
void _channelA;
void _channelB;

type _AssertSource = SourceConfig extends z.infer<typeof SourceSchema> ? true : never;
type _AssertSourceReverse = z.infer<typeof SourceSchema> extends SourceConfig ? true : never;
const _sourceA: _AssertSource = true;
const _sourceB: _AssertSourceReverse = true;
void _sourceA;
void _sourceB;

type _AssertChannelsFile =
  z.infer<typeof ChannelsFileSchema> extends { channels: ChannelConfig[] } ? true : never;
type _AssertSourcesFile =
  z.infer<typeof SourcesFileSchema> extends { sources: SourceConfig[] } ? true : never;
const _filesA: _AssertChannelsFile = true;
const _filesB: _AssertSourcesFile = true;
void _filesA;
void _filesB;
