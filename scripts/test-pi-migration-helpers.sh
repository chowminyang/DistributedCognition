#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dc-pi-helper-tests.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL - $1" >&2
  exit 1
}

ok() {
  echo "OK - $1"
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -Fq -- "$pattern" "$file"; then
    ok "$label"
  else
    echo "Expected to find: $pattern" >&2
    echo "--- output ---" >&2
    sed -n '1,180p' "$file" >&2
    fail "$label"
  fi
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$label"
  else
    fail "$label expected exit $expected, got $actual"
  fi
}

cd "$PROJECT_ROOT"

echo "Testing Raspberry Pi migration helpers"

helper_scripts=(
  scripts/pi-codex-goal.sh
  scripts/pi-cutover-plan.sh
  scripts/pi-rehearse-cutover.sh
  scripts/pi-ssh-admin.sh
  scripts/pi-ssh-bootstrap.sh
  scripts/pi-ssh-preflight.sh
  scripts/pi-mac-export-preflight.sh
  scripts/pi-export-state.sh
  scripts/pi-import-state.sh
  scripts/pi-install-systemd.sh
  scripts/pi-install-dropbox-sync.sh
)

for helper_script in "${helper_scripts[@]}"; do
  bash -n "$helper_script"
done
ok "shell syntax is valid"

goal_out="$TMP_DIR/codex-goal.out"
pnpm run pi:codex-goal -- \
  --local-root "$TMP_DIR/Distributed-Cognition" \
  --out-dir "$TMP_DIR/export" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main \
  --migration-date 02-06-26 \
  >"$goal_out"
assert_contains "$goal_out" "/goal" "codex goal starts with slash goal"
assert_contains "$goal_out" "Mac Codex is the control plane" "codex goal names Mac control plane"
assert_contains "$goal_out" "Raspberry Pi is the final always-on Distributed Cognition runtime" "codex goal names Pi runtime"
assert_contains "$goal_out" "pnpm run pi:ssh-bootstrap" "codex goal includes SSH bootstrap"
assert_contains "$goal_out" "Do not mark the goal complete" "codex goal includes completion guard"
assert_contains "$goal_out" "02-06-26" "codex goal includes migration date"

pnpm run pi:codex-goal -- --help >"$TMP_DIR/codex-goal-help.out"
assert_contains "$TMP_DIR/codex-goal-help.out" "paste-ready /goal prompt" "codex goal help documents purpose"

env \
  DC_SECOND_BRAIN_ROOT="$TMP_DIR/Distributed-Cognition" \
  NANOCLAW_PI_HOST=nanoclaw-pi.local \
  NANOCLAW_PI_USER=pi \
  NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw \
  NANOCLAW_PI_SECOND_BRAIN_ROOT=/home/pi/Distributed-Cognition \
  NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex \
  NANOCLAW_PI_REPO_URL=https://github.com/chowminyang/DistributedCognition.git \
  NANOCLAW_PI_BRANCH=main \
  NANOCLAW_PI_MIGRATION_DATE=02-06-26 \
  pnpm run pi:codex-goal -- \
    >"$TMP_DIR/codex-goal-env.out"
assert_contains "$TMP_DIR/codex-goal-env.out" "Pi SSH target: pi@nanoclaw-pi.local" "codex goal accepts environment defaults"

plan_out="$TMP_DIR/cutover-plan.out"
pnpm run pi:cutover-plan -- \
  --local-root "$TMP_DIR/Distributed-Cognition" \
  --out-dir "$TMP_DIR/export" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  >"$plan_out"
assert_contains "$plan_out" "Mac Codex remains the control plane" "cutover plan names Mac control plane"
assert_contains "$plan_out" "Distributed Cognition runs fully on the Raspberry Pi" "cutover plan names Pi runtime"
assert_contains "$plan_out" "CUTOVER_PLAN=ready" "cutover plan succeeds with complete values"
assert_contains "$plan_out" "pnpm run dc:stop-host -- --execute" "cutover plan includes final Mac host stop"
assert_contains "$plan_out" "pnpm run pi:ssh-preflight" "cutover plan includes SSH preflight"

set +e
pnpm run pi:cutover-plan -- --strict >"$TMP_DIR/cutover-missing.out" 2>"$TMP_DIR/cutover-missing.err"
missing_code="$?"
set -e
assert_exit_code 1 "$missing_code" "strict cutover plan fails when values are missing"
assert_contains "$TMP_DIR/cutover-missing.out" "CUTOVER_PLAN=missing_values" "strict cutover plan reports missing values"

env \
  DC_SECOND_BRAIN_ROOT="$TMP_DIR/Distributed-Cognition" \
  NANOCLAW_PI_HOST=nanoclaw-pi.local \
  NANOCLAW_PI_USER=pi \
  NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw \
  NANOCLAW_PI_SECOND_BRAIN_ROOT=/home/pi/Distributed-Cognition \
  pnpm run pi:cutover-plan -- \
    --repo-url https://github.com/chowminyang/DistributedCognition.git \
    --strict \
    >"$TMP_DIR/cutover-env.out"
assert_contains "$TMP_DIR/cutover-env.out" "CUTOVER_PLAN=ready" "cutover plan accepts environment defaults"

rehearsal_dir="$TMP_DIR/rehearsal"
pnpm run pi:rehearse-cutover -- \
  --local-root "$TMP_DIR/Distributed-Cognition" \
  --out-dir "$TMP_DIR/export" \
  --output-dir "$rehearsal_dir" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main \
  --migration-date 02-06-26 \
  >"$TMP_DIR/rehearsal.out"
assert_contains "$TMP_DIR/rehearsal.out" "PI_CUTOVER_REHEARSAL=ready" "cutover rehearsal succeeds with complete values"
assert_contains "$TMP_DIR/rehearsal.out" "No SSH was opened" "cutover rehearsal is non-mutating"
[ -f "$rehearsal_dir/summary.md" ] || fail "cutover rehearsal writes summary"
[ -f "$rehearsal_dir/codex-goal.md" ] || fail "cutover rehearsal writes codex goal"
[ -f "$rehearsal_dir/cutover-plan.txt" ] || fail "cutover rehearsal writes cutover plan"
[ -f "$rehearsal_dir/ssh-bootstrap-dry-run.txt" ] || fail "cutover rehearsal writes ssh bootstrap dry-run"
assert_contains "$rehearsal_dir/codex-goal.md" "/goal" "cutover rehearsal includes goal prompt"
assert_contains "$rehearsal_dir/cutover-plan.txt" "CUTOVER_PLAN=ready" "cutover rehearsal includes ready cutover plan"
assert_contains "$rehearsal_dir/ssh-bootstrap-dry-run.txt" "PI_SSH_BOOTSTRAP=dry_run" "cutover rehearsal includes bootstrap dry-run"
assert_contains "$rehearsal_dir/summary.md" "No SSH was opened" "cutover rehearsal summary states no SSH"

set +e
pnpm run pi:rehearse-cutover -- --strict --output-dir "$TMP_DIR/rehearsal-missing" >"$TMP_DIR/rehearsal-missing.out" 2>"$TMP_DIR/rehearsal-missing.err"
rehearsal_missing_code="$?"
set -e
assert_exit_code 1 "$rehearsal_missing_code" "strict cutover rehearsal fails when values are missing"
assert_contains "$TMP_DIR/rehearsal-missing.out" "PI_CUTOVER_REHEARSAL=missing_values" "strict cutover rehearsal reports missing values"
assert_contains "$TMP_DIR/rehearsal-missing.out" "No SSH was opened" "strict cutover rehearsal remains non-mutating"

pnpm run pi:ssh-admin -- --help >"$TMP_DIR/ssh-admin-help.out"
assert_contains "$TMP_DIR/ssh-admin-help.out" "Required options, unless the matching environment defaults are set" "ssh admin help documents env defaults"
assert_contains "$TMP_DIR/ssh-admin-help.out" "BatchMode=yes" "ssh admin help documents -o style ssh options"

pnpm run pi:ssh-preflight -- --help >"$TMP_DIR/ssh-preflight-help.out"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "Required options, unless the matching environment defaults are set" "ssh preflight help documents env defaults"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "BatchMode=yes" "ssh preflight help documents -o style ssh options"

pnpm run pi:ssh-bootstrap -- --help >"$TMP_DIR/ssh-bootstrap-help.out"
assert_contains "$TMP_DIR/ssh-bootstrap-help.out" "dry-run by default" "ssh bootstrap help documents dry-run default"
assert_contains "$TMP_DIR/ssh-bootstrap-help.out" "--execute" "ssh bootstrap help documents execute mode"

set +e
pnpm run pi:ssh-admin -- status >"$TMP_DIR/ssh-admin-missing.out" 2>"$TMP_DIR/ssh-admin-missing.err"
admin_missing_code="$?"
pnpm run pi:ssh-preflight >"$TMP_DIR/ssh-preflight-missing.out" 2>"$TMP_DIR/ssh-preflight-missing.err"
preflight_missing_code="$?"
pnpm run pi:ssh-bootstrap >"$TMP_DIR/ssh-bootstrap-missing.out" 2>"$TMP_DIR/ssh-bootstrap-missing.err"
bootstrap_missing_code="$?"
set -e
assert_exit_code 2 "$admin_missing_code" "ssh admin fails before SSH when target values are missing"
assert_exit_code 2 "$preflight_missing_code" "ssh preflight fails before SSH when target values are missing"
assert_exit_code 2 "$bootstrap_missing_code" "ssh bootstrap fails before SSH when target values are missing"
assert_contains "$TMP_DIR/ssh-admin-missing.err" "Missing required --host" "ssh admin missing host is explicit"
assert_contains "$TMP_DIR/ssh-preflight-missing.err" "Missing required --host" "ssh preflight missing host is explicit"
assert_contains "$TMP_DIR/ssh-bootstrap-missing.err" "Missing required --host" "ssh bootstrap missing host is explicit"

pnpm run pi:ssh-bootstrap -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main \
  --rclone-remote dropbox: \
  >"$TMP_DIR/ssh-bootstrap-dry-run.out"
assert_contains "$TMP_DIR/ssh-bootstrap-dry-run.out" "PI_SSH_BOOTSTRAP=dry_run" "ssh bootstrap dry-run does not SSH"
assert_contains "$TMP_DIR/ssh-bootstrap-dry-run.out" "git clone --branch" "ssh bootstrap dry-run shows clone command"
assert_contains "$TMP_DIR/ssh-bootstrap-dry-run.out" "bash setup.sh" "ssh bootstrap dry-run shows setup command"
assert_contains "$TMP_DIR/ssh-bootstrap-dry-run.out" "pnpm run build" "ssh bootstrap dry-run shows build command"
assert_contains "$TMP_DIR/ssh-bootstrap-dry-run.out" "pnpm run pi:ssh-preflight" "ssh bootstrap dry-run shows follow-up preflight"

env \
  NANOCLAW_PI_HOST=nanoclaw-pi.local \
  NANOCLAW_PI_USER=pi \
  NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw \
  NANOCLAW_PI_SECOND_BRAIN_ROOT=/home/pi/Distributed-Cognition \
  NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex \
  NANOCLAW_PI_REPO_URL=https://github.com/chowminyang/DistributedCognition.git \
  NANOCLAW_PI_BRANCH=main \
  pnpm run pi:ssh-bootstrap -- \
    >"$TMP_DIR/ssh-bootstrap-env.out"
assert_contains "$TMP_DIR/ssh-bootstrap-env.out" "PI_SSH_BOOTSTRAP=dry_run" "ssh bootstrap accepts environment defaults"

echo "PI_MIGRATION_HELPERS=ok"
