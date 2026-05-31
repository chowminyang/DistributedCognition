#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$PROJECT_ROOT/output"
ALLOW_RUNNING="false"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-export-state.sh [options]

Creates a secret NanoClaw state bundle for Raspberry Pi migration.

Options:
  --out-dir <path>       Output directory. Default: ./output
  --allow-running        Export even if a NanoClaw process appears to be running.
  -h, --help             Show this help.

The bundle includes .env, data/, store/, groups/, and ~/.config/nanoclaw
allowlist files when present. It contains secrets.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir)
      OUT_DIR="${2:-}"
      [ -n "$OUT_DIR" ] || { echo "Missing value for --out-dir" >&2; exit 2; }
      shift 2
      ;;
    --allow-running)
      ALLOW_RUNNING="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

is_nanoclaw_running() {
  pgrep -f "$PROJECT_ROOT/dist/index.js" >/dev/null 2>&1 && return 0
  pgrep -f "$PROJECT_ROOT/src/index.ts" >/dev/null 2>&1 && return 0
  return 1
}

copy_path() {
  local src="$1"
  local dest_dir="$2"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$src" "$dest_dir/"
  else
    cp -a "$src" "$dest_dir/"
  fi
}

if [ "$ALLOW_RUNNING" != "true" ] && is_nanoclaw_running; then
  cat >&2 <<EOF
NanoClaw appears to be running from:
  $PROJECT_ROOT

Stop the service first so SQLite and WhatsApp auth are quiet, then rerun.
Use --allow-running only for an emergency best-effort export.
EOF
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
BUNDLE="$OUT_DIR/nanoclaw-pi-state-$STAMP.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

umask 077
mkdir -p "$TMP_DIR/state" "$TMP_DIR/home-config/nanoclaw"

for item in .env data store groups; do
  if [ -e "$PROJECT_ROOT/$item" ]; then
    copy_path "$PROJECT_ROOT/$item" "$TMP_DIR/state"
  fi
done

NANOCLAW_CONFIG_DIR="${HOME:-}/.config/nanoclaw"
if [ -n "$NANOCLAW_CONFIG_DIR" ] && [ -d "$NANOCLAW_CONFIG_DIR" ]; then
  for item in mount-allowlist.json sender-allowlist.json; do
    if [ -f "$NANOCLAW_CONFIG_DIR/$item" ]; then
      copy_path "$NANOCLAW_CONFIG_DIR/$item" "$TMP_DIR/home-config/nanoclaw"
    fi
  done
fi

cat > "$TMP_DIR/MANIFEST.txt" <<EOF
NanoClaw Raspberry Pi state bundle
Created: $STAMP
Source: $PROJECT_ROOT
Includes:
  - state/.env
  - state/data/
  - state/store/
  - state/groups/
  - home-config/nanoclaw/*.json when present

This archive contains secrets. Store and transfer it carefully.
EOF

tar -C "$TMP_DIR" -czf "$BUNDLE" .
chmod 600 "$BUNDLE"

if command -v shasum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && shasum -a 256 "$(basename "$BUNDLE")" > "$(basename "$BUNDLE").sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "$(basename "$BUNDLE")" > "$(basename "$BUNDLE").sha256")
else
  echo "Warning: no SHA-256 tool found; skipped checksum" >&2
fi

echo "Created: $BUNDLE"
[ -f "$BUNDLE.sha256" ] && echo "Checksum: $BUNDLE.sha256"
echo "This bundle contains .env and WhatsApp auth. Keep it private."
