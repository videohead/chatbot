#!/usr/bin/env bash

set -Eeuo pipefail
set +x

readonly CHATBOT_ROOT="/opt/chatbot"
readonly CHATBOT_COMPOSE="$CHATBOT_ROOT/compose.yaml"
readonly CHATBOT_TEST_COMPOSE="$CHATBOT_ROOT/compose.test.yaml"
readonly CHATBOT_RUNTIME="$CHATBOT_ROOT/.runtime"
readonly CHATBOT_CURRENT_RELEASE="$CHATBOT_RUNTIME/current.env"
readonly CHATBOT_PENDING_RELEASE="$CHATBOT_RUNTIME/pending.env"
readonly CHATBOT_PREVIOUS_RELEASE="$CHATBOT_RUNTIME/previous.env"
readonly CHATBOT_TESTED_MANIFEST="$CHATBOT_RUNTIME/tested.manifest"

die() {
  printf 'Chatbot operation stopped: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  docker info >/dev/null 2>&1 || die "Docker access is required; run this command with sudo from the Spark host"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
}

require_root() {
  (( EUID == 0 )) || die "run this command with sudo from the Spark host"
}

acquire_operation_lock() {
  [[ ${CHATBOT_OPERATION_LOCK_HELD:-} == 1 ]] && return 0
  install -d -o 1000 -g optusers -m 2770 "$CHATBOT_RUNTIME"
  exec 8>"$CHATBOT_RUNTIME/operation.lock"
  flock -n 8 || die "another chatbot operation is already running"
  export CHATBOT_OPERATION_LOCK_HELD=1
}

ensure_runtime_dirs() {
  install -d -o 1000 -g optusers -m 2770 \
    "$CHATBOT_RUNTIME" \
    "$CHATBOT_RUNTIME/releases" \
    "$CHATBOT_RUNTIME/test/logs" \
    "$CHATBOT_RUNTIME/test/creative" \
    "$CHATBOT_RUNTIME/test/nvidia" \
    "$CHATBOT_RUNTIME/test/secrets" \
    "$CHATBOT_RUNTIME/test/workspace" \
    "$CHATBOT_RUNTIME/workspace" \
    "$CHATBOT_ROOT/logs" \
    "$CHATBOT_ROOT/generated-media"
  if (( EUID == 0 )); then
    local candidate_secret
    for candidate_secret in workspace.token github.token gitlab.token; do
      printf 'candidate-%s-disabled\n' "$candidate_secret" \
        | install -o 1000 -g 1000 -m 0400 /dev/stdin \
          "$CHATBOT_RUNTIME/test/secrets/$candidate_secret"
    done
  fi
}

require_assignment_schema() {
  local file=$1 expected_lines=$2 field count
  shift 2
  [[ "$(wc -l <"$file")" -eq "$expected_lines" ]] \
    || die "assignment file has an unexpected line count: $file"
  for field in "$@"; do
    count=$(awk -F= -v key="$field" '$1 == key { found++ } END { print found + 0 }' "$file")
    [[ "$count" -eq 1 ]] || die "assignment file must contain $field exactly once: $file"
  done
}

validate_release_file() {
  local release_file=$1
  [[ -f "$release_file" && ! -L "$release_file" ]] || die "release file is missing: $release_file"
  if grep -Ev '^(CHATBOT_(RELEASE_ID|WEB_IMAGE|MEDIA_IMAGE|MEDIA_BASE_IMAGE|WORKSPACE_IMAGE))=[A-Za-z0-9_./:@+-]+$' \
    "$release_file" | grep -q .; then
    die "release file contains an unsupported field or value: $release_file"
  fi
  local required
  require_assignment_schema "$release_file" 5 \
    CHATBOT_RELEASE_ID CHATBOT_WEB_IMAGE CHATBOT_MEDIA_IMAGE \
    CHATBOT_MEDIA_BASE_IMAGE CHATBOT_WORKSPACE_IMAGE
  for required in CHATBOT_RELEASE_ID CHATBOT_WEB_IMAGE CHATBOT_MEDIA_IMAGE \
    CHATBOT_MEDIA_BASE_IMAGE CHATBOT_WORKSPACE_IMAGE; do
    grep -q "^${required}=" "$release_file" || die "release file omits $required"
  done
}

load_release_file() {
  local release_file=$1
  validate_release_file "$release_file"
  set -a
  # The validator above restricts this file to simple image/reference fields.
  # shellcheck disable=SC1090
  source "$release_file"
  set +a
}

release_id_from_file() {
  local release_file=$1
  validate_release_file "$release_file"
  sed -n 's/^CHATBOT_RELEASE_ID=//p' "$release_file"
}

release_compose_path() {
  printf '%s/releases/%s.compose.yaml' "$CHATBOT_RUNTIME" "$(release_id_from_file "$1")"
}

release_test_compose_path() {
  printf '%s/releases/%s.compose.test.yaml' "$CHATBOT_RUNTIME" "$(release_id_from_file "$1")"
}

release_policy_path() {
  printf '%s/releases/%s.workspace-policy.json' "$CHATBOT_RUNTIME" "$(release_id_from_file "$1")"
}

require_release_configuration() {
  local release_file=$1 path policy_snapshot
  for path in \
    "$(release_compose_path "$release_file")" \
    "$(release_test_compose_path "$release_file")" \
    "$(release_policy_path "$release_file")"; do
    [[ -f "$path" && ! -L "$path" ]] || die "release configuration snapshot is missing: $path"
  done
  policy_snapshot=$(release_policy_path "$release_file")
  [[ "$(stat -c '%u:%g:%a' "$policy_snapshot")" == 1000:1000:400 ]] \
    || die "workspace policy snapshot does not have private container-readable ownership and mode"
}

snapshot_release_configuration() {
  local release_file=$1 compose_snapshot test_snapshot policy_snapshot
  validate_release_file "$release_file"
  compose_snapshot=$(release_compose_path "$release_file")
  test_snapshot=$(release_test_compose_path "$release_file")
  policy_snapshot=$(release_policy_path "$release_file")
  install -o root -g optusers -m 0640 "$CHATBOT_COMPOSE" "$compose_snapshot"
  install -o root -g optusers -m 0640 "$CHATBOT_TEST_COMPOSE" "$test_snapshot"
  install -o 1000 -g 1000 -m 0400 \
    "$CHATBOT_ROOT/config/workspace-policy.json" "$policy_snapshot"
  require_release_configuration "$release_file"
}

release_manifest_path() {
  local release_file=$1 release_id
  validate_release_file "$release_file"
  release_id=$(sed -n 's/^CHATBOT_RELEASE_ID=//p' "$release_file")
  printf '%s/releases/%s.manifest' "$CHATBOT_RUNTIME" "$release_id"
}

write_release_manifest() {
  local release_file=$1 source_commit=$2 catalog_sha256=$3 manifest tmp
  local compose_snapshot test_snapshot policy_snapshot
  local media_base_image_id web_image_id media_image_id workspace_image_id
  load_release_file "$release_file"
  require_release_configuration "$release_file"
  compose_snapshot=$(release_compose_path "$release_file")
  test_snapshot=$(release_test_compose_path "$release_file")
  policy_snapshot=$(release_policy_path "$release_file")
  manifest=$(release_manifest_path "$release_file")
  tmp="${manifest}.tmp.$$"
  media_base_image_id=$(docker image inspect --format '{{.Id}}' "$CHATBOT_MEDIA_BASE_IMAGE") \
    || die "media base image is unavailable while recording the release"
  web_image_id=$(docker image inspect --format '{{.Id}}' "$CHATBOT_WEB_IMAGE") \
    || die "web image is unavailable while recording the release"
  media_image_id=$(docker image inspect --format '{{.Id}}' "$CHATBOT_MEDIA_IMAGE") \
    || die "media image is unavailable while recording the release"
  workspace_image_id=$(docker image inspect --format '{{.Id}}' "$CHATBOT_WORKSPACE_IMAGE") \
    || die "workspace image is unavailable while recording the release"
  {
    printf 'RELEASE_ID=%s\n' "$CHATBOT_RELEASE_ID"
    printf 'RELEASE_FILE_SHA256=%s\n' "$(sha256sum "$release_file" | cut -d' ' -f1)"
    printf 'SOURCE_COMMIT=%s\n' "$source_commit"
    printf 'MODEL_CATALOG_SHA256=%s\n' "$catalog_sha256"
    printf 'MEDIA_BASE_IMAGE_ID=%s\n' "$media_base_image_id"
    printf 'WEB_IMAGE_ID=%s\n' "$web_image_id"
    printf 'MEDIA_IMAGE_ID=%s\n' "$media_image_id"
    printf 'WORKSPACE_IMAGE_ID=%s\n' "$workspace_image_id"
    printf 'BUILD_COMPOSE_SHA256=%s\n' "$(sha256sum "$compose_snapshot" | cut -d' ' -f1)"
    printf 'TEST_COMPOSE_SHA256=%s\n' "$(sha256sum "$test_snapshot" | cut -d' ' -f1)"
    printf 'WORKSPACE_POLICY_SHA256=%s\n' "$(sha256sum "$policy_snapshot" | cut -d' ' -f1)"
  } >"$tmp"
  chown root:optusers "$tmp"
  chmod 0640 "$tmp"
  mv -T -- "$tmp" "$manifest"
}

verify_release_images() {
  local release_file=$1 manifest compose_snapshot test_snapshot policy_snapshot
  validate_release_file "$release_file"
  require_release_configuration "$release_file"
  compose_snapshot=$(release_compose_path "$release_file")
  test_snapshot=$(release_test_compose_path "$release_file")
  policy_snapshot=$(release_policy_path "$release_file")
  load_release_file "$release_file"
  manifest=$(release_manifest_path "$release_file")
  [[ -f "$manifest" && ! -L "$manifest" ]] || die "release image manifest is missing: $manifest"
  if grep -Ev '^(RELEASE_ID=[A-Za-z0-9_.+-]+|RELEASE_FILE_SHA256=[a-f0-9]{64}|SOURCE_COMMIT=([a-f0-9]{40}|legacy)|MODEL_CATALOG_SHA256=([a-f0-9]{64}|legacy)|((WEB|MEDIA|MEDIA_BASE|WORKSPACE)_IMAGE_ID)=sha256:[a-f0-9]{64}|((BUILD|TEST)_COMPOSE|WORKSPACE_POLICY)_SHA256=[a-f0-9]{64})$' \
    "$manifest" | grep -q .; then
    die "release image manifest is invalid: $manifest"
  fi
  require_assignment_schema "$manifest" 11 \
    RELEASE_ID RELEASE_FILE_SHA256 SOURCE_COMMIT MODEL_CATALOG_SHA256 \
    MEDIA_BASE_IMAGE_ID WEB_IMAGE_ID MEDIA_IMAGE_ID WORKSPACE_IMAGE_ID BUILD_COMPOSE_SHA256 \
    TEST_COMPOSE_SHA256 WORKSPACE_POLICY_SHA256
  set -a
  # shellcheck disable=SC1090
  source "$manifest"
  set +a
  [[ "$RELEASE_ID" == "$CHATBOT_RELEASE_ID" ]] || die "release manifest ID mismatch"
  [[ "$(sha256sum "$release_file" | cut -d' ' -f1)" == "$RELEASE_FILE_SHA256" ]] \
    || die "release file changed after its images were recorded"
  [[ "$(sha256sum "$compose_snapshot" | cut -d' ' -f1)" == "$BUILD_COMPOSE_SHA256" ]] \
    || die "production Compose snapshot changed after release creation"
  [[ "$(sha256sum "$test_snapshot" | cut -d' ' -f1)" == "$TEST_COMPOSE_SHA256" ]] \
    || die "candidate Compose snapshot changed after release creation"
  [[ "$(sha256sum "$policy_snapshot" | cut -d' ' -f1)" == "$WORKSPACE_POLICY_SHA256" ]] \
    || die "workspace policy snapshot changed after release creation"
  [[ "$(docker image inspect --format '{{.Id}}' "$CHATBOT_MEDIA_BASE_IMAGE" 2>/dev/null || true)" == "$MEDIA_BASE_IMAGE_ID" ]] \
    || die "media base image tag differs from its release manifest"
  [[ "$(docker image inspect --format '{{.Id}}' "$CHATBOT_WEB_IMAGE" 2>/dev/null || true)" == "$WEB_IMAGE_ID" ]] \
    || die "web image tag differs from its release manifest"
  [[ "$(docker image inspect --format '{{.Id}}' "$CHATBOT_MEDIA_IMAGE" 2>/dev/null || true)" == "$MEDIA_IMAGE_ID" ]] \
    || die "media image tag differs from its release manifest"
  [[ "$(docker image inspect --format '{{.Id}}' "$CHATBOT_WORKSPACE_IMAGE" 2>/dev/null || true)" == "$WORKSPACE_IMAGE_ID" ]] \
    || die "workspace image tag differs from its release manifest"
}

verify_live_release() {
  local release_file=$1 service expected container
  verify_release_images "$release_file"
  for service in web media workspace; do
    case "$service" in
      web) expected=$WEB_IMAGE_ID ;;
      media) expected=$MEDIA_IMAGE_ID ;;
      workspace) expected=$WORKSPACE_IMAGE_ID ;;
    esac
    container="$(live_compose "$release_file" ps -q "$service")"
    [[ -n "$container" && "$(docker inspect --format '{{.Image}}' "$container")" == "$expected" ]] \
      || die "running $service container differs from the recorded current release"
  done
}

live_compose() {
  local release_file=${1:-$CHATBOT_CURRENT_RELEASE} compose_snapshot policy_snapshot
  shift || true
  validate_release_file "$release_file"
  require_release_configuration "$release_file"
  compose_snapshot=$(release_compose_path "$release_file")
  policy_snapshot=$(release_policy_path "$release_file")
  CHATBOT_PROJECT_NAME=chatbot \
  CHATBOT_HOST_PORT=3000 \
  CHATBOT_BUILD_CONTEXT="$CHATBOT_ROOT" \
  CHATBOT_WORKSPACE_BUILD_CONTEXT="$CHATBOT_ROOT/services/workspace" \
  CHATBOT_LOGS_DIR="$CHATBOT_ROOT/logs" \
  CHATBOT_GENERATED_MEDIA_DIR="$CHATBOT_ROOT/generated-media" \
  CHATBOT_CREATIVE_DIR=/home/blechdom/creative \
  CHATBOT_NVIDIA_DIR=/home/blechdom/nvidia \
  CHATBOT_WORKSPACE_STATE_DIR="$CHATBOT_RUNTIME/workspace" \
  CHATBOT_WORKSPACE_POLICY_FILE="$policy_snapshot" \
  CHATBOT_WORKSPACE_TOKEN_FILE=/etc/chatbot/secrets/workspace/token \
  CHATBOT_GITHUB_TOKEN_FILE=/etc/chatbot/secrets/workspace/github.token \
  CHATBOT_GITLAB_TOKEN_FILE=/etc/chatbot/secrets/workspace/gitlab.token \
  CHATBOT_RESTART_POLICY=unless-stopped \
    docker compose --env-file "$release_file" -f "$compose_snapshot" "$@"
}

test_compose() {
  local release_file=$1 compose_snapshot test_snapshot policy_snapshot
  shift
  validate_release_file "$release_file"
  require_release_configuration "$release_file"
  compose_snapshot=$(release_compose_path "$release_file")
  test_snapshot=$(release_test_compose_path "$release_file")
  policy_snapshot=$(release_policy_path "$release_file")
  CHATBOT_PROJECT_NAME=chatbot-test \
  CHATBOT_HOST_PORT=15008 \
  CHATBOT_BUILD_CONTEXT="$CHATBOT_ROOT" \
  CHATBOT_WORKSPACE_BUILD_CONTEXT="$CHATBOT_ROOT/services/workspace" \
  CHATBOT_LOGS_DIR="$CHATBOT_RUNTIME/test/logs" \
  CHATBOT_GENERATED_MEDIA_DIR="$CHATBOT_ROOT/generated-media" \
  CHATBOT_CREATIVE_DIR="$CHATBOT_RUNTIME/test/creative" \
  CHATBOT_NVIDIA_DIR="$CHATBOT_RUNTIME/test/nvidia" \
  CHATBOT_WORKSPACE_STATE_DIR="$CHATBOT_RUNTIME/test/workspace" \
  CHATBOT_WORKSPACE_POLICY_FILE="$policy_snapshot" \
  CHATBOT_WORKSPACE_TOKEN_FILE="$CHATBOT_RUNTIME/test/secrets/workspace.token" \
  CHATBOT_GITHUB_TOKEN_FILE="$CHATBOT_RUNTIME/test/secrets/github.token" \
  CHATBOT_GITLAB_TOKEN_FILE="$CHATBOT_RUNTIME/test/secrets/gitlab.token" \
  CHATBOT_RESTART_POLICY=no \
    docker compose --env-file "$release_file" \
      -f "$compose_snapshot" -f "$test_snapshot" "$@"
}

atomic_copy() {
  local source=$1 target=$2 tmp
  tmp="${target}.tmp.$$"
  install -o root -g optusers -m 0640 "$source" "$tmp"
  mv -T -- "$tmp" "$target"
}

derive_media_image() (
  set -Eeuo pipefail
  local base_image=$1 target_image=$2 context_dir=$3 source
  local base_id= layer_id= verify_id= target_id=
  local verify_dir= entrypoint_sha= config_sha=
  local may_remove_target=false keep_target=false

  cleanup_media_derivation() {
    local status=$?
    trap - EXIT INT TERM
    set +e
    [[ -z "$verify_id" ]] || docker rm -fv "$verify_id" >/dev/null 2>&1
    [[ -z "$layer_id" ]] || docker rm -fv "$layer_id" >/dev/null 2>&1
    [[ -z "$verify_dir" || ! -e "$verify_dir" ]] \
      || rm -rf --one-file-system -- "$verify_dir"
    if [[ "$may_remove_target" == true && "$keep_target" == false ]]; then
      docker image rm "$target_image" >/dev/null 2>&1 || true
    fi
    exit "$status"
  }
  trap cleanup_media_derivation EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  [[ -d "$context_dir" && ! -L "$context_dir" ]] \
    || { printf 'Media build context is unavailable.\n' >&2; exit 1; }
  for source in deploy/media/Dockerfile deploy/media/entrypoint.sh config/media-litellm.yaml; do
    [[ -f "$context_dir/$source" && ! -L "$context_dir/$source" ]] \
      || { printf 'Required media source is unavailable: %s.\n' "$source" >&2; exit 1; }
  done
  python3 -I - "$context_dir/deploy/media/Dockerfile" <<'PY'
from pathlib import Path
import sys

expected = '''ARG LITELLM_BASE_IMAGE=docker.litellm.ai/berriai/litellm:main-stable
FROM ${LITELLM_BASE_IMAGE}

USER root
COPY --chmod=0555 deploy/media/entrypoint.sh /app/chatbot-media-entrypoint.sh
COPY --chmod=0444 config/media-litellm.yaml /app/chatbot-media-config.yaml

ENTRYPOINT ["/app/chatbot-media-entrypoint.sh"]
CMD ["--config", "/app/chatbot-media-config.yaml"]
'''
if Path(sys.argv[1]).read_text() != expected:
    raise SystemExit('Media Dockerfile changed; update and review derive_media_image before building')
PY

  base_id=$(docker image inspect --format '{{.Id}}' "$base_image" 2>/dev/null) \
    || { printf 'Exact local media base image is unavailable.\n' >&2; exit 1; }
  [[ "$base_id" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || { printf 'Exact local media base identity is invalid.\n' >&2; exit 1; }
  if docker image inspect "$target_image" >/dev/null 2>&1; then
    printf 'Refusing to replace an existing media release image: %s.\n' "$target_image" >&2
    exit 1
  fi
  may_remove_target=true
  entrypoint_sha=$(sha256sum "$context_dir/deploy/media/entrypoint.sh" | cut -d' ' -f1)
  config_sha=$(sha256sum "$context_dir/config/media-litellm.yaml" | cut -d' ' -f1)
  verify_dir=$(mktemp -d "$CHATBOT_RUNTIME/media-image-verify.XXXXXX")
  chmod 0700 "$verify_dir"
  layer_id=$(docker create "$base_id") \
    || { printf 'Could not create the stopped media image layer container.\n' >&2; exit 1; }
  [[ "$(docker inspect --format '{{.Image}}' "$layer_id")" == "$base_id" ]] \
    || { printf 'Stopped media layer container does not use the pinned base image.\n' >&2; exit 1; }

  # Docker BuildKit cannot resolve this daemon-local legacy image. Inject the
  # two tracked public files into a never-started container instead. The tar
  # metadata reproduces the ownership and modes declared by the Dockerfile.
  python3 -I - "$context_dir" <<'PY' | docker cp - "$layer_id:/app"
import io
import os
from pathlib import Path
import stat
import sys
import tarfile

root = Path(sys.argv[1])
files = (
    ('deploy/media/entrypoint.sh', 'chatbot-media-entrypoint.sh', 0o555),
    ('config/media-litellm.yaml', 'chatbot-media-config.yaml', 0o444),
)
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as archive:
    for relative, target, mode in files:
        path = root / relative
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
                raise SystemExit(f'Invalid media source: {relative}')
            body = handle.read(1024 * 1024 + 1)
            if len(body) != info.st_size:
                raise SystemExit(f'Media source changed while reading: {relative}')
        member = tarfile.TarInfo(target)
        member.size = len(body)
        member.mode = mode
        member.uid = member.gid = 0
        member.uname = member.gname = 'root'
        member.mtime = 0
        archive.addfile(member, io.BytesIO(body))
PY

  target_id=$(docker commit \
    --change 'USER root' \
    --change 'ENTRYPOINT ["/app/chatbot-media-entrypoint.sh"]' \
    --change 'CMD ["--config","/app/chatbot-media-config.yaml"]' \
    "$layer_id" "$target_image") \
    || { printf 'Could not commit the canonical media release image.\n' >&2; exit 1; }
  [[ "$target_id" =~ ^sha256:[a-f0-9]{64}$ \
      && "$(docker image inspect --format '{{.Id}}' "$target_image")" == "$target_id" ]] \
    || { printf 'Committed media image identity could not be verified.\n' >&2; exit 1; }

  python3 -I - "$base_id" "$target_id" <<'PY'
import json
import subprocess
import sys

result = subprocess.run(
    ['docker', 'image', 'inspect', sys.argv[1], sys.argv[2]],
    check=True,
    stdout=subprocess.PIPE,
)
base, target = json.loads(result.stdout)
base_config = base['Config']
target_config = target['Config']
blocked_env = {
    'NVIDIA_INFERENCE_API_KEY', 'NGC_API_KEY',
    'MEDIA_LITELLM_MASTER_KEY', 'LITELLM_MASTER_KEY',
}
base_env_keys = {item.partition('=')[0] for item in (base_config.get('Env') or [])}
embedded = sorted(blocked_env & base_env_keys)
if embedded:
    raise SystemExit('Media base image contains credential environment fields: ' + ', '.join(embedded))
for field in ('Env', 'ExposedPorts', 'WorkingDir', 'Labels', 'Healthcheck',
              'StopSignal', 'Shell', 'Volumes', 'OnBuild'):
    if base_config.get(field) != target_config.get(field):
        raise SystemExit(f'Media image changed inherited config field: {field}')
if target_config.get('User') != 'root':
    raise SystemExit('Media image user is invalid')
if target_config.get('Entrypoint') != ['/app/chatbot-media-entrypoint.sh']:
    raise SystemExit('Media image entrypoint is invalid')
if target_config.get('Cmd') != ['--config', '/app/chatbot-media-config.yaml']:
    raise SystemExit('Media image command is invalid')
PY

  verify_id=$(docker create "$target_id")
  [[ "$(docker inspect --format '{{.Image}}' "$verify_id")" == "$target_id" ]] \
    || { printf 'Media verification container does not use the committed image.\n' >&2; exit 1; }
  docker cp "$verify_id:/app/chatbot-media-entrypoint.sh" - >"$verify_dir/entrypoint.tar"
  docker cp "$verify_id:/app/chatbot-media-config.yaml" - >"$verify_dir/config.tar"
  python3 -I - "$verify_dir" "$entrypoint_sha" "$config_sha" <<'PY'
import hashlib
from pathlib import Path
import stat
import sys
import tarfile

root = Path(sys.argv[1])
checks = (
    ('entrypoint.tar', sys.argv[2], 0o555),
    ('config.tar', sys.argv[3], 0o444),
)
for filename, expected_hash, expected_mode in checks:
    with tarfile.open(root / filename, mode='r:*') as archive:
        regular = [member for member in archive.getmembers() if member.isfile()]
        if len(regular) != 1:
            raise SystemExit(f'Unexpected media verification archive: {filename}')
        member = regular[0]
        if member.uid != 0 or member.gid != 0 or stat.S_IMODE(member.mode) != expected_mode:
            raise SystemExit(f'Invalid media file metadata: {filename}')
        handle = archive.extractfile(member)
        if handle is None:
            raise SystemExit(f'Media file is unavailable: {filename}')
        body = handle.read(1024 * 1024 + 1)
        if len(body) != member.size or hashlib.sha256(body).hexdigest() != expected_hash:
            raise SystemExit(f'Media file content mismatch: {filename}')
PY
  [[ "$(sha256sum "$context_dir/deploy/media/entrypoint.sh" | cut -d' ' -f1)" == "$entrypoint_sha" \
      && "$(sha256sum "$context_dir/config/media-litellm.yaml" | cut -d' ' -f1)" == "$config_sha" ]] \
    || { printf 'Media source changed during image derivation.\n' >&2; exit 1; }

  docker rm -fv "$verify_id" >/dev/null
  verify_id=
  docker rm -fv "$layer_id" >/dev/null
  layer_id=
  rm -rf --one-file-system -- "$verify_dir"
  verify_dir=
  [[ "$(docker image inspect --format '{{.Id}}' "$target_image")" == "$target_id" ]] \
    || { printf 'Media release image tag changed during validation.\n' >&2; exit 1; }
  keep_target=true
)

container_health() {
  docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null || true
}

load_migration_file() {
  local migration_record="$CHATBOT_RUNTIME/migration.env"
  [[ -f "$migration_record" && ! -L "$migration_record" ]] || die "legacy migration record is missing"
  if grep -Ev '^(MIGRATION_(PHASE|ID|RELEASE_FILE)|LEGACY_(WEB|MEDIA|WORKSPACE)_(ID|BACKUP|RESTART)|LEGACY_WORKSPACE_STATE|TRAEFIK_SHA256)=[A-Za-z0-9_./:@+-]+$' \
    "$migration_record" | grep -q .; then
    die "legacy migration record contains an unsupported field or value"
  fi
  require_assignment_schema "$migration_record" 14 \
    MIGRATION_PHASE MIGRATION_ID MIGRATION_RELEASE_FILE \
    LEGACY_WEB_ID LEGACY_WEB_BACKUP LEGACY_WEB_RESTART \
    LEGACY_MEDIA_ID LEGACY_MEDIA_BACKUP LEGACY_MEDIA_RESTART \
    LEGACY_WORKSPACE_ID LEGACY_WORKSPACE_BACKUP LEGACY_WORKSPACE_RESTART \
    LEGACY_WORKSPACE_STATE TRAEFIK_SHA256
  set -a
  # The validator above restricts this file to identifiers, paths, and hashes.
  # shellcheck disable=SC1090
  source "$migration_record"
  set +a
}

wait_for_url() {
  local url=$1 attempts=${2:-60}
  local count
  for ((count=1; count<=attempts; count++)); do
    if curl --fail --silent --show-error --max-time 5 --output /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

record_tested_release() {
  local release_file=$1 web_container media_container workspace_container tmp
  local compose_snapshot test_snapshot policy_snapshot
  validate_release_file "$release_file"
  require_release_configuration "$release_file"
  compose_snapshot=$(release_compose_path "$release_file")
  test_snapshot=$(release_test_compose_path "$release_file")
  policy_snapshot=$(release_policy_path "$release_file")
  web_container="$(test_compose "$release_file" ps -q web)"
  media_container="$(test_compose "$release_file" ps -q media)"
  workspace_container="$(test_compose "$release_file" ps -q workspace)"
  [[ -n "$web_container" && -n "$media_container" && -n "$workspace_container" ]] \
    || die "candidate container identity is incomplete"
  tmp="${CHATBOT_TESTED_MANIFEST}.tmp.$$"
  {
    printf 'TESTED_RELEASE_SHA256=%s\n' "$(sha256sum "$release_file" | cut -d' ' -f1)"
    printf 'TESTED_WEB_IMAGE_ID=%s\n' "$(docker inspect --format '{{.Image}}' "$web_container")"
    printf 'TESTED_MEDIA_IMAGE_ID=%s\n' "$(docker inspect --format '{{.Image}}' "$media_container")"
    printf 'TESTED_WORKSPACE_IMAGE_ID=%s\n' "$(docker inspect --format '{{.Image}}' "$workspace_container")"
    printf 'TESTED_COMPOSE_SHA256=%s\n' "$(sha256sum "$compose_snapshot" | cut -d' ' -f1)"
    printf 'TESTED_TEST_COMPOSE_SHA256=%s\n' "$(sha256sum "$test_snapshot" | cut -d' ' -f1)"
    printf 'TESTED_POLICY_SHA256=%s\n' "$(sha256sum "$policy_snapshot" | cut -d' ' -f1)"
  } >"$tmp"
  chown root:optusers "$tmp"
  chmod 0640 "$tmp"
  mv -T -- "$tmp" "$CHATBOT_TESTED_MANIFEST"
}

verify_tested_release() {
  local release_file=$1 compose_snapshot test_snapshot policy_snapshot
  validate_release_file "$release_file"
  verify_release_images "$release_file"
  compose_snapshot=$(release_compose_path "$release_file")
  test_snapshot=$(release_test_compose_path "$release_file")
  policy_snapshot=$(release_policy_path "$release_file")
  [[ -f "$CHATBOT_TESTED_MANIFEST" && ! -L "$CHATBOT_TESTED_MANIFEST" ]] \
    || die "tested-image manifest is missing"
  if grep -Ev '^TESTED_(RELEASE_SHA256|WEB_IMAGE_ID|MEDIA_IMAGE_ID|WORKSPACE_IMAGE_ID|COMPOSE_SHA256|TEST_COMPOSE_SHA256|POLICY_SHA256)=(sha256:)?[a-f0-9]{64}$' \
    "$CHATBOT_TESTED_MANIFEST" | grep -q .; then
    die "tested-image manifest is invalid"
  fi
  require_assignment_schema "$CHATBOT_TESTED_MANIFEST" 7 \
    TESTED_RELEASE_SHA256 TESTED_WEB_IMAGE_ID TESTED_MEDIA_IMAGE_ID \
    TESTED_WORKSPACE_IMAGE_ID TESTED_COMPOSE_SHA256 \
    TESTED_TEST_COMPOSE_SHA256 TESTED_POLICY_SHA256
  set -a
  # shellcheck disable=SC1090
  source "$CHATBOT_TESTED_MANIFEST"
  set +a
  [[ "$(sha256sum "$release_file" | cut -d' ' -f1)" == "$TESTED_RELEASE_SHA256" ]] \
    || die "tested release file changed"
  [[ "$(sha256sum "$compose_snapshot" | cut -d' ' -f1)" == "$TESTED_COMPOSE_SHA256" ]] \
    || die "production Compose changed after candidate testing"
  [[ "$(sha256sum "$test_snapshot" | cut -d' ' -f1)" == "$TESTED_TEST_COMPOSE_SHA256" ]] \
    || die "candidate Compose changed after candidate testing"
  [[ "$(sha256sum "$policy_snapshot" | cut -d' ' -f1)" == "$TESTED_POLICY_SHA256" ]] \
    || die "workspace policy changed after candidate testing"
  load_release_file "$release_file"

  local service variable expected container image_id
  for service in web media workspace; do
    case "$service" in
      web) variable=$CHATBOT_WEB_IMAGE; expected=$TESTED_WEB_IMAGE_ID ;;
      media) variable=$CHATBOT_MEDIA_IMAGE; expected=$TESTED_MEDIA_IMAGE_ID ;;
      workspace) variable=$CHATBOT_WORKSPACE_IMAGE; expected=$TESTED_WORKSPACE_IMAGE_ID ;;
    esac
    image_id="$(docker image inspect --format '{{.Id}}' "$variable" 2>/dev/null || true)"
    [[ "$image_id" == "$expected" ]] || die "tested $service image tag changed"
    container="$(test_compose "$release_file" ps -q "$service")"
    [[ -n "$container" && "$(docker inspect --format '{{.Image}}' "$container")" == "$expected" ]] \
      || die "candidate $service container no longer uses the tested image"
  done
}

migration_phase_if_any() {
  local migration_file="$CHATBOT_RUNTIME/migration.env"
  [[ -f "$migration_file" && ! -L "$migration_file" ]] || return 0
  sed -n 's/^MIGRATION_PHASE=//p' "$migration_file"
}

require_canonical_live_mode() {
  local phase
  phase=$(migration_phase_if_any)
  case "$phase" in
    preparing|prepared)
      die "the legacy deployment is still live while the canonical candidate is being tested; use ops/migrate-legacy"
      ;;
    rolled-back)
      die "the legacy deployment was restored; use ops/migrate-legacy prepare to retry the canonical cutover"
      ;;
  esac
}
