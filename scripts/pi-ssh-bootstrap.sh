#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$SCRIPT_DIR/pi-ssh-target-guard.sh"

HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
REMOTE_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
REMOTE_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-${DC_SECOND_BRAIN_ROOT:-}}"
CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-}"
RCLONE_REMOTE="${NANOCLAW_PI_RCLONE_REMOTE:-}"
REPO_URL="${NANOCLAW_PI_REPO_URL:-https://github.com/chowminyang/DistributedCognition.git}"
BRANCH="${NANOCLAW_PI_BRANCH:-main}"
SSH_CONNECT_TIMEOUT="${NANOCLAW_PI_SSH_CONNECT_TIMEOUT:-}"
EXECUTE=false
SKIP_APT=false
SKIP_DOCKER_CHECK=false
SSH_OPTIONS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-ssh-bootstrap.sh [options]

Prepares a fresh Raspberry Pi for Distributed Cognition from the Mac control
plane over SSH. This helper is dry-run by default. It only mutates the Pi when
--execute is supplied.

What --execute does on the Pi:
  - installs basic OS packages with apt, unless --skip-apt is supplied;
  - clones or updates the DistributedCognition repo;
  - creates the selected second-brain folder and optional Codex projects folder;
  - runs bash setup.sh and pnpm run build;
  - renders the systemd unit to /tmp without installing it;
  - checks Docker availability without installing Docker.

It does not copy secrets, import WhatsApp auth, start NanoClaw, install a
systemd service, configure rclone, or sync Dropbox.

Required options, unless the matching environment defaults are set:
  --host <host>                  Pi host or IP, for example nanoclaw-pi.local.
  --user <user>                  SSH user, for example pi.
  --path <path>                  NanoClaw checkout path on the Pi.
  --second-brain-root <path>     Writable Distributed-Cognition folder on the Pi.

Optional:
  --codex-projects-root <path>   Readable Codex projects folder on the Pi.
  --repo-url <url>               Repo to clone. Defaults to public DistributedCognition.
  --branch <name>                Branch to checkout. Default: main.
  --rclone-remote <name:>        Expected rclone remote name, for example dropbox:.
  --skip-apt                     Do not install apt packages.
  --skip-docker-check            Do not check Docker availability.
  --execute                      Actually SSH to the Pi and run the bootstrap.
  --ssh-option <option>          Extra ssh option. Values like BatchMode=yes
                                 are passed as ssh -o options. May be repeated.
                                 Defaults include BatchMode=yes,
                                 StrictHostKeyChecking=accept-new,
                                 ServerAliveInterval=15, and
                                 ServerAliveCountMax=2.
  -h, --help                     Show this help.

Environment defaults:
  NANOCLAW_PI_HOST
  NANOCLAW_PI_USER
  NANOCLAW_PI_PROJECT_ROOT
  NANOCLAW_PI_SECOND_BRAIN_ROOT
  NANOCLAW_PI_CODEX_PROJECTS_ROOT
  NANOCLAW_PI_RCLONE_REMOTE
  NANOCLAW_PI_REPO_URL
  NANOCLAW_PI_BRANCH
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT

Examples:
  bash scripts/pi-ssh-bootstrap.sh --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition
  bash scripts/pi-ssh-bootstrap.sh --host nanoclaw-pi.local --user pi --path /home/pi/NanoClaw --second-brain-root /home/pi/Distributed-Cognition --execute
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
  add_default_pi_ssh_options "$SSH_CONNECT_TIMEOUT"
}

add_default_ssh_options

shell_quote() {
  printf '%q' "$1"
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
    --rclone-remote)
      RCLONE_REMOTE="${2:-}"
      [ -n "$RCLONE_REMOTE" ] || { echo "Missing value for --rclone-remote" >&2; exit 2; }
      shift 2
      ;;
    --skip-apt)
      SKIP_APT=true
      shift
      ;;
    --skip-docker-check)
      SKIP_DOCKER_CHECK=true
      shift
      ;;
    --execute)
      EXECUTE=true
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
[ -n "$REPO_URL" ] || { echo "Missing required --repo-url" >&2; usage >&2; exit 2; }
[ -n "$BRANCH" ] || { echo "Missing required --branch" >&2; usage >&2; exit 2; }
assert_pi_ssh_target "$HOST" "$REMOTE_USER"

TARGET="$REMOTE_USER@$HOST"

emit_remote_script() {
  cat <<'REMOTE'
set -euo pipefail

PROJECT_ROOT="$1"
SECOND_BRAIN_ROOT="$2"
CODEX_PROJECTS_ROOT="$3"
RCLONE_REMOTE="$4"
REPO_URL="$5"
BRANCH="$6"
SKIP_APT="$7"
SKIP_DOCKER_CHECK="$8"
DOCKER_STATUS="not_checked"

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

have() {
  command -v "$1" >/dev/null 2>&1
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    echo "sudo is required for: $*" >&2
    exit 1
  fi
}

PROJECT_ROOT="$(expand_remote_path "$PROJECT_ROOT")"
SECOND_BRAIN_ROOT="$(expand_remote_path "$SECOND_BRAIN_ROOT")"
CODEX_PROJECTS_ROOT="$(expand_remote_path "$CODEX_PROJECTS_ROOT")"

echo "== Distributed Cognition Pi Bootstrap =="
echo "time: $(date '+%d-%m-%y, %H:%M %Z')"
echo "host: $(hostname)"
echo "kernel: $(uname -a)"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  echo "os: ${PRETTY_NAME:-unknown}"
fi

case "$(uname -m)" in
  aarch64|arm64)
    echo "OK - 64-bit ARM architecture"
    ;;
  armv7l|armv6l)
    echo "WARN - 32-bit ARM detected; prefer 64-bit Raspberry Pi OS for a new install"
    ;;
  *)
    echo "WARN - unexpected architecture: $(uname -m)"
    ;;
esac

echo
echo "== OS Packages =="
if [ "$SKIP_APT" = "true" ]; then
  echo "SKIP - apt package installation"
else
  if have apt-get; then
    run_sudo apt-get update
    run_sudo apt-get install -y git curl tar build-essential python3 make g++ sqlite3 rclone
  elif have apt; then
    run_sudo apt update
    run_sudo apt install -y git curl tar build-essential python3 make g++ sqlite3 rclone
  else
    echo "WARN - apt not found; install git curl tar build-essential python3 make g++ sqlite3 rclone manually"
  fi
fi

echo
echo "== Repo =="
mkdir -p "$(dirname "$PROJECT_ROOT")"
if [ -d "$PROJECT_ROOT/.git" ]; then
  cd "$PROJECT_ROOT"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
elif [ -e "$PROJECT_ROOT" ]; then
  echo "NanoClaw path exists but is not a git checkout: $PROJECT_ROOT" >&2
  exit 1
else
  git clone --branch "$BRANCH" "$REPO_URL" "$PROJECT_ROOT"
  cd "$PROJECT_ROOT"
fi
echo "repo: $(pwd)"
echo "commit: $(git rev-parse --short HEAD)"

echo
echo "== Distributed Cognition Folders =="
mkdir -p "$SECOND_BRAIN_ROOT"
for folder in \
  inbox-whatsapp \
  daily-reflections \
  processed-notes \
  pending-review \
  approved-updates \
  project-wikis \
  decision-log \
  open-questions \
  argument-bank \
  weekly-reviews \
  audio-transcripts \
  mnemon \
  dashboard \
  queues \
  codex-handoffs \
  provenance \
  ledgers \
  context-indexes \
  evals
do
  mkdir -p "$SECOND_BRAIN_ROOT/$folder"
done
touch "$SECOND_BRAIN_ROOT/.nanoclaw-pi-bootstrap-write-test"
rm -f "$SECOND_BRAIN_ROOT/.nanoclaw-pi-bootstrap-write-test"
echo "second_brain_root: $SECOND_BRAIN_ROOT"

if [ -n "$CODEX_PROJECTS_ROOT" ]; then
  mkdir -p "$CODEX_PROJECTS_ROOT"
  echo "codex_projects_root: $CODEX_PROJECTS_ROOT"
fi

echo
echo "== Node / NanoClaw Build =="
bash setup.sh
pnpm run build

echo
echo "== Systemd Dry Render =="
bash scripts/pi-install-systemd.sh --output-dir /tmp/nanoclaw-systemd-check
ls -1 /tmp/nanoclaw-systemd-check/nanoclaw-v2-*.service

echo
echo "== Docker =="
if [ "$SKIP_DOCKER_CHECK" = "true" ]; then
  DOCKER_STATUS="skipped"
  echo "SKIP - Docker check"
elif ! have docker; then
  DOCKER_STATUS="needs_install"
  cat <<'DOCKER'
ACTION NEEDED - Docker is not installed.
Install Docker using Docker's current Raspberry Pi instructions, then run:
  sudo usermod -aG docker "$USER"
  newgrp docker
  docker run hello-world
DOCKER
elif docker info >/dev/null 2>&1; then
  DOCKER_STATUS="ok"
  echo "OK - docker is reachable without sudo"
else
  DOCKER_STATUS="needs_permission"
  cat <<'DOCKER'
ACTION NEEDED - Docker is installed but not reachable without sudo.
Run:
  sudo usermod -aG docker "$USER"
Then log out and back in, or run:
  newgrp docker
DOCKER
fi

echo
echo "== Optional rclone =="
if [ -n "$RCLONE_REMOTE" ]; then
  if have rclone && rclone lsd "$RCLONE_REMOTE" >/dev/null 2>&1; then
    echo "OK - rclone remote is reachable: $RCLONE_REMOTE"
  else
    echo "WARN - rclone remote not reachable yet: $RCLONE_REMOTE"
    echo "Run rclone config on the Pi before installing the Dropbox sync timer."
  fi
fi

echo
echo "== Next Commands From The Mac =="
REMOTE_LOGIN_USER="${USER:-$(whoami)}"
REMOTE_HOSTNAME="$(hostname)"
cat <<NEXT
pnpm run pi:ssh-preflight
pnpm run pi:ssh-admin -- status

After final Mac export:
  scp "\$HOME/Desktop/dc-pi-migration"/nanoclaw-pi-state-*.tar.gz $REMOTE_LOGIN_USER@$REMOTE_HOSTNAME:~
  scp "\$HOME/Desktop/dc-pi-migration"/nanoclaw-pi-state-*.sha256 $REMOTE_LOGIN_USER@$REMOTE_HOSTNAME:~

Then import state on the Pi, install rclone sync if needed, and install/start systemd.
NEXT

case "$DOCKER_STATUS" in
  ok|skipped)
    echo "PI_SSH_BOOTSTRAP=ready"
    ;;
  *)
    echo "PI_SSH_BOOTSTRAP=needs_docker"
    ;;
esac
REMOTE
}

print_summary() {
  echo "Target: $TARGET"
  echo "NanoClaw path: $REMOTE_PROJECT_ROOT"
  echo "Second brain root: $SECOND_BRAIN_ROOT"
  [ -n "$CODEX_PROJECTS_ROOT" ] && echo "Codex projects root: $CODEX_PROJECTS_ROOT"
  echo "Repo URL: $REPO_URL"
  echo "Branch: $BRANCH"
  [ -n "$RCLONE_REMOTE" ] && echo "Expected rclone remote: $RCLONE_REMOTE"
  [ -n "$SSH_CONNECT_TIMEOUT" ] && echo "SSH connect timeout: ${SSH_CONNECT_TIMEOUT}s"
  echo "Skip apt: $SKIP_APT"
  echo "Skip Docker check: $SKIP_DOCKER_CHECK"
}

if [ "$EXECUTE" != "true" ]; then
  echo "PI_SSH_BOOTSTRAP=dry_run"
  print_summary
  cat <<EOF

This was a dry run. No SSH connection was opened and the Pi was not changed.
To execute the bootstrap, rerun:
EOF
  echo "  pnpm run pi:ssh-bootstrap -- \\"
  printf '    --host %s \\\n' "$(shell_quote "$HOST")"
  printf '    --user %s \\\n' "$(shell_quote "$REMOTE_USER")"
  printf '    --path %s \\\n' "$(shell_quote "$REMOTE_PROJECT_ROOT")"
  printf '    --second-brain-root %s \\\n' "$(shell_quote "$SECOND_BRAIN_ROOT")"
  [ -n "$CODEX_PROJECTS_ROOT" ] && printf '    --codex-projects-root %s \\\n' "$(shell_quote "$CODEX_PROJECTS_ROOT")"
  printf '    --repo-url %s \\\n' "$(shell_quote "$REPO_URL")"
  printf '    --branch %s \\\n' "$(shell_quote "$BRANCH")"
  [ -n "$RCLONE_REMOTE" ] && printf '    --rclone-remote %s \\\n' "$(shell_quote "$RCLONE_REMOTE")"
  [ "$SKIP_APT" = "true" ] && printf '    --skip-apt \\\n'
  [ "$SKIP_DOCKER_CHECK" = "true" ] && printf '    --skip-docker-check \\\n'
  printf '    --execute\n\n'
  echo "Remote script that would be sent to $TARGET:"
  emit_remote_script
  exit 0
fi

echo "PI_SSH_BOOTSTRAP=execute"
print_summary
echo

emit_remote_script | ssh "${SSH_OPTIONS[@]}" "$TARGET" 'bash -s' -- \
  "$REMOTE_PROJECT_ROOT" \
  "$SECOND_BRAIN_ROOT" \
  "$CODEX_PROJECTS_ROOT" \
  "$RCLONE_REMOTE" \
  "$REPO_URL" \
  "$BRANCH" \
  "$SKIP_APT" \
  "$SKIP_DOCKER_CHECK"
