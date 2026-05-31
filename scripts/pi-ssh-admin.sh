#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/pi-ssh-target-guard.sh"

ACTION=""
HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
REMOTE_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-${DC_SECOND_BRAIN_ROOT:-}}"
CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-}"
MNEMON_DB="${NANOCLAW_PI_MNEMON_DB:-}"
UNIT_NAME="${NANOCLAW_PI_UNIT_NAME:-}"
SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-}"
EXPECTED_COMMIT="${NANOCLAW_PI_EXPECTED_COMMIT:-}"
ALLOW_MAC_HOST_RUNNING="${NANOCLAW_PI_ALLOW_MAC_HOST_RUNNING:-false}"
LINES="120"
BRIDGE_LIMIT="5"
BRIDGE_EXECUTE_MODE="${NANOCLAW_PI_BRIDGE_EXECUTE_MODE:-dry-run}"
EXPECTED_BRIDGE_EXECUTE_MODE="${NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE:-}"
SSH_OPTIONS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-ssh-admin.sh <action> [options]

Runs common Raspberry Pi operations from the Mac control plane over SSH after
Distributed Cognition has moved to the Pi.

Actions:
  doctor          Run status, health, and dashboard checks in one SSH session.
  status          Show service, git, Docker, and runtime status.
  bridge-timers   Verify Distributed Cognition Pi bridge timers.
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
  --expected-commit <sha>        Verify the Pi checkout commit starts with this SHA.
  --lines <count>                Log lines for logs action. Default: 120.
  --limit <count>                Bridge queue limit. Default: 5.
  --bridge-execute-mode <mode>   dry-run, memory, or all. Default: dry-run.
  --expected-bridge-execute-mode <mode>
                                 For bridge-timers, fail unless installed bridge
                                 timer runners are dry-run, memory, or all.
  --execute-memory-bridge        Execute only the Mnemon memory bridge.
  --execute-bridges              Execute memory, Codex, and action bridge work.
  --allow-mac-host-running       Allow start/restart/update even if this Mac
                                 checkout still appears to run NanoClaw. Use
                                 only for rollback/emergency work.
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
  NANOCLAW_PI_EXPECTED_COMMIT
  NANOCLAW_PI_BRIDGE_EXECUTE_MODE
  NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE
  NANOCLAW_PI_ALLOW_MAC_HOST_RUNNING

Examples:
  bash scripts/pi-ssh-admin.sh doctor --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition
  bash scripts/pi-ssh-admin.sh status --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw
  bash scripts/pi-ssh-admin.sh bridge-timers --expected-bridge-execute-mode memory --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw
  bash scripts/pi-ssh-admin.sh health --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition
  bash scripts/pi-ssh-admin.sh process-bridges --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition --codex-projects-root /home/pi/Codex
  bash scripts/pi-ssh-admin.sh process-bridges --bridge-execute-mode memory --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition --codex-projects-root /home/pi/Codex
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

  local local_project_root pid cwd
  local_project_root="$(canonical_dir "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)")"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" != "$$" ] || continue
    [ "$pid" != "${PPID:-}" ] || continue
    cwd="$(pid_cwd "$pid" 2>/dev/null || true)"
    [ "$cwd" = "$local_project_root" ] || continue
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

require_mac_host_stopped_for_service_start() {
  case "$ACTION" in
    start|restart|update)
      ;;
    *)
      return 0
      ;;
  esac

  [ "$ALLOW_MAC_HOST_RUNNING" != "true" ] || {
    echo "WARN - Mac host guard bypassed by --allow-mac-host-running" >&2
    return 0
  }

  local host_pids screen_sessions docker_containers
  host_pids="$(find_local_host_pids | unique_lines)"
  screen_sessions="$(find_local_screen_sessions | unique_lines)"
  docker_containers="$(find_local_docker_containers | unique_lines)"

  [ -z "$host_pids" ] && [ -z "$screen_sessions" ] && [ -z "$docker_containers" ] && return 0

  echo "Refusing to $ACTION the Pi runtime while the Mac NanoClaw host appears to be running." >&2
  echo "WhatsApp/Baileys must run from only one host at a time." >&2
  echo "Run this first during final cutover:" >&2
  echo "  pnpm run dc:install-launchd -- uninstall" >&2
  echo "  pnpm run dc:stop-host -- --execute" >&2
  echo "  pnpm run pi:mac-preflight -- --root <mac Distributed-Cognition folder> --out-dir <export dir> --require-stopped" >&2
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
    doctor|status|bridge-timers|health|dashboard|logs|follow-logs|memory-bridge|codex-bridge|action-bridge|process-bridges|start|stop|restart|update)
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
    --expected-commit)
      EXPECTED_COMMIT="${2:-}"
      [ -n "$EXPECTED_COMMIT" ] || { echo "Missing value for --expected-commit" >&2; exit 2; }
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
    --bridge-execute-mode)
      BRIDGE_EXECUTE_MODE="${2:-}"
      [ -n "$BRIDGE_EXECUTE_MODE" ] || { echo "Missing value for --bridge-execute-mode" >&2; exit 2; }
      shift 2
      ;;
    --expected-bridge-execute-mode)
      EXPECTED_BRIDGE_EXECUTE_MODE="${2:-}"
      [ -n "$EXPECTED_BRIDGE_EXECUTE_MODE" ] || { echo "Missing value for --expected-bridge-execute-mode" >&2; exit 2; }
      shift 2
      ;;
    --execute-memory-bridge)
      BRIDGE_EXECUTE_MODE="memory"
      shift
      ;;
    --execute-bridges)
      BRIDGE_EXECUTE_MODE="all"
      shift
      ;;
    --allow-mac-host-running)
      ALLOW_MAC_HOST_RUNNING="true"
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
assert_pi_ssh_target "$HOST" "$REMOTE_USER"
case "$BRIDGE_EXECUTE_MODE" in
  dry-run|memory|all)
    ;;
  *)
    echo "--bridge-execute-mode must be dry-run, memory, or all" >&2
    exit 2
    ;;
esac
case "$EXPECTED_BRIDGE_EXECUTE_MODE" in
  ""|dry-run|memory|all)
    ;;
  *)
    echo "--expected-bridge-execute-mode must be dry-run, memory, or all" >&2
    exit 2
    ;;
esac
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
require_mac_host_stopped_for_service_start

TARGET="$REMOTE_USER@$HOST"

echo "Pi SSH admin action: $ACTION"
echo "Target: $TARGET"
echo "NanoClaw path: $REMOTE_PROJECT_ROOT"
[ -n "$SECOND_BRAIN_ROOT" ] && echo "Second brain root: $SECOND_BRAIN_ROOT"
[ -n "$CODEX_PROJECTS_ROOT" ] && echo "Codex projects root: $CODEX_PROJECTS_ROOT"
[ -n "$MNEMON_DB" ] && echo "Mnemon DB: $MNEMON_DB"
[ -n "$UNIT_NAME" ] && echo "Service unit: $UNIT_NAME"
[ -n "$SSH_CONNECT_TIMEOUT" ] && echo "SSH connect timeout: ${SSH_CONNECT_TIMEOUT}s"
[ -n "$EXPECTED_COMMIT" ] && echo "Expected commit: $EXPECTED_COMMIT"
[ -n "$EXPECTED_BRIDGE_EXECUTE_MODE" ] && echo "Expected bridge timer mode: $EXPECTED_BRIDGE_EXECUTE_MODE"
case "$ACTION" in
  memory-bridge|codex-bridge|action-bridge|process-bridges)
    echo "Bridge execute mode: $BRIDGE_EXECUTE_MODE"
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
  "$BRIDGE_EXECUTE_MODE" \
  "$EXPECTED_COMMIT" \
  "$EXPECTED_BRIDGE_EXECUTE_MODE" <<'REMOTE'
set -euo pipefail

ACTION="$1"
PROJECT_ROOT="$2"
SECOND_BRAIN_ROOT="$3"
CODEX_PROJECTS_ROOT="$4"
MNEMON_DB="$5"
UNIT_NAME="$6"
LINES="$7"
BRIDGE_LIMIT="$8"
BRIDGE_EXECUTE_MODE="$9"
EXPECTED_COMMIT="${10}"
EXPECTED_BRIDGE_EXECUTE_MODE="${11}"

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

verify_expected_commit() {
  [ -n "$EXPECTED_COMMIT" ] || return 0

  local actual_full="$1"
  local actual_short="$2"
  if [ -z "$actual_full" ]; then
    echo "expected_commit: $EXPECTED_COMMIT"
    echo "PI_EXPECTED_COMMIT=fail reason=no_git_commit"
    exit 1
  fi

  if [[ "$actual_full" == "$EXPECTED_COMMIT"* || "$actual_short" == "$EXPECTED_COMMIT"* ]]; then
    echo "expected_commit: $EXPECTED_COMMIT"
    echo "PI_EXPECTED_COMMIT=ok actual=${actual_short:-$actual_full}"
    return 0
  fi

  echo "expected_commit: $EXPECTED_COMMIT"
  echo "actual_commit: $actual_full"
  echo "PI_EXPECTED_COMMIT=fail"
  exit 1
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
    actual_full="$(git rev-parse HEAD 2>/dev/null || true)"
    actual_short="$(git rev-parse --short HEAD 2>/dev/null || true)"
    echo "commit: ${actual_short:-unknown}"
    echo "status_entries: $(git status --short 2>/dev/null | wc -l | tr -d ' ')"
    verify_expected_commit "$actual_full" "$actual_short"
  else
    echo "not a git checkout"
    if [ -n "$EXPECTED_COMMIT" ]; then
      echo "expected_commit: $EXPECTED_COMMIT"
      echo "PI_EXPECTED_COMMIT=fail reason=no_git_checkout"
      exit 1
    fi
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
  show_bridge_timers || true
}

show_bridge_timers() {
  require_command systemctl

  echo "== Distributed Cognition Bridge Timers =="
  local timers
  timers="$(
    {
      systemctl list-timers --all --no-legend --no-pager 2>/dev/null | awk '{print $1}'
      systemctl list-unit-files --type=timer --no-legend --no-pager 2>/dev/null | awk '{print $1}'
    } | grep -E -- '-(health|dashboard|memory-bridge|codex-bridge|action-bridge)\.timer$' | sort -u || true
  )"

  if [ -z "$timers" ]; then
    echo "PI_BRIDGE_TIMERS=missing"
    echo "No Distributed Cognition bridge timers were found."
    return 1
  fi

  local count=0
  local bridge_count=0
  local missing_mode_count=0
  local wrong_mode_count=0
  local actual_modes=""
  while IFS= read -r timer; do
    [ -n "$timer" ] || continue
    count=$((count + 1))
    local service runner mode
    service="$(systemctl show "$timer" -p Unit --value --no-pager 2>/dev/null || true)"
    [ -n "$service" ] || service="${timer%.timer}.service"
    runner="$(systemctl cat "$service" 2>/dev/null | awk '/^ExecStart=\/bin\/bash / {print $2; exit}' || true)"
    mode=""
    if [ -n "$runner" ] && [ -r "$runner" ]; then
      mode="$(sed -n 's/^BRIDGE_EXECUTE_MODE=//p' "$runner" 2>/dev/null | head -n 1 || true)"
      mode="${mode#\'}"
      mode="${mode%\'}"
      mode="${mode#\"}"
      mode="${mode%\"}"
    fi

    echo
    echo "timer: $timer"
    echo "service: $service"
    echo "enabled: $(systemctl is-enabled "$timer" 2>/dev/null || true)"
    echo "active: $(systemctl is-active "$timer" 2>/dev/null || true)"
    [ -n "$runner" ] && echo "runner: $runner"
    [ -n "$mode" ] && echo "bridge_execute_mode: $mode"
    systemctl show "$timer" \
      -p Unit \
      -p NextElapseUSecRealtime \
      -p LastTriggerUSec \
      -p Result \
      --no-pager 2>/dev/null || true

    case "$service" in
      *-memory-bridge.service|*-codex-bridge.service|*-action-bridge.service)
        bridge_count=$((bridge_count + 1))
        if [ -z "$mode" ]; then
          missing_mode_count=$((missing_mode_count + 1))
        else
          if ! printf '%s\n' "$actual_modes" | grep -Fxq "$mode"; then
            actual_modes="${actual_modes}${actual_modes:+$'\n'}$mode"
          fi
          if [ -n "$EXPECTED_BRIDGE_EXECUTE_MODE" ] && [ "$mode" != "$EXPECTED_BRIDGE_EXECUTE_MODE" ]; then
            wrong_mode_count=$((wrong_mode_count + 1))
          fi
        fi
        ;;
    esac
  done <<<"$timers"

  local actual_modes_csv
  actual_modes_csv="$(printf '%s\n' "$actual_modes" | awk 'NF {printf "%s%s", sep, $0; sep=","}')"
  [ -n "$actual_modes_csv" ] || actual_modes_csv="unknown"

  echo
  if [ -n "$EXPECTED_BRIDGE_EXECUTE_MODE" ]; then
    if [ "$bridge_count" -eq 0 ]; then
      echo "PI_BRIDGE_EXECUTE_MODE=fail expected=$EXPECTED_BRIDGE_EXECUTE_MODE actual=missing"
      echo "No memory/codex/action bridge timer services were found."
      return 1
    fi
    if [ "$missing_mode_count" -gt 0 ] || [ "$wrong_mode_count" -gt 0 ]; then
      echo "PI_BRIDGE_EXECUTE_MODE=fail expected=$EXPECTED_BRIDGE_EXECUTE_MODE actual=$actual_modes_csv missing=$missing_mode_count wrong=$wrong_mode_count"
      return 1
    fi
    echo "PI_BRIDGE_EXECUTE_MODE=ok expected=$EXPECTED_BRIDGE_EXECUTE_MODE actual=$actual_modes_csv"
  else
    echo "PI_BRIDGE_EXECUTE_MODE=unchecked actual=$actual_modes_csv"
  fi
  echo "PI_BRIDGE_TIMERS=ok count=$count"
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
  if [ "$BRIDGE_EXECUTE_MODE" = "memory" ] || [ "$BRIDGE_EXECUTE_MODE" = "all" ]; then
    cmd+=(--execute)
  fi
  "${cmd[@]}"
}

run_codex_bridge() {
  require_project
  [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing second brain root" >&2; exit 2; }
  [ -n "$CODEX_PROJECTS_ROOT" ] || { echo "Missing Codex projects root" >&2; exit 2; }
  cmd=(pnpm run dc:codex-bridge -- process --root "$SECOND_BRAIN_ROOT" --projects-root "$CODEX_PROJECTS_ROOT" --limit "$BRIDGE_LIMIT")
  if [ "$BRIDGE_EXECUTE_MODE" = "all" ]; then
    cmd+=(--execute)
  fi
  "${cmd[@]}"
}

run_action_bridge() {
  require_project
  [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing second brain root" >&2; exit 2; }
  cmd=(pnpm run dc:action-bridge -- process --root "$SECOND_BRAIN_ROOT" --limit "$BRIDGE_LIMIT")
  if [ "$BRIDGE_EXECUTE_MODE" = "all" ]; then
    cmd+=(--execute)
  fi
  "${cmd[@]}"
}

run_process_bridges() {
  echo "== Pi bridge mode =="
  case "$BRIDGE_EXECUTE_MODE" in
    all)
      echo "Executing queued memory, Codex, and action work on the Pi."
      ;;
    memory)
      echo "Executing queued memory work on the Pi; Codex/action remain dry-run for Mac-visible handoff review."
      ;;
    dry-run)
      echo "Dry run only. Add --bridge-execute-mode memory for Mnemon only or --execute-bridges for all queued work on the Pi."
      ;;
    *)
      echo "Invalid bridge execute mode: $BRIDGE_EXECUTE_MODE" >&2
      exit 2
      ;;
  esac
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
  bridge-timers) show_bridge_timers ;;
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
