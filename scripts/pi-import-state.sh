#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE=""
FORCE="false"
ALLOW_RUNNING="false"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-import-state.sh <bundle.tar.gz> [options]

Restores a NanoClaw Raspberry Pi migration bundle into the current checkout.

Options:
  --force                Move existing .env/data/store/groups aside and restore.
  --allow-running        Restore even if NanoClaw appears to be running.
  -h, --help             Show this help.

Existing paths are moved into backups/pi-import-<timestamp>/ when --force is
used. This script also restores ~/.config/nanoclaw allowlist files when the
bundle contains them.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE="true"
      shift
      ;;
    --allow-running)
      ALLOW_RUNNING="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$BUNDLE" ]; then
        echo "Only one bundle path may be provided" >&2
        exit 2
      fi
      BUNDLE="$1"
      shift
      ;;
  esac
done

[ -n "$BUNDLE" ] || { usage >&2; exit 2; }
[ -f "$BUNDLE" ] || { echo "Bundle not found: $BUNDLE" >&2; exit 1; }

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

Stop the service first, then rerun.
EOF
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ENTRY_LIST="$TMP_DIR/bundle-entries.txt"
tar -tzf "$BUNDLE" > "$ENTRY_LIST"
while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..)
      echo "Unsafe bundle entry refused: $entry" >&2
      exit 1
      ;;
  esac
done < "$ENTRY_LIST"

tar -xzf "$BUNDLE" -C "$TMP_DIR"

[ -d "$TMP_DIR/state" ] || { echo "Invalid bundle: missing state/" >&2; exit 1; }

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
BACKUP_DIR="$PROJECT_ROOT/backups/pi-import-$STAMP"
CONFLICTS=()

for item in .env data store groups; do
  if [ -e "$PROJECT_ROOT/$item" ] && [ -e "$TMP_DIR/state/$item" ]; then
    CONFLICTS+=("$item")
  fi
done

if [ "${#CONFLICTS[@]}" -gt 0 ] && [ "$FORCE" != "true" ]; then
  echo "Refusing to overwrite existing paths: ${CONFLICTS[*]}" >&2
  echo "Rerun with --force to move them into $BACKUP_DIR first." >&2
  exit 1
fi

if [ "${#CONFLICTS[@]}" -gt 0 ]; then
  mkdir -p "$BACKUP_DIR"
  for item in "${CONFLICTS[@]}"; do
    mv "$PROJECT_ROOT/$item" "$BACKUP_DIR/"
  done
  echo "Existing state moved to: $BACKUP_DIR"
fi

for item in .env data store groups; do
  if [ -e "$TMP_DIR/state/$item" ]; then
    copy_path "$TMP_DIR/state/$item" "$PROJECT_ROOT"
  fi
done

if [ -d "$TMP_DIR/home-config/nanoclaw" ]; then
  mkdir -p "$HOME/.config/nanoclaw"
  for file in "$TMP_DIR"/home-config/nanoclaw/*; do
    [ -e "$file" ] || continue
    copy_path "$file" "$HOME/.config/nanoclaw"
  done
fi

[ -f "$PROJECT_ROOT/.env" ] && chmod 600 "$PROJECT_ROOT/.env" || true
if [ -d "$PROJECT_ROOT/store/auth" ]; then
  find "$PROJECT_ROOT/store/auth" -type f -exec chmod 600 {} \; 2>/dev/null || true
fi

echo "Restored NanoClaw state into: $PROJECT_ROOT"
echo "Run: pnpm run build"
echo "Then install/start the Pi service with: bash scripts/pi-install-systemd.sh --start"
