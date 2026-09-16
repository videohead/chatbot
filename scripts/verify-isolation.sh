#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' \
  'The isolated candidate has been promoted; checking the primary deployment.'
exec /opt/chatbot-media-candidate/scripts/verify-primary.sh "$@"
