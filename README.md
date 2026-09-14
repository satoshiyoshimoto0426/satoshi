# 制度改正ウォッチ & 公式LINE毎朝配信システム

AI リスキリング制度と、就労支援事業所・放課後等デイサービスの制度改正情報を
公的サイトから自動収集し、**AI が日次のまとめを作って毎朝 LINE 公式アカウントへ配信**します。

- 機械的に全記事を流しません。**まとめのみ**を配信します。
- **すべての項目に出典 URL** を付け、配信前にリンクの実在を検証します。
- **新着が 0 件の日も配信します**。届かない日は障害だと判別できるようにするためです。

| 配信先 | チャネル ID | 扱う領域 |
|---|---|---|
| AI リスキリング制度情報局 | `ai_reskill` | 人材開発支援助成金、教育訓練給付、リスキリング施策、AI 関連法制 |
| 就労支援、放課後デイ情報局 | `welfare` | 障害福祉サービス等報酬改定、指定基準、就労選択支援、放課後等デイサービス、7 都府県の自治体通知 |

---

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/01_要件定義書.md](docs/01_要件定義書.md) | 背景・機能要件・非機能要件・監視対象情報源 |
| [docs/02_タスク管理書.md](docs/02_タスク管理書.md) | マイルストーンとタスク一覧、決定事項ログ |
| [docs/03_詳細設計書.md](docs/03_詳細設計書.md) | アーキテクチャ・データモデル・AI 設計・品質ゲート |
| [docs/04_運用手順書.md](docs/04_運用手順書.md) | 日常運用・障害対応・デプロイ・初回セットアップ |
| [docs/05_品質監査チェックリスト.md](docs/05_品質監査チェックリスト.md) | 週次 10 分の抜き取り監査手順 |

---

## しくみ

```
Cloud Scheduler
  ├─ 06/12/18/23時 ─→ collect    情報源を巡回 → 本文抽出 → 重複排除 → AI が分類
  ├─ 07:00        ─→ summarize  直近24時間を集約 → AI がまとめ生成 → 品質ゲート
  └─ 07:30        ─→ deliver    LINE 公式アカウントへブロードキャスト
```

3 つのジョブは独立して再実行でき、状態は Firestore に永続化されます。
すべて冪等なので、同じ日に何度実行しても配信は 1 通だけです。

### 誤情報を防ぐ二重のガード

AI が出典 URL を捏造しないよう、2 段で止めています。

1. AI には収集済みの本文と URL だけを渡し、外部検索をさせません。プロンプトで
   「入力に含まれない URL を出力してはならない」と制約します。
2. 生成後、プログラムが 8 項目の品質ゲートで検証します。入力に無い URL、到達しない URL、
   助言表現を含む要約は配信から除外し、除外理由を記録して Slack に通知します。

元記事があったのに品質ゲートで全滅した場合は、「新着なし」と偽らず**障害として扱います**。

---

## ローカルでの動かし方

```bash
pnpm install
cp .env.example .env        # 値を埋める

pnpm cli validate-config    # 設定 YAML の検証
pnpm test                   # ユニット・結合テスト
pnpm typecheck && pnpm lint
```

ネットワークに出したくない場合は `DRY_RUN=true` を付けます。
LINE 送信・Slack 通知は行われず、AI もスタブになります。

```bash
DRY_RUN=true STORE_KIND=memory pnpm cli summarize --date 2026-09-12
DRY_RUN=true STORE_KIND=memory pnpm cli preview   --date 2026-09-12
```

---

## コマンド

| コマンド | 用途 |
|---|---|
| `pnpm cli collect` | 情報源を巡回して新着を取り込み、AI が分類する |
| `pnpm cli collect --bootstrap` | 初回登録時。既存記事を「既知」にして翌朝の配信に流さない |
| `pnpm cli summarize --date <日付>` | 指定日のまとめを生成する |
| `pnpm cli preview --date <日付>` | 配信予定の文面を標準出力で確認する |
| `pnpm cli deliver --date <日付>` | LINE へ配信する(冪等) |
| `pnpm cli approve --date <日付> --channel <id>` | 承認モード時に配信を承認する |
| `pnpm cli validate-config` | 設定 YAML を検証する |
| `pnpm cli verify-sources [--fix]` | 全ソースの到達確認とセレクタ検証 |
| `pnpm cli health` | 連続失敗しているソースを表示する |

---

## 情報源を追加する

コード変更は不要です。`config/sources/` の YAML に 1 ブロック追記します。

```yaml
  - id: wf_example_new
    name: ○○県 障害福祉課 事業者向けお知らせ
    type: html
    url: https://www.pref.example.lg.jp/shogai/jigyosha.html
    channels: [welfare]
    priority: medium
    region: ○○県
    enabled: true
    html:
      itemSelector: 'main a'
      includeUrlPatterns: ['/shogai/']
      excludeUrlPatterns: ['javascript:', '#', 'twitter.com']
    note: ○○県の指定基準・独自加算の変更を検知する
```

追加後に `pnpm cli validate-config` と `pnpm cli verify-sources --source wf_example_new`、
そして `pnpm cli collect --source wf_example_new --bootstrap` を実行してください。

現在の登録数: 国 26 件 / 都府県庁 7 件 / 政令市等 12 件 = **45 件**。

---

## デプロイ

**`main` へ push すると自動でデプロイされます。**
GitHub Actions が検証 → イメージのビルド → Terraform 適用 → 疎通確認(送信なし)まで行います。
pull request では `terraform plan` の差分が出るだけで、適用はされません。

初回だけ設定が必要です。**Google Cloud Shell(ブラウザ)で実行するのがいちばん簡単です。**
インストールは不要で、gcloud が最初から使えます。
Windows の PowerShell では bash スクリプトが動かないので注意してください。

Google Cloud コンソールの右上にあるターミナルのアイコン(`>_`)を開き、次を実行します。

```bash
git clone https://github.com/satoshiyoshimoto0426/satoshi.git
cd satoshi
export PROJECT_ID=<Google Cloud のプロジェクト ID>

bash infra/bootstrap.sh      # API 有効化・状態バケット・権限・鍵なし認証・シークレットの箱
bash scripts/set-secrets.sh  # トークンの値を投入(画面に表示されません)
```

最後に表示されるリポジトリ変数 5 つを GitHub の
`Settings > Secrets and variables > Actions > Variables` に設定すれば完了です。

認証はサービスアカウントキーではなく Workload Identity 連携を使うため、
**鍵を GitHub に置きません。** トークンと API キーは Secret Manager にだけ入り、
git にも CI にも残りません。

詳細は [docs/04_運用手順書.md](docs/04_運用手順書.md) の §6 を参照してください。

---

## 本番投入の前に必ず行うこと

**`config/sources/*.yaml` の URL と CSS セレクタは実地検証できていません。**
開発環境から官公庁サイトへ接続できなかったためです。デプロイ先で必ず実行してください。

```bash
pnpm cli verify-sources        # NG があれば終了コード 1
pnpm cli verify-sources --fix  # NG を enabled: false に自動変更
```

NG のソースは URL とセレクタを修正してから有効化します。
この作業を省くと「巡回しているつもりで何も取れていない」状態になります。

詳細は [docs/04_運用手順書.md](docs/04_運用手順書.md) の §7 と §8 を参照してください。

---

## 構成

```
config/            チャネル定義と情報源定義(YAML)
src/
  types.ts         全モジュール共通のドメイン型
  config/          YAML スキーマ(zod)と読込
  util/            URL正規化・ハッシュ・JST時刻・リトライ・robots準拠HTTPクライアント
  fetchers/        RSS / HTML差分 / e-Gov API / 本文抽出(HTML・PDF)
  store/           Firestore と インメモリ(テスト用)
  ai/              分類・要約のプロンプトと構造化出力
  line/            メッセージ整形とブロードキャスト送信
  notify/          Slack 通知
  pipeline/        collect / classify / summarize / quality-gate / deliver
  cli.ts           エントリポイント
infra/terraform/   Cloud Run Jobs / Scheduler / Firestore / Secret Manager / 監視
infra/bootstrap.sh デプロイ自動化の初期設定(1 回だけ実行)
scripts/           シークレット投入などの運用スクリプト
test/              ユニット・結合テスト
```

## 技術スタック

TypeScript (Node 22) / Google Cloud (Cloud Run Jobs, Cloud Scheduler, Firestore, Secret Manager) /
Anthropic Claude / LINE Messaging API / Terraform
