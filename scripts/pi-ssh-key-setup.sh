#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/pi-ssh-target-guard.sh"

HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
IDENTITY_FILE="${NANOCLAW_PI_SSH_IDENTITY_FILE:-$HOME/.ssh/distributed_cognition_pi_ed25519}"
KEY_COMMENT="${NANOCLAW_PI_SSH_KEY_COMMENT:-distributed-cognition-mac-to-pi}"
EXECUTE="false"
warnings=()
failures=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-ssh-key-setup.sh [options]

Creates the dedicated Mac SSH identity used by Codex to control the Raspberry
Pi. By default this helper is a dry-run and prints the exact commands. It only
creates files when --execute is supplied.

Options:
  --identity-file <path>         Dedicated private key path.
                                 Default: ~/.ssh/distributed_cognition_pi_ed25519.
  --comment <comment>            SSH key comment.
                                 Default: distributed-cognition-mac-to-pi.
  --host <host>                  Optional Pi host for next-step commands.
  --user <user>                  Optional Pi SSH user for next-step commands.
  --execute                      Create the key if it does not already exist.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_SSH_IDENTITY_FILE
  NANOCLAW_PI_SSH_KEY_COMMENT
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

warn() {
  warnings+=("$1")
}

fail() {
  failures+=("$1")
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --identity-file)
      IDENTITY_FILE="${2:-}"
      [ -n "$IDENTITY_FILE" ] || { echo "Missing value for --identity-file" >&2; exit 2; }
      shift 2
      ;;
    --comment)
      KEY_COMMENT="${2:-}"
      [ -n "$KEY_COMMENT" ] || { echo "Missing value for --comment" >&2; exit 2; }
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
    --execute)
      EXECUTE="true"
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
IDENTITY_DIR="$(dirname "$IDENTITY_FILE")"
PUBLIC_KEY_FILE="$IDENTITY_FILE.pub"

if [ -z "$IDENTITY_FILE" ]; then
  fail "SSH identity file path is empty"
fi

if [ -e "$IDENTITY_FILE" ] && [ ! -f "$IDENTITY_FILE" ]; then
  fail "SSH identity path exists but is not a regular file: $IDENTITY_FILE"
fi

if [ -e "$PUBLIC_KEY_FILE" ] && [ ! -f "$PUBLIC_KEY_FILE" ]; then
  fail "SSH public key path exists but is not a regular file: $PUBLIC_KEY_FILE"
fi

if ! is_missing_or_placeholder "$HOST" && ! is_missing_or_placeholder "$REMOTE_USER"; then
  assert_pi_ssh_target "$HOST" "$REMOTE_USER"
fi

status="dry_run"

if [ -f "$IDENTITY_FILE" ]; then
  status="exists"
elif [ "$EXECUTE" = "true" ]; then
  if ! command -v ssh-keygen >/dev/null 2>&1; then
    fail "ssh-keygen command not found on this Mac"
  else
    mkdir -p "$IDENTITY_DIR"
    chmod 700 "$IDENTITY_DIR"
    ssh-keygen -t ed25519 -f "$IDENTITY_FILE" -N "" -C "$KEY_COMMENT" >/dev/null
    chmod 600 "$IDENTITY_FILE"
    [ ! -f "$PUBLIC_KEY_FILE" ] || chmod 644 "$PUBLIC_KEY_FILE"
    status="created"
  fi
fi

if [ -f "$IDENTITY_FILE" ] && [ ! -f "$PUBLIC_KEY_FILE" ]; then
  if [ "$EXECUTE" = "true" ] && command -v ssh-keygen >/dev/null 2>&1; then
    ssh-keygen -y -f "$IDENTITY_FILE" >"$PUBLIC_KEY_FILE"
    chmod 644 "$PUBLIC_KEY_FILE"
  else
    warn "SSH public key is missing; run with --execute to regenerate $PUBLIC_KEY_FILE"
  fi
fi

if [ "${#failures[@]}" -gt 0 ]; then
  status="fail"
fi

printf 'PI_SSH_KEY_SETUP=%s\n' "$status"
printf 'Generated: `%s`\n' "$(date '+%d-%m-%y, %H:%M')"
printf 'No SSH was opened. No WhatsApp/runtime state was changed.\n'
printf 'identity_file=%s\n' "$IDENTITY_FILE"
printf 'public_key_file=%s\n' "$PUBLIC_KEY_FILE"
printf 'ssh_key_comment=%s\n' "$KEY_COMMENT"
printf 'execute=%s\n\n' "$EXECUTE"

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
  exit 1
fi

if [ "$status" = "dry_run" ]; then
  printf 'Would create the dedicated key with:\n\n'
  printf '```bash\n'
  print_command mkdir -p "$IDENTITY_DIR"
  print_command chmod 700 "$IDENTITY_DIR"
  print_command ssh-keygen -t ed25519 -f "$IDENTITY_FILE" -N "" -C "$KEY_COMMENT"
  print_command chmod 600 "$IDENTITY_FILE"
  printf '```\n\n'

  printf 'To create it now, run:\n\n'
  printf '```bash\n'
  print_command pnpm run pi:ssh-key-setup -- --execute --identity-file "$IDENTITY_FILE" --comment "$KEY_COMMENT"
  printf '```\n\n'
fi

printf 'Use this identity for Pi operations:\n\n'
printf '```bash\n'
print_command export "NANOCLAW_PI_SSH_IDENTITY_FILE=$IDENTITY_FILE"
printf '```\n\n'

printf 'After the Pi host and user are known, copy the public key and prove non-interactive login:\n\n'
printf '```bash\n'
print_command ssh-copy-id -i "$PUBLIC_KEY_FILE" "${REMOTE_USER:-<pi-user>}@${HOST:-<pi-host>}"
print_command pnpm run pi:ssh-key-check -- --identity-file "$IDENTITY_FILE" --host "${HOST:-<pi-host>}" --user "${REMOTE_USER:-<pi-user>}" --test-login
printf '```\n'
