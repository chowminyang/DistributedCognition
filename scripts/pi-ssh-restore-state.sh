#!/usr/bin/env bash
set -euo pipefail

HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
REMOTE_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
BUNDLE="${NANOCLAW_PI_STATE_BUNDLE:-}"
CHECKSUM="${NANOCLAW_PI_STATE_CHECKSUM:-}"
REMOTE_IMPORT_DIR="${NANOCLAW_PI_REMOTE_IMPORT_DIR:-~/nanoclaw-state-import}"
SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-}"
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
  --execute                      Actually copy and import state.
  --ssh-option <option>          Extra ssh/scp option. Values like BatchMode=yes
                                 are passed as -o options. May be repeated.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_STATE_BUNDLE
  NANOCLAW_PI_STATE_CHECKSUM
  NANOCLAW_PI_REMOTE_IMPORT_DIR
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT

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
  if [ -n "$SSH_CONNECT_TIMEOUT" ]; then
    [[ "$SSH_CONNECT_TIMEOUT" =~ ^[0-9]+$ ]] || { echo "NANOCLAW_PI_SSH_CONNECT_TIMEOUT must be a positive integer" >&2; exit 2; }
    [ "$SSH_CONNECT_TIMEOUT" -gt 0 ] || { echo "NANOCLAW_PI_SSH_CONNECT_TIMEOUT must be greater than 0" >&2; exit 2; }
    add_ssh_option "ConnectTimeout=$SSH_CONNECT_TIMEOUT"
  fi
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
