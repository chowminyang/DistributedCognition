#!/usr/bin/env bash
set -euo pipefail

HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
REMOTE_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-${DC_SECOND_BRAIN_ROOT:-}}"
CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-}"
RCLONE_REMOTE="${NANOCLAW_PI_RCLONE_REMOTE:-}"
SSH_OPTIONS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-ssh-preflight.sh [options]

Checks whether a Raspberry Pi is ready to run Distributed Cognition, using SSH
from the Mac control plane. This script does not copy secrets, install
packages, start services, or mutate NanoClaw state.

Required options, unless the matching environment defaults are set:
  --host <host>                  Pi host or IP, for example nanoclaw-pi.local.
  --user <user>                  SSH user, for example pi.
  --path <path>                  NanoClaw checkout path on the Pi.
  --second-brain-root <path>     Writable Distributed-Cognition folder on the Pi.

Optional:
  --codex-projects-root <path>   Readable Codex projects folder on the Pi.
  --rclone-remote <name:>        Expected rclone remote name, for example dropbox:.
  --ssh-option <option>          Extra ssh option. Values like BatchMode=yes
                                 are passed as ssh -o options. May be repeated.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_SECOND_BRAIN_ROOT
  NANOCLAW_PI_CODEX_PROJECTS_ROOT
  NANOCLAW_PI_RCLONE_REMOTE
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
    --rclone-remote)
      RCLONE_REMOTE="${2:-}"
      [ -n "$RCLONE_REMOTE" ] || { echo "Missing value for --rclone-remote" >&2; exit 2; }
      shift 2
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
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$HOST" ] || { echo "Missing required --host" >&2; usage >&2; exit 2; }
[ -n "$REMOTE_USER" ] || { echo "Missing required --user" >&2; usage >&2; exit 2; }
[ -n "$REMOTE_PROJECT_ROOT" ] || { echo "Missing required --path" >&2; usage >&2; exit 2; }
[ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing required --second-brain-root" >&2; usage >&2; exit 2; }

TARGET="$REMOTE_USER@$HOST"

echo "Checking Raspberry Pi over SSH: $TARGET"
echo "NanoClaw path: $REMOTE_PROJECT_ROOT"
echo "Second brain root: $SECOND_BRAIN_ROOT"
[ -n "$CODEX_PROJECTS_ROOT" ] && echo "Codex projects root: $CODEX_PROJECTS_ROOT"
[ -n "$RCLONE_REMOTE" ] && echo "Expected rclone remote: $RCLONE_REMOTE"
echo

ssh "${SSH_OPTIONS[@]}" "$TARGET" 'bash -s' -- \
  "$REMOTE_PROJECT_ROOT" \
  "$SECOND_BRAIN_ROOT" \
  "$CODEX_PROJECTS_ROOT" \
  "$RCLONE_REMOTE" <<'REMOTE'
set -u

PROJECT_ROOT="$1"
SECOND_BRAIN_ROOT="$2"
CODEX_PROJECTS_ROOT="$3"
RCLONE_REMOTE="$4"
FAILURES=0
WARNINGS=0

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

ok() {
  printf 'OK - %s\n' "$1"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  printf 'WARN - %s\n' "$1"
}

fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL - %s\n' "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

check_command() {
  local name="$1"
  local required="${2:-true}"
  if have "$name"; then
    ok "$name found at $(command -v "$name")"
  elif [ "$required" = "true" ]; then
    fail "$name not found"
  else
    warn "$name not found"
  fi
}

echo "== Host =="
ok "ssh connected to $(hostname)"
ok "kernel: $(uname -a)"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  ok "os: ${PRETTY_NAME:-unknown}"
else
  warn "/etc/os-release not readable"
fi
ok "remote time: $(date '+%d-%m-%y, %H:%M %Z')"

case "$(uname -m)" in
  aarch64|arm64)
    ok "architecture is 64-bit ARM"
    ;;
  armv7l|armv6l)
    warn "architecture is 32-bit ARM; prefer 64-bit Raspberry Pi OS for a new install"
    ;;
  *)
    warn "unexpected architecture: $(uname -m)"
    ;;
esac

echo
echo "== Required Commands =="
check_command git true
check_command curl true
check_command tar true
check_command node true
check_command pnpm true
check_command docker true
check_command systemctl true
check_command rclone true
check_command sqlite3 false

if have node; then
  NODE_VERSION="$(node -v 2>/dev/null || true)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*)
      warn "could not parse Node version: $NODE_VERSION"
      ;;
    *)
      if [ "$NODE_MAJOR" -ge 20 ]; then
        ok "Node version is $NODE_VERSION"
      else
        fail "Node version is $NODE_VERSION; NanoClaw requires >=20"
      fi
      ;;
  esac
fi

echo
echo "== Docker =="
if have docker; then
  if docker info >/dev/null 2>&1; then
    ok "docker is reachable without sudo"
  else
    fail "docker is installed but not reachable without sudo"
  fi
  if id -nG | tr ' ' '\n' | grep -qx docker; then
    ok "user is in docker group"
  else
    warn "user is not in docker group"
  fi
fi

echo
echo "== Project Path =="
if [ -d "$PROJECT_ROOT" ]; then
  ok "NanoClaw path exists: $PROJECT_ROOT"
  if [ -d "$PROJECT_ROOT/.git" ]; then
    ok "git checkout exists"
    (cd "$PROJECT_ROOT" && git rev-parse --short HEAD >/dev/null 2>&1 && ok "git commit: $(git rev-parse --short HEAD)") || warn "could not read git commit"
    (cd "$PROJECT_ROOT" && git status --short >/tmp/nanoclaw-git-status.$$ 2>/dev/null && ok "git status entries: $(wc -l < /tmp/nanoclaw-git-status.$$ | tr -d ' ')") || warn "could not read git status"
    rm -f /tmp/nanoclaw-git-status.$$
  else
    warn "NanoClaw path exists but is not a git checkout"
  fi
  [ -f "$PROJECT_ROOT/package.json" ] && ok "package.json exists" || fail "package.json missing"
  [ -f "$PROJECT_ROOT/dist/index.js" ] && ok "dist/index.js exists" || warn "dist/index.js missing; run pnpm run build"
  [ -f "$PROJECT_ROOT/.env" ] && ok ".env exists" || warn ".env missing until state import"
  [ -d "$PROJECT_ROOT/store/auth" ] && ok "WhatsApp auth store exists" || warn "store/auth missing until state import or re-pair"
  [ -d "$PROJECT_ROOT/data" ] && ok "data/ exists" || warn "data/ missing until state import"
  [ -d "$PROJECT_ROOT/groups" ] && ok "groups/ exists" || warn "groups/ missing until state import"
  if [ -f "$PROJECT_ROOT/scripts/pi-install-systemd.sh" ]; then
    if (cd "$PROJECT_ROOT" && bash scripts/pi-install-systemd.sh --output-dir /tmp/nanoclaw-systemd-check >/tmp/nanoclaw-systemd-render.$$ 2>/tmp/nanoclaw-systemd-render.err.$$); then
      ok "systemd unit renders without installing"
    else
      warn "systemd unit render failed: $(tr '\n' ' ' < /tmp/nanoclaw-systemd-render.err.$$)"
    fi
    rm -f /tmp/nanoclaw-systemd-render.$$ /tmp/nanoclaw-systemd-render.err.$$
  else
    warn "pi-install-systemd.sh not present in checkout"
  fi
else
  warn "NanoClaw path does not exist yet: $PROJECT_ROOT"
fi

echo
echo "== Second Brain =="
if [ -d "$SECOND_BRAIN_ROOT" ]; then
  ok "second-brain root exists: $SECOND_BRAIN_ROOT"
  if [ -w "$SECOND_BRAIN_ROOT" ]; then
    ok "second-brain root is writable"
  else
    fail "second-brain root is not writable"
  fi
else
  warn "second-brain root does not exist yet: $SECOND_BRAIN_ROOT"
fi

if [ -n "$CODEX_PROJECTS_ROOT" ]; then
  echo
  echo "== Codex Projects =="
  if [ -d "$CODEX_PROJECTS_ROOT" ]; then
    ok "Codex projects root exists: $CODEX_PROJECTS_ROOT"
    [ -r "$CODEX_PROJECTS_ROOT" ] && ok "Codex projects root is readable" || warn "Codex projects root is not readable"
  else
    warn "Codex projects root does not exist yet: $CODEX_PROJECTS_ROOT"
  fi
fi

echo
echo "== rclone =="
if have rclone; then
  if [ -n "$RCLONE_REMOTE" ]; then
    if rclone listremotes 2>/dev/null | grep -Fx "$RCLONE_REMOTE" >/dev/null 2>&1; then
      ok "rclone remote configured: $RCLONE_REMOTE"
    else
      warn "rclone remote not configured yet: $RCLONE_REMOTE"
    fi
  else
    warn "no --rclone-remote provided; skipped remote-name check"
  fi
fi

echo
echo "== systemd =="
if have systemctl; then
  systemctl --version | sed -n '1p' | while IFS= read -r line; do ok "$line"; done
  if systemctl is-system-running >/tmp/nanoclaw-systemd-state.$$ 2>/dev/null; then
    ok "systemd is running"
  else
    warn "systemd state: $(cat /tmp/nanoclaw-systemd-state.$$ 2>/dev/null || echo unknown)"
  fi
  rm -f /tmp/nanoclaw-systemd-state.$$
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "PREFLIGHT_RESULT=fail failures=$FAILURES warnings=$WARNINGS"
  exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
  echo "PREFLIGHT_RESULT=warn failures=0 warnings=$WARNINGS"
else
  echo "PREFLIGHT_RESULT=ok failures=0 warnings=0"
fi
REMOTE
