#!/bin/sh
set -eu
umask 077

read_secret() {
  variable_name="$1"
  secret_path="$2"
  if [ ! -s "$secret_path" ]; then
    echo "Required secret file for $variable_name is missing or empty." >&2
    exit 1
  fi
  secret_value="$(cat "$secret_path")"
  export "$variable_name=$secret_value"
  unset secret_value
}

read_secret NVIDIA_INFERENCE_API_KEY /run/secrets/nvidia-inference-api-key
read_secret NGC_API_KEY /run/secrets/nvidia-hub-key
read_secret MEDIA_LITELLM_MASTER_KEY /run/secrets/media-litellm-master-key

exec docker/prod_entrypoint.sh "$@"
