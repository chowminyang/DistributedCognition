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
REPO_URL="${NANOCLAW_PI_REPO_URL:-https://github.com/chowminyang/DistributedCognition.git}"
BRANCH="${NANOCLAW_PI_BRANCH:-main}"
MIGRATION_DATE="${NANOCLAW_PI_MIGRATION_DATE:-02-06-26}"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-codex-goal.sh [options]

Prints a paste-ready /goal prompt for Codex on the Mac to control the
Raspberry Pi over SSH while moving Distributed Cognition to run fully on the Pi.

This script is read-only. It does not SSH, stop services, copy files, inspect
secrets, or mutate state.

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
  --branch <name>                 Branch to use on the Pi. Default: main.
  --migration-date <DD-MM-YY>     Planned migration date. Default: 02-06-26.
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
  NANOCLAW_PI_REPO_URL
  NANOCLAW_PI_BRANCH
  NANOCLAW_PI_MIGRATION_DATE
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

value_or_placeholder() {
  local value="$1"
  local placeholder="$2"
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    printf '<%s>\n' "$placeholder"
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

MAC_SECOND_BRAIN_DISPLAY="$(value_or_placeholder "$LOCAL_SECOND_BRAIN_ROOT" "Mac Distributed-Cognition folder")"
PI_HOST_DISPLAY="$(value_or_placeholder "$PI_HOST" "Pi host or IP")"
PI_USER_DISPLAY="$(value_or_placeholder "$PI_USER" "Pi SSH user")"
PI_PROJECT_DISPLAY="$(value_or_placeholder "$PI_PROJECT_ROOT" "Pi NanoClaw checkout path")"
PI_SECOND_BRAIN_DISPLAY="$(value_or_placeholder "$PI_SECOND_BRAIN_ROOT" "Pi Distributed-Cognition path")"
PI_CODEX_DISPLAY="$(value_or_placeholder "$PI_CODEX_PROJECTS_ROOT" "Pi Codex projects path")"
PI_UNIT_DISPLAY="$(value_or_placeholder "$PI_UNIT_NAME" "auto-detect")"

cat <<EOF
/goal

Migrate Distributed Cognition from my Mac to my Raspberry Pi on ${MIGRATION_DATE}, with Codex on my Mac controlling the Pi over SSH and Distributed Cognition running fully on the Pi after cutover.

Current architecture:
- Mac Codex is the control plane.
- Raspberry Pi is the final always-on Distributed Cognition runtime.
- After cutover, the Mac NanoClaw host must remain stopped unless I explicitly roll back.
- WhatsApp/Baileys must run from only one host at a time.
- Dropbox sync must remain outside NanoClaw, using rclone or another external sync method.
- Do not sync or expose .env, store/auth, data/v2.db, WhatsApp auth, API keys, or other runtime secrets.

Repo and paths:
- Mac NanoClaw repo: ${PROJECT_ROOT}
- Mac Distributed-Cognition folder: ${MAC_SECOND_BRAIN_DISPLAY}
- Mac export directory: ${OUT_DIR}
- Pi SSH target: ${PI_USER_DISPLAY}@${PI_HOST_DISPLAY}
- Pi NanoClaw path: ${PI_PROJECT_DISPLAY}
- Pi Distributed-Cognition folder: ${PI_SECOND_BRAIN_DISPLAY}
- Pi Codex projects folder: ${PI_CODEX_DISPLAY}
- Pi rclone remote: ${PI_RCLONE_REMOTE}
- Pi systemd unit: ${PI_UNIT_DISPLAY}
- Public repo: ${REPO_URL}
- Branch: ${BRANCH}

Rules:
- Inspect current state first; do not assume the Pi paths or env values are correct.
- Use the repo's helper scripts before ad hoc shell work.
- Never print or commit secrets.
- Do not run the final Mac stop/export/import/start cutover until you have shown me the plan and I confirm.
- Keep all final runtime state on the Pi; after cutover, verify DC is replying from the Pi.
- If WhatsApp auth restoration fails, keep the same private-mode settings and ask me to re-pair on the Pi.

Work plan:
1. On the Mac, inspect repo status and verify the public branch is current.
   Set the expected Pi runtime version from the current Mac checkout:
   EXPECTED_COMMIT="\$(git rev-parse HEAD)"
2. Generate and show the read-only cutover plan:
   pnpm run pi:cutover-plan -- \\
     --local-root "${MAC_SECOND_BRAIN_DISPLAY}" \\
     --out-dir "${OUT_DIR}" \\
     --pi-host "${PI_HOST_DISPLAY}" \\
     --pi-user "${PI_USER_DISPLAY}" \\
     --pi-path "${PI_PROJECT_DISPLAY}" \\
     --pi-second-brain-root "${PI_SECOND_BRAIN_DISPLAY}" \\
     --pi-codex-projects-root "${PI_CODEX_DISPLAY}" \\
     --repo-url "${REPO_URL}"
3. Run the Pi SSH bootstrap first as a dry run:
   pnpm run pi:ssh-bootstrap -- \\
     --host "${PI_HOST_DISPLAY}" \\
     --user "${PI_USER_DISPLAY}" \\
     --path "${PI_PROJECT_DISPLAY}" \\
     --second-brain-root "${PI_SECOND_BRAIN_DISPLAY}" \\
     --codex-projects-root "${PI_CODEX_DISPLAY}" \\
     --repo-url "${REPO_URL}" \\
     --branch "${BRANCH}"
4. If the dry-run output is correct and I approve, rerun the bootstrap with --execute.
5. Run:
   pnpm run pi:ssh-preflight
6. Before final cutover, stop Mac launchd and host only after I confirm:
   pnpm run dc:install-launchd -- uninstall
   pnpm run dc:stop-host -- --execute
7. Run Mac export preflight and export the secret state bundle:
   pnpm run pi:mac-preflight -- --root "${MAC_SECOND_BRAIN_DISPLAY}" --out-dir "${OUT_DIR}" --require-stopped
   pnpm run pi:export -- --out-dir "${OUT_DIR}"
8. Restore the final state bundle from the Mac control plane using the dry-run helper first:
   STATE_BUNDLE="\$(ls -t "${OUT_DIR}"/nanoclaw-pi-state-*.tar.gz | head -n 1)"
   pnpm run pi:inspect-state-bundle -- --bundle "\$STATE_BUNDLE"
   pnpm run pi:ssh-restore-state -- --host "${PI_HOST_DISPLAY}" --user "${PI_USER_DISPLAY}" --path "${PI_PROJECT_DISPLAY}" --bundle "\$STATE_BUNDLE" --force --cleanup-remote
   If the dry run is correct, rerun the same command with --execute. This must verify sha256 on the Pi before importing.
9. Configure rclone sync, update Docker mount access, install/start systemd, install/start Pi bridge timers, and run health using the dry-run helper first:
   pnpm run pi:ssh-start-runtime -- --host "${PI_HOST_DISPLAY}" --user "${PI_USER_DISPLAY}" --path "${PI_PROJECT_DISPLAY}" --second-brain-root "${PI_SECOND_BRAIN_DISPLAY}" --codex-projects-root "${PI_CODEX_DISPLAY}" --rclone-remote "${PI_RCLONE_REMOTE}"
   If the dry run is correct, rerun the same command with --execute. The execute path must refuse to start while the Mac NanoClaw host is still running, unless I explicitly approve rollback/emergency override.
10. Verify from the Mac:
   pnpm run pi:ssh-admin -- status --expected-commit "\$EXPECTED_COMMIT"
   pnpm run pi:ssh-admin -- health
   pnpm run pi:ssh-admin -- dashboard
   pnpm run pi:ssh-admin -- logs --lines 80
11. Gather the post-cutover verification bundle:
   pnpm run pi:verify-cutover -- \\
     --local-root "${MAC_SECOND_BRAIN_DISPLAY}" \\
     --host "${PI_HOST_DISPLAY}" \\
     --user "${PI_USER_DISPLAY}" \\
     --path "${PI_PROJECT_DISPLAY}" \\
     --second-brain-root "${PI_SECOND_BRAIN_DISPLAY}" \\
     --expected-commit "\$EXPECTED_COMMIT" \\
     --execute
12. Run a live WhatsApp smoke test from my allowed personal chat, using one unique harmless proof phrase:
   PROOF_TEXT="DC Pi cutover proof \$(date '+%d-%m-%y-%H%M')"
   DC, run a health check.
   DC, what can you see in the second-brain folder?
   DC, capture this as Pi cutover proof: <value of PROOF_TEXT>
   Then prove that the capture landed in the Pi second-brain folder:
   pnpm run pi:verify-cutover -- \\
     --local-root "${MAC_SECOND_BRAIN_DISPLAY}" \\
     --host "${PI_HOST_DISPLAY}" \\
     --user "${PI_USER_DISPLAY}" \\
     --path "${PI_PROJECT_DISPLAY}" \\
     --second-brain-root "${PI_SECOND_BRAIN_DISPLAY}" \\
     --expected-commit "\$EXPECTED_COMMIT" \\
     --proof-text "\$PROOF_TEXT" \\
     --proof-since-minutes 30 \\
     --execute
13. After WhatsApp is proven to be replying from the Pi, keep the Mac NanoClaw host stopped. Confirm Pi bridge timers are installed, then process DC bridge work on the Pi with one manual bridge dry-run/execution from Mac Codex over SSH:
   pnpm run pi:ssh-admin -- status --expected-commit "\$EXPECTED_COMMIT"
   pnpm run pi:ssh-admin -- process-bridges
   pnpm run pi:ssh-admin -- process-bridges --execute-bridges
   Do not restart the Mac NanoClaw/WhatsApp host unless I explicitly roll back. If I later choose Mac-visible Codex Desktop/App handoffs, explain the tradeoff and install only the Mac bridge jobs, never the Mac WhatsApp host.

Completion evidence required:
- Pi SSH bootstrap succeeds or gives clear remaining actions.
- Pi preflight succeeds, or every warning is explicitly accounted for.
- Final exported state bundle sha256 verifies before import.
- Final exported state bundle passes pnpm run pi:inspect-state-bundle.
- Pi systemd service is enabled and active.
- Pi status proves the checkout is running the expected commit from the Mac cutover thread.
- Pi bridge timers are installed and visible from pnpm run pi:ssh-admin -- status.
- Mac NanoClaw host remains stopped after cutover.
- The post-cutover verification helper writes a clean verification bundle.
- DC replies on WhatsApp from the Pi.
- The proof phrase from the live WhatsApp test is found in recent Pi second-brain files by running pnpm run pi:verify-cutover -- --proof-text ... --execute.
- A raw note and processed note are created in the Pi Distributed-Cognition folder.
- rclone sync is configured for only the selected Distributed-Cognition folder.
- DC bridge work is either processed on the Pi through pnpm run pi:ssh-admin -- process-bridges, or Mac bridge jobs are intentionally enabled only after I accept the Mac-visible Codex handoff tradeoff.
- No secrets are printed, committed, or synced to Dropbox.
- Rollback command is documented before the final switch.

Do not mark the goal complete until all completion evidence above is verified.
EOF
