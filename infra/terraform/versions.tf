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
  # tfstate は GCS に置く(部分設定)。
  #
  # なぜリモートか: CI から terraform apply する構成なので、状態をローカルに置くと
  # 実行のたびに状態を失い、毎回すべてを新規作成しようとして失敗する。
  # バケット名はプロジェクトごとに違うためここには書かず、init 時に指定する。
  #
  #   terraform init \
  #     -backend-config="bucket=<PROJECT_ID>-tfstate" \
  #     -backend-config="prefix=seido-watch"
  #
  # バケットは infra/bootstrap.sh が作成する(バージョニング有効)。
  # ローカルで状態を持ちたい場合のみ、このブロックをコメントアウトする。
  # ------------------------------------------------------------------------
  backend "gcs" {}
}
