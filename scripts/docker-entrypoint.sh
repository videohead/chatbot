#!/usr/bin/env bash
set -euo pipefail

export AUTH_SECRET="$(node -p 'process.env.AUTH_SECRET || process.env.CHATBOT_AUTH_SECRET || ""')"
export POSTGRES_URL="postgresql://chatbot_app:$(node -p 'encodeURIComponent(process.env.CHATBOT_POSTGRES_PASSWORD ?? "")')@litellm_db:5432/chatbot"

log_dir="${CHATBOT_LOG_DIR:-/app/logs}"
mkdir -p "$log_dir"

# Optionally expose one application user's private generated-media directory
# to its matching local Linux account. Other users remain container-owned.
media_owner_user_id="${MEDIA_LOCAL_OWNER_USER_ID:-}"
media_owner_uid="${MEDIA_LOCAL_OWNER_UID:-}"
media_owner_gid="${MEDIA_LOCAL_OWNER_GID:-}"
if [[ "$media_owner_user_id" =~ ^[0-9a-fA-F-]{36}$ ]] \
  && [[ "$media_owner_uid" =~ ^[0-9]+$ ]] \
  && [[ "$media_owner_gid" =~ ^[0-9]+$ ]]; then
  media_owner_dir="/app/generated-media/$media_owner_user_id"
  if [[ -d "$media_owner_dir" ]]; then
    chown -R "$media_owner_uid:$media_owner_gid" "$media_owner_dir"
    find "$media_owner_dir" -type d -exec chmod 0700 {} +
    find "$media_owner_dir" -type f -exec chmod 0600 {} +
  fi
fi

log_file="$log_dir/chatbot-$(date -u +%Y-%m-%d).log"
latest_log_file="$log_dir/chatbot-current.log"

ln -sfn "$(basename "$log_file")" "$latest_log_file"

printf '{"event":"container.start","level":"info","service":"chatbot","timestamp":"%s","argv":%s,"logFile":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@")" \
  "$log_file" | tee -a "$log_file"

"$@" 2>&1 | tee -a "$log_file"
