#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="install"
START="false"
EXECUTE_BRIDGES="false"
SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-${DC_SECOND_BRAIN_ROOT:-}}"
CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-}"
MNEMON_DB="${NANOCLAW_PI_MNEMON_DB:-}"
PNPM_PATH="$(command -v pnpm 2>/dev/null || true)"
INTERVAL="${NANOCLAW_PI_BRIDGE_INTERVAL:-5min}"
UNIT_PREFIX="${NANOCLAW_PI_BRIDGE_UNIT_PREFIX:-}"
OUTPUT_DIR=""

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-install-bridge-timers.sh [install|uninstall|status] [options]

Installs Pi-side systemd timers for the Distributed Cognition maintenance and
bridge loop. These timers are the Raspberry Pi equivalent of the optional Mac
launchd jobs, and keep bridge work on the Pi after migration.

Jobs:
  health          pnpm run dc:health
  dashboard       pnpm run dc:dashboard
  memory-bridge   pnpm run dc:memory-bridge -- process
  codex-bridge    pnpm run dc:codex-bridge -- process
  action-bridge   pnpm run dc:action-bridge -- process

Options:
  --root <path>                  Pi Distributed-Cognition second-brain root.
  --codex-projects-root <path>   Pi Codex projects root.
  --mnemon-db <path>             Optional Pi Mnemon SQLite DB path.
  --pnpm <path>                  pnpm executable path. Default: command -v pnpm.
  --interval <duration>          systemd OnUnitActiveSec value. Default: 5min.
  --unit-prefix <name>           Unit/timer prefix. Default: distributed-cognition-bridges-<slug>.
  --output-dir <path>            Render units and runner into a directory without installing.
  --execute-bridges              Add --execute to memory/codex/action bridge jobs.
  --start                        Start timers after installing.
  -h, --help                     Show this help.

Environment defaults:
  DC_SECOND_BRAIN_ROOT
  NANOCLAW_PI_SECOND_BRAIN_ROOT
  NANOCLAW_PI_CODEX_PROJECTS_ROOT
  NANOCLAW_PI_MNEMON_DB
  NANOCLAW_PI_BRIDGE_INTERVAL
  NANOCLAW_PI_BRIDGE_UNIT_PREFIX

Examples:
  bash scripts/pi-install-bridge-timers.sh --root /home/pi/Distributed-Cognition --codex-projects-root /home/pi/Codex
  bash scripts/pi-install-bridge-timers.sh --root /home/pi/Distributed-Cognition --codex-projects-root /home/pi/Codex --execute-bridges --start
  bash scripts/pi-install-bridge-timers.sh status
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    install|uninstall|status)
      ACTION="$1"
      shift
      ;;
    --root)
      SECOND_BRAIN_ROOT="${2:-}"
      [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing value for --root" >&2; exit 2; }
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
    --pnpm)
      PNPM_PATH="${2:-}"
      [ -n "$PNPM_PATH" ] || { echo "Missing value for --pnpm" >&2; exit 2; }
      shift 2
      ;;
    --interval)
      INTERVAL="${2:-}"
      [ -n "$INTERVAL" ] || { echo "Missing value for --interval" >&2; exit 2; }
      shift 2
      ;;
    --unit-prefix)
      UNIT_PREFIX="${2:-}"
      [ -n "$UNIT_PREFIX" ] || { echo "Missing value for --unit-prefix" >&2; exit 2; }
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      [ -n "$OUTPUT_DIR" ] || { echo "Missing value for --output-dir" >&2; exit 2; }
      shift 2
      ;;
    --execute-bridges)
      EXECUTE_BRIDGES="true"
      shift
      ;;
    --start)
      START="true"
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

hash_project_root() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$PROJECT_ROOT" | shasum -a 1 | awk '{print substr($1,1,8)}'
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$PROJECT_ROOT" | sha1sum | awk '{print substr($1,1,8)}'
  else
    basename "$PROJECT_ROOT" | tr -cd '[:alnum:]' | cut -c1-8
  fi
}

sanitize_unit_prefix() {
  printf '%s' "$1" | tr -c '[:alnum:]_.@-' '-'
}

if [ -z "$UNIT_PREFIX" ]; then
  UNIT_PREFIX="distributed-cognition-bridges-$(hash_project_root)"
fi
UNIT_PREFIX="$(sanitize_unit_prefix "$UNIT_PREFIX")"

jobs=(health dashboard memory-bridge codex-bridge action-bridge)

target_user() {
  printf '%s\n' "${SUDO_USER:-$(id -un)}"
}

resolve_home() {
  local user="$1"
  local home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$user" | cut -d: -f6)"
  fi
  if [ -z "$home" ] && [ "$user" = "$(id -un)" ]; then
    home="$HOME"
  fi
  printf '%s\n' "$home"
}

shell_quote() {
  printf '%q' "$1"
}

unit_name() {
  printf '%s-%s.service\n' "$UNIT_PREFIX" "$1"
}

timer_name() {
  printf '%s-%s.timer\n' "$UNIT_PREFIX" "$1"
}

runner_path() {
  if [ -n "$OUTPUT_DIR" ]; then
    printf '%s/dc-pi-run-bridges-%s.sh\n' "$OUTPUT_DIR" "$UNIT_PREFIX"
  else
    printf '/usr/local/lib/distributed-cognition/dc-pi-run-bridges-%s.sh\n' "$UNIT_PREFIX"
  fi
}

unit_dir() {
  if [ -n "$OUTPUT_DIR" ]; then
    printf '%s\n' "$OUTPUT_DIR"
  else
    printf '/etc/systemd/system\n'
  fi
}

if [ "$ACTION" = "status" ]; then
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found" >&2; exit 1; }
  for job in "${jobs[@]}"; do
    echo "== $(timer_name "$job") =="
    systemctl status "$(timer_name "$job")" --no-pager -l 2>/dev/null | sed -n '1,18p' || echo "not installed"
  done
  exit 0
fi

if [ "$ACTION" = "uninstall" ]; then
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found" >&2; exit 1; }
  for job in "${jobs[@]}"; do
    sudo systemctl disable --now "$(timer_name "$job")" >/dev/null 2>&1 || true
    sudo rm -f "/etc/systemd/system/$(timer_name "$job")" "/etc/systemd/system/$(unit_name "$job")"
    echo "Removed $(timer_name "$job") and $(unit_name "$job")"
  done
  sudo rm -f "$(runner_path)"
  sudo systemctl daemon-reload
  echo "Removed $(runner_path)"
  exit 0
fi

[ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing required --root" >&2; usage >&2; exit 2; }
[ -n "$CODEX_PROJECTS_ROOT" ] || { echo "Missing required --codex-projects-root" >&2; usage >&2; exit 2; }
[ -n "$PNPM_PATH" ] || { echo "pnpm not found; pass --pnpm <path>" >&2; exit 1; }

TARGET_USER="$(target_user)"
TARGET_HOME="$(resolve_home "$TARGET_USER")"
[ -n "$TARGET_HOME" ] || TARGET_HOME="$HOME"
PNPM_DIR="$(cd "$(dirname "$PNPM_PATH")" && pwd)"
PATH_VALUE="$PNPM_DIR:$TARGET_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
RUNNER_PATH="$(runner_path)"
UNIT_DIR="$(unit_dir)"

write_runner() {
  local out="$1"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n\n'
    printf 'PROJECT_ROOT=%q\n' "$PROJECT_ROOT"
    printf 'SECOND_BRAIN_ROOT=%q\n' "$SECOND_BRAIN_ROOT"
    printf 'CODEX_PROJECTS_ROOT=%q\n' "$CODEX_PROJECTS_ROOT"
    printf 'MNEMON_DB=%q\n' "$MNEMON_DB"
    printf 'PNPM_PATH=%q\n' "$PNPM_PATH"
    printf 'EXECUTE_BRIDGES=%q\n' "$EXECUTE_BRIDGES"
    cat <<'EOF'

if [ "$#" -ne 1 ]; then
  echo "Usage: dc-pi-run-bridges <job>" >&2
  exit 2
fi

JOB_NAME="$1"
case "$JOB_NAME" in
  health|dashboard|memory-bridge|codex-bridge|action-bridge) ;;
  *)
    echo "Unsupported Distributed Cognition Pi bridge job: $JOB_NAME" >&2
    exit 2
    ;;
esac

LOG_DIR="$PROJECT_ROOT/logs/systemd-bridges"
LOCK_DIR="$LOG_DIR/$JOB_NAME.lock"
mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date '+%d-%m-%y, %H:%M') $JOB_NAME already running; skipping this tick"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

export DC_SECOND_BRAIN_ROOT="$SECOND_BRAIN_ROOT"
export TZ="${TZ:-Asia/Singapore}"

cd "$PROJECT_ROOT"

case "$JOB_NAME" in
  health)
    "$PNPM_PATH" run dc:health -- --root "$SECOND_BRAIN_ROOT" --json
    ;;
  dashboard)
    "$PNPM_PATH" run dc:dashboard -- --root "$SECOND_BRAIN_ROOT"
    ;;
  memory-bridge)
    cmd=("$PNPM_PATH" run dc:memory-bridge -- process --root "$SECOND_BRAIN_ROOT")
    if [ -n "$MNEMON_DB" ]; then
      cmd+=(--mnemon-db "$MNEMON_DB")
    fi
    if [ "$EXECUTE_BRIDGES" = "true" ]; then
      cmd+=(--execute)
    fi
    "${cmd[@]}"
    ;;
  codex-bridge)
    cmd=("$PNPM_PATH" run dc:codex-bridge -- process --root "$SECOND_BRAIN_ROOT" --projects-root "$CODEX_PROJECTS_ROOT")
    if [ "$EXECUTE_BRIDGES" = "true" ]; then
      cmd+=(--execute)
    fi
    "${cmd[@]}"
    ;;
  action-bridge)
    cmd=("$PNPM_PATH" run dc:action-bridge -- process --root "$SECOND_BRAIN_ROOT")
    if [ "$EXECUTE_BRIDGES" = "true" ]; then
      cmd+=(--execute)
    fi
    "${cmd[@]}"
    ;;
esac
EOF
  } > "$out"
  chmod +x "$out"
}

write_unit() {
  local job="$1"
  local out="$2"
  cat > "$out" <<EOF
[Unit]
Description=Distributed Cognition Pi bridge job: $job
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$TARGET_USER
WorkingDirectory=$PROJECT_ROOT
Environment=HOME=$TARGET_HOME
Environment=PATH=$PATH_VALUE
Environment=TZ=Asia/Singapore
Environment=DC_SECOND_BRAIN_ROOT=$SECOND_BRAIN_ROOT
ExecStart=/bin/bash $RUNNER_PATH $job
EOF
}

write_timer() {
  local job="$1"
  local out="$2"
  cat > "$out" <<EOF
[Unit]
Description=Run Distributed Cognition Pi bridge job: $job

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
RandomizedDelaySec=30s
Persistent=true
Unit=$(unit_name "$job")

[Install]
WantedBy=timers.target
EOF
}

if [ -n "$OUTPUT_DIR" ]; then
  mkdir -p "$OUTPUT_DIR"
fi
tmp_dir="$(mktemp -d)"
cleanup_tmp() {
  rm -rf "$tmp_dir"
}
trap cleanup_tmp EXIT

write_runner "$tmp_dir/$(basename "$RUNNER_PATH")"
for job in "${jobs[@]}"; do
  write_unit "$job" "$tmp_dir/$(unit_name "$job")"
  write_timer "$job" "$tmp_dir/$(timer_name "$job")"
done

if [ -n "$OUTPUT_DIR" ]; then
  install -m 0755 "$tmp_dir/$(basename "$RUNNER_PATH")" "$RUNNER_PATH"
  for job in "${jobs[@]}"; do
    install -m 0644 "$tmp_dir/$(unit_name "$job")" "$UNIT_DIR/$(unit_name "$job")"
    install -m 0644 "$tmp_dir/$(timer_name "$job")" "$UNIT_DIR/$(timer_name "$job")"
  done
else
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found" >&2; exit 1; }
  sudo mkdir -p "$(dirname "$RUNNER_PATH")"
  sudo install -m 0755 "$tmp_dir/$(basename "$RUNNER_PATH")" "$RUNNER_PATH"
  for job in "${jobs[@]}"; do
    sudo install -m 0644 "$tmp_dir/$(unit_name "$job")" "$UNIT_DIR/$(unit_name "$job")"
    sudo install -m 0644 "$tmp_dir/$(timer_name "$job")" "$UNIT_DIR/$(timer_name "$job")"
  done
  sudo systemctl daemon-reload
  for job in "${jobs[@]}"; do
    if [ "$START" = "true" ]; then
      sudo systemctl enable --now "$(timer_name "$job")"
    else
      sudo systemctl enable "$(timer_name "$job")"
    fi
  done
fi

echo "Installed Distributed Cognition Pi bridge timers:"
for job in "${jobs[@]}"; do
  echo "  $UNIT_DIR/$(timer_name "$job")"
  echo "  $UNIT_DIR/$(unit_name "$job")"
done
echo "Runner:"
echo "  $RUNNER_PATH"
echo "Interval: $INTERVAL"
if [ "$EXECUTE_BRIDGES" = "true" ]; then
  echo "Bridge jobs execute queued work."
else
  echo "Bridge jobs are dry-run. Reinstall with --execute-bridges to execute queued work."
fi
if [ "$START" = "true" ]; then
  echo "Started timers."
else
  echo "Timers enabled but not started. Re-run with --start or start them with systemctl."
fi
