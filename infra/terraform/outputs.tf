# 出力値。運用手順(README.md)でそのまま使えるものだけを出す。
# シークレットの値は一切出力しない(NFR-03)。

output "artifact_registry_repository" {
  description = "コンテナイメージを push する Artifact Registry リポジトリのパス。"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}

output "image_uri_example" {
  description = "var.image に指定するイメージ URI の例(タグは push したものに合わせる)。"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}/${google_artifact_registry_repository.docker.repository_id}:latest"
}

output "firestore_database" {
  description = "Firestore データベース名(環境変数 FIRESTORE_DATABASE_ID と一致)。"
  value       = google_firestore_database.default.name
}

output "job_service_account_email" {
  description = "Cloud Run Jobs 実行用サービスアカウント。"
  value       = google_service_account.job.email
}

output "scheduler_service_account_email" {
  description = "Cloud Scheduler が Cloud Run Jobs を起動するためのサービスアカウント。"
  value       = google_service_account.scheduler.email
}

output "cloud_run_jobs" {
  description = "作成された Cloud Run Jobs 名(サブコマンド => ジョブ名)。"
  value       = { for k, j in google_cloud_run_v2_job.jobs : k => j.name }
}

output "scheduler_jobs" {
  description = "作成された Cloud Scheduler ジョブ名と cron(JST)。"
  value       = { for k, s in google_cloud_scheduler_job.triggers : s.name => s.schedule }
}

output "secret_ids" {
  description = "参照している Secret Manager のシークレット ID(作成は infra/bootstrap.sh)。"
  value       = local.secret_ids
}

output "secret_version_commands" {
  description = "シークレット値を投入するコマンド(値は標準入力から渡す。履歴に値を残さないこと)。"
  value = {
    for k, id in local.secret_ids :
    k => "printf '%s' '<値>' | gcloud secrets versions add ${id} --project=${var.project_id} --data-file=-"
  }
}

output "alert_policies" {
  description = "作成された Cloud Monitoring アラートポリシー(詳細設計書 §12 の 3 種)。"
  value = {
    job_error       = google_monitoring_alert_policy.job_error.name
    source_failure  = google_monitoring_alert_policy.source_failure.name
    deliver_missing = google_monitoring_alert_policy.deliver_missing.name
  }
}
