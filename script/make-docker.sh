#!/usr/bin/env bash
# Build locally by default. Set these environment variables when publishing.
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-sentinel-atlas}"
IMAGE_TAG="${IMAGE_TAG:-local}"
BUILD_TARGET="${BUILD_TARGET:-runtime}"
PLATFORMS="${PLATFORMS:-}"
PUSH="${PUSH:-false}"
TAG_LATEST="${TAG_LATEST:-false}"
dry_run=false

usage() {
  cat <<'HELP'
Usage: script/make-docker.sh [options]

Build Sentinel Atlas locally, or explicitly publish a configured image.

Environment variables (command-line options override them):
  IMAGE_NAME    Image/repository name (default: sentinel-atlas)
  IMAGE_TAG     Image tag (default: local)
  BUILD_TARGET  runtime or ansible (default: runtime)
  PLATFORMS     Local: native platform; push: linux/amd64,linux/arm64
  PUSH          false by default; set true to publish with buildx
  TAG_LATEST    false by default; true also tags the image as latest

Options:
  --image NAME       Set IMAGE_NAME (e.g. your-user/sentinel-atlas)
  --tag TAG          Set IMAGE_TAG (e.g. 2.0.0)
  --target TARGET    Choose runtime or ansible
  --platforms LIST   Set a platform or comma-separated publish platforms
  --push             Publish instead of loading the local Docker engine
  --dry-run          Print the build command without building or publishing
  -h, --help         Show this help

Examples:
  ./script/make-docker.sh
  IMAGE_NAME=your-user/sentinel-atlas IMAGE_TAG=2.0.0 ./script/make-docker.sh
  PUSH=true IMAGE_NAME=your-user/sentinel-atlas IMAGE_TAG=2.0.0 ./script/make-docker.sh

Run 'docker login' yourself before publishing. Runtime secrets and .env files
are not read by this script or passed as image build arguments.
HELP
}
fail() { printf 'Error: %s\n' "$*" >&2; exit 2; }
while (($#)); do
  case "$1" in
    --image|--tag|--target|--platforms)
      (($# >= 2)) || fail "$1 needs a value"
      case "$1" in
        --image) IMAGE_NAME=$2 ;;
        --tag) IMAGE_TAG=$2 ;;
        --target) BUILD_TARGET=$2 ;;
        --platforms) PLATFORMS=$2 ;;
      esac
      shift 2 ;;
    --push) PUSH=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1 (use --help)" ;;
  esac
done

[[ "$PUSH" == true || "$PUSH" == false ]] || fail 'PUSH must be true or false'
[[ "$TAG_LATEST" == true || "$TAG_LATEST" == false ]] || fail 'TAG_LATEST must be true or false'
[[ "$BUILD_TARGET" == runtime || "$BUILD_TARGET" == ansible ]] || fail 'BUILD_TARGET must be runtime or ansible'
[[ "$IMAGE_NAME" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || fail 'IMAGE_NAME must be a lowercase repository name without a tag'
[[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ && ${#IMAGE_TAG} -le 128 ]] || fail 'IMAGE_TAG must be a valid Docker tag (up to 128 characters)'
if [[ "$PUSH" == true ]]; then
  [[ "$IMAGE_NAME" == */* ]] || fail 'Publishing needs a repository namespace: IMAGE_NAME=your-user/sentinel-atlas'
  [[ "$IMAGE_TAG" != local ]] || fail 'Set an explicit IMAGE_TAG before publishing (for example 2.0.0)'
  PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
elif [[ "$PLATFORMS" == *,* ]]; then
  fail 'Local loading supports one platform. Set PUSH=true for a multi-platform publish.'
fi
if [[ -n "$PLATFORMS" ]]; then
  IFS=',' read -r -a selected_platforms <<< "$PLATFORMS"
  for platform in "${selected_platforms[@]}"; do
    [[ "$platform" =~ ^linux/[a-z0-9_]+(/[a-z0-9_.-]+)?$ ]] || fail "Invalid platform: $platform"
  done
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
revision="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || printf 'unknown')"
build_command=(docker buildx build --file "$repo_root/Dockerfile" --target "$BUILD_TARGET"
  --tag "$IMAGE_NAME:$IMAGE_TAG" --label "org.opencontainers.image.version=$IMAGE_TAG"
  --label "org.opencontainers.image.revision=$revision")
[[ -z "$PLATFORMS" ]] || build_command+=(--platform "$PLATFORMS")
if [[ "$TAG_LATEST" == true && "$IMAGE_TAG" != latest ]]; then build_command+=(--tag "$IMAGE_NAME:latest"); fi
if [[ "$PUSH" == true ]]; then build_command+=(--push); else build_command+=(--load); fi
build_command+=("$repo_root")

printf 'Image: %s:%s | target: %s | publish: %s\n' "$IMAGE_NAME" "$IMAGE_TAG" "$BUILD_TARGET" "$PUSH"
if [[ "$dry_run" == true ]]; then
  printf '%q ' "${build_command[@]}"; printf '\n'; exit 0
fi
command -v docker >/dev/null 2>&1 || fail 'Docker is not installed or is not on PATH'
docker info >/dev/null 2>&1 || fail 'Docker is not running. Start Docker and try again.'
docker buildx version >/dev/null 2>&1 || fail 'Docker Buildx is required'
"${build_command[@]}"
if [[ "$PUSH" == false ]]; then
  printf '\nBuilt %s:%s locally. Example run:\n' "$IMAGE_NAME" "$IMAGE_TAG"
  printf 'docker run --rm --env-file .env -p 127.0.0.1:5050:5050 -v sentinel-atlas-data:/var/lib/sentinel-atlas %q\n' "$IMAGE_NAME:$IMAGE_TAG"
else
  printf '\nPublished %s:%s.\n' "$IMAGE_NAME" "$IMAGE_TAG"
fi
