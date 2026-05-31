#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/pi-ssh-target-guard.sh"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
REMOTE_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
BUNDLE="${NANOCLAW_PI_STATE_BUNDLE:-}"
CHECKSUM="${NANOCLAW_PI_STATE_CHECKSUM:-}"
REMOTE_IMPORT_DIR="${NANOCLAW_PI_REMOTE_IMPORT_DIR:-~/nanoclaw-state-import}"
SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-}"
ALLOW_MAC_HOST_RUNNING="${NANOCLAW_PI_ALLOW_MAC_HOST_RUNNING:-false}"
EXECUTE=false
FORCE=false
CLEANUP_REMOTE=false
SSH_OPTIONS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-ssh-restore-state.sh [options]

Copies a secret NanoClaw Raspberry Pi state bundle from the Mac to the Pi,
verifies the checksum on the Pi, imports the state into the Pi checkout, and
runs pnpm run build.

This helper is dry-run by default. It only opens SSH, copies files, or imports
state when --execute is supplied.

What --execute does:
  - inspects the local bundle and checksum before transfer;
  - refuses to copy or import state while this Mac checkout appears to be
    running NanoClaw, unless --allow-mac-host-running is supplied;
  - creates the remote import directory on the Pi;
  - copies the bundle and .sha256 file to that directory;
  - verifies the SHA-256 checksum on the Pi before import;
  - runs bash scripts/pi-import-state.sh against the copied bundle;
  - runs pnpm run build in the Pi checkout.

It does not start NanoClaw, install systemd, configure rclone, sync Dropbox, or
re-pair WhatsApp.

Required options, unless the matching environment defaults are set:
  --host <host>                  Pi host or IP, for example nanoclaw-pi.local.
  --user <user>                  SSH user, for example pi.
  --path <path>                  NanoClaw checkout path on the Pi.
  --bundle <path>                Local nanoclaw-pi-state-*.tar.gz bundle.

Optional:
  --checksum <path>              Local checksum file. Defaults to <bundle>.sha256.
  --remote-import-dir <path>     Remote directory for copied bundle.
                                 Default: ~/nanoclaw-state-import.
  --force                        Pass --force to scripts/pi-import-state.sh.
  --cleanup-remote               Delete the copied bundle and checksum after a
                                 successful import and build.
  --allow-mac-host-running       Allow --execute even if this Mac checkout
                                 still appears to run NanoClaw. Use only for
                                 rollback/emergency work.
  --execute                      Actually copy and import state.
  --ssh-option <option>          Extra ssh/scp option. Values like BatchMode=yes
                                 are passed as -o options. May be repeated.
                                 Defaults include BatchMode=yes,
                                 StrictHostKeyChecking=accept-new,
                                 ServerAliveInterval=15, and
                                 ServerAliveCountMax=2.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_STATE_BUNDLE
  NANOCLAW_PI_STATE_CHECKSUM
  NANOCLAW_PI_REMOTE_IMPORT_DIR
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT
  NANOCLAW_PI_ALLOW_MAC_HOST_RUNNING

Examples:
  bash scripts/pi-ssh-restore-state.sh --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --bundle "$HOME/Desktop/dc-pi-migration/nanoclaw-pi-state-20260601T120000Z.tar.gz"
  bash scripts/pi-ssh-restore-state.sh --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --bundle "$HOME/Desktop/dc-pi-migration/nanoclaw-pi-state-20260601T120000Z.tar.gz" --force --cleanup-remote --execute
EOF
}

add_ssh_option() {
  local option_value="$1"
  if [[ "$option_value" == *=* && "$option_value" != -* ]]; then
    SSH_OPTIONS+=("-o" "$option_value")
  else
    SSH_OPTIONS+=("$option_value")
  fi
}

add_default_ssh_options() {
  add_default_pi_ssh_options "$SSH_CONNECT_TIMEOUT"
}

add_default_ssh_options

expand_local_path() {
  case "$1" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${1#~/}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

shell_quote() {
  printf '%q' "$1"
}

have_local() {
  command -v "$1" >/dev/null 2>&1
}

canonical_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

pid_cwd() {
  local pid="$1"
  local cwd=""

  if have_local lsof; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  fi

  if [ -z "$cwd" ] && [ -e "/proc/$pid/cwd" ] && have_local readlink; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  fi

  [ -n "$cwd" ] || return 1
  canonical_dir "$cwd"
}

find_local_host_pids() {
  have_local pgrep || return 0

  local candidates
  candidates="$(pgrep -f '(^|[ /])(node|tsx)([ ]|.*[ ])(dist/index\.js|src/index\.ts)' 2>/dev/null || true)"
  [ -n "$candidates" ] || return 0

  local pid cwd
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" != "$$" ] || continue
    [ "$pid" != "${PPID:-}" ] || continue
    cwd="$(pid_cwd "$pid" 2>/dev/null || true)"
    [ "$cwd" = "$PROJECT_ROOT" ] || continue
    printf '%s\n' "$pid"
  done <<EOF
$candidates
EOF
}

find_local_screen_sessions() {
  have_local screen || return 0

  { screen -ls 2>/dev/null || true; } |
    awk '
      /[0-9]+\./ {
        for (i = 1; i <= NF; i += 1) {
          if ($i ~ /^[0-9]+\./ && tolower($i) ~ /(nanoclaw|distributed|cognition)/) {
            print $i
          }
        }
      }
    '
}

find_local_docker_containers() {
  have_local docker || return 0

  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null |
    awk -F '\t' '
      $1 ~ /^nanoclaw-v2-/ || $1 ~ /^nanoclaw-agent-v2-/ || $2 ~ /(^|\/)nanoclaw-agent(:|@|$|-v2-)/ {
        print $1
      }
    '
}

unique_lines() {
  awk 'NF && !seen[$0]++'
}

require_mac_host_stopped_for_execute() {
  [ "$ALLOW_MAC_HOST_RUNNING" != "true" ] || {
    echo "WARN - Mac host guard bypassed by --allow-mac-host-running" >&2
    return 0
  }

  local host_pids screen_sessions docker_containers
  host_pids="$(find_local_host_pids | unique_lines)"
  screen_sessions="$(find_local_screen_sessions | unique_lines)"
  docker_containers="$(find_local_docker_containers | unique_lines)"

  [ -z "$host_pids" ] && [ -z "$screen_sessions" ] && [ -z "$docker_containers" ] && return 0

  echo "Refusing to restore Pi state while the Mac NanoClaw host appears to be running." >&2
  echo "WhatsApp/Baileys state should be exported/restored only after the Mac runtime is stopped." >&2
  echo "Run this first during final cutover:" >&2
  echo "  pnpm run dc:install-launchd -- uninstall" >&2
  echo "  pnpm run dc:stop-host -- --execute" >&2
  echo "  pnpm run pi:mac-preflight -- --root <mac Distributed-Cognition folder> --out-dir <export dir> --require-stopped" >&2
  echo "  pnpm run pi:export -- --out-dir <export dir>" >&2
  echo >&2
  if [ -n "$screen_sessions" ]; then
    echo "Matching screen sessions:" >&2
    while IFS= read -r session; do
      [ -n "$session" ] && echo "  screen: $session" >&2
    done <<EOF
$screen_sessions
EOF
  fi
  if [ -n "$docker_containers" ]; then
    echo "Matching Docker containers:" >&2
    while IFS= read -r container; do
      [ -n "$container" ] && echo "  container: $container" >&2
    done <<EOF
$docker_containers
EOF
  fi
  if [ -n "$host_pids" ]; then
    echo "Matching host PIDs:" >&2
    while IFS= read -r pid; do
      [ -n "$pid" ] && echo "  pid: $pid" >&2
    done <<EOF
$host_pids
EOF
  fi
  echo >&2
  echo "Use --allow-mac-host-running only for explicit rollback or emergency work." >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      [ -n "$HOST" ] || { echo "Missing value for --host" >&2; exit 2; }
      shift 2
      ;;
    --user)
      REMOTE_USER="${2:-}"
      [ -n "$REMOTE_USER" ] || { echo "Missing value for --user" >&2; exit 2; }
      shift 2
      ;;
    --path)
      REMOTE_PROJECT_ROOT="${2:-}"
      [ -n "$REMOTE_PROJECT_ROOT" ] || { echo "Missing value for --path" >&2; exit 2; }
      shift 2
      ;;
    --bundle)
      BUNDLE="${2:-}"
      [ -n "$BUNDLE" ] || { echo "Missing value for --bundle" >&2; exit 2; }
      shift 2
      ;;
    --checksum)
      CHECKSUM="${2:-}"
      [ -n "$CHECKSUM" ] || { echo "Missing value for --checksum" >&2; exit 2; }
      shift 2
      ;;
    --remote-import-dir)
      REMOTE_IMPORT_DIR="${2:-}"
      [ -n "$REMOTE_IMPORT_DIR" ] || { echo "Missing value for --remote-import-dir" >&2; exit 2; }
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --cleanup-remote)
      CLEANUP_REMOTE=true
      shift
      ;;
    --allow-mac-host-running)
      ALLOW_MAC_HOST_RUNNING=true
      shift
      ;;
    --execute)
      EXECUTE=true
      shift
      ;;
    --ssh-option)
      option_value="${2:-}"
      [ -n "$option_value" ] || { echo "Missing value for --ssh-option" >&2; exit 2; }
      add_ssh_option "$option_value"
      shift 2
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

[ -n "$HOST" ] || { echo "Missing required --host" >&2; usage >&2; exit 2; }
[ -n "$REMOTE_USER" ] || { echo "Missing required --user" >&2; usage >&2; exit 2; }
[ -n "$REMOTE_PROJECT_ROOT" ] || { echo "Missing required --path" >&2; usage >&2; exit 2; }
assert_pi_ssh_target "$HOST" "$REMOTE_USER"
[ -n "$BUNDLE" ] || { echo "Missing required --bundle" >&2; usage >&2; exit 2; }

BUNDLE="$(expand_local_path "$BUNDLE")"
if [ -z "$CHECKSUM" ]; then
  CHECKSUM="$BUNDLE.sha256"
fi
CHECKSUM="$(expand_local_path "$CHECKSUM")"

[ -f "$BUNDLE" ] || { echo "Bundle not found: $BUNDLE" >&2; exit 1; }
[ -f "$CHECKSUM" ] || { echo "Checksum not found: $CHECKSUM" >&2; exit 1; }

BUNDLE_BASE="$(basename "$BUNDLE")"
CHECKSUM_BASE="$(basename "$CHECKSUM")"
case "$BUNDLE_BASE" in
  nanoclaw-pi-state-*.tar.gz) ;;
  *)
    echo "Refusing unexpected bundle name: $BUNDLE_BASE" >&2
    echo "Expected nanoclaw-pi-state-*.tar.gz" >&2
    exit 2
    ;;
esac

case "$CHECKSUM_BASE" in
  *.sha256) ;;
  *)
    echo "Refusing unexpected checksum name: $CHECKSUM_BASE" >&2
    echo "Expected a .sha256 file" >&2
    exit 2
    ;;
esac

TARGET="$REMOTE_USER@$HOST"
IMPORT_ARGS=()
[ "$FORCE" = "true" ] && IMPORT_ARGS+=("--force")

echo "Pi SSH state restore"
echo "Target: $TARGET"
echo "NanoClaw path: $REMOTE_PROJECT_ROOT"
echo "Local bundle: $BUNDLE"
echo "Local checksum: $CHECKSUM"
echo "Remote import dir: $REMOTE_IMPORT_DIR"
[ -n "$SSH_CONNECT_TIMEOUT" ] && echo "SSH connect timeout: ${SSH_CONNECT_TIMEOUT}s"
echo "Force import: $FORCE"
echo "Cleanup remote bundle: $CLEANUP_REMOTE"
if [ "$ALLOW_MAC_HOST_RUNNING" = "true" ]; then
  echo "Mac host guard: bypassed"
else
  echo "Mac host guard: enforced"
fi
echo

echo "== Inspect Local State Bundle =="
bash scripts/pi-inspect-state-bundle.sh --bundle "$BUNDLE" --checksum "$CHECKSUM"
echo

if [ "$EXECUTE" != "true" ]; then
  echo "PI_SSH_RESTORE_STATE=dry_run"
  echo "No SSH was opened and no state was copied."
  echo
  echo "Would run:"
  echo "  bash scripts/pi-inspect-state-bundle.sh --bundle $(shell_quote "$BUNDLE") --checksum $(shell_quote "$CHECKSUM")"
  echo "  ssh $TARGET mkdir -p $(shell_quote "$REMOTE_IMPORT_DIR")"
  echo "  scp $(shell_quote "$BUNDLE") $(shell_quote "$CHECKSUM") $TARGET:$(shell_quote "$REMOTE_IMPORT_DIR")/"
  echo "  ssh $TARGET cd $(shell_quote "$REMOTE_PROJECT_ROOT") '&&' bash scripts/pi-import-state.sh $(shell_quote "$REMOTE_IMPORT_DIR/$BUNDLE_BASE") ${IMPORT_ARGS[*]:-}"
  echo "  ssh $TARGET cd $(shell_quote "$REMOTE_PROJECT_ROOT") '&&' pnpm run build"
  echo
  echo "Add --execute only after the Mac host is stopped and the exported bundle is final."
  exit 0
fi

require_mac_host_stopped_for_execute

REMOTE_IMPORT_DIR_RESOLVED="$(
  ssh "${SSH_OPTIONS[@]}" "$TARGET" 'bash -s' -- "$REMOTE_IMPORT_DIR" <<'REMOTE'
set -euo pipefail

expand_remote_path() {
  case "$1" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${1#~/}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

dir="$(expand_remote_path "$1")"
mkdir -p "$dir"
printf '%s\n' "$dir"
REMOTE
)"

scp "${SSH_OPTIONS[@]}" "$BUNDLE" "$CHECKSUM" "$TARGET:$(shell_quote "$REMOTE_IMPORT_DIR_RESOLVED")/"

ssh "${SSH_OPTIONS[@]}" "$TARGET" 'bash -s' -- \
  "$REMOTE_PROJECT_ROOT" \
  "$REMOTE_IMPORT_DIR_RESOLVED" \
  "$BUNDLE_BASE" \
  "$CHECKSUM_BASE" \
  "$FORCE" \
  "$CLEANUP_REMOTE" <<'REMOTE'
set -euo pipefail

PROJECT_ROOT="$1"
REMOTE_IMPORT_DIR="$2"
BUNDLE_BASE="$3"
CHECKSUM_BASE="$4"
FORCE="$5"
CLEANUP_REMOTE="$6"

expand_remote_path() {
  case "$1" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${1#~/}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

have() {
  command -v "$1" >/dev/null 2>&1
}

PROJECT_ROOT="$(expand_remote_path "$PROJECT_ROOT")"
REMOTE_IMPORT_DIR="$(expand_remote_path "$REMOTE_IMPORT_DIR")"
BUNDLE_PATH="$REMOTE_IMPORT_DIR/$BUNDLE_BASE"
CHECKSUM_PATH="$REMOTE_IMPORT_DIR/$CHECKSUM_BASE"

[ -d "$PROJECT_ROOT" ] || { echo "NanoClaw path does not exist on Pi: $PROJECT_ROOT" >&2; exit 1; }
[ -f "$BUNDLE_PATH" ] || { echo "Copied bundle missing on Pi: $BUNDLE_PATH" >&2; exit 1; }
[ -f "$CHECKSUM_PATH" ] || { echo "Copied checksum missing on Pi: $CHECKSUM_PATH" >&2; exit 1; }
have sha256sum || { echo "sha256sum is required on the Pi" >&2; exit 1; }
have pnpm || { echo "pnpm is required on the Pi" >&2; exit 1; }

echo "== Verify State Bundle =="
cd "$REMOTE_IMPORT_DIR"
sha256sum -c "$CHECKSUM_BASE"

echo
echo "== Import State =="
cd "$PROJECT_ROOT"
import_args=()
[ "$FORCE" = "true" ] && import_args+=("--force")
bash scripts/pi-import-state.sh "$BUNDLE_PATH" "${import_args[@]}"

echo
echo "== Build =="
pnpm run build

if [ "$CLEANUP_REMOTE" = "true" ]; then
  echo
  echo "== Cleanup Remote Bundle =="
  rm -f "$BUNDLE_PATH" "$CHECKSUM_PATH"
  echo "Removed copied bundle and checksum from: $REMOTE_IMPORT_DIR"
fi

echo
echo "PI_SSH_RESTORE_STATE=ok"
REMOTE
