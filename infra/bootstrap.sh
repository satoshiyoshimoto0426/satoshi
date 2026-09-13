#!/usr/bin/env bash
#
# 制度改正ウォッチ — デプロイ自動化の初期設定(1 回だけ実行する)
#
# このスクリプトが作るもの:
#   1. 必要な Google Cloud API の有効化
#   2. Terraform の状態を置く GCS バケット(バージョニング有効)
#   3. デプロイ用サービスアカウントと、Terraform が必要とする権限
#   4. Workload Identity 連携(GitHub Actions が鍵なしで認証するため)
#   5. Secret Manager のシークレット 4 つ(値は入れない。scripts/set-secrets.sh で投入)
#
# なぜ鍵を使わないか:
#   サービスアカウントキー(JSON)を GitHub に置くと、漏れたときに無期限で悪用できる。
#   Workload Identity 連携なら、この 1 リポジトリの GitHub Actions からのみ、
#   短命のトークンで認証される(NFR-03 の最小権限)。
#
# 実行後、表示される GitHub のシークレット/変数を設定すれば、
# 以降は main への push で自動デプロイされる。
#
# 使い方:
#   export PROJECT_ID=your-gcp-project
#   export GITHUB_REPO=satoshiyoshimoto0426/satoshi
#   bash infra/bootstrap.sh
#
# 何度実行しても同じ結果になる(既存のものは作り直さない)。

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID を指定してください(例: export PROJECT_ID=my-project)}"
GITHUB_REPO="${GITHUB_REPO:-satoshiyoshimoto0426/satoshi}"
REGION="${REGION:-asia-northeast1}"

STATE_BUCKET="${PROJECT_ID}-tfstate"
DEPLOY_SA="seido-watch-deployer"
DEPLOY_SA_EMAIL="${DEPLOY_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
POOL_ID="github-pool"
PROVIDER_ID="github-provider"

# Terraform がこの構成を作るために必要な権限。
# roles/owner を避け、リソース種別ごとに必要なものだけを付ける。
DEPLOY_ROLES=(
  roles/serviceusage.serviceUsageAdmin   # API の有効化
  roles/artifactregistry.admin           # イメージ置き場の作成とプッシュ
  roles/datastore.owner                  # Firestore の DB・インデックス・TTL
  roles/secretmanager.admin              # シークレットの作成と IAM 付与
  roles/run.admin                        # Cloud Run Jobs
  roles/cloudscheduler.admin             # Cloud Scheduler
  roles/iam.serviceAccountAdmin          # 実行用 SA の作成
  roles/iam.serviceAccountUser           # ジョブに SA を割り当てる
  roles/resourcemanager.projectIamAdmin  # 実行用 SA へのロール付与
  roles/monitoring.editor                # アラートポリシー
  roles/logging.configWriter             # ログベースメトリクス
)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "プロジェクト: ${PROJECT_ID} / リージョン: ${REGION} / リポジトリ: ${GITHUB_REPO}"
gcloud config set project "${PROJECT_ID}" >/dev/null

# ---------------------------------------------------------------------------
say "1/5 必要な API を有効化します(数分かかることがあります)"
# ---------------------------------------------------------------------------
gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  --project "${PROJECT_ID}"

# ---------------------------------------------------------------------------
say "2/5 Terraform の状態を置くバケットを用意します"
# ---------------------------------------------------------------------------
if gcloud storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  echo "  既にあります: gs://${STATE_BUCKET}"
else
  gcloud storage buckets create "gs://${STATE_BUCKET}" \
    --project "${PROJECT_ID}" --location "${REGION}" --uniform-bucket-level-access
  echo "  作成しました: gs://${STATE_BUCKET}"
fi
# 状態ファイルは壊れると復旧が難しいので、必ずバージョニングを有効にする。
gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning >/dev/null
echo "  バージョニング: 有効"

# ---------------------------------------------------------------------------
say "3/5 デプロイ用サービスアカウントを用意します"
# ---------------------------------------------------------------------------
if gcloud iam service-accounts describe "${DEPLOY_SA_EMAIL}" >/dev/null 2>&1; then
  echo "  既にあります: ${DEPLOY_SA_EMAIL}"
else
  gcloud iam service-accounts create "${DEPLOY_SA}" \
    --project "${PROJECT_ID}" \
    --display-name "制度改正ウォッチ デプロイ用(GitHub Actions)"
  echo "  作成しました: ${DEPLOY_SA_EMAIL}"
fi

for role in "${DEPLOY_ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${DEPLOY_SA_EMAIL}" \
    --role "${role}" --condition=None >/dev/null
  echo "  付与: ${role}"
done

# 状態バケットへの読み書き。プロジェクト全体の storage.admin は付けない。
gcloud storage buckets add-iam-policy-binding "gs://${STATE_BUCKET}" \
  --member "serviceAccount:${DEPLOY_SA_EMAIL}" \
  --role roles/storage.objectAdmin >/dev/null
echo "  付与: gs://${STATE_BUCKET} への objectAdmin"

# ---------------------------------------------------------------------------
say "4/5 Workload Identity 連携(GitHub Actions の鍵なし認証)を用意します"
# ---------------------------------------------------------------------------
if gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project "${PROJECT_ID}" --location global >/dev/null 2>&1; then
  echo "  プールは既にあります: ${POOL_ID}"
else
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project "${PROJECT_ID}" --location global \
    --display-name "GitHub Actions"
  echo "  プールを作成しました: ${POOL_ID}"
fi

if gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project "${PROJECT_ID}" --location global --workload-identity-pool "${POOL_ID}" >/dev/null 2>&1; then
  echo "  プロバイダは既にあります: ${PROVIDER_ID}"
else
  # attribute-condition は必須。これが無いと「GitHub 上の任意のリポジトリ」から
  # 認証できてしまう。このリポジトリ 1 つに限定する。
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --project "${PROJECT_ID}" --location global \
    --workload-identity-pool "${POOL_ID}" \
    --display-name "GitHub OIDC" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition "assertion.repository == '${GITHUB_REPO}'"
  echo "  プロバイダを作成しました: ${PROVIDER_ID}(${GITHUB_REPO} に限定)"
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER_ID}"

gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SA_EMAIL}" \
  --project "${PROJECT_ID}" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${GITHUB_REPO}" >/dev/null
echo "  ${GITHUB_REPO} からの偽装を許可しました"

# ---------------------------------------------------------------------------
say "5/5 Secret Manager のシークレットを用意します(値はまだ入れません)"
# ---------------------------------------------------------------------------
for secret in line-token-ai-reskill line-token-welfare anthropic-api-key slack-webhook-url; do
  if gcloud secrets describe "${secret}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "  既にあります: ${secret}"
  else
    gcloud secrets create "${secret}" --project "${PROJECT_ID}" --replication-policy automatic
    echo "  作成しました: ${secret}"
  fi
done

# ---------------------------------------------------------------------------
cat <<EOF

================================================================================
初期設定が完了しました。残りは 2 つです。

[1] シークレットの値を投入する(この端末から。GitHub には保存されません)

    bash scripts/set-secrets.sh

[2] GitHub にリポジトリ変数を設定する

    Settings > Secrets and variables > Actions > Variables タブ で以下を追加:

      GCP_PROJECT_ID           ${PROJECT_ID}
      GCP_REGION               ${REGION}
      GCP_WIF_PROVIDER         ${PROVIDER_NAME}
      GCP_DEPLOY_SA            ${DEPLOY_SA_EMAIL}
      TF_STATE_BUCKET          ${STATE_BUCKET}

    gh コマンドが使えるなら、この 5 行をそのまま実行しても設定できます:

      gh variable set GCP_PROJECT_ID   --body "${PROJECT_ID}"   --repo ${GITHUB_REPO}
      gh variable set GCP_REGION       --body "${REGION}"       --repo ${GITHUB_REPO}
      gh variable set GCP_WIF_PROVIDER --body "${PROVIDER_NAME}" --repo ${GITHUB_REPO}
      gh variable set GCP_DEPLOY_SA    --body "${DEPLOY_SA_EMAIL}" --repo ${GITHUB_REPO}
      gh variable set TF_STATE_BUCKET  --body "${STATE_BUCKET}" --repo ${GITHUB_REPO}

以降、main ブランチへ push するたびに自動でデプロイされます。
手動で走らせたい場合は GitHub の Actions タブから「デプロイ」を Run workflow してください。
================================================================================
EOF
