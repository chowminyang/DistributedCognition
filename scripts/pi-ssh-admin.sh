#!/usr/bin/env bash
set -euo pipefail

ACTION=""
HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
REMOTE_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-${DC_SECOND_BRAIN_ROOT:-}}"
CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-}"
MNEMON_DB="${NANOCLAW_PI_MNEMON_DB:-}"
UNIT_NAME="${NANOCLAW_PI_UNIT_NAME:-}"
SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-}"
LINES="120"
BRIDGE_LIMIT="5"
EXECUTE_BRIDGES="false"
SSH_OPTIONS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-ssh-admin.sh <action> [options]

Runs common Raspberry Pi operations from the Mac control plane over SSH after
Distributed Cognition has moved to the Pi.

Actions:
  doctor          Run status, health, and dashboard checks in one SSH session.
  status          Show service, git, Docker, and runtime status.
  health          Run pnpm run dc:health on the Pi.
  dashboard       Refresh the Distributed Cognition dashboard on the Pi.
  logs            Show recent systemd logs for the NanoClaw service.
  follow-logs     Follow systemd logs for the NanoClaw service.
  memory-bridge   Run the Mnemon durable-memory bridge on the Pi.
  codex-bridge    Run the Codex handoff bridge on the Pi.
  action-bridge   Run the action bridge on the Pi.
  process-bridges Run memory, Codex, and action bridges on the Pi.
  start           Start the NanoClaw systemd service.
  stop            Stop the NanoClaw systemd service.
  restart         Restart the NanoClaw systemd service.
  update          git pull, install, build, and restart the service.

Required options, unless the matching environment defaults are set:
  --host <host>                  Pi host or IP, for example nanoclaw-pi.local.
  --user <user>                  SSH user, for example pi.
  --path <path>                  NanoClaw checkout path on the Pi.

Required for doctor/health/dashboard/memory-bridge/action-bridge/process-bridges:
  --second-brain-root <path>     Distributed-Cognition folder on the Pi.

Required for codex-bridge/process-bridges:
  --codex-projects-root <path>   Codex projects folder on the Pi.

Optional:
  --mnemon-db <path>             Mnemon SQLite DB path on the Pi.
  --unit-name <name>             systemd unit name. Auto-detects nanoclaw-v2-*.
  --lines <count>                Log lines for logs action. Default: 120.
  --limit <count>                Bridge queue limit. Default: 5.
  --execute-bridges              Execute bridge work. Without this, bridges dry-run.
  --ssh-option <option>          Extra ssh option. Values like BatchMode=yes
                                 are passed as ssh -o options. May be repeated.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_SECOND_BRAIN_ROOT
  NANOCLAW_PI_CODEX_PROJECTS_ROOT
  NANOCLAW_PI_MNEMON_DB
  NANOCLAW_PI_UNIT_NAME
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT

Examples:
  bash scripts/pi-ssh-admin.sh doctor --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition
  bash scripts/pi-ssh-admin.sh status --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw
  bash scripts/pi-ssh-admin.sh health --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition
  bash scripts/pi-ssh-admin.sh process-bridges --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition --codex-projects-root /home/pi/Codex
  bash scripts/pi-ssh-admin.sh process-bridges --execute-bridges --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition --codex-projects-root /home/pi/Codex
  bash scripts/pi-ssh-admin.sh restart --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw
  NANOCLAW_PI_HOST=nanoclaw-pi.local NANOCLAW_PI_USER=pi NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw bash scripts/pi-ssh-admin.sh status
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

while [ "$#" -gt 0 ]; do
  case "$1" in
    doctor|status|health|dashboard|logs|follow-logs|memory-bridge|codex-bridge|action-bridge|process-bridges|start|stop|restart|update)
      if [ -n "$ACTION" ]; then
        echo "Action already set: $ACTION" >&2
        exit 2
      fi
      ACTION="$1"
      shift
      ;;
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
    --mnemon-db)
      MNEMON_DB="${2:-}"
      [ -n "$MNEMON_DB" ] || { echo "Missing value for --mnemon-db" >&2; exit 2; }
      shift 2
      ;;
    --unit-name)
      UNIT_NAME="${2:-}"
      [ -n "$UNIT_NAME" ] || { echo "Missing value for --unit-name" >&2; exit 2; }
      shift 2
      ;;
    --lines)
      LINES="${2:-}"
      [[ "$LINES" =~ ^[0-9]+$ ]] || { echo "--lines must be an integer" >&2; exit 2; }
      shift 2
      ;;
    --limit)
      BRIDGE_LIMIT="${2:-}"
      [[ "$BRIDGE_LIMIT" =~ ^[0-9]+$ ]] || { echo "--limit must be an integer" >&2; exit 2; }
      [ "$BRIDGE_LIMIT" -gt 0 ] || { echo "--limit must be greater than 0" >&2; exit 2; }
      shift 2
      ;;
    --execute-bridges)
      EXECUTE_BRIDGES="true"
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
      echo "Unknown option or action: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$ACTION" ] || { echo "Missing action" >&2; usage >&2; exit 2; }
[ -n "$HOST" ] || { echo "Missing required --host" >&2; usage >&2; exit 2; }
[ -n "$REMOTE_USER" ] || { echo "Missing required --user" >&2; usage >&2; exit 2; }
[ -n "$REMOTE_PROJECT_ROOT" ] || { echo "Missing required --path" >&2; usage >&2; exit 2; }
case "$ACTION" in
  doctor|health|dashboard|memory-bridge|action-bridge|process-bridges)
    [ -n "$SECOND_BRAIN_ROOT" ] || { echo "$ACTION requires --second-brain-root" >&2; exit 2; }
    ;;
esac
case "$ACTION" in
  codex-bridge|process-bridges)
    [ -n "$CODEX_PROJECTS_ROOT" ] || { echo "$ACTION requires --codex-projects-root" >&2; exit 2; }
    ;;
esac

TARGET="$REMOTE_USER@$HOST"

echo "Pi SSH admin action: $ACTION"
echo "Target: $TARGET"
echo "NanoClaw path: $REMOTE_PROJECT_ROOT"
[ -n "$SECOND_BRAIN_ROOT" ] && echo "Second brain root: $SECOND_BRAIN_ROOT"
[ -n "$CODEX_PROJECTS_ROOT" ] && echo "Codex projects root: $CODEX_PROJECTS_ROOT"
[ -n "$MNEMON_DB" ] && echo "Mnemon DB: $MNEMON_DB"
[ -n "$UNIT_NAME" ] && echo "Service unit: $UNIT_NAME"
[ -n "$SSH_CONNECT_TIMEOUT" ] && echo "SSH connect timeout: ${SSH_CONNECT_TIMEOUT}s"
case "$ACTION" in
  memory-bridge|codex-bridge|action-bridge|process-bridges)
    echo "Bridge mode: $([ "$EXECUTE_BRIDGES" = "true" ] && echo execute || echo dry-run)"
    echo "Bridge limit: $BRIDGE_LIMIT"
    ;;
esac
echo

ssh "${SSH_OPTIONS[@]}" "$TARGET" 'bash -s' -- \
  "$ACTION" \
  "$REMOTE_PROJECT_ROOT" \
  "$SECOND_BRAIN_ROOT" \
  "$CODEX_PROJECTS_ROOT" \
  "$MNEMON_DB" \
  "$UNIT_NAME" \
  "$LINES" \
  "$BRIDGE_LIMIT" \
  "$EXECUTE_BRIDGES" <<'REMOTE'
set -euo pipefail

ACTION="$1"
PROJECT_ROOT="$2"
SECOND_BRAIN_ROOT="$3"
CODEX_PROJECTS_ROOT="$4"
MNEMON_DB="$5"
UNIT_NAME="$6"
LINES="$7"
BRIDGE_LIMIT="$8"
EXECUTE_BRIDGES="$9"

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

PROJECT_ROOT="$(expand_remote_path "$PROJECT_ROOT")"
SECOND_BRAIN_ROOT="$(expand_remote_path "$SECOND_BRAIN_ROOT")"
CODEX_PROJECTS_ROOT="$(expand_remote_path "$CODEX_PROJECTS_ROOT")"
MNEMON_DB="$(expand_remote_path "$MNEMON_DB")"

have() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  if ! have "$1"; then
    echo "Missing required command on Pi: $1" >&2
    exit 1
  fi
}

require_project() {
  if [ ! -d "$PROJECT_ROOT" ]; then
    echo "NanoClaw path does not exist on Pi: $PROJECT_ROOT" >&2
    exit 1
  fi
  cd "$PROJECT_ROOT"
}

detect_unit() {
  if [ -n "$UNIT_NAME" ]; then
    printf '%s\n' "$UNIT_NAME"
    return 0
  fi

  local unit
  unit="$(systemctl list-units 'nanoclaw-v2-*.service' --all --no-legend --plain 2>/dev/null | awk 'NR == 1 {print $1}')"
  if [ -z "$unit" ]; then
    unit="$(systemctl list-unit-files 'nanoclaw-v2-*.service' --no-legend --plain 2>/dev/null | awk 'NR == 1 {print $1}')"
  fi
  if [ -z "$unit" ]; then
    echo "Could not auto-detect NanoClaw systemd unit. Pass --unit-name." >&2
    exit 1
  fi
  printf '%s\n' "$unit"
}

show_status() {
  require_command systemctl
  require_project
  local unit
  unit="$(detect_unit)"

  echo "== Host =="
  echo "hostname: $(hostname)"
  echo "time: $(date '+%d-%m-%y, %H:%M %Z')"
  echo "kernel: $(uname -a)"

  echo
  echo "== Git =="
  if [ -d .git ]; then
    echo "commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "status_entries: $(git status --short 2>/dev/null | wc -l | tr -d ' ')"
  else
    echo "not a git checkout"
  fi

  echo
  echo "== Service =="
  echo "unit: $unit"
  echo "active: $(systemctl is-active "$unit" 2>/dev/null || true)"
  echo "enabled: $(systemctl is-enabled "$unit" 2>/dev/null || true)"
  systemctl show "$unit" \
    -p FragmentPath \
    -p MainPID \
    -p ExecMainPID \
    -p ActiveEnterTimestamp \
    -p SubState \
    -p Result \
    -p NRestarts \
    --no-pager 2>/dev/null || true

  echo
  echo "== Docker =="
  if have docker && docker info >/dev/null 2>&1; then
    echo "docker: reachable"
    docker ps --filter 'name=nanoclaw' --format 'container={{.Names}} status={{.Status}}' 2>/dev/null || true
  elif have docker; then
    echo "docker: installed but not reachable by this user"
  else
    echo "docker: missing"
  fi

  echo
  echo "== Bridge Timers =="
  systemctl list-timers '*bridge*.timer' --all --no-pager 2>/dev/null || true
}

run_health() {
  require_project
  [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing second brain root" >&2; exit 2; }
  pnpm run dc:health -- --root "$SECOND_BRAIN_ROOT"
}

run_dashboard() {
  require_project
  [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing second brain root" >&2; exit 2; }
  pnpm run dc:dashboard -- --root "$SECOND_BRAIN_ROOT"
}

run_memory_bridge() {
  require_project
  [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing second brain root" >&2; exit 2; }
  cmd=(pnpm run dc:memory-bridge -- process --root "$SECOND_BRAIN_ROOT" --limit "$BRIDGE_LIMIT")
  if [ -n "$MNEMON_DB" ]; then
    cmd+=(--mnemon-db "$MNEMON_DB")
  fi
  if [ "$EXECUTE_BRIDGES" = "true" ]; then
    cmd+=(--execute)
  fi
  "${cmd[@]}"
}

run_codex_bridge() {
  require_project
  [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing second brain root" >&2; exit 2; }
  [ -n "$CODEX_PROJECTS_ROOT" ] || { echo "Missing Codex projects root" >&2; exit 2; }
  cmd=(pnpm run dc:codex-bridge -- process --root "$SECOND_BRAIN_ROOT" --projects-root "$CODEX_PROJECTS_ROOT" --limit "$BRIDGE_LIMIT")
  if [ "$EXECUTE_BRIDGES" = "true" ]; then
    cmd+=(--execute)
  fi
  "${cmd[@]}"
}

run_action_bridge() {
  require_project
  [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing second brain root" >&2; exit 2; }
  cmd=(pnpm run dc:action-bridge -- process --root "$SECOND_BRAIN_ROOT" --limit "$BRIDGE_LIMIT")
  if [ "$EXECUTE_BRIDGES" = "true" ]; then
    cmd+=(--execute)
  fi
  "${cmd[@]}"
}

run_process_bridges() {
  echo "== Pi bridge mode =="
  if [ "$EXECUTE_BRIDGES" = "true" ]; then
    echo "Executing queued work on the Pi."
  else
    echo "Dry run only. Add --execute-bridges to process queued work on the Pi."
  fi
  echo
  echo "== Memory bridge =="
  run_memory_bridge
  echo
  echo "== Codex bridge =="
  run_codex_bridge
  echo
  echo "== Action bridge =="
  run_action_bridge
  echo
  echo "== Dashboard =="
  run_dashboard
  echo
  echo "PI_SSH_PROCESS_BRIDGES=ok"
}

run_doctor() {
  echo "== Doctor: status =="
  show_status
  echo
  echo "== Doctor: health =="
  run_health
  echo
  echo "== Doctor: dashboard =="
  run_dashboard
  echo
  echo "PI_SSH_DOCTOR=ok"
}

run_logs() {
  require_command systemctl
  local unit
  unit="$(detect_unit)"
  journalctl -u "$unit" -n "$LINES" --no-pager
}

follow_logs() {
  require_command systemctl
  local unit
  unit="$(detect_unit)"
  journalctl -u "$unit" -f
}

service_action() {
  require_command systemctl
  local verb="$1"
  local unit
  unit="$(detect_unit)"
  sudo systemctl "$verb" "$unit"
  systemctl is-active "$unit" || true
}

update_and_restart() {
  require_command git
  require_command pnpm
  require_project
  local unit
  unit="$(detect_unit)"
  git pull --ff-only
  pnpm install --frozen-lockfile
  pnpm run build
  sudo systemctl restart "$unit"
  systemctl is-active "$unit" || true
}

case "$ACTION" in
  doctor) run_doctor ;;
  status) show_status ;;
  health) run_health ;;
  dashboard) run_dashboard ;;
  logs) run_logs ;;
  follow-logs) follow_logs ;;
  memory-bridge) run_memory_bridge ;;
  codex-bridge) run_codex_bridge ;;
  action-bridge) run_action_bridge ;;
  process-bridges) run_process_bridges ;;
  start) service_action start ;;
  stop) service_action stop ;;
  restart) service_action restart ;;
  update) update_and_restart ;;
  *)
    echo "Unsupported action: $ACTION" >&2
    exit 2
    ;;
esac
REMOTE
