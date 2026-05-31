#!/usr/bin/env bash
set -euo pipefail

HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
REMOTE_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-${DC_SECOND_BRAIN_ROOT:-}}"
CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-}"
CODEX_MEMORY_ROOT="${NANOCLAW_PI_CODEX_MEMORY_ROOT:-}"
RCLONE_REMOTE="${NANOCLAW_PI_RCLONE_REMOTE:-dropbox:}"
RCLONE_FOLDER="${NANOCLAW_PI_RCLONE_FOLDER:-Distributed-Cognition}"
RCLONE_TARGET="${NANOCLAW_PI_RCLONE_TARGET:-}"
RCLONE_INTERVAL="${NANOCLAW_PI_RCLONE_INTERVAL:-5min}"
RCLONE_MODE="${NANOCLAW_PI_RCLONE_MODE:-copy}"
UNIT_NAME="${NANOCLAW_PI_UNIT_NAME:-}"
SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-}"
EXECUTE=false
SKIP_RCLONE=false
SKIP_DOCKER_ACCESS=false
SKIP_SYSTEMD=false
SKIP_HEALTH=false
SSH_OPTIONS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-ssh-start-runtime.sh [options]

Starts the post-restore Raspberry Pi runtime setup from the Mac control plane.
This helper wraps the existing Pi-side scripts for rclone sync, Docker mount
access, systemd installation/startup, and DC health.

This helper is dry-run by default. It only opens SSH or mutates the Pi when
--execute is supplied.

What --execute does on the Pi:
  - creates the selected Distributed-Cognition folder;
  - creates the selected Codex projects folder;
  - installs and starts the rclone Dropbox timer unless --skip-rclone is set;
  - updates NanoClaw Docker mount access unless --skip-docker-access is set;
  - installs/enables/starts the NanoClaw systemd service unless --skip-systemd is set;
  - runs pnpm run dc:health unless --skip-health is set.

It does not copy secrets, import state, export state, or re-pair WhatsApp.

Required options, unless the matching environment defaults are set:
  --host <host>                  Pi host or IP, for example nanoclaw-pi.local.
  --user <user>                  SSH user, for example pi.
  --path <path>                  NanoClaw checkout path on the Pi.
  --second-brain-root <path>     Writable Distributed-Cognition folder on the Pi.
  --codex-projects-root <path>   Readable Codex projects folder on the Pi.

Optional:
  --codex-memory-root <path>     Readable Codex memory summaries folder on the Pi.
  --rclone-remote <name:>        rclone remote name. Default: dropbox:.
  --rclone-folder <path>         remote folder appended to --rclone-remote.
                                 Default: Distributed-Cognition.
  --rclone-target <remote:path>  full rclone target. Overrides remote+folder.
  --rclone-interval <duration>   timer interval. Default: 5min.
  --rclone-mode <copy|sync>      copy is non-destructive. Default: copy.
  --unit-name <name>             NanoClaw systemd unit name override.
  --skip-rclone                  Do not install/start the rclone timer.
  --skip-docker-access           Do not update Docker mount access.
  --skip-systemd                 Do not install/start the systemd service.
  --skip-health                  Do not run dc:health.
  --execute                      Actually SSH to the Pi and start setup.
  --ssh-option <option>          Extra ssh option. Values like BatchMode=yes
                                 are passed as ssh -o options. May be repeated.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_SECOND_BRAIN_ROOT
  NANOCLAW_PI_CODEX_PROJECTS_ROOT
  NANOCLAW_PI_CODEX_MEMORY_ROOT
  NANOCLAW_PI_RCLONE_REMOTE
  NANOCLAW_PI_RCLONE_FOLDER
  NANOCLAW_PI_RCLONE_TARGET
  NANOCLAW_PI_RCLONE_INTERVAL
  NANOCLAW_PI_RCLONE_MODE
  NANOCLAW_PI_UNIT_NAME
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT

Examples:
  bash scripts/pi-ssh-start-runtime.sh --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition --codex-projects-root /home/pi/Codex
  bash scripts/pi-ssh-start-runtime.sh --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition --codex-projects-root /home/pi/Codex --execute
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
    --second-brain-root)
      SECOND_BRAIN_ROOT="${2:-}"
      [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing value for --second-brain-root" >&2; exit 2; }
      shift 2
      ;;
    --codex-projects-root)
      CODEX_PROJECTS_ROOT="${2:-}"
      [ -n "$CODEX_PROJECTS_ROOT" ] || { echo "Missing value for --codex-projects-root" >&2; exit 2; }
      shift 2
      ;;
    --codex-memory-root)
      CODEX_MEMORY_ROOT="${2:-}"
      [ -n "$CODEX_MEMORY_ROOT" ] || { echo "Missing value for --codex-memory-root" >&2; exit 2; }
      shift 2
      ;;
    --rclone-remote)
      RCLONE_REMOTE="${2:-}"
      [ -n "$RCLONE_REMOTE" ] || { echo "Missing value for --rclone-remote" >&2; exit 2; }
      shift 2
      ;;
    --rclone-folder)
      RCLONE_FOLDER="${2:-}"
      [ -n "$RCLONE_FOLDER" ] || { echo "Missing value for --rclone-folder" >&2; exit 2; }
      shift 2
      ;;
    --rclone-target)
      RCLONE_TARGET="${2:-}"
      [ -n "$RCLONE_TARGET" ] || { echo "Missing value for --rclone-target" >&2; exit 2; }
      shift 2
      ;;
    --rclone-interval)
      RCLONE_INTERVAL="${2:-}"
      [ -n "$RCLONE_INTERVAL" ] || { echo "Missing value for --rclone-interval" >&2; exit 2; }
      shift 2
      ;;
    --rclone-mode)
      RCLONE_MODE="${2:-}"
      [ "$RCLONE_MODE" = "copy" ] || [ "$RCLONE_MODE" = "sync" ] || { echo "--rclone-mode must be copy or sync" >&2; exit 2; }
      shift 2
      ;;
    --unit-name)
      UNIT_NAME="${2:-}"
      [ -n "$UNIT_NAME" ] || { echo "Missing value for --unit-name" >&2; exit 2; }
      shift 2
      ;;
    --skip-rclone)
      SKIP_RCLONE=true
      shift
      ;;
    --skip-docker-access)
      SKIP_DOCKER_ACCESS=true
      shift
      ;;
    --skip-systemd)
      SKIP_SYSTEMD=true
      shift
      ;;
    --skip-health)
      SKIP_HEALTH=true
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
[ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing required --second-brain-root" >&2; usage >&2; exit 2; }
if [ "$SKIP_DOCKER_ACCESS" != "true" ]; then
  [ -n "$CODEX_PROJECTS_ROOT" ] || { echo "Missing required --codex-projects-root" >&2; usage >&2; exit 2; }
fi

if [ -z "$RCLONE_TARGET" ]; then
  RCLONE_TARGET="${RCLONE_REMOTE}${RCLONE_FOLDER}"
fi

TARGET="$REMOTE_USER@$HOST"

echo "Pi SSH runtime start"
echo "Target: $TARGET"
echo "NanoClaw path: $REMOTE_PROJECT_ROOT"
echo "Second brain root: $SECOND_BRAIN_ROOT"
[ -n "$CODEX_PROJECTS_ROOT" ] && echo "Codex projects root: $CODEX_PROJECTS_ROOT"
[ -n "$CODEX_MEMORY_ROOT" ] && echo "Codex memory root: $CODEX_MEMORY_ROOT"
echo "rclone target: $RCLONE_TARGET"
echo "rclone interval: $RCLONE_INTERVAL"
echo "rclone mode: $RCLONE_MODE"
[ -n "$SSH_CONNECT_TIMEOUT" ] && echo "SSH connect timeout: ${SSH_CONNECT_TIMEOUT}s"
[ -n "$UNIT_NAME" ] && echo "Service unit: $UNIT_NAME"
echo

if [ "$EXECUTE" != "true" ]; then
  echo "PI_SSH_START_RUNTIME=dry_run"
  echo "No SSH was opened and no Pi state was changed."
  echo
  echo "Would run on the Pi:"
  echo "  cd $(shell_quote "$REMOTE_PROJECT_ROOT")"
  echo "  mkdir -p $(shell_quote "$SECOND_BRAIN_ROOT") $(shell_quote "${CODEX_PROJECTS_ROOT:-<skipped>}")"
  if [ "$SKIP_RCLONE" = "true" ]; then
    echo "  # skip rclone timer"
  else
    echo "  bash scripts/pi-install-dropbox-sync.sh --local $(shell_quote "$SECOND_BRAIN_ROOT") --remote $(shell_quote "$RCLONE_TARGET") --interval $(shell_quote "$RCLONE_INTERVAL") --mode $(shell_quote "$RCLONE_MODE") --start"
  fi
  if [ "$SKIP_DOCKER_ACCESS" = "true" ]; then
    echo "  # skip Docker access update"
  else
    docker_cmd="pnpm run dc:ensure-docker-access -- --second-brain-root $(shell_quote "$SECOND_BRAIN_ROOT") --codex-projects-root $(shell_quote "$CODEX_PROJECTS_ROOT")"
    if [ -n "$CODEX_MEMORY_ROOT" ]; then
      docker_cmd="$docker_cmd --codex-memory-root $(shell_quote "$CODEX_MEMORY_ROOT")"
    fi
    echo "  $docker_cmd"
  fi
  if [ "$SKIP_SYSTEMD" = "true" ]; then
    echo "  # skip systemd install/start"
  else
    systemd_cmd="bash scripts/pi-install-systemd.sh --start"
    if [ -n "$UNIT_NAME" ]; then
      systemd_cmd="$systemd_cmd --unit-name $(shell_quote "$UNIT_NAME")"
    fi
    echo "  $systemd_cmd"
  fi
  if [ "$SKIP_HEALTH" = "true" ]; then
    echo "  # skip health check"
  else
    echo "  pnpm run dc:health -- --root $(shell_quote "$SECOND_BRAIN_ROOT")"
  fi
  echo
  echo "Add --execute only after state has been restored on the Pi and the Mac host remains stopped."
  exit 0
fi

ssh "${SSH_OPTIONS[@]}" "$TARGET" 'bash -s' -- \
  "$REMOTE_PROJECT_ROOT" \
  "$SECOND_BRAIN_ROOT" \
  "$CODEX_PROJECTS_ROOT" \
  "$CODEX_MEMORY_ROOT" \
  "$RCLONE_TARGET" \
  "$RCLONE_INTERVAL" \
  "$RCLONE_MODE" \
  "$UNIT_NAME" \
  "$SKIP_RCLONE" \
  "$SKIP_DOCKER_ACCESS" \
  "$SKIP_SYSTEMD" \
  "$SKIP_HEALTH" <<'REMOTE'
set -euo pipefail

PROJECT_ROOT="$1"
SECOND_BRAIN_ROOT="$2"
CODEX_PROJECTS_ROOT="$3"
CODEX_MEMORY_ROOT="$4"
RCLONE_TARGET="$5"
RCLONE_INTERVAL="$6"
RCLONE_MODE="$7"
UNIT_NAME="$8"
SKIP_RCLONE="$9"
SKIP_DOCKER_ACCESS="${10}"
SKIP_SYSTEMD="${11}"
SKIP_HEALTH="${12}"

expand_remote_path() {
  case "$1" in
    "")
      printf '\n'
      ;;
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
SECOND_BRAIN_ROOT="$(expand_remote_path "$SECOND_BRAIN_ROOT")"
CODEX_PROJECTS_ROOT="$(expand_remote_path "$CODEX_PROJECTS_ROOT")"
CODEX_MEMORY_ROOT="$(expand_remote_path "$CODEX_MEMORY_ROOT")"

[ -d "$PROJECT_ROOT" ] || { echo "NanoClaw path does not exist on Pi: $PROJECT_ROOT" >&2; exit 1; }
have pnpm || { echo "pnpm is required on the Pi" >&2; exit 1; }

echo "== Prepare Folders =="
mkdir -p "$SECOND_BRAIN_ROOT"
echo "Second brain root: $SECOND_BRAIN_ROOT"
if [ -n "$CODEX_PROJECTS_ROOT" ]; then
  mkdir -p "$CODEX_PROJECTS_ROOT"
  echo "Codex projects root: $CODEX_PROJECTS_ROOT"
fi

cd "$PROJECT_ROOT"

if [ "$SKIP_RCLONE" != "true" ]; then
  echo
  echo "== Install Dropbox Sync Timer =="
  bash scripts/pi-install-dropbox-sync.sh \
    --local "$SECOND_BRAIN_ROOT" \
    --remote "$RCLONE_TARGET" \
    --interval "$RCLONE_INTERVAL" \
    --mode "$RCLONE_MODE" \
    --start
else
  echo
  echo "== Install Dropbox Sync Timer =="
  echo "Skipped"
fi

if [ "$SKIP_DOCKER_ACCESS" != "true" ]; then
  echo
  echo "== Configure Docker Access =="
  docker_cmd=(pnpm run dc:ensure-docker-access -- --second-brain-root "$SECOND_BRAIN_ROOT" --codex-projects-root "$CODEX_PROJECTS_ROOT")
  if [ -n "$CODEX_MEMORY_ROOT" ]; then
    docker_cmd+=(--codex-memory-root "$CODEX_MEMORY_ROOT")
  fi
  "${docker_cmd[@]}"
else
  echo
  echo "== Configure Docker Access =="
  echo "Skipped"
fi

if [ "$SKIP_SYSTEMD" != "true" ]; then
  echo
  echo "== Install And Start systemd Service =="
  systemd_cmd=(bash scripts/pi-install-systemd.sh --start)
  if [ -n "$UNIT_NAME" ]; then
    systemd_cmd+=(--unit-name "$UNIT_NAME")
  fi
  "${systemd_cmd[@]}"
else
  echo
  echo "== Install And Start systemd Service =="
  echo "Skipped"
fi

if [ "$SKIP_HEALTH" != "true" ]; then
  echo
  echo "== Distributed Cognition Health =="
  pnpm run dc:health -- --root "$SECOND_BRAIN_ROOT"
else
  echo
  echo "== Distributed Cognition Health =="
  echo "Skipped"
fi

echo
echo "PI_SSH_START_RUNTIME=ok"
REMOTE
