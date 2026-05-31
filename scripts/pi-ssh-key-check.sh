#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/pi-ssh-target-guard.sh"

HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-10}"
IDENTITY_FILE="${NANOCLAW_PI_SSH_IDENTITY_FILE:-}"
TEST_LOGIN="false"
STRICT="false"
SSH_OPTIONS=()
missing=()
warnings=()
failures=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-ssh-key-check.sh [options]

Checks whether Mac Codex has the local SSH pieces needed to control the
Raspberry Pi non-interactively. This helper is local-only by default and opens
no SSH connection unless --test-login is supplied.

When --identity-file is not supplied, the helper looks first for a dedicated
Distributed Cognition key at ~/.ssh/distributed_cognition_pi_ed25519 before
falling back to common default SSH identities.

Options:
  --host <host>                  Pi host or IP, for example nanoclaw-pi.local.
  --user <user>                  SSH user, for example pi.
  --identity-file <path>         SSH private key to check/use.
  --ssh-timeout <seconds>        SSH connect timeout. Default: 10.
  --test-login                   Actually open a non-mutating SSH login test.
                                 This may add a first-seen Pi host key to
                                 ~/.ssh/known_hosts.
  --strict                       Exit non-zero if target values or local keys
                                 are missing.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT
  NANOCLAW_PI_SSH_IDENTITY_FILE
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
    SSH_OPTIONS+=("-o" "$option_value")
  else
    SSH_OPTIONS+=("$option_value")
  fi
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

private_key_mode() {
  local file="$1"
  stat -f '%Lp' "$file" 2>/dev/null || stat -c '%a' "$file" 2>/dev/null || true
}

check_identity_file() {
  local key_path="$1"
  local pub_path="$key_path.pub"
  local mode=""

  [ -f "$key_path" ] || return 1
  mode="$(private_key_mode "$key_path")"

  printf -- '- private key: `%s`\n' "$key_path"
  if [ -f "$pub_path" ]; then
    printf '  public key: `%s`\n' "$pub_path"
  else
    printf '  public key: `<missing %s>`\n' "$pub_path"
    warn "SSH public key is missing for $key_path"
  fi

  if [ -n "$mode" ]; then
    printf '  private key mode: `%s`\n' "$mode"
    case "$mode" in
      400|600)
        ;;
      *)
        warn "SSH private key permissions are unusual for $key_path; expected 400 or 600"
        ;;
    esac
  fi

  return 0
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
    --identity-file)
      IDENTITY_FILE="${2:-}"
      [ -n "$IDENTITY_FILE" ] || { echo "Missing value for --identity-file" >&2; exit 2; }
      shift 2
      ;;
    --ssh-timeout)
      SSH_CONNECT_TIMEOUT="${2:-}"
      [ -n "$SSH_CONNECT_TIMEOUT" ] || { echo "Missing value for --ssh-timeout" >&2; exit 2; }
      shift 2
      ;;
    --test-login)
      TEST_LOGIN="true"
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

IDENTITY_FILE="$(expand_local_path "$IDENTITY_FILE")"

if ! command -v ssh >/dev/null 2>&1; then
  fail "ssh command not found on this Mac"
fi

if [ -n "$SSH_CONNECT_TIMEOUT" ]; then
  [[ "$SSH_CONNECT_TIMEOUT" =~ ^[0-9]+$ ]] || { echo "NANOCLAW_PI_SSH_CONNECT_TIMEOUT must be a positive integer" >&2; exit 2; }
  [ "$SSH_CONNECT_TIMEOUT" -gt 0 ] || { echo "NANOCLAW_PI_SSH_CONNECT_TIMEOUT must be greater than 0" >&2; exit 2; }
fi

require_value "Pi host (--host or NANOCLAW_PI_HOST)" "$HOST"
require_value "Pi SSH user (--user or NANOCLAW_PI_USER)" "$REMOTE_USER"

if [ "${#missing[@]}" -eq 0 ]; then
  assert_pi_ssh_target "$HOST" "$REMOTE_USER"
fi

candidate_keys=()
if [ -n "$IDENTITY_FILE" ]; then
  candidate_keys+=("$IDENTITY_FILE")
else
  candidate_keys+=(
    "$HOME/.ssh/distributed_cognition_pi_ed25519"
    "$HOME/.ssh/id_ed25519"
    "$HOME/.ssh/id_rsa"
    "$HOME/.ssh/id_ecdsa"
    "$HOME/.ssh/id_ed25519_sk"
    "$HOME/.ssh/id_ecdsa_sk"
  )
fi

found_key=""
identity_report="$(mktemp "${TMPDIR:-/tmp}/dc-pi-ssh-key-report.XXXXXX")"
trap 'rm -f "$identity_report"' EXIT
{
  for candidate_key in "${candidate_keys[@]}"; do
    candidate_key="$(expand_local_path "$candidate_key")"
    if check_identity_file "$candidate_key"; then
      [ -n "$found_key" ] || found_key="$candidate_key"
    fi
  done
} >"$identity_report"

if [ -z "$found_key" ]; then
  if [ -n "$IDENTITY_FILE" ]; then
    warn "Configured SSH identity file does not exist: $IDENTITY_FILE"
  else
    warn "No usable local SSH identity file found in ~/.ssh"
  fi
fi

status="local_ready"
exit_code=0
if [ "${#failures[@]}" -gt 0 ]; then
  status="fail"
  exit_code=1
elif [ "$TEST_LOGIN" = "true" ]; then
  if [ "${#missing[@]}" -gt 0 ]; then
    status="missing_values"
    exit_code=2
  elif [ -z "$found_key" ]; then
    status="missing_key"
    exit_code=1
  else
    status="login_pending"
  fi
elif [ -z "$found_key" ]; then
  status="missing_key"
  [ "$STRICT" = "true" ] && exit_code=1
elif [ "${#missing[@]}" -gt 0 ]; then
  status="missing_values"
  [ "$STRICT" = "true" ] && exit_code=1
fi

printf 'PI_SSH_KEY_CHECK=%s\n' "$status"
printf 'Generated: `%s`\n' "$(date '+%d-%m-%y, %H:%M')"
if [ "$TEST_LOGIN" = "true" ]; then
  printf 'SSH login test requested.\n'
else
  printf 'No SSH was opened. No WhatsApp/runtime state was changed.\n'
fi
printf 'pi_target=%s@%s\n' "${REMOTE_USER:-<missing>}" "${HOST:-<missing>}"
printf 'ssh_connect_timeout=%s\n' "${SSH_CONNECT_TIMEOUT:-<unset>}"
printf 'first_identity=%s\n\n' "${found_key:-<missing>}"

printf 'Local SSH identities:\n'
if [ -s "$identity_report" ]; then
  cat "$identity_report"
else
  printf -- '- `<none found>`\n'
fi
printf '\n'

if [ "${#missing[@]}" -gt 0 ]; then
  printf 'Missing values:\n'
  for item in "${missing[@]}"; do
    printf -- '- %s\n' "$item"
  done
  printf '\n'
fi

if [ "${#warnings[@]}" -gt 0 ]; then
  printf 'Warnings:\n'
  for item in "${warnings[@]}"; do
    printf -- '- %s\n' "$item"
  done
  printf '\n'
fi

if [ "${#failures[@]}" -gt 0 ]; then
  printf 'Failures:\n'
  for item in "${failures[@]}"; do
    printf -- '- %s\n' "$item"
  done
  printf '\n'
fi

if [ -z "$found_key" ]; then
  printf 'Suggested one-time setup:\n\n'
  printf '```bash\n'
  printf 'mkdir -p "$HOME/.ssh"\n'
  printf 'chmod 700 "$HOME/.ssh"\n'
  printf 'ssh-keygen -t ed25519 -f "$HOME/.ssh/distributed_cognition_pi_ed25519" -N "" -C "distributed-cognition-mac-to-pi"\n'
  printf 'export NANOCLAW_PI_SSH_IDENTITY_FILE="$HOME/.ssh/distributed_cognition_pi_ed25519"\n'
  printf 'ssh-copy-id -i "$NANOCLAW_PI_SSH_IDENTITY_FILE.pub" %s@%s\n' "${REMOTE_USER:-<pi-user>}" "${HOST:-<pi-host>}"
  printf 'pnpm run pi:ssh-key-check -- --identity-file "$NANOCLAW_PI_SSH_IDENTITY_FILE" --host %s --user %s --test-login\n' "${HOST:-<pi-host>}" "${REMOTE_USER:-<pi-user>}"
  printf '```\n\n'
fi

if [ "${#missing[@]}" -eq 0 ]; then
  add_default_pi_ssh_options "$SSH_CONNECT_TIMEOUT"
  if [ -n "$IDENTITY_FILE" ]; then
    add_ssh_option "IdentitiesOnly=yes"
    add_ssh_option "IdentityFile=$IDENTITY_FILE"
  fi
  target="$REMOTE_USER@$HOST"

  printf 'Non-interactive login test command:\n\n'
  printf '```bash\n'
  print_command ssh "${SSH_OPTIONS[@]}" "$target" "printf 'PI_SSH_KEY_LOGIN=ok\nremote_host=%s\nremote_user=%s\n' \"\$(hostname)\" \"\$USER\""
  printf '```\n\n'

  if [ "$TEST_LOGIN" = "true" ] && [ "$status" = "login_pending" ]; then
    set +e
    ssh "${SSH_OPTIONS[@]}" "$target" "printf 'PI_SSH_KEY_LOGIN=ok\nremote_host=%s\nremote_user=%s\n' \"\$(hostname)\" \"\$USER\""
    login_code="$?"
    set -e
    if [ "$login_code" -eq 0 ]; then
      printf '\nPI_SSH_KEY_CHECK=login_ok\n'
      exit 0
    fi
    printf '\nPI_SSH_KEY_CHECK=login_failed\n'
    exit "$login_code"
  fi
fi

exit "$exit_code"
