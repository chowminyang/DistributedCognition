#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/pi-ssh-target-guard.sh"

PI_HOST="${NANOCLAW_PI_HOST:-nanoclaw-pi.local}"
PI_USER="${NANOCLAW_PI_USER:-pi}"
PI_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-/home/pi/NanoClaw}"
PI_SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-/home/pi/Distributed-Cognition}"
PI_CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-/home/pi/Codex}"
PI_RCLONE_REMOTE="${NANOCLAW_PI_RCLONE_REMOTE:-dropbox:}"
IDENTITY_FILE="${NANOCLAW_PI_SSH_IDENTITY_FILE:-$HOME/.ssh/distributed_cognition_pi_ed25519}"
STRICT="false"
warnings=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-first-boot-checklist.sh [options]

Prints a non-mutating first-boot checklist for making a Raspberry Pi visible to
Mac Codex over SSH before Distributed Cognition cutover.

This helper does not create SSH keys, open SSH, write files, copy state,
inspect secrets, stop services, or touch WhatsApp runtime state.

Options:
  --host <host>                  Pi host or IP, for example nanoclaw-pi.local.
  --user <user>                  SSH user to create on the Pi, for example pi.
  --pi-path <path>               NanoClaw checkout path on the Pi.
  --pi-second-brain-root <path>  Distributed-Cognition folder on the Pi.
  --pi-codex-projects-root <path>
                                 Codex projects folder on the Pi.
  --pi-rclone-remote <name:>     rclone remote name. Default: dropbox:.
  --identity-file <path>         Dedicated Mac private key path.
                                 Default: ~/.ssh/distributed_cognition_pi_ed25519.
  --strict                       Exit non-zero if the dedicated public key is
                                 missing.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_SECOND_BRAIN_ROOT
  NANOCLAW_PI_CODEX_PROJECTS_ROOT
  NANOCLAW_PI_RCLONE_REMOTE
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

host_without_local_suffix() {
  local host="$1"
  case "$host" in
    *.local)
      printf '%s\n' "${host%.local}"
      ;;
    "")
      printf '<pi-hostname>\n'
      ;;
    *)
      printf '%s\n' "$host"
      ;;
  esac
}

warn() {
  warnings+=("$1")
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      PI_HOST="${2:-}"
      [ -n "$PI_HOST" ] || { echo "Missing value for --host" >&2; exit 2; }
      shift 2
      ;;
    --user)
      PI_USER="${2:-}"
      [ -n "$PI_USER" ] || { echo "Missing value for --user" >&2; exit 2; }
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
    --identity-file)
      IDENTITY_FILE="${2:-}"
      [ -n "$IDENTITY_FILE" ] || { echo "Missing value for --identity-file" >&2; exit 2; }
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

assert_pi_ssh_target "$PI_HOST" "$PI_USER"

IDENTITY_FILE="$(expand_local_path "$IDENTITY_FILE")"
PUBLIC_KEY_FILE="$IDENTITY_FILE.pub"
PI_HOSTNAME="$(host_without_local_suffix "$PI_HOST")"

status="ready"
if [ ! -f "$PUBLIC_KEY_FILE" ]; then
  status="needs_ssh_key"
  warn "Dedicated public key is missing: $PUBLIC_KEY_FILE"
fi

printf 'PI_FIRST_BOOT_CHECKLIST=%s\n' "$status"
printf 'Generated: `%s`\n' "$(date '+%d-%m-%y, %H:%M')"
printf 'No SSH was opened. No files, Docker state, Pi state, or WhatsApp/runtime state were changed.\n\n'

printf '## Raspberry Pi Imager Settings\n\n'
printf -- '- OS: `Raspberry Pi OS Lite (64-bit)`\n'
printf -- '- Hostname: `%s`\n' "$PI_HOSTNAME"
printf -- '- SSH: `enabled`\n'
printf -- '- Username: `%s`\n' "$PI_USER"
printf -- '- Authentication: `public key preferred; password fallback only for first boot if needed`\n'
printf -- '- Public key file on Mac: `%s`\n' "$PUBLIC_KEY_FILE"
printf -- '- Network: configure Wi-Fi in Imager or use Ethernet\n\n'

printf '## Planned Pi Paths\n\n'
printf -- '- NanoClaw checkout: `%s`\n' "$PI_PROJECT_ROOT"
printf -- '- Distributed-Cognition folder: `%s`\n' "$PI_SECOND_BRAIN_ROOT"
printf -- '- Codex projects folder: `%s`\n' "$PI_CODEX_PROJECTS_ROOT"
printf -- '- rclone remote: `%s`\n\n' "$PI_RCLONE_REMOTE"

if [ "${#warnings[@]}" -gt 0 ]; then
  printf '## Warnings\n\n'
  for item in "${warnings[@]}"; do
    printf -- '- %s\n' "$item"
  done
  printf '\n'
fi

printf '## Mac Commands After Imaging\n\n'
printf '```bash\n'
if [ ! -f "$PUBLIC_KEY_FILE" ]; then
  print_command pnpm run pi:ssh-key-setup -- --execute --identity-file "$IDENTITY_FILE"
fi
print_command export "NANOCLAW_PI_SSH_IDENTITY_FILE=$IDENTITY_FILE"
print_command pnpm run pi:discover -- --host "$PI_HOST"
print_command ssh-copy-id -i "$PUBLIC_KEY_FILE" "$PI_USER@$PI_HOST"
print_command pnpm run pi:ssh-key-check -- --identity-file "$IDENTITY_FILE" --host "$PI_HOST" --user "$PI_USER" --test-login
printf '```\n\n'

printf '## Operator Environment Values To Fill\n\n'
printf '```bash\n'
print_command export "NANOCLAW_PI_HOST=$PI_HOST"
print_command export "NANOCLAW_PI_USER=$PI_USER"
print_command export "NANOCLAW_PI_PROJECT_ROOT=$PI_PROJECT_ROOT"
print_command export "NANOCLAW_PI_SECOND_BRAIN_ROOT=$PI_SECOND_BRAIN_ROOT"
print_command export "NANOCLAW_PI_CODEX_PROJECTS_ROOT=$PI_CODEX_PROJECTS_ROOT"
print_command export "NANOCLAW_PI_RCLONE_REMOTE=$PI_RCLONE_REMOTE"
printf '```\n\n'

printf 'After `pi:ssh-key-check` reports `PI_SSH_KEY_CHECK=login_ok`, rerun:\n\n'
printf '```bash\n'
print_command pnpm run pi:mac-readiness -- --include-ssh-preflight
printf '```\n'

if [ "$STRICT" = "true" ] && [ "$status" != "ready" ]; then
  exit 1
fi
