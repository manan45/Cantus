#!/usr/bin/env bash
# Populate src-tauri/binaries/node-aarch64-apple-darwin with the macOS ARM Node.js
# binary and install agent-host npm dependencies before `cargo tauri build`.
#
# Usage: ./scripts/bundle-node.sh [NODE_VERSION]
#   NODE_VERSION defaults to the value of .nvmrc or 22.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$REPO_ROOT/src-tauri/binaries"
AGENT_HOST_DIR="$REPO_ROOT/agent-host"

NODE_VERSION="${1:-}"
if [[ -z "$NODE_VERSION" && -f "$REPO_ROOT/.nvmrc" ]]; then
  NODE_VERSION="$(cat "$REPO_ROOT/.nvmrc")"
fi
NODE_VERSION="${NODE_VERSION:-22}"

TARGET="node-aarch64-apple-darwin"
DEST="$BINARIES_DIR/$TARGET"

if [[ -f "$DEST" && ! -L "$DEST" ]]; then
  echo "Sidecar already present: $DEST"
else
  ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
  URL="https://nodejs.org/dist/latest-v${NODE_VERSION}.x/$ARCHIVE"
  TMP="$(mktemp -d)"
  echo "Downloading Node $NODE_VERSION for darwin-arm64..."
  curl -fsSL "$URL" -o "$TMP/$ARCHIVE"
  tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
  # Remove any dev symlink before placing the real binary.
  rm -f "$DEST"
  cp "$TMP/node-v${NODE_VERSION}-darwin-arm64/bin/node" "$DEST"
  chmod +x "$DEST"
  rm -rf "$TMP"
  echo "Sidecar written: $DEST"
fi

echo "Installing agent-host dependencies..."
(cd "$AGENT_HOST_DIR" && npm ci --omit=dev)
echo "Done. You can now run: cargo tauri build"
