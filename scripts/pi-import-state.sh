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

By default the script refuses to import while a NanoClaw host process or
NanoClaw Docker agent container appears to be running. Restoring WhatsApp auth
and SQLite state should happen while the runtime is quiet.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
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

have() {
  command -v "$1" >/dev/null 2>&1
}

canonical_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

pid_cwd() {
  local pid="$1"
  local cwd=""

  if have lsof; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  fi

  if [ -z "$cwd" ] && [ -e "/proc/$pid/cwd" ] && have readlink; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  fi

  [ -n "$cwd" ] || return 1
  canonical_dir "$cwd"
}

find_host_pids() {
  have pgrep || return 0

  local candidates
  candidates="$(pgrep -f '(^|[ /])(node|tsx)([ ]|.*[ ])(dist/index\.js|src/index\.ts)' 2>/dev/null || true)"
  [ -n "$candidates" ] || return 0

  local project_root_canonical pid cwd
  project_root_canonical="$(canonical_dir "$PROJECT_ROOT")"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" != "$$" ] || continue
    [ "$pid" != "${PPID:-}" ] || continue
    cwd="$(pid_cwd "$pid" 2>/dev/null || true)"
    [ "$cwd" = "$project_root_canonical" ] || continue
    printf '%s\n' "$pid"
  done <<EOF
$candidates
EOF
}

find_docker_containers() {
  have docker || return 0

  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null |
    awk -F '\t' '
      $1 ~ /^nanoclaw-v2-/ || $1 ~ /^nanoclaw-agent-v2-/ || $2 ~ /(^|\/)nanoclaw-agent(:|@|$|-v2-)/ {
        print $1 "\t" $2 "\t" $3
      }
    '
}

unique_lines() {
  awk 'NF && !seen[$0]++'
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

HOST_PIDS="$(find_host_pids | unique_lines)"
DOCKER_CONTAINERS="$(find_docker_containers | unique_lines)"

if [ "$ALLOW_RUNNING" != "true" ] && { [ -n "$HOST_PIDS" ] || [ -n "$DOCKER_CONTAINERS" ]; }; then
  cat >&2 <<EOF
NanoClaw appears to be running on this host.

Project:
  $PROJECT_ROOT
EOF

  if [ -n "$HOST_PIDS" ]; then
    cat >&2 <<'EOF'

Matching host PIDs:
EOF
    while IFS= read -r pid; do
      [ -n "$pid" ] && printf '  - %s\n' "$pid" >&2
    done <<EOF
$HOST_PIDS
EOF
  fi

  if [ -n "$DOCKER_CONTAINERS" ]; then
    cat >&2 <<'EOF'

NanoClaw Docker agent containers are still running:
EOF
    while IFS=$'\t' read -r name image status; do
      [ -n "$name" ] || continue
      printf '  - %s image=%s status=%s\n' "$name" "${image:-unknown}" "${status:-unknown}" >&2
    done <<EOF
$DOCKER_CONTAINERS
EOF
  fi

  cat >&2 <<'EOF'

Stop the service first, then rerun.
Use --allow-running only for an emergency best-effort import.
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
