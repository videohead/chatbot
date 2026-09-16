#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' \
  'The former candidate now serves the public chatbot.' \
  'Forwarding to the guarded primary stop command.'
exec /opt/chatbot-media-candidate/scripts/stop-primary.sh "$@"
