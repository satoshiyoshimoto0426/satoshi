#!/usr/bin/env bash
#
# デプロイ前の点検と、GitHub に設定する変数の表示。
#
# infra/bootstrap.sh と scripts/set-secrets.sh を実行したあとに動かします。
# 何も変更しません(読み取りだけ)。何度実行しても安全です。
#
# 見るもの:
#   1. bootstrap.sh が作るはずのものが揃っているか
#   2. シークレット 4 つに「使える値」が入っているか(箱だけでは配信できない)
#   3. LINE のトークンが実際に使えるか(送信はしない)
#   4. GitHub に設定する変数の値
#
# 使い方:
#   export PROJECT_ID=<プロジェクトID>
#   bash scripts/preflight.sh

set -uo pipefail

# シークレットを扱うので、bash -x で実行されても値が画面に出ないようにする。
# 「-x を付けて実行して出力を送ってください」は問い合わせの定番で、
# その出力がそのまま貼られるとトークンが漏れる。
XTRACE_WAS_ON=0
case "$-" in *x*) XTRACE_WAS_ON=1 ;; esac
hide_values() { set +x; }
restore_xtrace() { [[ "${XTRACE_WAS_ON}" -eq 1 ]] && set -x; return 0; }

# 必要なコマンドが無いときに、原因と違うメッセージで迷わせない。
for cmd in gcloud curl; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "${cmd} が見つかりません。" >&2
    echo "Google Cloud Shell で実行すると、どちらも最初から入っています。" >&2
    exit 1
  fi
done

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "PROJECT_ID を指定してください(例: export PROJECT_ID=my-project)" >&2
  exit 1
fi

GITHUB_REPO="${GITHUB_REPO:-satoshiyoshimoto0426/satoshi}"
REGION="${REGION:-asia-northeast1}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

STATE_BUCKET="${PROJECT_ID}-tfstate"
DEPLOY_SA_EMAIL="seido-watch-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
POOL_ID="github-pool"
PROVIDER_ID="github-provider"
SECRETS=(line-token-ai-reskill line-token-welfare anthropic-api-key notify-webhook-url)

# bootstrap.sh が書き込む条件と同じ文字列。ここがずれていると GitHub からの認証が通らない。
EXPECTED_CONDITION="assertion.repository == '${GITHUB_REPO}' && (assertion.ref == 'refs/heads/${DEPLOY_BRANCH}' || assertion.ref.startsWith('refs/pull/'))"

# 端末以外(ログファイルへのリダイレクト)では色を付けない。
# 点検結果をそのまま支援者へ送れるようにするため。
if [[ -t 1 ]]; then
  C_G=$'\033[32m' C_R=$'\033[31m' C_Y=$'\033[33m' C_B=$'\033[1m' C_0=$'\033[0m'
else
  C_G='' C_R='' C_Y='' C_B='' C_0=''
fi

# 値に混ざっている空白文字の種類を、値そのものを見せずに言葉で説明する。
# 「空白が混ざっています」だけでは、どこを直せばよいか分からないため。
describe_whitespace() {
  printf '%s' "$1" | od -An -tu1 -v | tr ' ' '\n' | grep -E '^(9|10|13|32)$' | sort -u |
    while read -r code; do
      case "${code}" in
        9) printf 'タブ ' ;;
        10) printf '改行 ' ;;
        13) printf '復帰(CR。Windows やメモ帳を経由するとき付く) ' ;;
        32) printf '空白 ' ;;
      esac
    done
}

ng=0
ok() { printf '  %s✓%s %s\n' "${C_G}" "${C_0}" "$*"; }
bad() {
  printf '  %s×%s %s\n' "${C_R}" "${C_0}" "$1"
  shift
  for line in "$@"; do printf '      %s\n' "${line}"; done
  ng=1
}
warn() { printf '  %s!%s %s\n' "${C_Y}" "${C_0}" "$*"; }
say() { printf '\n%s%s%s\n' "${C_B}" "$*" "${C_0}"; }

printf '\n%s点検対象: %s(リージョン %s)%s\n' "${C_B}" "${PROJECT_ID}" "${REGION}" "${C_0}"

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)' 2>/dev/null)"

# ---------------------------------------------------------------------------
say "1/4 bootstrap.sh が作るもの"
# ---------------------------------------------------------------------------
if gcloud storage buckets describe "gs://${STATE_BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  ok "Terraform の状態バケット: gs://${STATE_BUCKET}"
else
  bad "状態バケットがありません: gs://${STATE_BUCKET}" "infra/bootstrap.sh を実行してください"
fi

if gcloud iam service-accounts describe "${DEPLOY_SA_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  ok "デプロイ用サービスアカウント: ${DEPLOY_SA_EMAIL}"
else
  bad "デプロイ用サービスアカウントがありません" "infra/bootstrap.sh を実行してください"
fi

# describe は 1 回だけ呼ぶ。条件が空なら「プロバイダが無い」か「条件が付いていない」。
condition="$(gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project "${PROJECT_ID}" --location global --workload-identity-pool "${POOL_ID}" \
  --format='value(attributeCondition)' 2>/dev/null)"
provider_exists=$?

# 空白の入り方だけが違うケースを「不一致」と誤判定しないよう、空白を除いて比べる。
norm() { printf '%s' "$1" | tr -d '[:space:]'; }

if [[ "${provider_exists}" -ne 0 ]]; then
  bad "GitHub からの認証設定がありません" "infra/bootstrap.sh を実行してください"
elif [[ "$(norm "${condition}")" == "$(norm "${EXPECTED_CONDITION}")" ]]; then
  ok "GitHub からの認証設定(鍵なし)"
  ok "  認証できるのは ${GITHUB_REPO} の ${DEPLOY_BRANCH} ブランチと、そのプルリクエストだけです"
else
  # bootstrap.sh は既存のプロバイダも上書きするので、再実行で直る。
  # それでも直らないとき用に、実際のコマンドもそのまま出す。
  bad "認証を許可する条件が想定と違います" \
    "いま入っている条件: ${condition:-(条件なし。どのリポジトリからでも認証できる状態です)}" \
    "本来あるべき条件: ${EXPECTED_CONDITION}" \
    "" \
    "infra/bootstrap.sh を実行し直すと入れ替わります。直らない場合は次を実行してください:" \
    "  gcloud iam workload-identity-pools providers update-oidc ${PROVIDER_ID} \\" \
    "    --project=${PROJECT_ID} --location=global --workload-identity-pool=${POOL_ID} \\" \
    "    --attribute-condition=\"${EXPECTED_CONDITION}\""
fi

# プロバイダがあっても、サービスアカウント側で「なりすまし」を許していないと認証は通らない。
# デプロイが認証で落ちる原因として最も多いので、必ず見る。
if [[ -n "${PROJECT_NUMBER}" ]]; then
  expected_member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPO}"
  if gcloud iam service-accounts get-iam-policy "${DEPLOY_SA_EMAIL}" --project "${PROJECT_ID}" \
    --flatten="bindings[].members[]" --format='value(bindings.members)' 2>/dev/null |
    grep -qxF "${expected_member}"; then
    ok "  ${GITHUB_REPO} からのなりすましを許可済み"
  else
    bad "  ${GITHUB_REPO} からのなりすましが許可されていません" \
      "この 1 行が無いと、点検が通ってもデプロイは認証で必ず失敗します。" \
      "infra/bootstrap.sh を実行し直してください"
  fi
fi

# ---------------------------------------------------------------------------
say "2/4 シークレットに使える値が入っているか"
# ---------------------------------------------------------------------------
# Cloud Run Jobs は version = "latest" を参照する(infra/terraform/main.tf)。
# 「有効なバージョンが 1 つでもある」ではなく「latest が有効」でなければ動かない。
hide_values
for secret in "${SECRETS[@]}"; do
  if ! gcloud secrets describe "${secret}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    bad "${secret}: 箱がありません" "infra/bootstrap.sh を実行してください"
    continue
  fi

  state="$(gcloud secrets versions describe latest --secret="${secret}" --project="${PROJECT_ID}" \
    --format='value(state)' 2>/dev/null)"
  if [[ -z "${state}" ]]; then
    bad "${secret}: 値が入っていません" "scripts/set-secrets.sh を実行してください"
    continue
  fi
  if [[ "${state}" != "ENABLED" ]]; then
    bad "${secret}: 最新の値が無効(${state})になっています" \
      "Cloud Run は常に最新の値を読むため、古い有効な値があっても動きません。" \
      "scripts/set-secrets.sh で入れ直してください"
    continue
  fi

  # 貼り付け由来の改行・空白は「見た目は正しいのに認証が通らない」最悪の失敗を生む。
  # set-secrets.sh は前後を削るが、ブラウザの Secret Manager 画面から入れた値は削られない。
  # 値そのものは一切表示せず、長さの差だけで判定する。
  raw_len="$(gcloud secrets versions access latest --secret="${secret}" --project="${PROJECT_ID}" 2>/dev/null | wc -c | tr -d '[:space:]')"
  value="$(gcloud secrets versions access latest --secret="${secret}" --project="${PROJECT_ID}" 2>/dev/null)"
  value_len="$(printf '%s' "${value}" | wc -c | tr -d '[:space:]')"
  if [[ -n "${raw_len}" && -n "${value_len}" && "${raw_len}" != "${value_len}" ]]; then
    bad "${secret}: 値の末尾に改行が入っています" \
      "このまま配信すると認証に失敗します。scripts/set-secrets.sh で入れ直してください"
  elif [[ "${value}" =~ [[:space:]] ]]; then
    bad "${secret}: 値に空白や改行が混ざっています" \
      "混ざっている文字: $(describe_whitespace "${value}")" \
      "このまま配信すると認証に失敗します。scripts/set-secrets.sh で入れ直してください"
  else
    ok "${secret}: 値あり"
  fi
  unset value
done
restore_xtrace

# ---------------------------------------------------------------------------
say "3/4 LINE のトークンが実際に使えるか(送信はしません)"
# ---------------------------------------------------------------------------
hide_values
for pair in "line-token-ai-reskill:AIリスキリング制度情報局" "line-token-welfare:就労支援、放課後デイ情報局"; do
  secret="${pair%%:*}"
  label="${pair#*:}"
  token="$(gcloud secrets versions access latest --secret="${secret}" --project="${PROJECT_ID}" 2>/dev/null)"
  if [[ -z "${token}" ]]; then
    bad "${label}: トークンを読み出せません" \
      "値がまだ入っていないか、このアカウントに読み取り権限がありません。" \
      "scripts/set-secrets.sh を実行してください"
    continue
  fi
  # トークンを curl の引数に置かない。引数は ps で他の利用者から見えるため、
  # 設定を標準入力から渡す(--config -)。
  body="$(printf 'header = "Authorization: Bearer %s"\n' "${token}" |
    curl -sS -m 15 -w '\n%{http_code}' --config - https://api.line.me/v2/bot/info 2>/dev/null)" || {
    warn "${label}: 確認できませんでした(ネットワークに出られない環境の可能性)"
    continue
  }
  status="$(printf '%s' "${body}" | tail -n1)"
  case "${status}" in
    200)
      name="$(printf '%s' "${body}" | sed '$d' | sed -n 's/.*"displayName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      ok "${label} → LINE 側のアカウント名: ${name:-取得できず}"
      ;;
    400 | 401 | 403)
      # 待っても直らない。値そのものが違う。
      bad "${label}: LINE に拒否されました(HTTP ${status})" \
        "トークンが違うか、途中で切れているか、期限切れです。" \
        "scripts/set-secrets.sh で入れ直してください"
      ;;
    429 | 5*)
      # LINE 側の一時的な都合。待てば直るのでデプロイ準備は止めない。
      warn "${label}: LINE 側が一時的に応答できません(HTTP ${status})。時間をおいて再実行してください"
      ;;
    *)
      warn "${label}: 応答が想定外でした(HTTP ${status})"
      ;;
  esac
done
unset token
restore_xtrace

# ---------------------------------------------------------------------------
say "4/4 GitHub に設定する変数"
# ---------------------------------------------------------------------------
if [[ -z "${PROJECT_NUMBER}" ]]; then
  bad "プロジェクト番号を取得できませんでした" \
    "gcloud auth login を実行したか、PROJECT_ID が正しいか確認してください。" \
    "GCP_WIF_PROVIDER 以外の 5 つは下に表示します"
  PROVIDER_NAME="(プロジェクト番号を取得できなかったため表示できません)"
else
  PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
fi

cat <<EOF

  GitHub の Settings > Secrets and variables > Actions > Variables タブに
  次の 6 つを追加してください(秘密情報ではありません)。

  GCP_PROJECT_ID          ${PROJECT_ID}
  GCP_REGION              ${REGION}
  GCP_FIRESTORE_LOCATION  ${REGION}
  GCP_DEPLOY_SA           ${DEPLOY_SA_EMAIL}
  TF_STATE_BUCKET         ${STATE_BUCKET}
  GCP_WIF_PROVIDER        ${PROVIDER_NAME}

EOF

if command -v gh >/dev/null 2>&1 && [[ -n "${PROJECT_NUMBER}" ]]; then
  cat <<EOF
  gh コマンドが使えます。次をそのまま貼り付ければ設定できます
  (初回は 'gh auth login' で GitHub にログインしてください)。

gh variable set GCP_PROJECT_ID         --body "${PROJECT_ID}"         --repo ${GITHUB_REPO}
gh variable set GCP_REGION             --body "${REGION}"             --repo ${GITHUB_REPO}
gh variable set GCP_FIRESTORE_LOCATION --body "${REGION}"             --repo ${GITHUB_REPO}
gh variable set GCP_DEPLOY_SA          --body "${DEPLOY_SA_EMAIL}"    --repo ${GITHUB_REPO}
gh variable set TF_STATE_BUCKET        --body "${STATE_BUCKET}"       --repo ${GITHUB_REPO}
gh variable set GCP_WIF_PROVIDER       --body "${PROVIDER_NAME}"      --repo ${GITHUB_REPO}

EOF
fi

# ---------------------------------------------------------------------------
if [[ "${ng}" -eq 0 ]]; then
  cat <<'EOF'
================================================================================
点検の結果、問題は見つかりませんでした。

次にやること:
  1. 上の 6 つの変数を GitHub に設定する
  2. GitHub の Actions タブ →「デプロイ」→「Run workflow」で初回を実行する

     変数を設定しただけでは何も起きません。デプロイは push で始まりますが、
     コードが既に main にある場合は押すべき push が無いためです。
     2 回目以降は main に変更が入るたび自動で走ります。

デプロイの経過は GitHub の Actions タブで見られます。
================================================================================
EOF
else
  cat <<'EOF'
================================================================================
× の項目があります。上の指示にしたがって直してから、もう一度実行してください。
このスクリプトは何も変更しないので、何度実行しても安全です。
================================================================================
EOF
  exit 1
fi
