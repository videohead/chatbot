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

# Persistent logging: tee stdout/stderr to a dated file plus a `current`
# symlink so the chatbot -> LiteLLM -> metis tool chain can be traced after
# container restarts. See docs/tool-chain-logging.md.
log_dir="${CHATBOT_LOG_DIR:-/app/logs}"
log_file="$log_dir/chatbot-$(date -u +%Y-%m-%d).log"
chown node:node "$log_dir" 2>/dev/null || true

printf '{"event":"container.start","level":"info","service":"chatbot","timestamp":"%s","argv":%s,"logFile":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@")" \
  "$log_file" >> "$log_file"
chown node:node "$log_file" 2>/dev/null || true

ln -sfn "$(basename "$log_file")" "$log_dir/chatbot-current.log"

# Run the app as the node user with stdout/stderr teed into the dated file.
# Inside the -c script, $0 is the log file and "$@" is the app command.
exec gosu node sh -c '"$@" 2>&1 | tee -a "$0"' "$log_file" "$@"
