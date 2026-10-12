#!/bin/sh
set -eu
umask 077

read_secret() {
  variable_name="$1"
  secret_path="$2"

  if [ ! -f "$secret_path" ] || [ ! -s "$secret_path" ]; then
    echo "Required secret file for $variable_name is missing or empty." >&2
    exit 1
  fi

  secret_value="$(cat "$secret_path")"
  export "$variable_name=$secret_value"
  unset secret_value
}

read_secret AUTH_SECRET "${AUTH_SECRET_FILE:-/run/secrets/chatbot-auth-secret}"
read_secret LITELLM_API_KEY "${LITELLM_API_KEY_FILE:-/run/secrets/litellm-client-key}"
read_secret CHATBOT_POSTGRES_PASSWORD \
  "${CHATBOT_POSTGRES_PASSWORD_FILE:-/run/secrets/chatbot-postgres-password}"

POSTGRES_URL="$(node -e '
  const user = encodeURIComponent(process.env.CHATBOT_POSTGRES_USER || "chatbot_app");
  const password = encodeURIComponent(process.env.CHATBOT_POSTGRES_PASSWORD);
  const host = process.env.CHATBOT_POSTGRES_HOST || "litellm_db";
  const port = process.env.CHATBOT_POSTGRES_PORT || "5432";
  const database = encodeURIComponent(process.env.CHATBOT_POSTGRES_DATABASE || "chatbot");
  process.stdout.write(`postgresql://${user}:${password}@${host}:${port}/${database}`);
')"
export POSTGRES_URL
unset CHATBOT_POSTGRES_PASSWORD

mkdir -p "${CHATBOT_LOG_DIR:-/app/logs}" /app/generated-media
exec gosu node "$@"
