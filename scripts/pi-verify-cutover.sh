#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_SECOND_BRAIN_ROOT="${DC_SECOND_BRAIN_ROOT:-}"
OUT_DIR="$HOME/Desktop/dc-pi-migration"
HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
REMOTE_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-}"
UNIT_NAME="${NANOCLAW_PI_UNIT_NAME:-}"
VERIFY_DIR=""
LINES="80"
EXECUTE="false"
STRICT="false"
INCLUDE_LOGS="false"
SKIP_DASHBOARD="false"
SSH_OPTIONS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-verify-cutover.sh [options]

Creates a post-cutover verification bundle for the intended final state:
Codex on the Mac controls the Pi over SSH, while Distributed Cognition runs
fully on the Pi.

Dry-run is the default. With --execute, it checks that the Mac host is stopped,
then runs Pi SSH admin status, health, and dashboard checks. It still does not
send WhatsApp messages, copy secrets, import/export state, or change service
state.

Required for --execute, unless matching environment defaults are set:
  --host <host>                  Pi host or IP, for example nanoclaw-pi.local.
  --user <user>                  SSH user, for example pi.
  --path <path>                  NanoClaw checkout path on the Pi.
  --second-brain-root <path>     Distributed-Cognition folder on the Pi.
  --local-root <path>            Mac Distributed-Cognition folder.

Optional:
  --out-dir <path>               Mac export output directory.
                                  Default: ~/Desktop/dc-pi-migration
  --unit-name <name>             systemd unit name. Auto-detects nanoclaw-v2-*.
  --output-dir <path>            Exact verification bundle directory.
                                  Default: output/pi-cutover-verification/DD-MM-YY-HHMM
  --lines <count>                Log lines if --include-logs is supplied. Default: 80.
  --include-logs                 Also capture recent Pi service logs. Logs may contain private content.
  --skip-dashboard               Do not run the remote dashboard refresh.
  --ssh-option <option>          Extra ssh option. Values like BatchMode=yes
                                 are passed as ssh -o options. May be repeated.
  --execute                      Actually run the local stopped check and SSH verification.
  --strict                       Exit non-zero in dry-run if required values are missing.
  -h, --help                     Show this help.

Environment defaults:
  DC_SECOND_BRAIN_ROOT
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_SECOND_BRAIN_ROOT
  NANOCLAW_PI_UNIT_NAME
EOF
}

expand_local_path() {
  case "$1" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${1#~/}"
      ;;
    "")
      printf '\n'
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

quote_arg() {
  printf "%q" "$1"
}

print_command() {
  local first="true"
  for arg in "$@"; do
    if [ "$first" = "true" ]; then
      first="false"
    else
      printf ' '
    fi
    quote_arg "$arg"
  done
  printf '\n'
}

is_missing_or_placeholder() {
  local value="$1"
  [ -z "$value" ] && return 0
  [[ "$value" == *"<"* || "$value" == *">"* ]] && return 0
  return 1
}

add_ssh_option() {
  local option_value="$1"
  if [[ "$option_value" == *=* && "$option_value" != -* ]]; then
    SSH_OPTIONS+=("--ssh-option" "$option_value")
  else
    SSH_OPTIONS+=("--ssh-option" "$option_value")
  fi
}

missing=()
failures=()

require_value() {
  local label="$1"
  local value="$2"
  if is_missing_or_placeholder "$value"; then
    missing+=("$label")
  fi
}

run_capture() {
  local output_file="$1"
  local label="$2"
  shift 2

  {
    printf '# %s\n\n' "$label"
    printf 'Command:\n\n```bash\n'
    print_command "$@"
    printf '```\n\n'
  } >"$output_file"

  set +e
  "$@" >>"$output_file" 2>&1
  local exit_code="$?"
  set -e

  if [ "$exit_code" -ne 0 ]; then
    failures+=("$label exited with $exit_code")
  fi
}

write_dry_run_artifact() {
  local output_file="$1"
  local label="$2"
  shift 2
  {
    printf '# %s\n\n' "$label"
    printf 'Dry-run command:\n\n```bash\n'
    print_command "$@"
    printf '```\n\n'
    printf 'Not executed. No SSH was opened. No WhatsApp/runtime state was changed.\n'
  } >"$output_file"
}

write_manual_whatsapp_checklist() {
  local output_file="$1"
  {
    printf '# Manual WhatsApp Verification\n\n'
    printf 'Run this only after the Pi service is started and the Mac NanoClaw host remains stopped.\n\n'
    printf 'Send these from the allowlisted personal WhatsApp identity:\n\n'
    printf '1. `DC, run a health check.`\n'
    printf '2. `DC, capture this as a harmless Pi cutover verification reflection.`\n'
    printf '3. `DC, what system are you running on now?`\n\n'
    printf 'Expected evidence:\n\n'
    printf -- '- DC replies in the 1:1 WhatsApp chat.\n'
    printf -- '- A new raw ingress/capture note appears under the Pi second-brain folder.\n'
    printf -- '- A processed note or pending-review item appears for the harmless reflection.\n'
    printf -- '- `pnpm run pi:ssh-admin -- health` reports overall ok from the Pi.\n'
    printf -- '- The Mac NanoClaw host remains stopped after the reply.\n\n'
    printf 'Do not mark the migration complete until this manual WhatsApp reply path is verified from the Pi.\n'
  } >"$output_file"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local-root)
      LOCAL_SECOND_BRAIN_ROOT="${2:-}"
      [ -n "$LOCAL_SECOND_BRAIN_ROOT" ] || { echo "Missing value for --local-root" >&2; exit 2; }
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      [ -n "$OUT_DIR" ] || { echo "Missing value for --out-dir" >&2; exit 2; }
      shift 2
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
    --unit-name)
      UNIT_NAME="${2:-}"
      [ -n "$UNIT_NAME" ] || { echo "Missing value for --unit-name" >&2; exit 2; }
      shift 2
      ;;
    --output-dir)
      VERIFY_DIR="${2:-}"
      [ -n "$VERIFY_DIR" ] || { echo "Missing value for --output-dir" >&2; exit 2; }
      shift 2
      ;;
    --lines)
      LINES="${2:-}"
      [[ "$LINES" =~ ^[0-9]+$ ]] || { echo "--lines must be an integer" >&2; exit 2; }
      shift 2
      ;;
    --ssh-option)
      option_value="${2:-}"
      [ -n "$option_value" ] || { echo "Missing value for --ssh-option" >&2; exit 2; }
      add_ssh_option "$option_value"
      shift 2
      ;;
    --include-logs)
      INCLUDE_LOGS="true"
      shift
      ;;
    --skip-dashboard)
      SKIP_DASHBOARD="true"
      shift
      ;;
    --execute)
      EXECUTE="true"
      shift
      ;;
    --strict)
      STRICT="true"
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

LOCAL_SECOND_BRAIN_ROOT="$(expand_local_path "$LOCAL_SECOND_BRAIN_ROOT")"
OUT_DIR="$(expand_local_path "$OUT_DIR")"
VERIFY_DIR="$(expand_local_path "$VERIFY_DIR")"

if [ -z "$VERIFY_DIR" ]; then
  timestamp="$(date '+%d-%m-%y-%H%M')"
  VERIFY_DIR="$PROJECT_ROOT/output/pi-cutover-verification/$timestamp"
fi

require_value "Mac Distributed-Cognition folder (--local-root or DC_SECOND_BRAIN_ROOT)" "$LOCAL_SECOND_BRAIN_ROOT"
require_value "Pi host (--host or NANOCLAW_PI_HOST)" "$HOST"
require_value "Pi SSH user (--user or NANOCLAW_PI_USER)" "$REMOTE_USER"
require_value "Pi NanoClaw path (--path or NANOCLAW_PI_PROJECT_ROOT)" "$REMOTE_PROJECT_ROOT"
require_value "Pi Distributed-Cognition path (--second-brain-root or NANOCLAW_PI_SECOND_BRAIN_ROOT)" "$SECOND_BRAIN_ROOT"

mkdir -p "$VERIFY_DIR"
cd "$PROJECT_ROOT"

mac_check_cmd=(pnpm run pi:mac-preflight -- --root "$LOCAL_SECOND_BRAIN_ROOT" --out-dir "$OUT_DIR" --require-stopped)
admin_base=(pnpm run pi:ssh-admin --)
admin_common=(--host "$HOST" --user "$REMOTE_USER" --path "$REMOTE_PROJECT_ROOT")
[ -n "$UNIT_NAME" ] && admin_common+=(--unit-name "$UNIT_NAME")
if [ "${#SSH_OPTIONS[@]}" -gt 0 ]; then
  admin_common+=("${SSH_OPTIONS[@]}")
fi

status_cmd=("${admin_base[@]}" status "${admin_common[@]}")
health_cmd=("${admin_base[@]}" health "${admin_common[@]}" --second-brain-root "$SECOND_BRAIN_ROOT")
dashboard_cmd=("${admin_base[@]}" dashboard "${admin_common[@]}" --second-brain-root "$SECOND_BRAIN_ROOT")
logs_cmd=("${admin_base[@]}" logs "${admin_common[@]}" --lines "$LINES")

if [ "$EXECUTE" = "true" ]; then
  if [ "${#missing[@]}" -gt 0 ]; then
    {
      printf '# Missing Values\n\n'
      for item in "${missing[@]}"; do
        printf -- '- %s\n' "$item"
      done
    } >"$VERIFY_DIR/missing-values.md"
    echo "PI_CUTOVER_VERIFY=missing_values"
    echo "bundle=$VERIFY_DIR"
    echo "missing_values=${#missing[@]}"
    exit 2
  fi

  run_capture "$VERIFY_DIR/mac-stopped-check.txt" "Mac Host Stopped Check" "${mac_check_cmd[@]}"
  run_capture "$VERIFY_DIR/pi-status.txt" "Pi Status" "${status_cmd[@]}"
  run_capture "$VERIFY_DIR/pi-health.txt" "Pi Health" "${health_cmd[@]}"
  if [ "$SKIP_DASHBOARD" = "true" ]; then
    write_dry_run_artifact "$VERIFY_DIR/pi-dashboard.txt" "Pi Dashboard" "${dashboard_cmd[@]}"
  else
    run_capture "$VERIFY_DIR/pi-dashboard.txt" "Pi Dashboard" "${dashboard_cmd[@]}"
  fi
  if [ "$INCLUDE_LOGS" = "true" ]; then
    run_capture "$VERIFY_DIR/pi-logs.txt" "Pi Service Logs" "${logs_cmd[@]}"
  fi
else
  write_dry_run_artifact "$VERIFY_DIR/mac-stopped-check.txt" "Mac Host Stopped Check" "${mac_check_cmd[@]}"
  write_dry_run_artifact "$VERIFY_DIR/pi-status.txt" "Pi Status" "${status_cmd[@]}"
  write_dry_run_artifact "$VERIFY_DIR/pi-health.txt" "Pi Health" "${health_cmd[@]}"
  write_dry_run_artifact "$VERIFY_DIR/pi-dashboard.txt" "Pi Dashboard" "${dashboard_cmd[@]}"
  if [ "$INCLUDE_LOGS" = "true" ]; then
    write_dry_run_artifact "$VERIFY_DIR/pi-logs.txt" "Pi Service Logs" "${logs_cmd[@]}"
  fi
fi

write_manual_whatsapp_checklist "$VERIFY_DIR/manual-whatsapp-checklist.md"

status="dry_run"
exit_code=0
if [ "$EXECUTE" = "true" ]; then
  if [ "${#failures[@]}" -gt 0 ]; then
    status="fail"
    exit_code=1
  else
    status="verified_local_and_pi_checks"
  fi
elif [ "${#missing[@]}" -gt 0 ]; then
  status="missing_values"
  [ "$STRICT" = "true" ] && exit_code=1
fi

{
  printf '# Distributed Cognition Pi Cutover Verification\n\n'
  printf 'Status: `%s`\n\n' "$status"
  printf 'Generated: `%s`\n\n' "$(date '+%d-%m-%y, %H:%M')"
  printf 'Bundle path: `%s`\n\n' "$VERIFY_DIR"
  if [ "$EXECUTE" = "true" ]; then
    printf 'Executed local stopped check and Pi SSH verification commands.\n\n'
  else
    printf 'Dry run only. No SSH was opened. No WhatsApp/runtime state was changed.\n\n'
  fi
  printf '## Values\n\n'
  printf -- '- Mac repo: `%s`\n' "$PROJECT_ROOT"
  printf -- '- Mac Distributed-Cognition folder: `%s`\n' "${LOCAL_SECOND_BRAIN_ROOT:-<missing>}"
  printf -- '- Mac export directory: `%s`\n' "$OUT_DIR"
  printf -- '- Pi SSH target: `%s@%s`\n' "${REMOTE_USER:-<missing>}" "${HOST:-<missing>}"
  printf -- '- Pi NanoClaw path: `%s`\n' "${REMOTE_PROJECT_ROOT:-<missing>}"
  printf -- '- Pi Distributed-Cognition folder: `%s`\n' "${SECOND_BRAIN_ROOT:-<missing>}"
  printf -- '- Pi systemd unit: `%s`\n\n' "${UNIT_NAME:-<auto-detect>}"

  if [ "${#missing[@]}" -gt 0 ]; then
    printf '## Missing Values\n\n'
    for item in "${missing[@]}"; do
      printf -- '- %s\n' "$item"
    done
    printf '\n'
  fi

  if [ "${#failures[@]}" -gt 0 ]; then
    printf '## Failures\n\n'
    for item in "${failures[@]}"; do
      printf -- '- %s\n' "$item"
    done
    printf '\n'
  fi

  printf '## Artifacts\n\n'
  printf -- '- `mac-stopped-check.txt`\n'
  printf -- '- `pi-status.txt`\n'
  printf -- '- `pi-health.txt`\n'
  printf -- '- `pi-dashboard.txt`\n'
  [ "$INCLUDE_LOGS" = "true" ] && printf -- '- `pi-logs.txt`\n'
  printf -- '- `manual-whatsapp-checklist.md`\n\n'

  printf '## Completion Rule\n\n'
  printf 'This helper can verify the Mac stopped state plus Pi service/health/dashboard checks. It cannot by itself prove WhatsApp delivery. The migration is complete only after the manual WhatsApp checklist also succeeds from the Pi.\n'
} >"$VERIFY_DIR/summary.md"

echo "PI_CUTOVER_VERIFY=$status"
echo "bundle=$VERIFY_DIR"
if [ "$EXECUTE" = "true" ]; then
  echo "Executed local stopped check and Pi SSH verification commands."
else
  echo "No SSH was opened. No WhatsApp/runtime state was changed."
fi
if [ "${#missing[@]}" -gt 0 ]; then
  echo "missing_values=${#missing[@]}"
fi
if [ "${#failures[@]}" -gt 0 ]; then
  echo "failures=${#failures[@]}"
fi

exit "$exit_code"
