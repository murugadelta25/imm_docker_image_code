#!/usr/bin/env bash
# Build IMM Docker image, export tar, pack App Management zip.
# Usage:
#   ./scripts/build-docker-appzip.sh
#   VITE_BASE=/app/imm-pms/v1/imm-pms/ VARIANT=external-db ./scripts/build-docker-appzip.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE_NAME="${IMAGE_NAME:-imm-pms}"
IMAGE_TAG="${IMAGE_TAG:-v1.0.0}"
VITE_BASE="${VITE_BASE:-/}"
VARIANT="${VARIANT:-external-db}"  # external-db | with-mysql

FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
TAR_NAME="imm-pms-${IMAGE_TAG}.tar"
APP_DIR="${ROOT}/appzip/imm-pms-${VARIANT}"
OUT_ZIP="${ROOT}/appzip/imm-pms-${VARIANT}-${IMAGE_TAG}.zip"

echo "==> Building ${FULL_IMAGE}  (VITE_BASE=${VITE_BASE})"
docker build --build-arg "VITE_BASE=${VITE_BASE}" -t "${FULL_IMAGE}" .

echo "==> Saving ${TAR_NAME}"
mkdir -p "${APP_DIR}"
docker save -o "${APP_DIR}/${TAR_NAME}" "${FULL_IMAGE}"

echo "==> Packing App Management zip"
rm -f "${OUT_ZIP}"
(
  cd "${APP_DIR}"
  zip -r "${OUT_ZIP}" metadata.json deployment.yaml service.yaml configmap.yaml "${TAR_NAME}"
)

echo
echo "Done."
echo "  Image : ${FULL_IMAGE}"
echo "  Tar   : ${APP_DIR}/${TAR_NAME}"
echo "  Zip   : ${OUT_ZIP}"
echo
echo "Next: edit configmap.yaml secrets, re-zip if needed, upload in App Management."