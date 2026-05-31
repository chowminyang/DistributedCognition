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
READINESS_DIR=""
STRICT="false"
SKIP_HEALTH="false"
SKIP_PUBLIC_READINESS="false"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-mac-readiness.sh [options]

Creates a non-mutating Mac-side readiness bundle for Raspberry Pi cutover.
It gathers git state, public-readiness, DC health, Mac export preflight, and
the Pi rehearsal bundle into one timestamped folder.

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
  --output-dir <path>             Exact readiness bundle directory.
                                  Default: output/pi-mac-readiness/DD-MM-YY-HHMM
  --strict                        Exit non-zero on warnings or missing Pi values.
  --skip-health                   Do not run dc:health.
  --skip-public-readiness         Do not run dc:public-readiness.
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
warnings=()
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

run_capture_allow_warn() {
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

write_skipped() {
  local output_file="$1"
  local title="$2"
  local reason="$3"
  {
    printf '# %s\n\n' "$title"
    printf 'Skipped: %s\n\n' "$reason"
    printf 'No SSH was opened. No WhatsApp/runtime state was changed.\n'
  } >"$output_file"
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
      READINESS_DIR="${2:-}"
      [ -n "$READINESS_DIR" ] || { echo "Missing value for --output-dir" >&2; exit 2; }
      shift 2
      ;;
    --strict)
      STRICT="true"
      shift
      ;;
    --skip-health)
      SKIP_HEALTH="true"
      shift
      ;;
    --skip-public-readiness)
      SKIP_PUBLIC_READINESS="true"
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
READINESS_DIR="$(expand_local_path "$READINESS_DIR")"

if [ -z "$READINESS_DIR" ]; then
  timestamp="$(date '+%d-%m-%y-%H%M')"
  READINESS_DIR="$PROJECT_ROOT/output/pi-mac-readiness/$timestamp"
fi

require_value "Mac Distributed-Cognition folder (--local-root or DC_SECOND_BRAIN_ROOT)" "$LOCAL_SECOND_BRAIN_ROOT"
require_value "Pi host (--pi-host or NANOCLAW_PI_HOST)" "$PI_HOST"
require_value "Pi SSH user (--pi-user or NANOCLAW_PI_USER)" "$PI_USER"
require_value "Pi NanoClaw path (--pi-path or NANOCLAW_PI_PROJECT_ROOT)" "$PI_PROJECT_ROOT"
require_value "Pi Distributed-Cognition path (--pi-second-brain-root or NANOCLAW_PI_SECOND_BRAIN_ROOT)" "$PI_SECOND_BRAIN_ROOT"
require_value "Repository URL (--repo-url or NANOCLAW_PI_REPO_URL)" "$REPO_URL"
require_value "Branch (--branch or NANOCLAW_PI_BRANCH)" "$BRANCH"

mkdir -p "$READINESS_DIR"
cd "$PROJECT_ROOT"

run_capture "$READINESS_DIR/git-status.txt" "Git Status" git status --short --branch

if [ "$SKIP_PUBLIC_READINESS" = "true" ]; then
  write_skipped "$READINESS_DIR/public-readiness.txt" "Public Readiness" "--skip-public-readiness supplied"
else
  run_capture "$READINESS_DIR/public-readiness.txt" "Public Readiness" pnpm run dc:public-readiness
fi

if is_missing_or_placeholder "$LOCAL_SECOND_BRAIN_ROOT"; then
  write_skipped "$READINESS_DIR/health.json" "Distributed Cognition Health" "local second-brain root is missing"
elif [ "$SKIP_HEALTH" = "true" ]; then
  write_skipped "$READINESS_DIR/health.json" "Distributed Cognition Health" "--skip-health supplied"
else
  run_capture "$READINESS_DIR/health.json" "Distributed Cognition Health" pnpm run dc:health -- --root "$LOCAL_SECOND_BRAIN_ROOT" --json
fi

if is_missing_or_placeholder "$LOCAL_SECOND_BRAIN_ROOT"; then
  write_skipped "$READINESS_DIR/mac-preflight.txt" "Mac Export Preflight" "local second-brain root is missing"
else
  run_capture_allow_warn "$READINESS_DIR/mac-preflight.txt" "Mac Export Preflight" pnpm run pi:mac-preflight -- --root "$LOCAL_SECOND_BRAIN_ROOT" --out-dir "$OUT_DIR"
  if grep -Fq "MAC_EXPORT_PREFLIGHT=warn" "$READINESS_DIR/mac-preflight.txt"; then
    warnings+=("Mac export preflight has warnings; final export still requires stopped Mac host")
  fi
fi

rehearsal_cmd=(pnpm run pi:rehearse-cutover -- --output-dir "$READINESS_DIR/rehearsal")
[ -n "$LOCAL_SECOND_BRAIN_ROOT" ] && rehearsal_cmd+=(--local-root "$LOCAL_SECOND_BRAIN_ROOT")
rehearsal_cmd+=(--out-dir "$OUT_DIR")
[ -n "$PI_HOST" ] && rehearsal_cmd+=(--pi-host "$PI_HOST")
[ -n "$PI_USER" ] && rehearsal_cmd+=(--pi-user "$PI_USER")
[ -n "$PI_PROJECT_ROOT" ] && rehearsal_cmd+=(--pi-path "$PI_PROJECT_ROOT")
[ -n "$PI_SECOND_BRAIN_ROOT" ] && rehearsal_cmd+=(--pi-second-brain-root "$PI_SECOND_BRAIN_ROOT")
[ -n "$PI_CODEX_PROJECTS_ROOT" ] && rehearsal_cmd+=(--pi-codex-projects-root "$PI_CODEX_PROJECTS_ROOT")
[ -n "$PI_RCLONE_REMOTE" ] && rehearsal_cmd+=(--pi-rclone-remote "$PI_RCLONE_REMOTE")
[ -n "$PI_UNIT_NAME" ] && rehearsal_cmd+=(--pi-unit-name "$PI_UNIT_NAME")
[ -n "$REPO_URL" ] && rehearsal_cmd+=(--repo-url "$REPO_URL")
[ -n "$BRANCH" ] && rehearsal_cmd+=(--branch "$BRANCH")
rehearsal_cmd+=(--migration-date "$MIGRATION_DATE")
run_capture_allow_warn "$READINESS_DIR/rehearsal.txt" "Pi Cutover Rehearsal" "${rehearsal_cmd[@]}"

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

{
  printf '# Distributed Cognition Mac-To-Pi Readiness\n\n'
  printf 'Status: `%s`\n\n' "$status"
  printf 'Generated: `%s`\n\n' "$(date '+%d-%m-%y, %H:%M')"
  printf 'Bundle path: `%s`\n\n' "$READINESS_DIR"
  printf 'No SSH was opened. No WhatsApp/runtime state was changed.\n\n'
  printf '## Current Values\n\n'
  printf -- '- Mac repo: `%s`\n' "$PROJECT_ROOT"
  printf -- '- Mac Distributed-Cognition folder: `%s`\n' "${LOCAL_SECOND_BRAIN_ROOT:-<missing>}"
  printf -- '- Mac export directory: `%s`\n' "$OUT_DIR"
  printf -- '- Pi SSH target: `%s@%s`\n' "${PI_USER:-<missing>}" "${PI_HOST:-<missing>}"
  printf -- '- Pi NanoClaw path: `%s`\n' "${PI_PROJECT_ROOT:-<missing>}"
  printf -- '- Pi Distributed-Cognition folder: `%s`\n' "${PI_SECOND_BRAIN_ROOT:-<missing>}"
  printf -- '- Pi Codex projects folder: `%s`\n' "${PI_CODEX_PROJECTS_ROOT:-<optional-not-set>}"
  printf -- '- Pi rclone remote: `%s`\n' "${PI_RCLONE_REMOTE:-<optional-not-set>}"
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

  if [ "${#warnings[@]}" -gt 0 ]; then
    printf '## Warnings\n\n'
    for item in "${warnings[@]}"; do
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
  printf -- '- `git-status.txt`\n'
  printf -- '- `public-readiness.txt`\n'
  printf -- '- `health.json`\n'
  printf -- '- `mac-preflight.txt`\n'
  printf -- '- `rehearsal.txt`\n'
  printf -- '- `rehearsal/summary.md`\n\n'

  printf '## What This Means\n\n'
  if [ "$status" = "missing_values" ]; then
    printf 'The Mac side can be checked, but Pi-specific SSH/path values are still needed before Codex can control the Pi.\n\n'
  elif [ "$status" = "warn" ]; then
    printf 'The Mac side is usable for rehearsal. Resolve warnings before final state export.\n\n'
  elif [ "$status" = "ready" ]; then
    printf 'The Mac side has enough values for a dry-run Pi handoff. Final export still requires explicit stop/export confirmation.\n\n'
  else
    printf 'One or more readiness checks failed. Inspect the artifacts before cutover.\n\n'
  fi
  printf 'Final cutover still requires stopping the Mac NanoClaw host before export, and WhatsApp must run on only one host at a time.\n'
} >"$READINESS_DIR/summary.md"

echo "PI_MAC_READINESS=$status"
echo "bundle=$READINESS_DIR"
echo "No SSH was opened. No WhatsApp/runtime state was changed."
if [ "${#missing[@]}" -gt 0 ]; then
  echo "missing_values=${#missing[@]}"
fi
if [ "${#warnings[@]}" -gt 0 ]; then
  echo "warnings=${#warnings[@]}"
fi
if [ "${#failures[@]}" -gt 0 ]; then
  echo "failures=${#failures[@]}"
fi

exit "$exit_code"
