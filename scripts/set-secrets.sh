#!/usr/bin/env bash
#
# Secret Manager へシークレットの値を投入する。
#
# なぜ専用スクリプトか:
#   トークンの値は git にも GitHub Actions にも置かない(NFR-03)。
#   この端末から Secret Manager へ直接入れ、Cloud Run Jobs が実行時に読む。
#   値はシェル履歴にも残らないよう、画面に表示せずに読み取る。
#
# 使い方:
#   export PROJECT_ID=your-gcp-project
#   bash scripts/set-secrets.sh
#
# 既に値が入っている場合は「新しいバージョン」として追加される(ローテーション)。
# 何も入力せず Enter を押せば、そのシークレットは変更しない。

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID を指定してください(例: export PROJECT_ID=my-project)}"

add_secret() {
  local name="$1" label="$2" required="$3" value=""

  printf '\n\033[1m%s\033[0m\n' "${label}"
  printf '  シークレット: %s\n' "${name}"
  if gcloud secrets versions list "${name}" --project "${PROJECT_ID}" --limit 1 --format='value(name)' 2>/dev/null | grep -q .; then
    printf '  現在: 値あり(入力すると新しいバージョンとして追加されます)\n'
  else
    printf '  現在: 値なし\n'
  fi

  # -s で画面に出さない。履歴にも残らない。
  read -r -s -p "  値を貼り付けて Enter(変更しない場合は空のまま Enter): " value
  echo

  if [[ -z "${value}" ]]; then
    if [[ "${required}" == "required" ]] &&
      ! gcloud secrets versions list "${name}" --project "${PROJECT_ID}" --limit 1 --format='value(name)' 2>/dev/null | grep -q .; then
      echo "  × このシークレットは必須です。値を入れないと配信できません。" >&2
      return 1
    fi
    echo "  変更しませんでした。"
    return 0
  fi

  printf '%s' "${value}" | gcloud secrets versions add "${name}" --project "${PROJECT_ID}" --data-file=- >/dev/null
  echo "  ✓ 新しいバージョンを追加しました。"
}

echo "プロジェクト: ${PROJECT_ID}"
echo "値は画面に表示されません。貼り付けて Enter を押してください。"

add_secret line-token-ai-reskill \
  "LINE チャネルアクセストークン(AIリスキリング制度情報局)" required
add_secret line-token-welfare \
  "LINE チャネルアクセストークン(就労支援、放課後デイ情報局)" required
add_secret anthropic-api-key \
  "Anthropic API キー" required
add_secret slack-webhook-url \
  "Slack Incoming Webhook URL(運用通知先。未設定ならログ出力のみ)" optional

cat <<'EOF'

================================================================================
投入が完了しました。

ローテーションするときも同じスクリプトを実行してください。
古いバージョンの無効化は次のコマンドです(運用手順書 §5):

  gcloud secrets versions disable <番号> --secret=line-token-welfare
================================================================================
EOF
