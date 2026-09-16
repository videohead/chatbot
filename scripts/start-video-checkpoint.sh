#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' \
  'The video checkpoint has been promoted to the primary port-3000 deployment.' \
  'Running the guarded primary start command.'
exec /opt/chatbot-media-candidate/scripts/start-primary.sh "$@"
