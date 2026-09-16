#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf '%s\n' 'Run this start command with sudo from an ordinary Spark host terminal.' >&2
  exit 1
fi

root=/opt/chatbot-media-candidate
compose_file="$root/docker-compose.yml"
project=chatbot-media-candidate
diagnostics="$root/logs/primary-startup.log"

install -d -m 0750 "$root/logs"

if docker inspect chatbot >/dev/null 2>&1 && \
   [[ "$(docker inspect --format '{{.State.Status}}' chatbot)" == running ]]; then
  printf '%s\n' \
    'Start stopped: the retained rollback chatbot is already running and may own port 3000.' >&2
  exit 1
fi

active_route="$(DYNAMIC_FILE=/opt/traefik/dynamic.yml python3 - <<'PY'
import os
import yaml

with open(os.environ["DYNAMIC_FILE"], encoding="utf-8") as stream:
    data = yaml.safe_load(stream)
print(data["http"]["services"]["chatbot"]["loadBalancer"]["servers"][0]["url"])
PY
)"
[[ "$active_route" == http://127.0.0.1:3000 ]] || {
  printf 'Start stopped: Traefik has an unexpected chatbot upstream: %s\n' "$active_route" >&2
  exit 1
}

docker compose -f "$compose_file" -p "$project" config --quiet
printf '%s\n' 'Building and starting the primary chatbot on loopback port 3000.'
if ! docker compose -f "$compose_file" -p "$project" up -d --build --wait chatbot \
  >"$diagnostics" 2>&1; then
  docker compose -f "$compose_file" -p "$project" logs --no-color --tail 300 \
    >>"$diagnostics" 2>&1 || true
  chmod 0600 "$diagnostics" || true
  printf 'Primary chatbot did not become ready. Private diagnostics: %s\n' \
    "$diagnostics" >&2
  exit 1
fi

chmod 0600 "$diagnostics" || true
"$root/scripts/verify-primary.sh"
