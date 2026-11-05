#!/usr/bin/env bash
# Builds Phi's image with Cloud Build, then restarts the VM's container on it.
# Usage: deploy/gcp/deploy.sh [git-ref]   (default: HEAD; an older ref rolls back)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
# shellcheck source=/dev/null
source "$HERE/phi.conf"
: "${PROJECT:?} ${REGION:?} ${ZONE:?}"

REF=${1:-HEAD}
TAG=$(git -C "$ROOT" rev-parse --short "$REF")
IMAGE="$REGION-docker.pkg.dev/$PROJECT/phi/phi:$TAG"
if [[ "$REF" == HEAD && -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "Uncommitted changes: the image is built from the working tree but tagged $TAG." >&2
fi

gcloud config set project "$PROJECT" >/dev/null
if gcloud artifacts docker images describe "$IMAGE" >/dev/null 2>&1; then
  echo "Image $IMAGE already built."
else
  SRC=$ROOT
  if [[ "$REF" != HEAD ]]; then
    SRC=$(mktemp -d)
    trap 'rm -rf "$SRC"' EXIT
    git -C "$ROOT" archive "$REF" | tar -x -C "$SRC"
  fi
  gcloud builds submit "$SRC" --config="$HERE/cloudbuild.yaml" --substitutions="_IMAGE=$IMAGE"
fi

gcloud compute instances add-metadata phi --zone="$ZONE" --metadata=phi-image="$IMAGE"
gcloud compute ssh phi --zone="$ZONE" --tunnel-through-iap --command='sudo systemctl restart phi'
echo "Deployed $IMAGE"
