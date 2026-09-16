#!/bin/sh
set -eu

keys_dir="${PROVIDER_KEYS_DIR:-/opt/provider-keys}"

read_secret() {
  secret_path="$1"
  if [ -f "$secret_path" ] && [ -s "$secret_path" ]; then
    tr -d '[:space:]' < "$secret_path"
  fi
}

if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
  NVIDIA_INFERENCE_API_KEY="$(read_secret "$keys_dir/api.key")"
  export NVIDIA_INFERENCE_API_KEY
fi
if [ -z "${NGC_API_KEY:-}" ]; then
  NGC_API_KEY="$(read_secret "$keys_dir/hub.key")"
  export NGC_API_KEY
fi

if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
  echo '[candidate-media] NVIDIA inference credential is unavailable' >&2
  exit 1
fi

echo '[candidate-media] Provider credential loaded; value is not logged.'
exec docker/prod_entrypoint.sh "$@"
