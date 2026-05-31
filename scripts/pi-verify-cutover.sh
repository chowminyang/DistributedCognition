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
EXPECTED_COMMIT="${NANOCLAW_PI_EXPECTED_COMMIT:-}"
EXPECTED_BRIDGE_EXECUTE_MODE="${NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE:-${NANOCLAW_PI_BRIDGE_EXECUTE_MODE:-memory}}"
VERIFY_DIR=""
LINES="80"
EXECUTE="false"
STRICT="false"
INCLUDE_LOGS="false"
SKIP_DASHBOARD="false"
PROOF_TEXT="${NANOCLAW_PI_WHATSAPP_PROOF_TEXT:-}"
PROOF_SINCE_MINUTES="${NANOCLAW_PI_WHATSAPP_PROOF_SINCE_MINUTES:-30}"
SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-}"
SSH_OPTIONS=()
RAW_SSH_OPTIONS=()
PROOF_RESULT="skipped"
MAC_RUNTIME_LOCK="$PROJECT_ROOT/logs/pi-cutover/mac-runtime-disabled.lock"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-verify-cutover.sh [options]

Creates a post-cutover verification bundle for the intended final state:
Codex on the Mac controls the Pi over SSH, while Distributed Cognition runs
fully on the Pi.

Dry-run is the default. With --execute, it checks that the Mac host is stopped,
then runs Pi SSH admin status, bridge timer, health, and dashboard checks. It
still does not send WhatsApp messages, copy secrets, import/export state, or
change service state.

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
  --expected-commit <sha>        Pi checkout commit expected during status checks.
                                  Default: current local HEAD, when available.
  --expected-bridge-execute-mode <mode>
                                  Expected installed Pi bridge timer mode:
                                  dry-run, memory, or all. Default: memory.
  --output-dir <path>            Exact verification bundle directory.
                                  Default: output/pi-cutover-verification/DD-MM-YY-HHMM
  --lines <count>                Log lines if --include-logs is supplied. Default: 80.
  --include-logs                 Also capture recent Pi service logs. Logs may contain private content.
  --skip-dashboard               Do not run the remote dashboard refresh.
  --proof-text <text>            Unique harmless WhatsApp phrase to verify in
                                 recent Pi second-brain files. The script does
                                 not send this message; send it manually first.
  --proof-since-minutes <count>  Search recent Pi files modified within this
                                 many minutes. Default: 30.
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
  NANOCLAW_PI_EXPECTED_COMMIT
  NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE
  NANOCLAW_PI_BRIDGE_EXECUTE_MODE
  NANOCLAW_PI_WHATSAPP_PROOF_TEXT
  NANOCLAW_PI_WHATSAPP_PROOF_SINCE_MINUTES
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT
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
  SSH_OPTIONS+=("--ssh-option" "$option_value")
  if [[ "$option_value" == *=* && "$option_value" != -* ]]; then
    RAW_SSH_OPTIONS+=("-o" "$option_value")
  else
    RAW_SSH_OPTIONS+=("$option_value")
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

write_runtime_lock_dry_run() {
  local output_file="$1"
  {
    printf '# Mac Runtime Lock Check\n\n'
    printf 'Status: `dry_run`\n\n'
    printf 'Expected lock path: `%s`\n\n' "$MAC_RUNTIME_LOCK"
    printf 'This check proves the final Mac export wrote the local cutover lock that blocks accidental `pnpm start` / `pnpm dev` after the Pi becomes the runtime host.\n\n'
    printf 'Not executed. No runtime state was changed.\n'
  } >"$output_file"
}

run_runtime_lock_capture() {
  local output_file="$1"
  local source_host=""
  local current_host=""
  local reason=""
  local override_env=""
  local mode=""

  current_host="$(hostname 2>/dev/null || printf 'unknown')"

  {
    printf '# Mac Runtime Lock Check\n\n'
    printf 'Expected lock path: `%s`\n\n' "$MAC_RUNTIME_LOCK"
  } >"$output_file"

  if [ ! -f "$MAC_RUNTIME_LOCK" ]; then
    {
      printf 'MAC_RUNTIME_LOCK=missing\n'
      printf 'The final Mac export lock was not found. Run `pnpm run pi:export` after stopping the Mac host, or restore the lock before marking cutover complete.\n'
    } >>"$output_file"
    failures+=("Mac runtime lock missing at $MAC_RUNTIME_LOCK")
    return
  fi

  source_host="$(sed -n 's/^source_host=//p' "$MAC_RUNTIME_LOCK" | head -n 1)"
  reason="$(sed -n 's/^reason=//p' "$MAC_RUNTIME_LOCK" | head -n 1)"
  override_env="$(sed -n 's/^override_env=//p' "$MAC_RUNTIME_LOCK" | head -n 1)"

  if command -v stat >/dev/null 2>&1; then
    mode="$(stat -f '%Lp' "$MAC_RUNTIME_LOCK" 2>/dev/null || stat -c '%a' "$MAC_RUNTIME_LOCK" 2>/dev/null || true)"
  fi

  {
    printf 'MAC_RUNTIME_LOCK=present\n'
    printf 'source_host=%s\n' "${source_host:-<missing>}"
    printf 'current_host=%s\n' "$current_host"
    printf 'reason=%s\n' "${reason:-<missing>}"
    printf 'override_env=%s\n' "${override_env:-<missing>}"
    [ -n "$mode" ] && printf 'mode=%s\n' "$mode"
  } >>"$output_file"

  if [ -z "$source_host" ]; then
    failures+=("Mac runtime lock is missing source_host")
  elif [ "$(printf '%s' "$source_host" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$current_host" | tr '[:upper:]' '[:lower:]')" ]; then
    failures+=("Mac runtime lock source_host does not match this Mac")
  fi

  if [ "$reason" != "pi_state_export_completed" ]; then
    failures+=("Mac runtime lock reason is not pi_state_export_completed")
  fi

  if [ "$override_env" != "NANOCLAW_ALLOW_MAC_RUNTIME_AFTER_PI_EXPORT=true" ]; then
    failures+=("Mac runtime lock override_env marker is missing")
  fi
}

write_manual_whatsapp_checklist() {
  local output_file="$1"
  {
    printf '# Manual WhatsApp Verification\n\n'
    printf 'Run this only after the Pi service is started and the Mac NanoClaw host remains stopped.\n\n'
    printf 'For persistence proof, choose a unique harmless phrase such as:\n\n'
    printf '`DC Pi cutover proof DD-MM-YY-HHMM`\n\n'
    printf 'Send this from the allowlisted personal WhatsApp identity:\n\n'
    printf '`DC, capture this as Pi cutover proof: <your unique proof phrase>`\n\n'
    printf 'Then rerun the verifier with `--proof-text "<your unique proof phrase>" --execute` so the Mac can SSH into the Pi and confirm the phrase landed in the Pi second-brain folder.\n\n'
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

write_whatsapp_proof_skipped() {
  local output_file="$1"
  {
    printf '# Pi WhatsApp Persistence Proof\n\n'
    printf 'Status: `skipped`\n\n'
    printf 'No proof text was configured. This verifier did not search the Pi second-brain folder for a WhatsApp capture.\n\n'
    printf 'To prove persistence after manual WhatsApp testing, rerun with:\n\n'
    printf '```bash\n'
    printf 'pnpm run pi:verify-cutover -- ... --proof-text "<unique harmless proof phrase>" --execute\n'
    printf '```\n'
  } >"$output_file"
}

write_whatsapp_proof_dry_run() {
  local output_file="$1"
  {
    printf '# Pi WhatsApp Persistence Proof\n\n'
    printf 'Status: `dry_run`\n\n'
    printf 'Proof text: `%s`\n\n' "$PROOF_TEXT"
    printf 'Search window: `%s minutes`\n\n' "$PROOF_SINCE_MINUTES"
    printf 'Dry-run command:\n\n```bash\n'
    print_command ssh "${RAW_SSH_OPTIONS[@]}" "$REMOTE_USER@$HOST" "bash -s -- $(quote_arg "$SECOND_BRAIN_ROOT") $(quote_arg "$PROOF_TEXT") $(quote_arg "$PROOF_SINCE_MINUTES")"
    printf '```\n\n'
    printf 'Not executed. No SSH was opened. No WhatsApp/runtime state was changed.\n'
  } >"$output_file"
}

run_whatsapp_proof_capture() {
  local output_file="$1"
  {
    printf '# Pi WhatsApp Persistence Proof\n\n'
    printf 'Proof text: `%s`\n\n' "$PROOF_TEXT"
    printf 'Search window: `%s minutes`\n\n' "$PROOF_SINCE_MINUTES"
    printf 'Command:\n\n```bash\n'
    print_command ssh "${RAW_SSH_OPTIONS[@]}" "$REMOTE_USER@$HOST" "bash -s -- $(quote_arg "$SECOND_BRAIN_ROOT") $(quote_arg "$PROOF_TEXT") $(quote_arg "$PROOF_SINCE_MINUTES")"
    printf '```\n\n'
  } >"$output_file"

  set +e
  ssh "${RAW_SSH_OPTIONS[@]}" "$REMOTE_USER@$HOST" 'bash -s' -- "$SECOND_BRAIN_ROOT" "$PROOF_TEXT" "$PROOF_SINCE_MINUTES" >>"$output_file" 2>&1 <<'REMOTE_SCRIPT'
set -euo pipefail

root="$1"
proof_text="$2"
minutes="$3"

if [ -z "$proof_text" ]; then
  echo "PI_WHATSAPP_PROOF=skipped"
  echo "No proof text was supplied."
  exit 2
fi

if ! [[ "$minutes" =~ ^[0-9]+$ ]] || [ "$minutes" -le 0 ]; then
  echo "PI_WHATSAPP_PROOF=invalid_window"
  echo "Search window must be a positive integer number of minutes."
  exit 2
fi

if [ ! -d "$root" ]; then
  echo "PI_WHATSAPP_PROOF=missing"
  echo "Pi second-brain root not found."
  echo "Search root: $root"
  exit 1
fi

matches=()
while IFS= read -r -d '' file; do
  if grep -IlF -- "$proof_text" "$file" >/dev/null 2>&1; then
    rel="${file#$root/}"
    matches+=("$rel")
    [ "${#matches[@]}" -ge 20 ] && break
  fi
done < <(find "$root" -type f \( -name '*.md' -o -name '*.txt' -o -name '*.json' \) -mmin "-$minutes" -print0)

if [ "${#matches[@]}" -eq 0 ]; then
  echo "PI_WHATSAPP_PROOF=missing"
  echo "No recent Markdown/text/JSON file under the Pi second-brain root contained the proof text."
  echo "Search root: $root"
  echo "Search window minutes: $minutes"
  exit 1
fi

echo "PI_WHATSAPP_PROOF=found"
echo "Matched recent files relative to the Pi second-brain root:"
printf -- '- %s\n' "${matches[@]}"
REMOTE_SCRIPT
  local exit_code="$?"
  set -e

  if [ "$exit_code" -ne 0 ]; then
    PROOF_RESULT="missing"
    failures+=("Pi WhatsApp persistence proof exited with $exit_code")
  else
    PROOF_RESULT="found"
  fi
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
    --expected-commit)
      EXPECTED_COMMIT="${2:-}"
      [ -n "$EXPECTED_COMMIT" ] || { echo "Missing value for --expected-commit" >&2; exit 2; }
      shift 2
      ;;
    --expected-bridge-execute-mode)
      EXPECTED_BRIDGE_EXECUTE_MODE="${2:-}"
      [ -n "$EXPECTED_BRIDGE_EXECUTE_MODE" ] || { echo "Missing value for --expected-bridge-execute-mode" >&2; exit 2; }
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
    --proof-text)
      PROOF_TEXT="${2:-}"
      [ -n "$PROOF_TEXT" ] || { echo "Missing value for --proof-text" >&2; exit 2; }
      shift 2
      ;;
    --proof-since-minutes)
      PROOF_SINCE_MINUTES="${2:-}"
      [[ "$PROOF_SINCE_MINUTES" =~ ^[0-9]+$ ]] || { echo "--proof-since-minutes must be a positive integer" >&2; exit 2; }
      [ "$PROOF_SINCE_MINUTES" -gt 0 ] || { echo "--proof-since-minutes must be greater than 0" >&2; exit 2; }
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

if ! [[ "$PROOF_SINCE_MINUTES" =~ ^[0-9]+$ ]] || [ "$PROOF_SINCE_MINUTES" -le 0 ]; then
  echo "NANOCLAW_PI_WHATSAPP_PROOF_SINCE_MINUTES must be a positive integer" >&2
  exit 2
fi
case "$EXPECTED_BRIDGE_EXECUTE_MODE" in
  dry-run|memory|all)
    ;;
  *)
    echo "--expected-bridge-execute-mode must be dry-run, memory, or all" >&2
    exit 2
    ;;
esac

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

if [ -z "$EXPECTED_COMMIT" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  EXPECTED_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
fi

mac_check_cmd=(pnpm run pi:mac-preflight -- --root "$LOCAL_SECOND_BRAIN_ROOT" --out-dir "$OUT_DIR" --require-stopped)
admin_base=(pnpm run pi:ssh-admin --)
admin_common=(--host "$HOST" --user "$REMOTE_USER" --path "$REMOTE_PROJECT_ROOT")
[ -n "$UNIT_NAME" ] && admin_common+=(--unit-name "$UNIT_NAME")
[ -n "$EXPECTED_COMMIT" ] && admin_common+=(--expected-commit "$EXPECTED_COMMIT")
if [ "${#SSH_OPTIONS[@]}" -gt 0 ]; then
  admin_common+=("${SSH_OPTIONS[@]}")
fi

status_cmd=("${admin_base[@]}" status "${admin_common[@]}")
bridge_timers_cmd=("${admin_base[@]}" bridge-timers "${admin_common[@]}" --expected-bridge-execute-mode "$EXPECTED_BRIDGE_EXECUTE_MODE")
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
  run_runtime_lock_capture "$VERIFY_DIR/mac-runtime-lock.txt"
  run_capture "$VERIFY_DIR/pi-status.txt" "Pi Status" "${status_cmd[@]}"
  run_capture "$VERIFY_DIR/pi-bridge-timers.txt" "Pi Bridge Timers" "${bridge_timers_cmd[@]}"
  run_capture "$VERIFY_DIR/pi-health.txt" "Pi Health" "${health_cmd[@]}"
  if [ "$SKIP_DASHBOARD" = "true" ]; then
    write_dry_run_artifact "$VERIFY_DIR/pi-dashboard.txt" "Pi Dashboard" "${dashboard_cmd[@]}"
  else
    run_capture "$VERIFY_DIR/pi-dashboard.txt" "Pi Dashboard" "${dashboard_cmd[@]}"
  fi
  if [ "$INCLUDE_LOGS" = "true" ]; then
    run_capture "$VERIFY_DIR/pi-logs.txt" "Pi Service Logs" "${logs_cmd[@]}"
  fi
  if [ -n "$PROOF_TEXT" ]; then
    run_whatsapp_proof_capture "$VERIFY_DIR/pi-whatsapp-proof.txt"
  else
    write_whatsapp_proof_skipped "$VERIFY_DIR/pi-whatsapp-proof.txt"
  fi
else
  write_dry_run_artifact "$VERIFY_DIR/mac-stopped-check.txt" "Mac Host Stopped Check" "${mac_check_cmd[@]}"
  write_runtime_lock_dry_run "$VERIFY_DIR/mac-runtime-lock.txt"
  write_dry_run_artifact "$VERIFY_DIR/pi-status.txt" "Pi Status" "${status_cmd[@]}"
  write_dry_run_artifact "$VERIFY_DIR/pi-bridge-timers.txt" "Pi Bridge Timers" "${bridge_timers_cmd[@]}"
  write_dry_run_artifact "$VERIFY_DIR/pi-health.txt" "Pi Health" "${health_cmd[@]}"
  write_dry_run_artifact "$VERIFY_DIR/pi-dashboard.txt" "Pi Dashboard" "${dashboard_cmd[@]}"
  if [ "$INCLUDE_LOGS" = "true" ]; then
    write_dry_run_artifact "$VERIFY_DIR/pi-logs.txt" "Pi Service Logs" "${logs_cmd[@]}"
  fi
  if [ -n "$PROOF_TEXT" ]; then
    PROOF_RESULT="dry_run"
    write_whatsapp_proof_dry_run "$VERIFY_DIR/pi-whatsapp-proof.txt"
  else
    write_whatsapp_proof_skipped "$VERIFY_DIR/pi-whatsapp-proof.txt"
  fi
fi

write_manual_whatsapp_checklist "$VERIFY_DIR/manual-whatsapp-checklist.md"

status="dry_run"
exit_code=0
if [ "$EXECUTE" = "true" ]; then
  if [ "${#failures[@]}" -gt 0 ]; then
    status="fail"
    exit_code=1
  elif [ "$PROOF_RESULT" = "found" ]; then
    status="verified_local_pi_and_whatsapp_persistence"
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
  printf -- '- Expected Pi commit: `%s`\n' "${EXPECTED_COMMIT:-<not checked>}"
  printf -- '- Expected Pi bridge timer mode: `%s`\n' "$EXPECTED_BRIDGE_EXECUTE_MODE"
  printf -- '- Pi systemd unit: `%s`\n\n' "${UNIT_NAME:-<auto-detect>}"
  [ -n "$SSH_CONNECT_TIMEOUT" ] && printf -- '- SSH connect timeout: `%ss`\n' "$SSH_CONNECT_TIMEOUT"
  printf -- '- WhatsApp persistence proof: `%s`\n' "$PROOF_RESULT"
  printf -- '- WhatsApp proof search window: `%s minutes`\n\n' "$PROOF_SINCE_MINUTES"

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
  printf -- '- `mac-runtime-lock.txt`\n'
  printf -- '- `pi-status.txt`\n'
  printf -- '- `pi-bridge-timers.txt`\n'
  printf -- '- `pi-health.txt`\n'
  printf -- '- `pi-dashboard.txt`\n'
  [ "$INCLUDE_LOGS" = "true" ] && printf -- '- `pi-logs.txt`\n'
  printf -- '- `pi-whatsapp-proof.txt`\n'
  printf -- '- `manual-whatsapp-checklist.md`\n\n'

  printf '## Completion Rule\n\n'
  printf 'This helper verifies the Mac stopped state, Mac runtime lock, Pi service, bridge timer, health, and dashboard checks. If `--proof-text` is supplied after a manual WhatsApp test, it also verifies that the proof phrase landed in recent Pi second-brain files. The visual WhatsApp reply still needs to be confirmed from the allowlisted 1:1 chat before migration is complete.\n'
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
