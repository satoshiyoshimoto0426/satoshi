# 入力変数。値は terraform.tfvars(git 管理外)で与える。
# シークレットの「値」はここでは絶対に受け取らない(NFR-03 / 詳細設計書 §11)。

variable "project_id" {
  description = "デプロイ先の Google Cloud プロジェクト ID。"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id は Google Cloud のプロジェクト ID 形式(小文字英数字とハイフン、6〜30 文字)で指定してください。"
  }
}

variable "region" {
  description = "Cloud Run Jobs / Cloud Scheduler / Artifact Registry を配置するリージョン。"
  type        = string
  default     = "asia-northeast1"
}

variable "firestore_location" {
  description = "Firestore データベースのロケーション。作成後は変更できない。"
  type        = string
  default     = "asia-northeast1"
}

variable "image" {
  description = <<-EOT
    3 ジョブが共通で使うコンテナイメージの URI(タグまたはダイジェスト付き)。
    例: asia-northeast1-docker.pkg.dev/<PROJECT_ID>/seido-watch/seido-watch:2026-09-12
    Cloud Run はデプロイ時にイメージの存在を検証するため、apply の前に push しておくこと(README 参照)。
  EOT
  type        = string

  validation {
    # 「ホスト/パス」形式であることだけを確認する。タグやダイジェストの有無は問わない。
    condition     = can(regex("^[a-z0-9.-]+(:[0-9]+)?/[^\\s]+$", var.image))
    error_message = "image はレジストリのホストを含む完全なイメージ URI で指定してください(例: asia-northeast1-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG)。"
  }
}

variable "notification_channel_ids" {
  description = <<-EOT
    アラートの通知先チャネルのリソース名のリスト。
    形式: projects/<PROJECT_ID>/notificationChannels/<ID>
    空のままでもアラートポリシーは作成されるが、通知は飛ばない(Cloud Monitoring 上で確認するのみ)。
    Slack へ飛ばす場合は README「通知チャネルの作成」を参照。
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for c in var.notification_channel_ids : can(regex("^projects/[^/]+/notificationChannels/[0-9]+$", c))
    ])
    error_message = "notification_channel_ids は projects/<PROJECT_ID>/notificationChannels/<ID> 形式で指定してください。"
  }
}
