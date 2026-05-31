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
EXPECTED_COMMIT="${NANOCLAW_PI_EXPECTED_COMMIT:-}"
REPO_URL="${NANOCLAW_PI_REPO_URL:-https://github.com/chowminyang/DistributedCognition.git}"
BRANCH="${NANOCLAW_PI_BRANCH:-main}"
MIGRATION_DATE="${NANOCLAW_PI_MIGRATION_DATE:-02-06-26}"
READINESS_DIR=""
STRICT="false"
SKIP_HEALTH="false"
SKIP_PUBLIC_READINESS="false"
SKIP_REMOTE_CHECK="false"
SKIP_DISCOVERY="false"
INCLUDE_SSH_PREFLIGHT="false"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-mac-readiness.sh [options]

Creates a non-mutating Mac-side readiness bundle for Raspberry Pi cutover.
It gathers git state, public branch reachability, public-readiness, DC health,
Mac export preflight, and the Pi rehearsal bundle into one timestamped folder.

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
  --expected-commit <sha>         Expected Pi checkout commit. Default: current local HEAD.
  --repo-url <url>                Repository URL to clone on the Pi.
  --branch <name>                 Branch to use on the Pi. Default: main.
  --migration-date <DD-MM-YY>     Planned migration date. Default: 02-06-26.
  --output-dir <path>             Exact readiness bundle directory.
                                  Default: output/pi-mac-readiness/DD-MM-YY-HHMM
  --strict                        Exit non-zero on warnings or missing Pi values.
  --skip-health                   Do not run dc:health.
  --skip-public-readiness         Do not run dc:public-readiness.
  --skip-remote-check             Do not check that expected commit is on the
                                  configured repo branch.
  --skip-discovery                Do not run non-mutating Pi local-network
                                  discovery.
  --include-ssh-preflight         Also run pi:ssh-preflight against the Pi.
                                  This opens SSH but does not mutate Pi state.
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
  NANOCLAW_PI_EXPECTED_COMMIT
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

write_git_revision_check() {
  local output_file="$1"
  local revision_warnings=()
  local local_head=""
  local local_short=""
  local local_branch=""
  local status_entries="unknown"
  local status_output=""
  local remote_output=""
  local remote_code=0
  local remote_head=""

  local_head="$(git rev-parse HEAD 2>/dev/null || true)"
  local_short="$(git rev-parse --short HEAD 2>/dev/null || true)"
  local_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  status_output="$(git status --short 2>/dev/null || true)"
  if [ -n "$status_output" ]; then
    status_entries="$(printf '%s\n' "$status_output" | wc -l | tr -d ' ')"
  elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    status_entries="0"
  fi

  {
    printf '# Git Revision Check\n\n'
    printf 'Generated: `%s`\n\n' "$(date '+%d-%m-%y, %H:%M')"
    printf 'This proves whether the commit pinned for the Pi is reachable from the configured public branch.\n\n'
    printf '## Local\n\n'
    printf -- '- Local branch: `%s`\n' "${local_branch:-unknown}"
    printf -- '- Local HEAD: `%s`\n' "${local_head:-unknown}"
    printf -- '- Expected Pi commit: `%s`\n' "${EXPECTED_COMMIT:-<not checked>}"
    printf -- '- Worktree status entries: `%s`\n\n' "$status_entries"

    if [ "$status_entries" != "0" ]; then
      printf 'GIT_WORKTREE=dirty entries=%s\n\n' "$status_entries"
      warnings+=("Git worktree has $status_entries status entries; expected Pi commit does not include uncommitted local changes")
    else
      printf 'GIT_WORKTREE=clean\n\n'
    fi

    if [ -n "$local_head" ] && [ -n "$EXPECTED_COMMIT" ]; then
      if [[ "$local_head" == "$EXPECTED_COMMIT"* || "$EXPECTED_COMMIT" == "$local_head"* ]]; then
        printf 'GIT_EXPECTED_COMMIT=ok actual=%s\n\n' "${local_short:-$local_head}"
      else
        printf 'GIT_EXPECTED_COMMIT=warn actual=%s expected=%s\n\n' "$local_head" "$EXPECTED_COMMIT"
        revision_warnings+=("Expected Pi commit does not match local HEAD")
      fi
    else
      printf 'GIT_EXPECTED_COMMIT=skipped\n\n'
      revision_warnings+=("Could not compare expected commit with local HEAD")
    fi

    printf '## Remote\n\n'
    printf -- '- Repo URL: `%s`\n' "${REPO_URL:-<missing>}"
    printf -- '- Branch: `%s`\n\n' "${BRANCH:-<missing>}"

    if [ "$SKIP_REMOTE_CHECK" = "true" ]; then
      printf 'GIT_REMOTE_COMMIT=skipped reason=skip_remote_check\n'
      revision_warnings+=("Remote branch check was skipped")
    elif is_missing_or_placeholder "$REPO_URL" || is_missing_or_placeholder "$BRANCH" || [ -z "$EXPECTED_COMMIT" ]; then
      printf 'GIT_REMOTE_COMMIT=skipped reason=missing_values\n'
      revision_warnings+=("Remote branch check could not run because repo, branch, or expected commit is missing")
    else
      set +e
      remote_output="$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" 2>&1)"
      remote_code="$?"
      set -e
      if [ "$remote_code" -ne 0 ]; then
        printf 'GIT_REMOTE_COMMIT=warn reason=ls_remote_failed\n\n'
        printf '```text\n%s\n```\n' "$remote_output"
        revision_warnings+=("Could not read configured repo branch with git ls-remote")
      else
        remote_head="$(printf '%s\n' "$remote_output" | awk 'NR == 1 {print $1}')"
        if [ -z "$remote_head" ]; then
          printf 'GIT_REMOTE_COMMIT=warn reason=branch_not_found\n'
          revision_warnings+=("Configured repo branch was not found by git ls-remote")
        elif [[ "$remote_head" == "$EXPECTED_COMMIT"* || "$EXPECTED_COMMIT" == "$remote_head"* ]]; then
          printf -- '- Remote HEAD: `%s`\n\n' "$remote_head"
          printf 'GIT_REMOTE_COMMIT=ok branch=%s remote=%s\n' "$BRANCH" "$remote_head"
        else
          printf -- '- Remote HEAD: `%s`\n\n' "$remote_head"
          printf 'GIT_REMOTE_COMMIT=warn branch=%s remote=%s expected=%s\n' "$BRANCH" "$remote_head" "$EXPECTED_COMMIT"
          revision_warnings+=("Expected Pi commit is not the HEAD of the configured repo branch")
        fi
      fi
    fi

    if [ "${#revision_warnings[@]}" -gt 0 ]; then
      printf '\nGIT_REVISION_CHECK=warn\n'
      printf '\n## Warnings\n\n'
      for item in "${revision_warnings[@]}"; do
        printf -- '- %s\n' "$item"
        warnings+=("$item")
      done
    else
      printf '\nGIT_REVISION_CHECK=ok\n'
    fi
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
    --skip-remote-check)
      SKIP_REMOTE_CHECK="true"
      shift
      ;;
    --skip-discovery)
      SKIP_DISCOVERY="true"
      shift
      ;;
    --include-ssh-preflight)
      INCLUDE_SSH_PREFLIGHT="true"
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
require_value "Pi Codex projects path (--pi-codex-projects-root or NANOCLAW_PI_CODEX_PROJECTS_ROOT)" "$PI_CODEX_PROJECTS_ROOT"
require_value "Repository URL (--repo-url or NANOCLAW_PI_REPO_URL)" "$REPO_URL"
require_value "Branch (--branch or NANOCLAW_PI_BRANCH)" "$BRANCH"

mkdir -p "$READINESS_DIR"
cd "$PROJECT_ROOT"

if [ -z "$EXPECTED_COMMIT" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  EXPECTED_COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
fi

run_capture "$READINESS_DIR/git-status.txt" "Git Status" git status --short --branch
write_git_revision_check "$READINESS_DIR/git-revision-check.txt"

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

if [ "$SKIP_DISCOVERY" = "true" ]; then
  write_skipped "$READINESS_DIR/pi-discovery.txt" "Pi Discovery" "--skip-discovery supplied"
elif is_missing_or_placeholder "$PI_HOST"; then
  run_capture_allow_warn "$READINESS_DIR/pi-discovery.txt" "Pi Discovery" pnpm run pi:discover -- --timeout 3
else
  run_capture_allow_warn "$READINESS_DIR/pi-discovery.txt" "Pi Discovery" pnpm run pi:discover -- --timeout 3 --host "$PI_HOST"
fi

ssh_preflight_attempted="false"
if [ "$INCLUDE_SSH_PREFLIGHT" = "true" ]; then
  if is_missing_or_placeholder "$PI_HOST" || is_missing_or_placeholder "$PI_USER" || is_missing_or_placeholder "$PI_PROJECT_ROOT" || is_missing_or_placeholder "$PI_SECOND_BRAIN_ROOT"; then
    write_skipped "$READINESS_DIR/ssh-preflight.txt" "Pi SSH Preflight" "required Pi SSH/path values are missing"
  else
    ssh_preflight_attempted="true"
    ssh_preflight_cmd=(pnpm run pi:ssh-preflight -- --host "$PI_HOST" --user "$PI_USER" --path "$PI_PROJECT_ROOT" --second-brain-root "$PI_SECOND_BRAIN_ROOT")
    [ -n "$PI_CODEX_PROJECTS_ROOT" ] && ssh_preflight_cmd+=(--codex-projects-root "$PI_CODEX_PROJECTS_ROOT")
    [ -n "$PI_RCLONE_REMOTE" ] && ssh_preflight_cmd+=(--rclone-remote "$PI_RCLONE_REMOTE")
    run_capture_allow_warn "$READINESS_DIR/ssh-preflight.txt" "Pi SSH Preflight" "${ssh_preflight_cmd[@]}"
    if grep -Fq "PREFLIGHT_RESULT=warn" "$READINESS_DIR/ssh-preflight.txt"; then
      warnings+=("Pi SSH preflight completed with warnings")
    fi
  fi
else
  write_skipped "$READINESS_DIR/ssh-preflight.txt" "Pi SSH Preflight" "--include-ssh-preflight was not supplied"
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
[ -n "$EXPECTED_COMMIT" ] && rehearsal_cmd+=(--expected-commit "$EXPECTED_COMMIT")
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
  if [ "$ssh_preflight_attempted" = "true" ]; then
    printf 'SSH preflight was attempted through `pi:ssh-preflight`. No WhatsApp/runtime state was changed.\n\n'
  else
    printf 'No SSH was opened. No WhatsApp/runtime state was changed.\n\n'
  fi
  printf '## Current Values\n\n'
  printf -- '- Mac repo: `%s`\n' "$PROJECT_ROOT"
  printf -- '- Mac Distributed-Cognition folder: `%s`\n' "${LOCAL_SECOND_BRAIN_ROOT:-<missing>}"
  printf -- '- Mac export directory: `%s`\n' "$OUT_DIR"
  printf -- '- Pi SSH target: `%s@%s`\n' "${PI_USER:-<missing>}" "${PI_HOST:-<missing>}"
  printf -- '- Pi NanoClaw path: `%s`\n' "${PI_PROJECT_ROOT:-<missing>}"
  printf -- '- Pi Distributed-Cognition folder: `%s`\n' "${PI_SECOND_BRAIN_ROOT:-<missing>}"
  printf -- '- Pi Codex projects folder: `%s`\n' "${PI_CODEX_PROJECTS_ROOT:-<missing>}"
  printf -- '- Pi rclone remote: `%s`\n' "${PI_RCLONE_REMOTE:-<optional-not-set>}"
  printf -- '- Expected Pi commit: `%s`\n' "${EXPECTED_COMMIT:-<not checked>}"
  printf -- '- Repo URL: `%s`\n' "${REPO_URL:-<missing>}"
  printf -- '- Branch: `%s`\n' "${BRANCH:-<missing>}"
  printf -- '- Migration date: `%s`\n\n' "$MIGRATION_DATE"

  if [ "${#missing[@]}" -gt 0 ]; then
    printf '## Missing Values\n\n'
    for item in "${missing[@]}"; do
      printf -- '- %s\n' "$item"
    done
    printf '\n'
    printf '## Fillable Operator Environment\n\n'
    printf 'Start with `rehearsal/operator-env.sh` in this bundle. It contains only non-secret SSH, path, repo, branch, bridge-mode, and expected-commit values.\n\n'
    printf 'Check `pi-discovery.txt` for passive local-network hints if the Pi host is still unknown.\n\n'
    printf 'Uncomment and set the missing `NANOCLAW_PI_*` exports there, source it from the Mac Codex shell, then rerun this readiness check. When the Pi is reachable, rerun with `--include-ssh-preflight`.\n\n'
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
  printf -- '- `git-revision-check.txt`\n'
  printf -- '- `public-readiness.txt`\n'
  printf -- '- `health.json`\n'
  printf -- '- `mac-preflight.txt`\n'
  printf -- '- `pi-discovery.txt`\n'
  printf -- '- `ssh-preflight.txt`\n'
  printf -- '- `rehearsal.txt`\n'
  printf -- '- `rehearsal/operator-env.sh`\n'
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
echo "operator_env=$READINESS_DIR/rehearsal/operator-env.sh"
if [ "$ssh_preflight_attempted" = "true" ]; then
  echo "SSH preflight was attempted. No WhatsApp/runtime state was changed."
else
  echo "No SSH was opened. No WhatsApp/runtime state was changed."
fi
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
