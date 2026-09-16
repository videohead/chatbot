#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf '%s\n' 'Run this stop command with sudo from an ordinary Spark host terminal.' >&2
  exit 1
fi

if [[ "${1:-}" != --confirm-public-stop ]]; then
  printf '%s\n' \
    'This container serves the public chatbot.' \
    'To stop it intentionally, rerun with: --confirm-public-stop' >&2
  exit 2
fi

docker compose \
  -f /opt/chatbot-media-candidate/docker-compose.yml \
  -p chatbot-media-candidate \
  stop chatbot

printf '%s\n' \
  'The public chatbot was stopped intentionally.' \
  'The media gateway, shared LiteLLM, databases, generated media, and rollback container were retained.'
