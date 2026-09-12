# infra/terraform — 制度改正ウォッチの Google Cloud 基盤

制度改正ウォッチ & 公式LINE毎朝配信システムの実行基盤を Terraform で定義しています。
根拠: `docs/03_詳細設計書.md` §2.1 / §5 / §10 / §11 / §12、`docs/01_要件定義書.md` FR-02・FR-05・FR-10・FR-16・NFR-01・NFR-03・NFR-08。
対応タスク: **M0-03**(プロジェクト・API 有効化)/ **M1-10**(collect のジョブ化 + スケジュール)/ **M2-08**(summarize・deliver のスケジュール)。

## 何が作られるか

| 種別 | リソース | 備考 |
|---|---|---|
| API 有効化 | Run / Scheduler / Firestore / Secret Manager / Artifact Registry / Cloud Build / Logging / Monitoring | `destroy` しても無効化しない |
| コンテナ置き場 | Artifact Registry(Docker, `seido-watch`) | イメージ 1 種類を 3 ジョブで共用 |
| データストア | Firestore(Native, 既定 DB) | 削除保護 ON |
| TTL | `items` / `digests` / `deliveries` / `runs` の `expiresAt` | FR-16 の 90 日保持を Firestore 側で自動削除 |
| 複合インデックス | `items(classifiedAt, detectedAt)` / `runs(date, job, startedAt desc)` | 未分類抽出と実行履歴クエリ用 |
| シークレット | `line-token-ai-reskill` / `line-token-welfare` / `anthropic-api-key` / `slack-webhook-url` | **箱だけ**作る。値は手順 3 で投入 |
| サービスアカウント | `seido-watch-job`(実行用)/ `seido-watch-scheduler`(起動用) | 最小権限 |
| ジョブ | Cloud Run Jobs `seido-watch-collect` / `-summarize` / `-deliver` | 同一イメージ、`args` でサブコマンド切替 |
| スケジュール | Cloud Scheduler ×3(`Asia/Tokyo`) | collect `0 6,12,18,23 * * *` / summarize `0 7 * * *` / deliver `30 7 * * *` |
| 監視 | ログベースメトリクス ×3 + アラートポリシー ×3 | 詳細設計書 §12 の 3 種 |

権限は以下だけです(NFR-03)。

- `seido-watch-job`: `roles/datastore.user` / `roles/logging.logWriter` / `roles/monitoring.metricWriter` と、**シークレット 1 件ごとの** `roles/secretmanager.secretAccessor`。
- `seido-watch-scheduler`: **ジョブ 1 件ごとの** `roles/run.invoker` のみ。

## 前提

- `terraform` 1.5 以上、`gcloud` CLI、`docker`(または Cloud Build)。
- 課金が有効な Google Cloud プロジェクトが作成済みであること(プロジェクト自体はこの構成では作りません)。
- 適用する人が対象プロジェクトの `roles/owner` 相当、または Run / Scheduler / Firestore / Secret Manager / Artifact Registry / Monitoring / IAM の管理権限を持つこと。
- 既定リージョンは `asia-northeast1`(東京)。Firestore のロケーションは**作成後に変更できない**ので、初回に確定させること。

```bash
gcloud auth login
gcloud auth application-default login   # Terraform はこの資格情報を使う
gcloud config set project <PROJECT_ID>
```

---

## 初回適用手順

シークレットの値とコンテナイメージは Terraform の管理対象外です。
Cloud Run はデプロイ時に **イメージの存在** と **シークレットへのアクセス可否・バージョンの存在** を検証するため、
**「箱を作る → 中身を入れる → ジョブを作る」の 3 段階**で適用します。

### 0. 変数ファイルを用意する

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars          # project_id と image を埋める
terraform init
```

`image` にはこれから push する URI を先に書いておきます(形式は手順 2 のとおり)。

`terraform init` が生成する `.terraform.lock.hcl` は**コミットしてください**(プロバイダのバージョンと
チェックサムを固定し、全員・CI で同じプロバイダを使うため)。`.terraform/` と `terraform.tfvars` は
`.gitignore` 済みです。

### 1. API・レジストリ・シークレットの「箱」だけ先に作る

```bash
terraform apply \
  -target=google_project_service.services \
  -target=google_artifact_registry_repository.docker \
  -target=google_secret_manager_secret.secrets
```

> API 有効化の反映に数十秒かかることがあります。`API has not been used in project ...` で失敗したら、
> 1〜2 分おいて同じコマンドを再実行してください。

### 2. イメージのビルドと push

リポジトリのルート(`package.json` のある階層)で実行します。

```bash
# 認証(初回のみ)
gcloud auth configure-docker asia-northeast1-docker.pkg.dev

PROJECT_ID=<PROJECT_ID>   # terraform.tfvars の project_id と同じ値
IMAGE="asia-northeast1-docker.pkg.dev/${PROJECT_ID}/seido-watch/seido-watch:$(date +%Y%m%d-%H%M)"

# ローカルでビルドして push(Apple Silicon などでは --platform の指定が必須)
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
echo "$IMAGE"
```

Cloud Build を使う場合(ローカルに docker が無いとき):

```bash
gcloud builds submit --tag "$IMAGE" .
```

push した URI を `terraform.tfvars` の `image` に反映します。
運用ではタグではなく**ダイジェスト固定**を推奨します(同じタグの中身が入れ替わる事故を防ぐため)。

```bash
gcloud artifacts docker images describe "$IMAGE" --format='value(image_summary.fully_qualified_digest)'
# 例: asia-northeast1-docker.pkg.dev/PROJECT/seido-watch/seido-watch@sha256:....
```

> リポジトリルートの `Dockerfile` は `WORKDIR /app`、`config/` を `/app/config` に配置し、
> `ENTRYPOINT ["node", "dist/cli.js"]` になっています。Terraform 側はこれに合わせて
> `CONFIG_DIR=/app/config` を渡し、`args` に `collect` / `summarize` / `deliver` を指定して
> サブコマンドを切り替えます(Dockerfile の構成を変える場合は `main.tf` の `common_env` も合わせること)。

### 3. シークレット値の投入

**値をコマンドライン引数に書かないでください**(シェル履歴とプロセス一覧に残ります)。
標準入力から渡します。`printf` を使うのは、`echo` が付ける末尾改行をトークンに混入させないためです。

```bash
PROJECT_ID=<PROJECT_ID>

# LINE チャネルアクセストークン(長期)× 2 … M0-01
printf '%s' '<AIリスキリング制度情報局のトークン>' | \
  gcloud secrets versions add line-token-ai-reskill --project="$PROJECT_ID" --data-file=-

printf '%s' '<就労支援、放課後デイ情報局のトークン>' | \
  gcloud secrets versions add line-token-welfare --project="$PROJECT_ID" --data-file=-

# Anthropic API キー … M0-02
printf '%s' '<sk-ant-...>' | \
  gcloud secrets versions add anthropic-api-key --project="$PROJECT_ID" --data-file=-

# Slack Incoming Webhook URL … M3-02
printf '%s' 'https://hooks.slack.com/services/...' | \
  gcloud secrets versions add slack-webhook-url --project="$PROJECT_ID" --data-file=-
```

ファイルから入れる場合は、投入後に必ず消してください。

```bash
gcloud secrets versions add anthropic-api-key --project="$PROJECT_ID" --data-file=./key.txt
shred -u ./key.txt   # または rm -P / rm
```

投入できたかの確認(値は表示しない):

```bash
for s in line-token-ai-reskill line-token-welfare anthropic-api-key slack-webhook-url; do
  printf '%s: ' "$s"
  gcloud secrets versions list "$s" --project="$PROJECT_ID" --filter='state=ENABLED' --format='value(name)' | head -1
done
```

4 つすべてに **ENABLED なバージョンが 1 つ以上**必要です。Cloud Run はジョブ作成時に参照先バージョンの存在を
検証するため、1 つでも欠けると手順 4 のジョブ作成が失敗します。
Slack 通知を当面使わない場合は、ダミー値を入れるのではなく `main.tf` の各ジョブの `secret_env` から
`SLACK_WEBHOOK_URL` を外してください(未設定なら通知はログ出力のみになります)。

### 4. 全体を適用する

```bash
terraform apply
terraform output
```

ここで Cloud Run Jobs 3 つ、Cloud Scheduler 3 つ、ログメトリクス 3 つ、アラート 3 つが作られます。

### 5. 通知チャネルの作成(アラートの通知先)

アラートポリシーは `notification_channel_ids` が空でも作成されますが、通知は飛びません。
Slack へ通知する場合は、先に Cloud Monitoring の Slack 通知チャネルを作成し、その ID を変数に渡します。

```bash
# メールの例(Slack は Cloud Console > Monitoring > アラート > 通知チャネル から OAuth 連携が必要)
gcloud beta monitoring channels create \
  --project="$PROJECT_ID" \
  --display-name="制度改正ウォッチ運用" \
  --type=email \
  --channel-labels=email_address=ops@example.com

# 作成済みチャネルの一覧(name をそのまま tfvars に入れる)
gcloud beta monitoring channels list --project="$PROJECT_ID" --format='value(name,displayName)'
```

`terraform.tfvars` の `notification_channel_ids` に追記して `terraform apply` を再実行します。

### 6. 動作確認

```bash
REGION=asia-northeast1

# 手動でジョブを 1 回実行(--wait で完了まで待つ)
gcloud run jobs execute seido-watch-collect --region="$REGION" --project="$PROJECT_ID" --wait

# スケジューラ経由の起動経路を確認(本来の時刻を待たずに叩く)
gcloud scheduler jobs run seido-watch-collect-trigger --location="$REGION" --project="$PROJECT_ID"

# ログ確認
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="seido-watch-collect"' \
  --project="$PROJECT_ID" --limit=50 --format='value(timestamp,severity,jsonPayload.msg)'
```

配信の確認は、まず影響のない `--dry-run`(`DRY_RUN=true`)で行うことを推奨します。
ジョブの引数はワンショットで上書きできます。

```bash
gcloud run jobs execute seido-watch-deliver --region="$REGION" --project="$PROJECT_ID" \
  --args=deliver,--dry-run --wait
```

---

## 運用メモ

### スケジュール(すべて JST / NFR-08)

| ジョブ | cron | タイムアウト | 内容 |
|---|---|---|---|
| `seido-watch-collect` | `0 6,12,18,23 * * *` | 1200s | 巡回・本文取得・分類(FR-02) |
| `seido-watch-summarize` | `0 7 * * *` | 600s | 直近 24 時間のダイジェスト生成(FR-05) |
| `seido-watch-deliver` | `30 7 * * *` | 300s | LINE ブロードキャスト(FR-10) |

Cloud Scheduler のリトライは 3 回ですが、これは**起動 API の呼び出し**に対するリトライです。
ジョブ本体の失敗は Cloud Run Jobs の `max_retries = 3` で再試行されます(NFR-01)。

### キーローテーション(LINE トークン / API キー)

ジョブは `version = "latest"` を参照しているため、**新バージョンを追加するだけ**で次回実行から反映されます。
再デプロイは不要です。

```bash
printf '%s' '<新しいトークン>' | gcloud secrets versions add line-token-welfare --project="$PROJECT_ID" --data-file=-
# 反映を確認したら旧バージョンを無効化する
gcloud secrets versions disable <旧バージョン番号> --secret=line-token-welfare --project="$PROJECT_ID"
```

### アラート(詳細設計書 §12)

| ポリシー | 条件 | 意味 |
|---|---|---|
| ジョブ失敗 | `seido_watch_job_error` > 0 | 3 ジョブのいずれかが ERROR ログを出した |
| ソース連続失敗 | `seido_watch_source_consecutive_failure` > 0 | 同一ソースが 3 回連続で巡回失敗(ページ構造変更の疑い) |
| 配信未確認 | `seido_watch_deliver_success` と Cloud Run のタスク成功メトリクスがともに 24 時間途絶 | 当日の配信が行われていない |

アラートはアプリの構造化ログ(`jsonPayload`)の形に依存します。ログ側を変えるときは `main.tf` の
`google_logging_metric` も合わせて見直してください。前提にしているフィールドは次の 3 つです。

| 使う場所 | 前提 |
|---|---|
| ジョブ失敗 | ジョブ全体の異常は `severity=ERROR` で出る。**1 ソースだけの失敗は `sourceId` を含める**(このログはジョブ失敗アラートから除外される) |
| ソース連続失敗 | 連続失敗の警告ログに `consecutiveFailures`(数値)と `sourceId` を含める |
| 配信未確認 | deliver は正常終了時に `job="deliver"` と `status="succeeded"` を含むログを 1 行出す |

ジョブ失敗アラートから `sourceId` 付きのログを除いているのは、「1 件の失敗が全体を止めない」設計
(詳細設計書 §6.1)に合わせるためです。単発のソース失敗で毎晩呼び出されると警報が形骸化します。
ソース側の異常は連続失敗 3 回の警告で拾います。

配信未確認アラートについての注意:

- 0 件の日も「新着はありません」を必ず配信する(FR-11)ため、**配信ログが無い = 異常**と断定できます。
- `absence` 条件は「直近 24 時間データが無い」ときに発火します。deliver は毎日 07:30 に 1 回動くので、
  前日の成功から 24 時間後 ≒ 当日 07:30〜07:45 に発火します(§12 の「07:45 時点」に対応)。
- `absence` は**過去に 1 度でもデータがある時系列**にしか働きません。構築直後は deliver を 1 回成功させるまで
  この見張りは効きません。初回適用後に必ず 1 回手動実行してください。
- ログベースの条件はアプリのログ形式(`jsonPayload.job="deliver"` / `jsonPayload.status="succeeded"`)に依存します。
  形式が変わっても Cloud Run のタスク成功メトリクス側の条件で検知は継続します。

### コスト(NFR-04)

Cloud Run Jobs は実行時間課金、Firestore と Secret Manager は小規模利用、Cloud Scheduler は 3 ジョブ(無料枠内)。
`RETENTION_DAYS=90` の TTL により Firestore のデータ量は頭打ちになります。
Artifact Registry のイメージは放置すると増え続けるので、古いタグは定期的に削除してください。

```bash
gcloud artifacts docker images list asia-northeast1-docker.pkg.dev/"$PROJECT_ID"/seido-watch \
  --include-tags --sort-by=~UPDATE_TIME
gcloud artifacts docker images delete <IMAGE@sha256:...> --delete-tags
```

### 破棄

Firestore は削除保護が有効で、`deletion_policy = "ABANDON"`(Terraform からは切り離すだけでデータは残す)です。
本当に消す場合のみ、手動で保護を外してから削除してください。

```bash
terraform destroy     # Firestore のデータは残る
# データごと消す場合のみ:
gcloud firestore databases update --database='(default)' --no-delete-protection --project="$PROJECT_ID"
gcloud firestore databases delete --database='(default)' --project="$PROJECT_ID"
```

---

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `Error creating Job: ... image not found` | 手順 2 のイメージ push が済んでいない、またはタグ違い。`terraform output image_uri_example` と `var.image` を突き合わせる |
| `Error creating Job: ... Secret projects/.../versions/latest was not found` | 手順 3 のシークレットバージョン投入漏れ。4 つすべてに ENABLED なバージョンが必要 |
| `Permission 'secretmanager.versions.access' denied` | `seido-watch-job` への IAM 付与前にジョブが作られた。`terraform apply` を再実行する |
| Scheduler が `PERMISSION_DENIED` / `UNAUTHENTICATED` | 同一プロジェクトなら通常不要だが、OAuth トークン生成が拒否される場合は Cloud Scheduler サービスエージェント (`service-<プロジェクト番号>@gcp-sa-cloudscheduler.iam.gserviceaccount.com`) に `roles/iam.serviceAccountTokenCreator` を `seido-watch-scheduler` に対して付与する |
| `google_firestore_database` の作成が `ALREADY_EXISTS` | 既定 DB が既にある。`terraform import google_firestore_database.default projects/<PROJECT_ID>/databases/'(default)'` で取り込む |
| TTL が効かない | Firestore の TTL は**最大 24 時間程度の遅延**がある。コンソールの「TTL」タブで `expiresAt` が `Active` か確認する |
| アラートが飛ばない | `notification_channel_ids` が空、または Slack 連携が未認可。手順 5 を確認する |
