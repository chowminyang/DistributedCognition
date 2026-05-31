#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_SECOND_BRAIN_ROOT="${DC_SECOND_BRAIN_ROOT:-}"
OUT_DIR="$HOME/Desktop/dc-pi-migration"
PI_HOST="${NANOCLAW_PI_HOST:-${PI_HOST:-}}"
PI_USER="${NANOCLAW_PI_USER:-${PI_USER:-}}"
PI_PROJECT_ROOT="${NANOCLAW_PI_PROJECT_ROOT:-}"
PI_SECOND_BRAIN_ROOT="${NANOCLAW_PI_SECOND_BRAIN_ROOT:-}"
PI_CODEX_PROJECTS_ROOT="${NANOCLAW_PI_CODEX_PROJECTS_ROOT:-}"
PI_RCLONE_REMOTE="${NANOCLAW_PI_RCLONE_REMOTE:-dropbox:}"
PI_UNIT_NAME="${NANOCLAW_PI_UNIT_NAME:-}"
REPO_URL="<repo-url>"
STRICT="false"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-cutover-plan.sh [options]

Prints a Raspberry Pi migration checklist for the intended architecture:
Codex on the Mac controls the Pi over SSH, while Distributed Cognition runs
fully on the Pi after cutover.

This script is read-only. It does not SSH, stop services, copy files, install
packages, start systemd units, or inspect secrets.

Options:
  --local-root <path>             Mac Distributed-Cognition folder.
  --out-dir <path>                Mac export output directory.
                                  Default: ~/Desktop/dc-pi-migration
  --pi-host <host>                Pi host or IP, for example nanoclaw-pi.local.
  --pi-user <user>                SSH user, for example pi.
  --pi-path <path>                NanoClaw checkout path on the Pi.
  --pi-second-brain-root <path>   Distributed-Cognition folder on the Pi.
  --pi-codex-projects-root <path> Codex projects folder on the Pi.
  --pi-rclone-remote <name:>      rclone remote name. Default: dropbox:.
  --pi-unit-name <name>           Optional NanoClaw systemd unit name.
  --repo-url <url>                Repository URL to clone on the Pi.
  --strict                        Exit non-zero if required values are missing.
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
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

quote_shell() {
  printf "%q" "$1"
}

is_missing_or_placeholder() {
  local value="$1"
  [ -z "$value" ] && return 0
  [[ "$value" == *"<"* || "$value" == *">"* ]] && return 0
  return 1
}

missing=()

require_value() {
  local label="$1"
  local value="$2"
  if is_missing_or_placeholder "$value"; then
    missing+=("$label")
  fi
}

section() {
  printf '\n== %s ==\n' "$1"
}

print_command() {
  printf '  %s\n' "$*"
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
    --repo-url)
      REPO_URL="${2:-}"
      [ -n "$REPO_URL" ] || { echo "Missing value for --repo-url" >&2; exit 2; }
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

LOCAL_SECOND_BRAIN_ROOT="$(expand_local_path "$LOCAL_SECOND_BRAIN_ROOT")"
OUT_DIR="$(expand_local_path "$OUT_DIR")"

require_value "Mac Distributed-Cognition folder (--local-root or DC_SECOND_BRAIN_ROOT)" "$LOCAL_SECOND_BRAIN_ROOT"
require_value "Pi host (--pi-host or NANOCLAW_PI_HOST)" "$PI_HOST"
require_value "Pi SSH user (--pi-user or NANOCLAW_PI_USER)" "$PI_USER"
require_value "Pi NanoClaw path (--pi-path or NANOCLAW_PI_PROJECT_ROOT)" "$PI_PROJECT_ROOT"
require_value "Pi Distributed-Cognition path (--pi-second-brain-root or NANOCLAW_PI_SECOND_BRAIN_ROOT)" "$PI_SECOND_BRAIN_ROOT"
require_value "Pi Codex projects path (--pi-codex-projects-root or NANOCLAW_PI_CODEX_PROJECTS_ROOT)" "$PI_CODEX_PROJECTS_ROOT"
require_value "Repository URL (--repo-url)" "$REPO_URL"

cat <<EOF
Distributed Cognition Raspberry Pi Cutover Plan

Architecture:
  - Mac Codex remains the control plane and uses SSH for Pi operations.
  - Distributed Cognition runs fully on the Raspberry Pi after cutover.
  - The Mac NanoClaw host must stay stopped after the final state export.
  - Dropbox sync stays outside NanoClaw, through rclone or another external sync.
  - Only the selected Distributed-Cognition folder should sync to Dropbox.

Current values:
  Mac project: $PROJECT_ROOT
  Mac second brain: ${LOCAL_SECOND_BRAIN_ROOT:-<missing>}
  Mac export dir: $OUT_DIR
  Pi SSH target: ${PI_USER:-<missing>}@${PI_HOST:-<missing>}
  Pi NanoClaw path: ${PI_PROJECT_ROOT:-<missing>}
  Pi second brain: ${PI_SECOND_BRAIN_ROOT:-<missing>}
  Pi Codex projects: ${PI_CODEX_PROJECTS_ROOT:-<optional-not-set>}
  Pi rclone remote: ${PI_RCLONE_REMOTE:-<optional-not-set>}
  Pi systemd unit: ${PI_UNIT_NAME:-<auto-detect>}
  Repo URL: $REPO_URL
EOF

if [ "${#missing[@]}" -gt 0 ]; then
  section "Missing Values"
  for item in "${missing[@]}"; do
    printf '  - %s\n' "$item"
  done
fi

section "0. Rehearsal On Mac"
print_command "cd $(quote_shell "$PROJECT_ROOT")"
print_command "pnpm install --frozen-lockfile"
print_command "pnpm run build"
print_command "pnpm test"
if [ -n "$LOCAL_SECOND_BRAIN_ROOT" ]; then
  print_command "pnpm run dc:health -- --root $(quote_shell "$LOCAL_SECOND_BRAIN_ROOT")"
  print_command "pnpm run pi:mac-preflight -- --root $(quote_shell "$LOCAL_SECOND_BRAIN_ROOT") --out-dir $(quote_shell "$OUT_DIR")"
else
  print_command "pnpm run dc:health -- --root <mac Distributed-Cognition folder>"
  print_command "pnpm run pi:mac-preflight -- --root <mac Distributed-Cognition folder> --out-dir $(quote_shell "$OUT_DIR")"
fi

section "1. Prepare Pi"
print_command "ssh ${PI_USER:-<pi-user>}@${PI_HOST:-<pi-host>}"
print_command "sudo apt update"
print_command "sudo apt full-upgrade -y"
print_command "sudo apt install -y git curl build-essential python3 make g++ sqlite3 rclone"
print_command "# Install Docker from Docker's Raspberry Pi instructions, then:"
print_command "sudo usermod -aG docker \"\$USER\""
print_command "newgrp docker"
print_command "docker run hello-world"
print_command "git clone $(quote_shell "$REPO_URL") $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}")"
print_command "cd $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}")"
print_command "bash setup.sh"
print_command "pnpm run build"

section "2. Mac-To-Pi SSH Preflight"
if [ -n "$PI_CODEX_PROJECTS_ROOT" ]; then
  print_command "export NANOCLAW_PI_CODEX_PROJECTS_ROOT=$(quote_shell "$PI_CODEX_PROJECTS_ROOT")"
fi
print_command "export NANOCLAW_PI_HOST=$(quote_shell "${PI_HOST:-<pi-host>}")"
print_command "export NANOCLAW_PI_USER=$(quote_shell "${PI_USER:-<pi-user>}")"
print_command "export NANOCLAW_PI_PROJECT_ROOT=$(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}")"
print_command "export NANOCLAW_PI_SECOND_BRAIN_ROOT=$(quote_shell "${PI_SECOND_BRAIN_ROOT:-<pi Distributed-Cognition path>}")"
print_command "export NANOCLAW_PI_RCLONE_REMOTE=$(quote_shell "$PI_RCLONE_REMOTE")"
print_command 'export NANOCLAW_PI_EXPECTED_COMMIT="$(git rev-parse HEAD)"'
print_command "pnpm run pi:ssh-preflight"

section "3. Final Mac Cutover And State Export"
print_command "cd $(quote_shell "$PROJECT_ROOT")"
print_command "pnpm run dc:install-launchd -- uninstall"
print_command "pnpm run dc:stop-host -- --execute"
if [ -n "$LOCAL_SECOND_BRAIN_ROOT" ]; then
  print_command "pnpm run pi:mac-preflight -- --root $(quote_shell "$LOCAL_SECOND_BRAIN_ROOT") --out-dir $(quote_shell "$OUT_DIR") --require-stopped"
else
  print_command "pnpm run pi:mac-preflight -- --root <mac Distributed-Cognition folder> --out-dir $(quote_shell "$OUT_DIR") --require-stopped"
fi
print_command "pnpm run pi:export -- --out-dir $(quote_shell "$OUT_DIR")"

section "4. Restore State From Mac"
print_command "STATE_BUNDLE=\"\$(ls -t $(quote_shell "$OUT_DIR")/nanoclaw-pi-state-*.tar.gz | head -n 1)\""
print_command "pnpm run pi:ssh-restore-state -- --host $(quote_shell "${PI_HOST:-<pi-host>}") --user $(quote_shell "${PI_USER:-<pi-user>}") --path $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}") --bundle \"\$STATE_BUNDLE\" --force --cleanup-remote"
print_command "# If the dry run is correct, rerun the same command with --execute."

if [ -n "$PI_CODEX_PROJECTS_ROOT" ]; then
  start_runtime_cmd="pnpm run pi:ssh-start-runtime -- --host $(quote_shell "${PI_HOST:-<pi-host>}") --user $(quote_shell "${PI_USER:-<pi-user>}") --path $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}") --second-brain-root $(quote_shell "${PI_SECOND_BRAIN_ROOT:-<pi Distributed-Cognition path>}") --codex-projects-root $(quote_shell "$PI_CODEX_PROJECTS_ROOT") --rclone-remote $(quote_shell "$PI_RCLONE_REMOTE")"
else
  start_runtime_cmd="pnpm run pi:ssh-start-runtime -- --host $(quote_shell "${PI_HOST:-<pi-host>}") --user $(quote_shell "${PI_USER:-<pi-user>}") --path $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}") --second-brain-root $(quote_shell "${PI_SECOND_BRAIN_ROOT:-<pi Distributed-Cognition path>}") --codex-projects-root <pi Codex projects path> --rclone-remote $(quote_shell "$PI_RCLONE_REMOTE")"
fi
if [ -n "$PI_UNIT_NAME" ]; then
  start_runtime_cmd="$start_runtime_cmd --unit-name $(quote_shell "$PI_UNIT_NAME")"
fi
section "5. Configure Pi Sync And Service"
print_command "$start_runtime_cmd"
print_command "# The --execute path refuses to start while the Mac NanoClaw host appears to be running."
print_command "# This also installs Pi bridge timers in dry-run mode by default. Add --execute-bridges only when queued bridge work should execute automatically on the Pi."
print_command "# If the dry run is correct, rerun the same command with --execute."

section "6. Smoke Test From Mac"
if [ -n "$PI_UNIT_NAME" ]; then
  print_command "export NANOCLAW_PI_UNIT_NAME=$(quote_shell "$PI_UNIT_NAME")"
fi
print_command "PROOF_TEXT=\"DC Pi cutover proof \$(date '+%d-%m-%y-%H%M')\""
print_command 'pnpm run pi:ssh-admin -- status --expected-commit "$NANOCLAW_PI_EXPECTED_COMMIT"'
print_command "pnpm run pi:ssh-admin -- health"
print_command 'pnpm run pi:ssh-admin -- doctor --expected-commit "$NANOCLAW_PI_EXPECTED_COMMIT"'
print_command "pnpm run pi:ssh-admin -- dashboard"
print_command "pnpm run pi:ssh-admin -- logs --lines 80"
if [ -n "$LOCAL_SECOND_BRAIN_ROOT" ]; then
  print_command "pnpm run pi:verify-cutover -- --local-root $(quote_shell "$LOCAL_SECOND_BRAIN_ROOT") --host $(quote_shell "${PI_HOST:-<pi-host>}") --user $(quote_shell "${PI_USER:-<pi-user>}") --path $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}") --second-brain-root $(quote_shell "${PI_SECOND_BRAIN_ROOT:-<pi Distributed-Cognition path>}") --expected-commit \"\$NANOCLAW_PI_EXPECTED_COMMIT\" --execute"
else
  print_command "pnpm run pi:verify-cutover -- --local-root <mac Distributed-Cognition folder> --host $(quote_shell "${PI_HOST:-<pi-host>}") --user $(quote_shell "${PI_USER:-<pi-user>}") --path $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}") --second-brain-root $(quote_shell "${PI_SECOND_BRAIN_ROOT:-<pi Distributed-Cognition path>}") --expected-commit \"\$NANOCLAW_PI_EXPECTED_COMMIT\" --execute"
fi

section "7. WhatsApp Test"
cat <<'EOF'
  From the allowed personal WhatsApp chat, send:
    DC, run a health check.
    DC, what can you see in the second-brain folder?
    DC, capture this as Pi cutover proof: <value of PROOF_TEXT>

  Confirm:
    - DC replies from the Pi.
    - New raw and processed Markdown files land in the Pi second-brain folder.
    - rclone copies those files to the selected Dropbox folder.
    - The Mac host remains stopped.
EOF
if [ -n "$LOCAL_SECOND_BRAIN_ROOT" ]; then
  print_command "pnpm run pi:verify-cutover -- --local-root $(quote_shell "$LOCAL_SECOND_BRAIN_ROOT") --host $(quote_shell "${PI_HOST:-<pi-host>}") --user $(quote_shell "${PI_USER:-<pi-user>}") --path $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}") --second-brain-root $(quote_shell "${PI_SECOND_BRAIN_ROOT:-<pi Distributed-Cognition path>}") --expected-commit \"\$NANOCLAW_PI_EXPECTED_COMMIT\" --proof-text \"\$PROOF_TEXT\" --proof-since-minutes 30 --execute"
else
  print_command "pnpm run pi:verify-cutover -- --local-root <mac Distributed-Cognition folder> --host $(quote_shell "${PI_HOST:-<pi-host>}") --user $(quote_shell "${PI_USER:-<pi-user>}") --path $(quote_shell "${PI_PROJECT_ROOT:-<pi NanoClaw path>}") --second-brain-root $(quote_shell "${PI_SECOND_BRAIN_ROOT:-<pi Distributed-Cognition path>}") --expected-commit \"\$NANOCLAW_PI_EXPECTED_COMMIT\" --proof-text \"\$PROOF_TEXT\" --proof-since-minutes 30 --execute"
fi

section "8. Post-Cutover Bridge Work"
cat <<'EOF'
  Default for the Pi migration: keep the Mac NanoClaw/WhatsApp host stopped and
  use Mac Codex only as an SSH operator. The Pi bridge timers handle queued
  Mnemon, Codex, and action work periodically; run one manual check:
EOF
if [ -n "$LOCAL_SECOND_BRAIN_ROOT" ]; then
  print_command "pnpm run pi:ssh-admin -- process-bridges"
  print_command "pnpm run pi:ssh-admin -- process-bridges --execute-bridges"
else
  print_command "pnpm run pi:ssh-admin -- process-bridges"
  print_command "pnpm run pi:ssh-admin -- process-bridges --execute-bridges"
fi
cat <<'EOF'

  Optional tradeoff: if you specifically need Codex Desktop/App-visible local
  handoff work on the Mac, you may install only the Mac bridge launchd jobs
  after the Pi WhatsApp runtime is proven. Do not restart the Mac NanoClaw host.
EOF

section "Rollback"
print_command "ssh ${PI_USER:-<pi-user>}@${PI_HOST:-<pi-host>} \"sudo systemctl stop 'nanoclaw-v2-*.service'\""
print_command "# Then intentionally restart the Mac service only if you are rolling back."

if [ "${#missing[@]}" -gt 0 ]; then
  echo
  echo "CUTOVER_PLAN=missing_values count=${#missing[@]}"
  if [ "$STRICT" = "true" ]; then
    exit 1
  fi
else
  echo
  echo "CUTOVER_PLAN=ready"
fi
