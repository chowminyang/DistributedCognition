#!/usr/bin/env bash
set -euo pipefail

LOCAL_SECOND_BRAIN_ROOT="${DC_SECOND_BRAIN_ROOT:-}"
PI_HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
PI_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
PI_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
PI_SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-}"
PI_CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-}"
PI_RCLONE_REMOTE="${NANOCLAW_PI_RCLONE_REMOTE:-dropbox:}"
PI_UNIT_NAME="${NANOCLAW_PI_UNIT_NAME:-}"
PI_SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-}"
PI_BRIDGE_EXECUTE_MODE="${NANOCLAW_PI_BRIDGE_EXECUTE_MODE:-}"
EXPECTED_BRIDGE_EXECUTE_MODE="${NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE:-}"
EXPECTED_COMMIT="${NANOCLAW_PI_EXPECTED_COMMIT:-}"
REPO_URL="${NANOCLAW_PI_REPO_URL:-https://github.com/chowminyang/DistributedCognition.git}"
BRANCH="${NANOCLAW_PI_BRANCH:-main}"
MIGRATION_DATE="${NANOCLAW_PI_MIGRATION_DATE:-02-06-26}"
OPERATOR_ENV_PATH="${NANOCLAW_PI_OPERATOR_ENV:-}"
STRICT="false"

missing=()
warnings=()
failures=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-operator-env-check.sh [options]

Validates the non-secret Raspberry Pi operator environment used by Mac Codex
before it controls the Pi over SSH.

This script does not source files, open SSH, stop services, copy files, inspect
secrets, export state, import state, or touch WhatsApp runtime state.

Options:
  --operator-env <path>           Generated operator-env.sh to inspect.
                                  The file is parsed, not sourced.
  --local-root <path>             Mac Distributed-Cognition folder.
  --pi-host <host>                Pi host or IP, for example nanoclaw-pi.local.
  --pi-user <user>                SSH user, for example pi.
  --pi-path <path>                NanoClaw checkout path on the Pi.
  --pi-second-brain-root <path>   Distributed-Cognition folder on the Pi.
  --pi-codex-projects-root <path> Codex projects folder on the Pi.
  --pi-rclone-remote <name:>      rclone remote name. Default: dropbox:.
  --pi-unit-name <name>           Optional NanoClaw systemd unit name.
  --ssh-timeout <seconds>         SSH connect timeout.
  --bridge-execute-mode <mode>    dry-run, memory, or all.
  --expected-bridge-execute-mode <mode>
                                  Expected installed bridge timer mode.
  --expected-commit <sha>         Expected Pi checkout commit.
  --repo-url <url>                Repository URL to clone on the Pi.
  --branch <name>                 Branch to use on the Pi. Default: main.
  --migration-date <DD-MM-YY>     Planned migration date. Default: 02-06-26.
  --strict                        Exit non-zero if values are missing or warnings exist.
  -h, --help                      Show this help.

Environment defaults:
  DC_SECOND_BRAIN_ROOT
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_SECOND_BRAIN_ROOT
  NANOCLAW_PI_CODEX_PROJECTS_ROOT
  NANOCLAW_PI_RCLONE_REMOTE
  NANOCLAW_PI_UNIT_NAME
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT
  NANOCLAW_PI_BRIDGE_EXECUTE_MODE
  NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE
  NANOCLAW_PI_EXPECTED_COMMIT
  NANOCLAW_PI_REPO_URL
  NANOCLAW_PI_BRANCH
  NANOCLAW_PI_MIGRATION_DATE
  NANOCLAW_PI_OPERATOR_ENV
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

is_missing_or_placeholder() {
  local value="$1"
  [ -z "$value" ] && return 0
  [[ "$value" == *"<"* || "$value" == *">"* ]] && return 0
  return 1
}

require_value() {
  local label="$1"
  local value="$2"
  if is_missing_or_placeholder "$value"; then
    missing+=("$label")
  fi
}

warn() {
  warnings+=("$1")
}

fail() {
  failures+=("$1")
}

validate_absolute_path() {
  local label="$1"
  local value="$2"
  is_missing_or_placeholder "$value" && return 0
  [[ "$value" == /* ]] || fail "$label must be an absolute path"
}

validate_local_dir() {
  local label="$1"
  local value="$2"
  is_missing_or_placeholder "$value" && return 0
  validate_absolute_path "$label" "$value"
  [ -d "$value" ] || warn "$label does not exist on this Mac yet: $value"
}

validate_mode() {
  local label="$1"
  local value="$2"
  is_missing_or_placeholder "$value" && return 0
  case "$value" in
    dry-run|memory|all)
      ;;
    *)
      fail "$label must be dry-run, memory, or all"
      ;;
  esac
}

decode_operator_env_value() {
  local value="$1"

  case "$value" in
    \"*\")
      value="${value#\"}"
      value="${value%\"}"
      ;;
    \'*\')
      value="${value#\'}"
      value="${value%\'}"
      ;;
  esac

  value="${value//\\ / }"
  value="${value//\\:/\:}"
  value="${value//\\-/-}"
  value="${value//\\_/_}"
  value="${value//\\./.}"
  value="${value//\\//\/}"
  printf '%s\n' "$value"
}

load_operator_env_file_values() {
  local file="$1"
  local line=""
  local key=""
  local value=""

  is_missing_or_placeholder "$file" && return 0
  [ -f "$file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^export[[:space:]]+([A-Z0-9_]+)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="$(decode_operator_env_value "${BASH_REMATCH[2]}")"

    case "$key" in
      DC_SECOND_BRAIN_ROOT)
        [ -z "$LOCAL_SECOND_BRAIN_ROOT" ] && LOCAL_SECOND_BRAIN_ROOT="$value"
        ;;
      NANOCLAW_PI_HOST)
        [ -z "$PI_HOST" ] && PI_HOST="$value"
        ;;
      NANOCLAW_PI_USER)
        [ -z "$PI_USER" ] && PI_USER="$value"
        ;;
      NANOCLAW_PI_PROJECT_ROOT)
        [ -z "$PI_PROJECT_ROOT" ] && PI_PROJECT_ROOT="$value"
        ;;
      NANOCLAW_PI_SECOND_BRAIN_ROOT)
        [ -z "$PI_SECOND_BRAIN_ROOT" ] && PI_SECOND_BRAIN_ROOT="$value"
        ;;
      NANOCLAW_PI_CODEX_PROJECTS_ROOT)
        [ -z "$PI_CODEX_PROJECTS_ROOT" ] && PI_CODEX_PROJECTS_ROOT="$value"
        ;;
      NANOCLAW_PI_RCLONE_REMOTE)
        [ "$PI_RCLONE_REMOTE" = "dropbox:" ] && PI_RCLONE_REMOTE="$value"
        ;;
      NANOCLAW_PI_UNIT_NAME)
        [ -z "$PI_UNIT_NAME" ] && PI_UNIT_NAME="$value"
        ;;
      NANOCLAW_PI_SSH_CONNECT_TIMEOUT)
        [ -z "$PI_SSH_CONNECT_TIMEOUT" ] && PI_SSH_CONNECT_TIMEOUT="$value"
        ;;
      NANOCLAW_PI_BRIDGE_EXECUTE_MODE)
        [ -z "$PI_BRIDGE_EXECUTE_MODE" ] && PI_BRIDGE_EXECUTE_MODE="$value"
        ;;
      NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE)
        [ -z "$EXPECTED_BRIDGE_EXECUTE_MODE" ] && EXPECTED_BRIDGE_EXECUTE_MODE="$value"
        ;;
      NANOCLAW_PI_EXPECTED_COMMIT)
        [ -z "$EXPECTED_COMMIT" ] && EXPECTED_COMMIT="$value"
        ;;
      NANOCLAW_PI_REPO_URL)
        [ "$REPO_URL" = "https://github.com/chowminyang/DistributedCognition.git" ] && REPO_URL="$value"
        ;;
      NANOCLAW_PI_BRANCH)
        [ "$BRANCH" = "main" ] && BRANCH="$value"
        ;;
      NANOCLAW_PI_MIGRATION_DATE)
        [ "$MIGRATION_DATE" = "02-06-26" ] && MIGRATION_DATE="$value"
        ;;
    esac
  done <"$file"
}

validate_operator_env_file() {
  local file="$1"
  local line=""
  local unexpected=""
  local missing_lines=""
  local secret_like=""

  is_missing_or_placeholder "$file" && return 0
  if [ ! -f "$file" ]; then
    fail "operator env file does not exist: $file"
    return 0
  fi

  missing_lines="$(grep -n '^# Missing:' "$file" 2>/dev/null || true)"
  if [ -n "$missing_lines" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && warn "operator env still has unresolved line: $line"
    done <<EOF_MISSING
$missing_lines
EOF_MISSING
  fi

  secret_like="$(grep -En '(OPENAI_API_KEY|ANTHROPIC_API_KEY|WHATSAPP_[A-Z_]*=|sk-[A-Za-z0-9_-]{20,})' "$file" 2>/dev/null || true)"
  if [ -n "$secret_like" ]; then
    fail "operator env appears to contain secret-like content; remove secrets before use"
  fi

  unexpected="$(grep -En -v '^(#|$|export [A-Z0-9_]+=)' "$file" 2>/dev/null || true)"
  if [ -n "$unexpected" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && fail "operator env has unexpected non-export content: $line"
    done <<EOF_UNEXPECTED
$unexpected
EOF_UNEXPECTED
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --operator-env)
      OPERATOR_ENV_PATH="${2:-}"
      [ -n "$OPERATOR_ENV_PATH" ] || { echo "Missing value for --operator-env" >&2; exit 2; }
      shift 2
      ;;
    --local-root)
      LOCAL_SECOND_BRAIN_ROOT="${2:-}"
      [ -n "$LOCAL_SECOND_BRAIN_ROOT" ] || { echo "Missing value for --local-root" >&2; exit 2; }
      shift 2
      ;;
    --pi-host)
      PI_HOST="${2:-}"
      [ -n "$PI_HOST" ] || { echo "Missing value for --pi-host" >&2; exit 2; }
      shift 2
      ;;
    --pi-user)
      PI_USER="${2:-}"
      [ -n "$PI_USER" ] || { echo "Missing value for --pi-user" >&2; exit 2; }
      shift 2
      ;;
    --pi-path)
      PI_PROJECT_ROOT="${2:-}"
      [ -n "$PI_PROJECT_ROOT" ] || { echo "Missing value for --pi-path" >&2; exit 2; }
      shift 2
      ;;
    --pi-second-brain-root)
      PI_SECOND_BRAIN_ROOT="${2:-}"
      [ -n "$PI_SECOND_BRAIN_ROOT" ] || { echo "Missing value for --pi-second-brain-root" >&2; exit 2; }
      shift 2
      ;;
    --pi-codex-projects-root)
      PI_CODEX_PROJECTS_ROOT="${2:-}"
      [ -n "$PI_CODEX_PROJECTS_ROOT" ] || { echo "Missing value for --pi-codex-projects-root" >&2; exit 2; }
      shift 2
      ;;
    --pi-rclone-remote)
      PI_RCLONE_REMOTE="${2:-}"
      [ -n "$PI_RCLONE_REMOTE" ] || { echo "Missing value for --pi-rclone-remote" >&2; exit 2; }
      shift 2
      ;;
    --pi-unit-name)
      PI_UNIT_NAME="${2:-}"
      [ -n "$PI_UNIT_NAME" ] || { echo "Missing value for --pi-unit-name" >&2; exit 2; }
      shift 2
      ;;
    --ssh-timeout)
      PI_SSH_CONNECT_TIMEOUT="${2:-}"
      [ -n "$PI_SSH_CONNECT_TIMEOUT" ] || { echo "Missing value for --ssh-timeout" >&2; exit 2; }
      shift 2
      ;;
    --bridge-execute-mode)
      PI_BRIDGE_EXECUTE_MODE="${2:-}"
      [ -n "$PI_BRIDGE_EXECUTE_MODE" ] || { echo "Missing value for --bridge-execute-mode" >&2; exit 2; }
      shift 2
      ;;
    --expected-bridge-execute-mode)
      EXPECTED_BRIDGE_EXECUTE_MODE="${2:-}"
      [ -n "$EXPECTED_BRIDGE_EXECUTE_MODE" ] || { echo "Missing value for --expected-bridge-execute-mode" >&2; exit 2; }
      shift 2
      ;;
    --expected-commit)
      EXPECTED_COMMIT="${2:-}"
      [ -n "$EXPECTED_COMMIT" ] || { echo "Missing value for --expected-commit" >&2; exit 2; }
      shift 2
      ;;
    --repo-url)
      REPO_URL="${2:-}"
      [ -n "$REPO_URL" ] || { echo "Missing value for --repo-url" >&2; exit 2; }
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      [ -n "$BRANCH" ] || { echo "Missing value for --branch" >&2; exit 2; }
      shift 2
      ;;
    --migration-date)
      MIGRATION_DATE="${2:-}"
      [ -n "$MIGRATION_DATE" ] || { echo "Missing value for --migration-date" >&2; exit 2; }
      shift 2
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

OPERATOR_ENV_PATH="$(expand_local_path "$OPERATOR_ENV_PATH")"
load_operator_env_file_values "$OPERATOR_ENV_PATH"
LOCAL_SECOND_BRAIN_ROOT="$(expand_local_path "$LOCAL_SECOND_BRAIN_ROOT")"

require_value "Mac Distributed-Cognition folder (--local-root or DC_SECOND_BRAIN_ROOT)" "$LOCAL_SECOND_BRAIN_ROOT"
require_value "Pi host (--pi-host or NANOCLAW_PI_HOST)" "$PI_HOST"
require_value "Pi SSH user (--pi-user or NANOCLAW_PI_USER)" "$PI_USER"
require_value "Pi NanoClaw path (--pi-path or NANOCLAW_PI_PROJECT_ROOT)" "$PI_PROJECT_ROOT"
require_value "Pi Distributed-Cognition path (--pi-second-brain-root or NANOCLAW_PI_SECOND_BRAIN_ROOT)" "$PI_SECOND_BRAIN_ROOT"
require_value "Pi Codex projects path (--pi-codex-projects-root or NANOCLAW_PI_CODEX_PROJECTS_ROOT)" "$PI_CODEX_PROJECTS_ROOT"
require_value "Pi rclone remote (--pi-rclone-remote or NANOCLAW_PI_RCLONE_REMOTE)" "$PI_RCLONE_REMOTE"
require_value "Pi SSH timeout (--ssh-timeout or NANOCLAW_PI_SSH_CONNECT_TIMEOUT)" "$PI_SSH_CONNECT_TIMEOUT"
require_value "Pi bridge execute mode (--bridge-execute-mode or NANOCLAW_PI_BRIDGE_EXECUTE_MODE)" "$PI_BRIDGE_EXECUTE_MODE"
require_value "Expected bridge timer mode (--expected-bridge-execute-mode or NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE)" "$EXPECTED_BRIDGE_EXECUTE_MODE"
require_value "Expected Pi commit (--expected-commit or NANOCLAW_PI_EXPECTED_COMMIT)" "$EXPECTED_COMMIT"
require_value "Repository URL (--repo-url or NANOCLAW_PI_REPO_URL)" "$REPO_URL"
require_value "Branch (--branch or NANOCLAW_PI_BRANCH)" "$BRANCH"
require_value "Migration date (--migration-date or NANOCLAW_PI_MIGRATION_DATE)" "$MIGRATION_DATE"

validate_operator_env_file "$OPERATOR_ENV_PATH"
validate_local_dir "Mac Distributed-Cognition folder" "$LOCAL_SECOND_BRAIN_ROOT"
validate_absolute_path "Pi NanoClaw path" "$PI_PROJECT_ROOT"
validate_absolute_path "Pi Distributed-Cognition path" "$PI_SECOND_BRAIN_ROOT"
validate_absolute_path "Pi Codex projects path" "$PI_CODEX_PROJECTS_ROOT"
validate_mode "Pi bridge execute mode" "$PI_BRIDGE_EXECUTE_MODE"
validate_mode "Expected bridge timer mode" "$EXPECTED_BRIDGE_EXECUTE_MODE"

if ! is_missing_or_placeholder "$PI_HOST"; then
  if [[ "$PI_HOST" == *"@"* || "$PI_HOST" =~ [[:space:]] ]]; then
    fail "Pi host must be a hostname or IP without user@ prefix or whitespace"
  fi
  case "$PI_HOST" in
    localhost|127.*|::1)
      fail "Pi host points at localhost; that would target the Mac rather than the Pi"
      ;;
  esac
fi

if ! is_missing_or_placeholder "$PI_USER" && ! [[ "$PI_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  fail "Pi SSH user contains unsupported characters"
fi

if ! is_missing_or_placeholder "$PI_RCLONE_REMOTE" && [[ "$PI_RCLONE_REMOTE" != *: ]]; then
  warn "Pi rclone remote usually ends with ':'; current value is '$PI_RCLONE_REMOTE'"
fi

if ! is_missing_or_placeholder "$PI_SSH_CONNECT_TIMEOUT"; then
  if ! [[ "$PI_SSH_CONNECT_TIMEOUT" =~ ^[0-9]+$ ]] || [ "$PI_SSH_CONNECT_TIMEOUT" -lt 1 ]; then
    fail "Pi SSH timeout must be a positive integer"
  fi
fi

if ! is_missing_or_placeholder "$EXPECTED_COMMIT" && ! [[ "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  fail "Expected Pi commit must look like a git SHA"
fi

if ! is_missing_or_placeholder "$REPO_URL" && [[ "$REPO_URL" =~ [[:space:]] ]]; then
  fail "Repository URL must not contain whitespace"
fi

status="ready"
exit_code=0
if [ "${#failures[@]}" -gt 0 ]; then
  status="fail"
  exit_code=1
elif [ "${#missing[@]}" -gt 0 ]; then
  status="missing_values"
  [ "$STRICT" = "true" ] && exit_code=1
elif [ "${#warnings[@]}" -gt 0 ]; then
  status="warn"
  [ "$STRICT" = "true" ] && exit_code=1
fi

printf 'PI_OPERATOR_ENV_CHECK=%s\n' "$status"
printf 'Generated: `%s`\n' "$(date '+%d-%m-%y, %H:%M')"
printf 'No SSH was opened. No WhatsApp/runtime state was changed.\n'
printf 'operator_env=%s\n' "${OPERATOR_ENV_PATH:-<not-supplied>}"
printf 'pi_target=%s@%s\n' "${PI_USER:-<missing>}" "${PI_HOST:-<missing>}"
printf 'pi_project_root=%s\n' "${PI_PROJECT_ROOT:-<missing>}"
printf 'pi_second_brain_root=%s\n' "${PI_SECOND_BRAIN_ROOT:-<missing>}"
printf 'pi_codex_projects_root=%s\n' "${PI_CODEX_PROJECTS_ROOT:-<missing>}"
printf 'bridge_execute_mode=%s\n' "${PI_BRIDGE_EXECUTE_MODE:-<missing>}"
printf 'expected_bridge_execute_mode=%s\n' "${EXPECTED_BRIDGE_EXECUTE_MODE:-<missing>}"
printf 'expected_commit=%s\n' "${EXPECTED_COMMIT:-<missing>}"
printf 'repo_url=%s\n' "${REPO_URL:-<missing>}"
printf 'branch=%s\n' "${BRANCH:-<missing>}"
printf 'migration_date=%s\n' "${MIGRATION_DATE:-<missing>}"

if [ "${#missing[@]}" -gt 0 ]; then
  printf '\nMissing values:\n'
  for item in "${missing[@]}"; do
    printf -- '- %s\n' "$item"
  done
fi

if [ "${#warnings[@]}" -gt 0 ]; then
  printf '\nWarnings:\n'
  for item in "${warnings[@]}"; do
    printf -- '- %s\n' "$item"
  done
fi

if [ "${#failures[@]}" -gt 0 ]; then
  printf '\nFailures:\n'
  for item in "${failures[@]}"; do
    printf -- '- %s\n' "$item"
  done
fi

if [ "$status" = "ready" ]; then
  printf '\nNext step: run `pnpm run pi:mac-readiness -- --include-ssh-preflight` or the explicit SSH helper dry-run.\n'
elif [ "$status" = "missing_values" ]; then
  printf '\nNext step: fill and source the operator env, then rerun this check before any SSH helper.\n'
fi

exit "$exit_code"
