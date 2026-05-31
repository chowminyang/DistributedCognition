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
STRICT="false"
REHEARSAL_DIR=""

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-rehearse-cutover.sh [options]

Creates a non-mutating Raspberry Pi cutover rehearsal bundle for Codex on the
Mac to review before controlling the Pi over SSH. The bundle contains:
  - codex-goal.md
  - cutover-plan.txt
  - ssh-bootstrap-dry-run.txt, or a skipped bootstrap note when values are missing
  - summary.md

This script does not SSH, stop services, copy files, inspect secrets, export
state, import state, or touch WhatsApp runtime state.

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
  --output-dir <path>             Exact rehearsal bundle directory.
                                  Default: output/pi-cutover-rehearsal/DD-MM-YY-HHMM
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

missing=()
failures=()
bootstrap_missing=()

require_value() {
  local label="$1"
  local value="$2"
  if is_missing_or_placeholder "$value"; then
    missing+=("$label")
  fi
}

require_bootstrap_value() {
  local label="$1"
  local value="$2"
  if is_missing_or_placeholder "$value"; then
    bootstrap_missing+=("$label")
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

write_bootstrap_skipped() {
  local output_file="$1"
  {
    printf '# Pi SSH Bootstrap Dry Run\n\n'
    printf 'Skipped because required Pi SSH values are missing.\n\n'
    printf 'No SSH was opened. No WhatsApp/runtime state was changed.\n\n'
    printf 'Missing values:\n'
    for item in "${bootstrap_missing[@]}"; do
      printf -- '- %s\n' "$item"
    done
  } >"$output_file"
}

write_summary() {
  local summary_file="$1"
  local status="$2"
  {
    printf '# Distributed Cognition Pi Cutover Rehearsal\n\n'
    printf 'Status: `%s`\n\n' "$status"
    printf 'Generated: `%s`\n\n' "$(date '+%d-%m-%y, %H:%M')"
    printf 'Bundle path: `%s`\n\n' "$REHEARSAL_DIR"
    printf 'No SSH was opened. No WhatsApp/runtime state was changed.\n\n'
    printf '## Values\n\n'
    printf -- '- Mac repo: `%s`\n' "$PROJECT_ROOT"
    printf -- '- Mac Distributed-Cognition folder: `%s`\n' "${LOCAL_SECOND_BRAIN_ROOT:-<missing>}"
    printf -- '- Mac export directory: `%s`\n' "$OUT_DIR"
    printf -- '- Pi SSH target: `%s@%s`\n' "${PI_USER:-<missing>}" "${PI_HOST:-<missing>}"
    printf -- '- Pi NanoClaw path: `%s`\n' "${PI_PROJECT_ROOT:-<missing>}"
    printf -- '- Pi Distributed-Cognition folder: `%s`\n' "${PI_SECOND_BRAIN_ROOT:-<missing>}"
    printf -- '- Pi Codex projects folder: `%s`\n' "${PI_CODEX_PROJECTS_ROOT:-<optional-not-set>}"
    printf -- '- Pi rclone remote: `%s`\n' "${PI_RCLONE_REMOTE:-<optional-not-set>}"
    printf -- '- Pi systemd unit: `%s`\n' "${PI_UNIT_NAME:-<auto-detect>}"
    printf -- '- Repo URL: `%s`\n' "${REPO_URL:-<missing>}"
    printf -- '- Branch: `%s`\n' "${BRANCH:-<missing>}"
    printf -- '- Migration date: `%s`\n\n' "$MIGRATION_DATE"

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
    printf -- '- `codex-goal.md`\n'
    printf -- '- `cutover-plan.txt`\n'
    printf -- '- `ssh-bootstrap-dry-run.txt`\n'
    printf -- '- `summary.md`\n\n'

    printf '## Next Commands\n\n'
    printf 'Review the generated `/goal` prompt:\n\n'
    printf '```bash\n'
    printf 'sed -n '\''1,220p'\'' %s\n' "$(quote_arg "$REHEARSAL_DIR/codex-goal.md")"
    printf '```\n\n'
    printf 'Review the cutover checklist:\n\n'
    printf '```bash\n'
    printf 'sed -n '\''1,260p'\'' %s\n' "$(quote_arg "$REHEARSAL_DIR/cutover-plan.txt")"
    printf '```\n\n'
    printf 'On Tuesday, paste `codex-goal.md` into the Mac Codex thread that will control the Pi over SSH.\n\n'
    printf 'Only after the Pi exists and the dry-run looks right should Codex rerun `pnpm run pi:ssh-bootstrap` with `--execute`.\n'
  } >"$summary_file"
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
    --output-dir)
      REHEARSAL_DIR="${2:-}"
      [ -n "$REHEARSAL_DIR" ] || { echo "Missing value for --output-dir" >&2; exit 2; }
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
REHEARSAL_DIR="$(expand_local_path "$REHEARSAL_DIR")"

if [ -z "$REHEARSAL_DIR" ]; then
  timestamp="$(date '+%d-%m-%y-%H%M')"
  REHEARSAL_DIR="$PROJECT_ROOT/output/pi-cutover-rehearsal/$timestamp"
fi

require_value "Mac Distributed-Cognition folder (--local-root or DC_SECOND_BRAIN_ROOT)" "$LOCAL_SECOND_BRAIN_ROOT"
require_value "Pi host (--pi-host or NANOCLAW_PI_HOST)" "$PI_HOST"
require_value "Pi SSH user (--pi-user or NANOCLAW_PI_USER)" "$PI_USER"
require_value "Pi NanoClaw path (--pi-path or NANOCLAW_PI_PROJECT_ROOT)" "$PI_PROJECT_ROOT"
require_value "Pi Distributed-Cognition path (--pi-second-brain-root or NANOCLAW_PI_SECOND_BRAIN_ROOT)" "$PI_SECOND_BRAIN_ROOT"
require_value "Repository URL (--repo-url or NANOCLAW_PI_REPO_URL)" "$REPO_URL"
require_value "Branch (--branch or NANOCLAW_PI_BRANCH)" "$BRANCH"
require_bootstrap_value "Pi host (--pi-host or NANOCLAW_PI_HOST)" "$PI_HOST"
require_bootstrap_value "Pi SSH user (--pi-user or NANOCLAW_PI_USER)" "$PI_USER"
require_bootstrap_value "Pi NanoClaw path (--pi-path or NANOCLAW_PI_PROJECT_ROOT)" "$PI_PROJECT_ROOT"
require_bootstrap_value "Pi Distributed-Cognition path (--pi-second-brain-root or NANOCLAW_PI_SECOND_BRAIN_ROOT)" "$PI_SECOND_BRAIN_ROOT"
require_bootstrap_value "Repository URL (--repo-url or NANOCLAW_PI_REPO_URL)" "$REPO_URL"
require_bootstrap_value "Branch (--branch or NANOCLAW_PI_BRANCH)" "$BRANCH"

mkdir -p "$REHEARSAL_DIR"
cd "$PROJECT_ROOT"

goal_cmd=(pnpm run pi:codex-goal --)
[ -n "$LOCAL_SECOND_BRAIN_ROOT" ] && goal_cmd+=(--local-root "$LOCAL_SECOND_BRAIN_ROOT")
goal_cmd+=(--out-dir "$OUT_DIR")
[ -n "$PI_HOST" ] && goal_cmd+=(--pi-host "$PI_HOST")
[ -n "$PI_USER" ] && goal_cmd+=(--pi-user "$PI_USER")
[ -n "$PI_PROJECT_ROOT" ] && goal_cmd+=(--pi-path "$PI_PROJECT_ROOT")
[ -n "$PI_SECOND_BRAIN_ROOT" ] && goal_cmd+=(--pi-second-brain-root "$PI_SECOND_BRAIN_ROOT")
[ -n "$PI_CODEX_PROJECTS_ROOT" ] && goal_cmd+=(--pi-codex-projects-root "$PI_CODEX_PROJECTS_ROOT")
[ -n "$PI_RCLONE_REMOTE" ] && goal_cmd+=(--pi-rclone-remote "$PI_RCLONE_REMOTE")
[ -n "$PI_UNIT_NAME" ] && goal_cmd+=(--pi-unit-name "$PI_UNIT_NAME")
[ -n "$REPO_URL" ] && goal_cmd+=(--repo-url "$REPO_URL")
[ -n "$BRANCH" ] && goal_cmd+=(--branch "$BRANCH")
goal_cmd+=(--migration-date "$MIGRATION_DATE")

plan_cmd=(pnpm run pi:cutover-plan --)
[ -n "$LOCAL_SECOND_BRAIN_ROOT" ] && plan_cmd+=(--local-root "$LOCAL_SECOND_BRAIN_ROOT")
plan_cmd+=(--out-dir "$OUT_DIR")
[ -n "$PI_HOST" ] && plan_cmd+=(--pi-host "$PI_HOST")
[ -n "$PI_USER" ] && plan_cmd+=(--pi-user "$PI_USER")
[ -n "$PI_PROJECT_ROOT" ] && plan_cmd+=(--pi-path "$PI_PROJECT_ROOT")
[ -n "$PI_SECOND_BRAIN_ROOT" ] && plan_cmd+=(--pi-second-brain-root "$PI_SECOND_BRAIN_ROOT")
[ -n "$PI_CODEX_PROJECTS_ROOT" ] && plan_cmd+=(--pi-codex-projects-root "$PI_CODEX_PROJECTS_ROOT")
[ -n "$PI_RCLONE_REMOTE" ] && plan_cmd+=(--pi-rclone-remote "$PI_RCLONE_REMOTE")
[ -n "$PI_UNIT_NAME" ] && plan_cmd+=(--pi-unit-name "$PI_UNIT_NAME")
[ -n "$REPO_URL" ] && plan_cmd+=(--repo-url "$REPO_URL")

run_capture "$REHEARSAL_DIR/codex-goal.md" "Codex Goal Prompt" "${goal_cmd[@]}"
run_capture "$REHEARSAL_DIR/cutover-plan.txt" "Read-Only Cutover Plan" "${plan_cmd[@]}"

if [ "${#bootstrap_missing[@]}" -eq 0 ]; then
  bootstrap_cmd=(
    pnpm run pi:ssh-bootstrap --
    --host "$PI_HOST"
    --user "$PI_USER"
    --path "$PI_PROJECT_ROOT"
    --second-brain-root "$PI_SECOND_BRAIN_ROOT"
    --repo-url "$REPO_URL"
    --branch "$BRANCH"
  )
  [ -n "$PI_CODEX_PROJECTS_ROOT" ] && bootstrap_cmd+=(--codex-projects-root "$PI_CODEX_PROJECTS_ROOT")
  [ -n "$PI_RCLONE_REMOTE" ] && bootstrap_cmd+=(--rclone-remote "$PI_RCLONE_REMOTE")
  run_capture "$REHEARSAL_DIR/ssh-bootstrap-dry-run.txt" "Pi SSH Bootstrap Dry Run" "${bootstrap_cmd[@]}"
else
  write_bootstrap_skipped "$REHEARSAL_DIR/ssh-bootstrap-dry-run.txt"
fi

status="ready"
exit_code=0
if [ "${#failures[@]}" -gt 0 ]; then
  status="failed"
  exit_code=1
elif [ "${#missing[@]}" -gt 0 ]; then
  status="missing_values"
  if [ "$STRICT" = "true" ]; then
    exit_code=1
  fi
fi

write_summary "$REHEARSAL_DIR/summary.md" "$status"

echo "PI_CUTOVER_REHEARSAL=$status"
echo "bundle=$REHEARSAL_DIR"
echo "No SSH was opened. No WhatsApp/runtime state was changed."
if [ "${#missing[@]}" -gt 0 ]; then
  echo "missing_values=${#missing[@]}"
fi
if [ "${#failures[@]}" -gt 0 ]; then
  echo "failures=${#failures[@]}"
fi

exit "$exit_code"
