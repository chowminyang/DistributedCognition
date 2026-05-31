#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$PROJECT_ROOT/output"
ALLOW_RUNNING="false"
CREATE_RUNTIME_LOCK="true"
RUNTIME_LOCK="$PROJECT_ROOT/logs/pi-cutover/mac-runtime-disabled.lock"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-export-state.sh [options]

Creates a secret NanoClaw state bundle for Raspberry Pi migration.

Options:
  --out-dir <path>       Output directory. Default: ./output
  --allow-running        Export even if a NanoClaw process appears to be running.
  --no-runtime-lock      Do not write the local Mac cutover runtime lock.
  -h, --help             Show this help.

The bundle includes .env, data/, store/, groups/, and ~/.config/nanoclaw
allowlist files when present. It contains secrets.

After a successful export, this script writes a local ignored lock file that
prevents this Mac checkout from starting the WhatsApp/NanoClaw runtime again
by accident. Remove it only for rollback, or set
NANOCLAW_ALLOW_MAC_RUNTIME_AFTER_PI_EXPORT=true for an intentional override.
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
    --no-runtime-lock)
      CREATE_RUNTIME_LOCK="false"
      shift
      ;;
    --)
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

write_runtime_lock() {
  local source_host
  source_host="$(hostname 2>/dev/null || printf 'unknown')"
  mkdir -p "$(dirname "$RUNTIME_LOCK")"
  {
    printf '# Distributed Cognition Mac runtime lock\n'
    printf 'created_at_utc=%s\n' "$STAMP"
    printf 'source_host=%s\n' "$source_host"
    printf 'project_root=%s\n' "$PROJECT_ROOT"
    printf 'state_bundle=%s\n' "$BUNDLE"
    printf 'reason=pi_state_export_completed\n'
    printf 'override_env=NANOCLAW_ALLOW_MAC_RUNTIME_AFTER_PI_EXPORT=true\n'
  } > "$RUNTIME_LOCK"
  chmod 600 "$RUNTIME_LOCK"
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

if [ "$CREATE_RUNTIME_LOCK" = "true" ]; then
  write_runtime_lock
fi

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
if [ "$CREATE_RUNTIME_LOCK" = "true" ]; then
  echo "Mac runtime lock: $RUNTIME_LOCK"
  echo "The Mac NanoClaw runtime will refuse to start from this checkout unless you remove that lock for rollback or set NANOCLAW_ALLOW_MAC_RUNTIME_AFTER_PI_EXPORT=true."
else
  echo "Mac runtime lock: skipped"
fi
