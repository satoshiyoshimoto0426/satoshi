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

# 値が入っているかを判定する。
has_version() {
  gcloud secrets versions list "$1" --project "${PROJECT_ID}" --limit 1 --format='value(name)' 2>/dev/null |
    grep -q .
}

# LINE のチャネルアクセストークンが本当に使えるかを確認する。
# 送信は行わない読み取り専用の API を叩くだけ(ボットの基本情報を取得する)。
# 貼り付け間違いや期限切れを、デプロイの当日ではなくこの場で見つけるため。
verify_line_token() {
  local token="$1" body status
  body="$(curl -sS -m 15 -o /dev/stdout -w '\n%{http_code}' \
    -H "Authorization: Bearer ${token}" https://api.line.me/v2/bot/info 2>/dev/null)" || {
    echo "  ! 確認できませんでした(ネットワークに出られない環境の可能性)。先に進めます。"
    return 0
  }
  status="$(printf '%s' "${body}" | tail -n1)"
  if [[ "${status}" == "200" ]]; then
    local display
    display="$(printf '%s' "${body}" | head -n-1 | sed -n 's/.*"displayName":"\([^"]*\)".*/\1/p')"
    echo "  ✓ 確認できました: ${display:-(アカウント名を取得できませんでした)}"
    return 0
  fi
  if [[ "${status}" == "401" ]]; then
    echo "  × このトークンは LINE に拒否されました(401)。" >&2
    echo "    貼り付けが途中で切れているか、別の値の可能性があります。" >&2
    return 1
  fi
  echo "  ! 確認の応答が想定外でした(HTTP ${status})。値は保存済みです。"
  return 0
}

add_secret() {
  local name="$1" label="$2" required="$3" kind="${4:-}" value=""

  printf '\n\033[1m%s\033[0m\n' "${label}"
  printf '  シークレット: %s\n' "${name}"
  if has_version "${name}"; then
    printf '  現在: 値あり(入力すると新しいバージョンとして追加されます)\n'
  else
    printf '  現在: 値なし\n'
  fi

  # -s で画面に出さない。履歴にも残らない。
  # **貼り付けても画面には何も出ません。これは正常です。**
  # Ctrl+D や端末が TTY でない場合に read は非ゼロを返すが、
  # set -e でスクリプト全体を落とさず「変更しない」として扱う。
  printf '  ヒント: 貼り付けても画面には何も表示されません(伏せて入力しています)。\n'
  printf '          貼り付けたらそのまま Enter を押してください。\n'
  read -r -s -p "  値を貼り付けて Enter(変更しない場合は空のまま Enter): " value || true
  echo

  # 貼り付けでは前後に空白や改行が紛れ込みやすい。そのまま保存すると
  # 「見た目は正しいのに認証が通らない」という原因の分かりにくい失敗になる。
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [[ -z "${value}" ]]; then
    if [[ "${required}" == "required" ]] && ! has_version "${name}"; then
      echo "  × このシークレットには値が必要です。" >&2
      echo "    Cloud Run Jobs はジョブ作成時に値の存在を検証するため、" >&2
      echo "    1 つでも欠けるとデプロイが失敗します。" >&2
      echo "" >&2
      echo "    貼り付けができない場合は、ブラウザの Secret Manager 画面からも入れられます。" >&2
      echo "    手順: docs/06_認証情報の取得手順.md の「貼り付けができないとき」を参照" >&2
      exit 1
    fi
    echo "  変更しませんでした。"
    return 0
  fi

  # 値そのものは出さず、長さだけ出す。
  # 「貼り付けられたのか分からない」という不安を、値を晒さずに解消するため。
  echo "  受け取りました(${#value} 文字)"

  printf '%s' "${value}" | gcloud secrets versions add "${name}" --project "${PROJECT_ID}" --data-file=- >/dev/null
  echo "  ✓ 新しいバージョンを追加しました。"

  if [[ "${kind}" == "line" ]]; then
    verify_line_token "${value}" || return 1
  fi
}

echo "プロジェクト: ${PROJECT_ID}"
echo ""
echo "値を貼り付けても画面には何も表示されません(伏せて入力しています)。"
echo "それで正常です。貼り付けたらそのまま Enter を押してください。"
echo "貼り付け自体ができない場合は Ctrl+C で中断し、"
echo "docs/06_認証情報の取得手順.md の「貼り付けができないとき」を参照してください。"

add_secret line-token-ai-reskill \
  "LINE チャネルアクセストークン(AIリスキリング制度情報局)" required line
add_secret line-token-welfare \
  "LINE チャネルアクセストークン(就労支援、放課後デイ情報局)" required line
add_secret anthropic-api-key \
  "Anthropic API キー" required
# 通知先も必須にしている。Cloud Run Jobs はジョブ作成時に参照先バージョンの存在を
# 検証するため、1 つでも値が無いとジョブの作成が失敗する。
# 通知を使わない運用にするなら、値を入れるのではなく
# infra/terraform/main.tf の各ジョブの secret_env から NOTIFY_WEBHOOK_URL を外すこと。
add_secret notify-webhook-url \
  "運用通知の Webhook URL(Slack または Discord。どちらでも可)" required

cat <<'EOF'

================================================================================
投入が完了しました。

ローテーションするときも同じスクリプトを実行してください。
古いバージョンの無効化は次のコマンドです(運用手順書 §5):

  gcloud secrets versions disable <番号> --secret=line-token-welfare
================================================================================
EOF
