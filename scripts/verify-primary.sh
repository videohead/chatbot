#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf '%s\n' 'Run this check with sudo from an ordinary Spark host terminal.' >&2
  exit 1
fi

compose_file=/opt/chatbot-media-candidate/docker-compose.yml
dynamic_file=/opt/traefik/dynamic.yml
primary_container=chatbot-media-candidate
media_container=media-litellm-candidate
retained_container=chatbot

docker compose -f "$compose_file" -p chatbot-media-candidate config --quiet

primary_state="$(docker inspect --format '{{.State.Status}}' "$primary_container")"
primary_port="$(docker port "$primary_container" 3000/tcp)"
media_state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$media_container")"

[[ "$primary_state" == running ]] || {
  printf 'Primary chatbot is not running: %s\n' "$primary_state" >&2
  exit 1
}
[[ "$primary_port" == 127.0.0.1:3000 ]] || {
  printf 'Primary chatbot has an unexpected published port: %s\n' "$primary_port" >&2
  exit 1
}
[[ "$media_state" == 'running healthy' ]] || {
  printf 'Media gateway is not healthy: %s\n' "$media_state" >&2
  exit 1
}

if docker inspect "$retained_container" >/dev/null 2>&1; then
  retained_state="$(docker inspect --format '{{.State.Status}}' "$retained_container")"
  [[ "$retained_state" != running ]] || {
    printf '%s\n' 'Retained rollback chatbot is unexpectedly running.' >&2
    exit 1
  }
fi

active_route="$(DYNAMIC_FILE="$dynamic_file" python3 - <<'PY'
import os
import yaml

with open(os.environ["DYNAMIC_FILE"], encoding="utf-8") as stream:
    data = yaml.safe_load(stream)
print(data["http"]["services"]["chatbot"]["loadBalancer"]["servers"][0]["url"])
PY
)"
[[ "$active_route" == http://127.0.0.1:3000 ]] || {
  printf 'Traefik has an unexpected chatbot upstream: %s\n' "$active_route" >&2
  exit 1
}

curl --fail --silent --show-error --max-time 20 \
  -o /dev/null http://127.0.0.1:3000/login
curl --fail --silent --show-error --max-time 20 --insecure \
  --resolve videohead.duckdns.org:443:127.0.0.1 \
  -o /dev/null https://videohead.duckdns.org/login

printf '%s\n' \
  'Primary chatbot checks passed.' \
  'The chatbot is loopback-only on port 3000 and Traefik is its public entry point.' \
  'The media gateway is healthy and the preceding chatbot remains stopped for rollback.'
