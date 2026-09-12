# Terraform / プロバイダのバージョン固定。
# 再現性(M0-03「Terraform で再現可能」)のため、メジャーバージョンを跨いだ自動更新は許可しない。

terraform {
  # 本構成は変数の validation / 省略可能引数など 1.5 系以降の機能に依存する。
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source = "hashicorp/google"
      # 6.x 系に固定する。7.x はリソーススキーマが変わる可能性があるため、
      # 上げるときは計画差分を必ず確認すること。
      version = "~> 6.0"
    }
  }

  # ------------------------------------------------------------------------
  # tfstate はシークレットそのものは含まないが、プロジェクト構成が丸ごと入る。
  # チームで運用する場合は下記コメントを外して GCS バックエンドを使うこと。
  # バケットは事前に手動作成し、バージョニングを有効にしておく。
  #   gcloud storage buckets create gs://<PROJECT_ID>-tfstate \
  #     --location=asia-northeast1 --uniform-bucket-level-access
  #   gcloud storage buckets update gs://<PROJECT_ID>-tfstate --versioning
  # ------------------------------------------------------------------------
  # backend "gcs" {
  #   bucket = "<PROJECT_ID>-tfstate"
  #   prefix = "seido-watch"
  # }
}
