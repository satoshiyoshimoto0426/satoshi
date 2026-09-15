# syntax=docker/dockerfile:1
#
# 制度改正ウォッチ & 公式LINE毎朝配信システムの実行イメージ。
# 詳細設計書 §2.1 の通り、collect / summarize / deliver の 3 ジョブは
# 「同一イメージ・異なる引数」で Cloud Run Jobs から実行する。
#
# なぜマルチステージか:
#   ビルドには TypeScript・tsx・vitest などの devDependencies が必要だが実行時には不要。
#   最終イメージに残すと配布サイズが膨らみ、攻撃面も無駄に広がる(NFR-03)。

# -----------------------------------------------------------------------------
# builder: TypeScript を dist/ にコンパイルする
# -----------------------------------------------------------------------------
FROM node:22-slim AS builder

# corepack がバージョン確認のプロンプトを出すとビルドが無言でハングするため無効化する。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

# pnpm のバージョンは package.json の packageManager フィールドに従う(ここでは固定しない)。
RUN corepack enable

# 依存解決をソースのコピーより先に行う。src/ だけを変更したときに
# install レイヤのキャッシュが効き、ビルド時間を短縮できる。
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# tsconfig.build.json は rootDir=src / outDir=dist(= dist/cli.js が生成される)。
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# -----------------------------------------------------------------------------
# runner: 本番依存 + dist/ + config/ だけを含む実行イメージ
# -----------------------------------------------------------------------------
FROM node:22-slim AS runner

# NODE_ENV=production: 各ライブラリを本番動作にする。
# TZ=Asia/Tokyo: スケジュールと日付境界は JST 基準(NFR-08)。
#   内部保存は ISO8601 UTC のままなので、TZ はログ表示と JST 変換の補助にのみ効く。
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

RUN corepack enable

# 本番依存のみを lockfile 通りに導入する。
# jsdom / @mozilla/readability / unpdf はいずれも純粋な JavaScript 実装で、
# unpdf は canvas に依存しない pdf.js ビルドを同梱しているため、
# 追加の OS パッケージ(libcairo / poppler / tzdata など)は入れない。
#   ※ Node は ICU にタイムゾーンデータを内蔵しているので TZ=Asia/Tokyo も tzdata 無しで機能する。
# pnpm のストアとキャッシュは同じ RUN の中で消す。別の RUN にすると
# 前のレイヤに残ってしまい削除の効果が無いため。
# (ストアは node_modules へのハードリンク元なので、削除しても依存の実体は残る)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile \
    && rm -rf /root/.local/share/pnpm /root/.cache

COPY --from=builder /app/dist ./dist

# config/ はチャネル定義とソース定義の YAML。CONFIG_DIR 未指定時の既定パス(./config)に置く。
COPY config ./config

# 非 root で実行する(NFR-03 の最小権限)。node ユーザ(uid 1000)は node:22-slim に同梱。
RUN chown -R node:node /app
USER node

# サブコマンド(collect / summarize / deliver / validate-config など)は
# Cloud Run Job の args で渡すため CMD は指定しない。
ENTRYPOINT ["node", "dist/cli.js"]
