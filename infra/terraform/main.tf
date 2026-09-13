# 制度改正ウォッチ & 公式LINE毎朝配信システム — Google Cloud 基盤
#
# 根拠:
#   docs/03_詳細設計書.md §2.1(コンポーネント)/ §5(データモデル・TTL)
#                        §10(スケジュール)/ §11(セキュリティ)/ §12(観測性・アラート)
#   docs/01_要件定義書.md FR-02 / FR-05 / FR-10 / FR-12 / FR-16 / NFR-01 / NFR-03 / NFR-08
# 対応タスク: M0-03(プロジェクト・API 有効化)/ M1-10(collect のジョブ化)/ M2-08(summarize・deliver のスケジュール)
#
# 適用手順は README.md を参照。イメージとシークレット値は Terraform では作らない。

provider "google" {
  project = var.project_id
  region  = var.region
}

# ---------------------------------------------------------------------------
# 共通定義
# ---------------------------------------------------------------------------

locals {
  # リソース名の接頭辞。プロジェクト内で本システムのリソースを一目で識別するため。
  name_prefix = "seido-watch"

  # 有効化する API(詳細設計書 §2.1 のコンポーネントに対応)。
  services = [
    "run.googleapis.com",
    "cloudscheduler.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]

  # Secret Manager のシークレット ID。値(バージョン)は Terraform では作らない。
  # tfstate に秘密情報を残さないため(NFR-03 / 詳細設計書 §11)。
  secret_ids = {
    line_token_ai_reskill = "line-token-ai-reskill"
    line_token_welfare    = "line-token-welfare"
    anthropic_api_key     = "anthropic-api-key"
    slack_webhook_url     = "slack-webhook-url"
  }

  # expiresAt に TTL を設定するコレクション(詳細設計書 §5 / FR-16: 90 日保持)。
  # source_state は expiresAt を持たない(常に最新状態を保持する)ため対象外。
  ttl_collections = ["items", "digests", "deliveries", "runs"]

  # 3 ジョブ共通の環境変数。名前は src/config/runtime.ts / src/config/load.ts が読むものと一致させること。
  # 秘密情報はここには置かない(下の secret_env で Secret Manager から注入する)。
  common_env = {
    GCP_PROJECT_ID           = var.project_id
    FIRESTORE_DATABASE_ID    = google_firestore_database.default.name
    STORE_KIND               = "firestore"
    CONFIG_DIR               = "/app/config"
    ANTHROPIC_MODEL          = "claude-opus-5"
    USER_AGENT               = "SeidoWatchBot/1.0 (+mailto:ops@example.com)"
    HOST_DELAY_MS            = "2000" # NFR-07: 同一ホストへは 2 秒以上あける
    HOST_CONCURRENCY         = "4"
    HTTP_TIMEOUT_MS          = "20000"
    MAX_NEW_ITEMS_PER_SOURCE = "50"
    MAX_CONTENT_CHARS        = "6000"
    RETENTION_DAYS           = "90"
    DRY_RUN                  = "false"
  }

  # 3 ジョブの定義。同一イメージを args のサブコマンドで切り替える(詳細設計書 §2.1)。
  # timeout / schedule は詳細設計書 §10 の表どおり。
  jobs = {
    collect = {
      display     = "収集"
      description = "情報源を巡回して items を更新し、未分類アイテムを分類する(詳細設計書 §6.1)"
      args        = ["collect"]
      timeout     = "1200s" # 20 分
      cpu         = "1"
      memory      = "2Gi" # jsdom/Readability と PDF 抽出があるため大きめに取る
      schedule    = "0 6,12,18,23 * * *"
      secret_env = tomap({
        ANTHROPIC_API_KEY = local.secret_ids.anthropic_api_key
        SLACK_WEBHOOK_URL = local.secret_ids.slack_webhook_url
      })
    }
    summarize = {
      display     = "要約"
      description = "チャネルごとに当日のダイジェストを生成する(詳細設計書 §6.2)"
      args        = ["summarize"]
      timeout     = "600s" # 10 分
      cpu         = "1"
      memory      = "1Gi"
      schedule    = "0 7 * * *"
      secret_env = tomap({
        ANTHROPIC_API_KEY = local.secret_ids.anthropic_api_key
        SLACK_WEBHOOK_URL = local.secret_ids.slack_webhook_url
      })
    }
    deliver = {
      display     = "配信"
      description = "生成済みダイジェストを LINE 公式アカウントへブロードキャストする(詳細設計書 §6.3)"
      args        = ["deliver"]
      timeout     = "300s" # 5 分
      cpu         = "1"
      memory      = "512Mi"
      schedule    = "30 7 * * *"
      # deliver は AI を呼ばないので Anthropic キーは注入しない(最小権限)。
      secret_env = tomap({
        LINE_TOKEN_AI_RESKILL = local.secret_ids.line_token_ai_reskill
        LINE_TOKEN_WELFARE    = local.secret_ids.line_token_welfare
        SLACK_WEBHOOK_URL     = local.secret_ids.slack_webhook_url
      })
    }
  }
}

# ---------------------------------------------------------------------------
# API 有効化(M0-03)
# ---------------------------------------------------------------------------

resource "google_project_service" "services" {
  for_each = toset(local.services)

  project = var.project_id
  service = each.value

  # destroy でうっかり API を無効化すると、同一プロジェクトの他資産まで壊れるため無効化しない。
  disable_on_destroy         = false
  disable_dependent_services = false
}

# ---------------------------------------------------------------------------
# Artifact Registry(コンテナイメージ置き場)
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "docker" {
  project       = var.project_id
  location      = var.region
  repository_id = local.name_prefix
  format        = "DOCKER"
  description   = "制度改正ウォッチのジョブイメージ"

  labels = {
    app = local.name_prefix
  }

  depends_on = [google_project_service.services]
}

# ---------------------------------------------------------------------------
# Firestore(Native モード)
# ---------------------------------------------------------------------------

resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  concurrency_mode            = "OPTIMISTIC"
  app_engine_integration_mode = "DISABLED"

  # 監査データ(FR-16)が入るため、誤削除を防ぐ。破棄する場合は README の手順で明示的に解除する。
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"

  depends_on = [google_project_service.services]
}

# TTL ポリシー(FR-16: 監査データ 90 日保持 / 詳細設計書 §5)。
# アプリ側が各ドキュメントの expiresAt に「作成時刻 + RETENTION_DAYS」を入れ、
# Firestore がその時刻を過ぎたドキュメントを自動削除する。
resource "google_firestore_field" "ttl" {
  for_each = toset(local.ttl_collections)

  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = each.value
  field      = "expiresAt"

  ttl_config {}

  # index_config は指定しない。空ブロックを書くと当該フィールドの単一フィールドインデックスが
  # すべて無効化され、既存クエリが壊れるため。
}

# 複合インデックス。単一フィールドの自動インデックスでは賄えないクエリのみ定義する。
# (Store.listUnclassifiedItems / Store.listRuns に対応)
resource "google_firestore_index" "items_unclassified" {
  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = "items"
  query_scope = "COLLECTION"

  # classifiedAt == null の等価条件 + detectedAt 昇順の並び替え。
  fields {
    field_path = "classifiedAt"
    order      = "ASCENDING"
  }
  fields {
    field_path = "detectedAt"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "runs_by_date_job" {
  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = "runs"
  query_scope = "COLLECTION"

  # date == 当日 / job == ジョブ名 の等価条件 + startedAt 降順(新しい順)。
  fields {
    field_path = "date"
    order      = "ASCENDING"
  }
  fields {
    field_path = "job"
    order      = "ASCENDING"
  }
  fields {
    field_path = "startedAt"
    order      = "DESCENDING"
  }
}

# runs を job 指定なしで引く場合(CLI の health / 監査)に必要。
# 上の (date, job, startedAt) は先頭から連続する部分集合しか使えないため、
# job を飛ばした (date, startedAt DESC) は別インデックスが要る。
resource "google_firestore_index" "runs_by_date" {
  project     = var.project_id
  database    = google_firestore_database.default.name
  collection  = "runs"
  query_scope = "COLLECTION"

  fields {
    field_path = "date"
    order      = "ASCENDING"
  }
  fields {
    field_path = "startedAt"
    order      = "DESCENDING"
  }
}

# ---------------------------------------------------------------------------
# Secret Manager(詳細設計書 §11)
# ---------------------------------------------------------------------------

# シークレットの「箱」は Terraform では作らない。infra/bootstrap.sh が作る。
#
# なぜ Terraform 管理下に置かないか:
#   Cloud Run Jobs はジョブ作成時に参照先シークレットの「バージョンが存在すること」を
#   検証する。つまり値の投入が先に済んでいなければジョブは作れない。
#   値の投入は人が手元で行う作業(トークンを CI に置かないため)なので、
#   「箱の作成 → 値の投入 → ジョブ作成」の順序を Terraform の中では表現できない。
#   箱の作成を bootstrap.sh に寄せることで、
#     bootstrap.sh(箱)→ set-secrets.sh(値)→ push → terraform apply(ジョブ)
#   という一方向の流れになり、初回デプロイが一度で通る。
#
#   両方で作ると secret_id が衝突して apply が必ず 409 で失敗する。
#   レプリケーション方式も不変属性なので、あとから片方に寄せることもできない。

# ---------------------------------------------------------------------------
# サービスアカウントと IAM(最小権限 / NFR-03)
# ---------------------------------------------------------------------------

# ジョブ実行用。Firestore 読み書き・シークレット参照・ログ/メトリクス書込のみ。
resource "google_service_account" "job" {
  project      = var.project_id
  account_id   = "${local.name_prefix}-job"
  display_name = "制度改正ウォッチ ジョブ実行用"
  description  = "Cloud Run Jobs(collect / summarize / deliver)の実行 ID"

  depends_on = [google_project_service.services]
}

# Scheduler が Cloud Run Jobs を起動するためだけのアカウント。権限は run.invoker のみ。
resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "${local.name_prefix}-scheduler"
  display_name = "制度改正ウォッチ スケジューラ用"
  description  = "Cloud Scheduler から Cloud Run Jobs を起動するための ID"

  depends_on = [google_project_service.services]
}

resource "google_project_iam_member" "job_roles" {
  for_each = toset([
    "roles/datastore.user",          # Firestore の読み書き
    "roles/logging.logWriter",       # 構造化ログ(詳細設計書 §12)
    "roles/monitoring.metricWriter", # メトリクス書込
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.job.email}"
}

# secretAccessor はプロジェクト全体ではなく、シークレット 1 件ごとに付与する(最小権限)。
# シークレット自体は bootstrap.sh が作成済みである前提。
# 未作成なら apply がここで「シークレットが見つからない」と失敗する(意図した挙動)。
resource "google_secret_manager_secret_iam_member" "job_secret_accessor" {
  for_each = local.secret_ids

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job.email}"
}

# ---------------------------------------------------------------------------
# Cloud Run Jobs(同一イメージ・args でサブコマンド切替)
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_job" "jobs" {
  for_each = local.jobs

  project  = var.project_id
  name     = "${local.name_prefix}-${each.key}"
  location = var.region

  # ジョブはイメージから再作成できる。守るべき状態は Firestore 側にあるため保護は不要。
  deletion_protection = false

  labels = {
    app = local.name_prefix
    job = each.key
  }

  template {
    # 1 実行 = 1 タスク。多重起動による二重配信を避ける(FR-12 はアプリ側でも冪等)。
    task_count  = 1
    parallelism = 1

    template {
      service_account = google_service_account.job.email
      timeout         = each.value.timeout
      max_retries     = 3 # NFR-01: 失敗時は最大 3 回リトライ

      containers {
        image = var.image
        args  = each.value.args

        resources {
          limits = {
            cpu    = each.value.cpu
            memory = each.value.memory
          }
        }

        # 通常の環境変数。
        dynamic "env" {
          for_each = local.common_env
          content {
            name  = env.key
            value = env.value
          }
        }

        # 秘密情報は値を持たせず、Secret Manager の最新バージョンを参照させる。
        # ローテーション時はシークレットに新バージョンを追加するだけで次回実行から反映される。
        dynamic "env" {
          for_each = each.value.secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_project_iam_member.job_roles,
    # Cloud Run はデプロイ時にシークレットへのアクセス可否を検証するため、
    # IAM 付与が先に完了している必要がある。
    google_secret_manager_secret_iam_member.job_secret_accessor,
  ]
}

# Scheduler 用アカウントにジョブ単位で run.invoker を付与する。
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  for_each = google_cloud_run_v2_job.jobs

  project  = var.project_id
  location = each.value.location
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# ---------------------------------------------------------------------------
# Cloud Scheduler(詳細設計書 §10 / FR-02・FR-05・FR-10 / NFR-08: すべて JST)
# ---------------------------------------------------------------------------

resource "google_cloud_scheduler_job" "triggers" {
  for_each = local.jobs

  project     = var.project_id
  region      = var.region
  name        = "${local.name_prefix}-${each.key}-trigger"
  description = "${each.value.display}ジョブの定期起動: ${each.value.description}"

  schedule  = each.value.schedule
  time_zone = "Asia/Tokyo"

  # :run は実行を「開始」するだけで完了は待たないため、短くてよい。
  attempt_deadline = "180s"

  retry_config {
    retry_count          = 3 # NFR-01
    min_backoff_duration = "10s"
    max_backoff_duration = "300s"
    max_doublings        = 3
  }

  http_target {
    http_method = "POST"
    # Cloud Run Admin API の jobs.run。OAuth トークン(= scheduler 用 SA)で認証する。
    uri = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.jobs[each.key].name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.services,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
  ]
}

# ---------------------------------------------------------------------------
# 観測性・アラート(詳細設計書 §12 / NFR-06)
# ---------------------------------------------------------------------------

locals {
  # ログフィルタで 3 ジョブを指定するための OR 条件。
  job_name_or_filter = join(" OR ", [
    for j in google_cloud_run_v2_job.jobs : format("resource.labels.job_name=%q", j.name)
  ])

  deliver_job_name = google_cloud_run_v2_job.jobs["deliver"].name
}

# (1) ジョブのエラーログ件数。アプリが出す ERROR レベルの構造化ログを数える。
# sourceId を持つログを除いているのは、1 ソースの取得失敗でジョブ全体を止めない設計
# (詳細設計書 §6.1)に合わせるため。単発のソース失敗で夜中に呼び出されると警報が形骸化する。
# ソース側の異常は「連続失敗 3 回」の警告((2))で拾う。
resource "google_logging_metric" "job_error" {
  project = var.project_id
  name    = "seido_watch_job_error"
  filter  = <<-EOT
    resource.type="cloud_run_job"
    severity>=ERROR
    (${local.job_name_or_filter})
    NOT jsonPayload.sourceId:*
  EOT

  description = "制度改正ウォッチの 3 ジョブが出力した ERROR 以上のログ件数"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "制度改正ウォッチ ジョブエラー"

    labels {
      key         = "job_name"
      value_type  = "STRING"
      description = "Cloud Run ジョブ名"
    }
  }

  # どのジョブで起きたかをアラート側で切り分けられるようにする。
  label_extractors = {
    "job_name" = "EXTRACT(resource.labels.job_name)"
  }

  depends_on = [google_project_service.services]
}

# (2) ソースの連続失敗(3 回以上)。詳細設計書 §6.1 / §12。
# 前提: collect は連続失敗を警告する際、構造化ログに consecutiveFailures(数値)を含める。
resource "google_logging_metric" "source_consecutive_failure" {
  project = var.project_id
  name    = "seido_watch_source_consecutive_failure"
  filter  = <<-EOT
    resource.type="cloud_run_job"
    resource.labels.job_name="${google_cloud_run_v2_job.jobs["collect"].name}"
    jsonPayload.consecutiveFailures>=3
  EOT

  description = "同一ソースの巡回が 3 回以上連続で失敗したことを示すログ件数"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "制度改正ウォッチ ソース連続失敗"

    labels {
      key         = "source_id"
      value_type  = "STRING"
      description = "失敗したソース ID"
    }
  }

  label_extractors = {
    "source_id" = "EXTRACT(jsonPayload.sourceId)"
  }

  depends_on = [google_project_service.services]
}

# (3) deliver の成功ログ。見張り用アラート(下の absence 条件)の入力。
# 前提: deliver は正常終了時に jsonPayload.job="deliver" / jsonPayload.status="succeeded" を含むログを出す。
resource "google_logging_metric" "deliver_success" {
  project = var.project_id
  name    = "seido_watch_deliver_success"
  filter  = <<-EOT
    resource.type="cloud_run_job"
    resource.labels.job_name="${local.deliver_job_name}"
    jsonPayload.job="deliver"
    jsonPayload.status="succeeded"
  EOT

  description = "deliver ジョブが正常終了したことを示すログ件数"

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "制度改正ウォッチ 配信成功"
  }

  depends_on = [google_project_service.services]
}

# アラート 1: ジョブ失敗(即時)。deliver 失敗もここで拾う。
resource "google_monitoring_alert_policy" "job_error" {
  project      = var.project_id
  display_name = "[制度改正ウォッチ] ジョブ失敗(ERROR ログ検出)"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "ERROR ログが発生"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.job_error.name}\" AND resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.job_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  alert_strategy {
    # 日次バッチなので、翌日の実行までに自動クローズさせる。
    auto_close = "86400s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      制度改正ウォッチのジョブが ERROR ログを出力しました(詳細設計書 §12)。

      1. Cloud Logging で `resource.type="cloud_run_job"` と `severity>=ERROR` を確認する。
      2. collect の失敗ならソース単位の問題の可能性が高い。`pnpm cli health` でソース状態を確認する。
      3. summarize / deliver の失敗は当日の配信欠落に直結する。復旧後に
         `pnpm cli summarize --date <YYYY-MM-DD> --force` / `pnpm cli deliver --date <YYYY-MM-DD>` で再実行する
         (配信は冪等キーで二重配信を防止している)。
    EOT
  }

  depends_on = [google_project_service.services]
}

# アラート 2: ソース連続失敗 3 回(警告)。
resource "google_monitoring_alert_policy" "source_failure" {
  project      = var.project_id
  display_name = "[制度改正ウォッチ] ソース巡回が 3 回連続で失敗"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "連続失敗 3 回以上のソースあり"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.source_consecutive_failure.name}\" AND resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.source_id"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  alert_strategy {
    auto_close = "86400s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      同一ソースの巡回が 3 回以上連続で失敗しています(要件定義書 §10「サイト構造変更で取得失敗」)。

      1. `source_id` ラベルから対象ソースを特定する。
      2. `pnpm cli verify-sources --source <id>` で到達確認とセレクタの妥当性を確認する。
      3. ページ構造が変わっている場合は `config/sources/*.yaml` の `itemSelector` を修正する。
         復旧見込みが立たない場合は `--fix` で一時的に `enabled: false` にする。
    EOT
  }

  depends_on = [google_project_service.services]
}

# アラート 3: 見張り用。当日の配信が行われていないことを検知する。
# 詳細設計書 §12「07:45 時点で当日 deliveries が無い」。0 件の日も必ず配信する(FR-11)ため、
# 「配信ログが無い = 異常」と断定してよい。
#
# metric absence は「直近 duration の間データが無い」ときに発火する。deliver は毎日 07:30 に
# 1 回だけ動くため、duration を 24 時間(absence の上限)にすると、前日の成功時刻から
# 24 時間後 ≒ 当日 07:3x〜07:45 に発火する。
#
# 条件を 2 つ入れて combiner = OR にしているのは、アプリのログ形式が変わっても
# Cloud Run 側のタスク完了メトリクスで検知を継続できるようにするため(見張りの二重化)。
resource "google_monitoring_alert_policy" "deliver_missing" {
  project      = var.project_id
  display_name = "[制度改正ウォッチ] 当日の LINE 配信が確認できない"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "deliver の成功ログが 24 時間途絶えている"

    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.deliver_success.name}\" AND resource.type=\"cloud_run_job\""
      duration = "86400s"

      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "deliver ジョブのタスク成功が 24 時間途絶えている"

    condition_absent {
      filter   = "metric.type=\"run.googleapis.com/job/completed_task_attempt_count\" AND resource.type=\"cloud_run_job\" AND resource.label.job_name=\"${local.deliver_job_name}\" AND metric.label.result=\"succeeded\""
      duration = "86400s"

      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = var.notification_channel_ids

  alert_strategy {
    auto_close = "86400s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      当日の LINE 配信(deliver)が確認できません。受信者からは「配信が届かない = システム障害」と見えます。

      1. Cloud Scheduler `${local.name_prefix}-deliver-trigger` の最終実行結果を確認する。
      2. Cloud Run ジョブ `${local.deliver_job_name}` の実行履歴とログを確認する。
      3. digest が無い場合は先に `pnpm cli summarize --date <YYYY-MM-DD> --force` を実行する。
      4. 復旧後に `pnpm cli deliver --date <YYYY-MM-DD>` で再配信する(同一日・同一チャネルは冪等)。

      注意: このアラートは「過去に 1 度でも配信成功データがあること」を前提に発火する。
      初回構築直後は deliver を 1 回成功させるまで見張りが効かない。
    EOT
  }

  depends_on = [google_project_service.services]
}
