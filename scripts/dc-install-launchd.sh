#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_ROOT_1="$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition"
DEFAULT_ROOT_2="$HOME/Dropbox/Distributed-Cognition"
DEFAULT_PROJECTS_ROOT="$HOME/Documents/Codex"

ACTION="install"
LOAD="false"
EXECUTE_BRIDGES="false"
ROOT="${DC_SECOND_BRAIN_ROOT:-}"
PROJECTS_ROOT="$DEFAULT_PROJECTS_ROOT"
PNPM_PATH="$(command -v pnpm 2>/dev/null || true)"
OUTPUT_DIR="$HOME/Library/LaunchAgents"
INTERVAL="300"

usage() {
  cat <<'EOF'
Usage: bash scripts/dc-install-launchd.sh [install|uninstall|status] [options]

Installs user-level macOS LaunchAgents for the Distributed Cognition host-side
maintenance loop. Generated plists live in ~/Library/LaunchAgents. A small
machine-local runner is written under ~/Library/Application Support.

Jobs:
  health          pnpm run dc:health
  dashboard       pnpm run dc:dashboard
  memory-bridge   pnpm run dc:memory-bridge -- process
  codex-bridge    pnpm run dc:codex-bridge -- process
  action-bridge   pnpm run dc:action-bridge -- process

Options:
  --root <path>              Distributed Cognition second-brain root.
  --projects-root <path>     Local Codex projects root. Default: ~/Documents/Codex.
  --pnpm <path>              pnpm executable path. Default: command -v pnpm.
  --output-dir <path>        Where to write plists. Default: ~/Library/LaunchAgents.
  --interval <seconds>       StartInterval for each job. Default: 300.
  --execute-bridges          Add --execute to memory/codex/action bridge jobs.
  --load                     Bootstrap/kickstart jobs after writing plists.
  -h, --help                 Show this help.

Examples:
  bash scripts/dc-install-launchd.sh install \
    --root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
    --execute-bridges --load

  bash scripts/dc-install-launchd.sh status
  bash scripts/dc-install-launchd.sh uninstall
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    install|uninstall|status)
      ACTION="$1"
      shift
      ;;
    --root)
      ROOT="${2:-}"
      [ -n "$ROOT" ] || { echo "Missing value for --root" >&2; exit 2; }
      shift 2
      ;;
    --projects-root)
      PROJECTS_ROOT="${2:-}"
      [ -n "$PROJECTS_ROOT" ] || { echo "Missing value for --projects-root" >&2; exit 2; }
      shift 2
      ;;
    --pnpm)
      PNPM_PATH="${2:-}"
      [ -n "$PNPM_PATH" ] || { echo "Missing value for --pnpm" >&2; exit 2; }
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      [ -n "$OUTPUT_DIR" ] || { echo "Missing value for --output-dir" >&2; exit 2; }
      shift 2
      ;;
    --interval)
      INTERVAL="${2:-}"
      [[ "$INTERVAL" =~ ^[0-9]+$ ]] || { echo "--interval must be an integer number of seconds" >&2; exit 2; }
      [ "$INTERVAL" -ge 60 ] || { echo "--interval must be at least 60 seconds" >&2; exit 2; }
      shift 2
      ;;
    --execute-bridges)
      EXECUTE_BRIDGES="true"
      shift
      ;;
    --load)
      LOAD="true"
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

detect_root() {
  if [ -n "$ROOT" ]; then
    printf '%s\n' "$ROOT"
  elif [ -d "$DEFAULT_ROOT_1" ]; then
    printf '%s\n' "$DEFAULT_ROOT_1"
  elif [ -d "$DEFAULT_ROOT_2" ]; then
    printf '%s\n' "$DEFAULT_ROOT_2"
  else
    return 1
  fi
}

hash_project_root() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$PROJECT_ROOT" | shasum -a 1 | awk '{print substr($1,1,8)}'
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$PROJECT_ROOT" | sha1sum | awk '{print substr($1,1,8)}'
  else
    basename "$PROJECT_ROOT" | tr -cd '[:alnum:]' | cut -c1-8
  fi
}

xml_escape() {
  printf '%s' "$1" |
    sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

plist_string() {
  printf '        <string>%s</string>\n' "$(xml_escape "$1")"
}

write_plist() {
  local label="$1"
  local job_name="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  shift 4
  local plist="$OUTPUT_DIR/$label.plist"

  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$(xml_escape "$label")</string>
    <key>ProgramArguments</key>
    <array>
EOF
    for arg in "$@"; do
      plist_string "$arg"
    done
    cat <<EOF
    </array>
    <key>WorkingDirectory</key>
    <string>$(xml_escape "$HOME")</string>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>$INTERVAL</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(xml_escape "$PATH_VALUE")</string>
        <key>HOME</key>
        <string>$(xml_escape "$HOME")</string>
        <key>TZ</key>
        <string>Asia/Singapore</string>
        <key>DC_SECOND_BRAIN_ROOT</key>
        <string>$(xml_escape "$RESOLVED_ROOT")</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$(xml_escape "$stdout_path")</string>
    <key>StandardErrorPath</key>
    <string>$(xml_escape "$stderr_path")</string>
</dict>
</plist>
EOF
  } > "$plist"
  echo "$plist"
}

write_runner() {
  local runner="$1"
  mkdir -p "$(dirname "$runner")"
  {
    cat <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

EOF
    printf 'PROJECT_ROOT=%q\n' "$PROJECT_ROOT"
    cat <<'EOF'

usage() {
  cat <<'USAGE'
Usage: dc-run-launchd-job <job-name> <second-brain-root> <command> [args...]

Runs a Distributed Cognition launchd job with a per-job lock so periodic
health/dashboard/bridge runs do not overlap.
USAGE
}

if [ "$#" -lt 3 ]; then
  usage >&2
  exit 2
fi

JOB_NAME="$1"
SECOND_BRAIN_ROOT="$2"
shift 2

case "$JOB_NAME" in
  health|dashboard|memory-bridge|codex-bridge|action-bridge) ;;
  *)
    echo "Unsupported Distributed Cognition launchd job: $JOB_NAME" >&2
    exit 2
    ;;
esac

LOG_DIR="$PROJECT_ROOT/logs/launchd"
LOCK_DIR="$LOG_DIR/$JOB_NAME.lock"
mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') $JOB_NAME already running; skipping this tick"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

export DC_SECOND_BRAIN_ROOT="$SECOND_BRAIN_ROOT"
export TZ="${TZ:-Asia/Singapore}"

cd "$PROJECT_ROOT"
"$@"
EOF
  } > "$runner"
  chmod +x "$runner"
}

project_hash="$(hash_project_root)"
label_prefix="com.distributedcognition.nanoclaw.$project_hash"
RUNNER="$HOME/Library/Application Support/DistributedCognition/bin/dc-run-launchd-job-$project_hash.sh"
labels=(
  "$label_prefix.health"
  "$label_prefix.dashboard"
  "$label_prefix.memory-bridge"
  "$label_prefix.codex-bridge"
  "$label_prefix.action-bridge"
)

unload_label() {
  local label="$1"
  local plist="$OUTPUT_DIR/$label.plist"
  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  fi
}

if [ "$ACTION" = "status" ]; then
  command -v launchctl >/dev/null 2>&1 || { echo "launchctl not found" >&2; exit 1; }
  for label in "${labels[@]}"; do
    echo "== $label =="
    launchctl print "gui/$(id -u)/$label" 2>/dev/null | sed -n '1,24p' || echo "not loaded"
  done
  exit 0
fi

if [ "$ACTION" = "uninstall" ]; then
  mkdir -p "$OUTPUT_DIR"
  for label in "${labels[@]}"; do
    unload_label "$label"
    rm -f "$OUTPUT_DIR/$label.plist"
    echo "Removed $OUTPUT_DIR/$label.plist"
  done
  rm -f "$RUNNER"
  echo "Removed $RUNNER"
  exit 0
fi

RESOLVED_ROOT="$(detect_root)" || {
  echo "Second-brain root not found. Pass --root <local Distributed-Cognition folder>." >&2
  exit 2
}
RESOLVED_ROOT="$(cd "$RESOLVED_ROOT" && pwd)"
PROJECTS_ROOT="$(cd "$PROJECTS_ROOT" 2>/dev/null && pwd || printf '%s' "$PROJECTS_ROOT")"

[ -d "$RESOLVED_ROOT" ] || { echo "Second-brain root does not exist: $RESOLVED_ROOT" >&2; exit 1; }
[ -n "$PNPM_PATH" ] || { echo "pnpm not found; pass --pnpm <path>" >&2; exit 1; }
[ -x "$PNPM_PATH" ] || { echo "pnpm path is not executable: $PNPM_PATH" >&2; exit 1; }

PNPM_DIR="$(cd "$(dirname "$PNPM_PATH")" && pwd)"
PATH_VALUE="$PNPM_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$OUTPUT_DIR" "$PROJECT_ROOT/logs/launchd"
write_runner "$RUNNER"

bridge_execute_args=()
if [ "$EXECUTE_BRIDGES" = "true" ]; then
  bridge_execute_args=(--execute)
fi

created=()
created+=("$(write_plist "$label_prefix.health" health "$PROJECT_ROOT/logs/launchd/health.log" "$PROJECT_ROOT/logs/launchd/health.error.log" /bin/bash "$RUNNER" health "$RESOLVED_ROOT" "$PNPM_PATH" run dc:health -- --root "$RESOLVED_ROOT" --json)")
created+=("$(write_plist "$label_prefix.dashboard" dashboard "$PROJECT_ROOT/logs/launchd/dashboard.log" "$PROJECT_ROOT/logs/launchd/dashboard.error.log" /bin/bash "$RUNNER" dashboard "$RESOLVED_ROOT" "$PNPM_PATH" run dc:dashboard -- --root "$RESOLVED_ROOT")")
created+=("$(write_plist "$label_prefix.memory-bridge" memory-bridge "$PROJECT_ROOT/logs/launchd/memory-bridge.log" "$PROJECT_ROOT/logs/launchd/memory-bridge.error.log" /bin/bash "$RUNNER" memory-bridge "$RESOLVED_ROOT" "$PNPM_PATH" run dc:memory-bridge -- process --root "$RESOLVED_ROOT" "${bridge_execute_args[@]}")")
created+=("$(write_plist "$label_prefix.codex-bridge" codex-bridge "$PROJECT_ROOT/logs/launchd/codex-bridge.log" "$PROJECT_ROOT/logs/launchd/codex-bridge.error.log" /bin/bash "$RUNNER" codex-bridge "$RESOLVED_ROOT" "$PNPM_PATH" run dc:codex-bridge -- process --root "$RESOLVED_ROOT" --projects-root "$PROJECTS_ROOT" "${bridge_execute_args[@]}")")
created+=("$(write_plist "$label_prefix.action-bridge" action-bridge "$PROJECT_ROOT/logs/launchd/action-bridge.log" "$PROJECT_ROOT/logs/launchd/action-bridge.error.log" /bin/bash "$RUNNER" action-bridge "$RESOLVED_ROOT" "$PNPM_PATH" run dc:action-bridge -- process --root "$RESOLVED_ROOT" "${bridge_execute_args[@]}")")

echo "Wrote Distributed Cognition LaunchAgents:"
for plist in "${created[@]}"; do
  echo "  $plist"
done
echo "Wrote Distributed Cognition launchd runner:"
echo "  $RUNNER"

if [ "$EXECUTE_BRIDGES" != "true" ]; then
  cat <<'EOF'

Bridge jobs were installed in dry-run mode. Re-run with --execute-bridges when you want queued
memory, Codex, and action work to execute automatically.
EOF
fi

if [ "$LOAD" = "true" ]; then
  command -v launchctl >/dev/null 2>&1 || { echo "launchctl not found" >&2; exit 1; }
  for label in "${labels[@]}"; do
    plist="$OUTPUT_DIR/$label.plist"
    unload_label "$label"
    launchctl bootstrap "gui/$(id -u)" "$plist"
    launchctl kickstart -k "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    echo "Loaded $label"
  done
else
  cat <<EOF

Not loaded yet. To load them:
  bash scripts/dc-install-launchd.sh install --root "$RESOLVED_ROOT" --execute-bridges --load

To inspect:
  bash scripts/dc-install-launchd.sh status

To uninstall:
  bash scripts/dc-install-launchd.sh uninstall
EOF
fi
