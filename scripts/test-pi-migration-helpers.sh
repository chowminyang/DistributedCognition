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

assert_not_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -Fq -- "$pattern" "$file"; then
    echo "Did not expect to find: $pattern" >&2
    echo "--- output ---" >&2
    sed -n '1,180p' "$file" >&2
    fail "$label"
  else
    ok "$label"
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
  scripts/pi-mac-readiness.sh
  scripts/pi-rehearse-cutover.sh
  scripts/pi-ssh-admin.sh
  scripts/pi-ssh-bootstrap.sh
  scripts/pi-ssh-preflight.sh
  scripts/pi-ssh-restore-state.sh
  scripts/pi-ssh-start-runtime.sh
  scripts/pi-verify-cutover.sh
  scripts/pi-mac-export-preflight.sh
  scripts/pi-export-state.sh
  scripts/pi-import-state.sh
  scripts/pi-install-bridge-timers.sh
  scripts/pi-install-systemd.sh
  scripts/pi-install-dropbox-sync.sh
)

for helper_script in "${helper_scripts[@]}"; do
  bash -n "$helper_script"
done
ok "shell syntax is valid"

systemd_render_dir="$TMP_DIR/systemd-render"
bash scripts/pi-install-systemd.sh --output-dir "$systemd_render_dir" >"$TMP_DIR/systemd-render.out"
systemd_unit="$(find "$systemd_render_dir" -name 'nanoclaw-v2-*.service' -print -quit)"
[ -n "$systemd_unit" ] || fail "systemd unit render writes a unit file"
assert_contains "$systemd_unit" "docker info" "systemd unit waits for Docker readiness"
assert_contains "$systemd_unit" "Docker is not reachable by the service user after 60s" "systemd unit reports Docker readiness timeout"
assert_contains "$systemd_unit" "Restart=always" "systemd unit restarts NanoClaw"

bridge_timer_render_dir="$TMP_DIR/bridge-timer-render"
bash scripts/pi-install-bridge-timers.sh \
  --output-dir "$bridge_timer_render_dir" \
  --root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --mnemon-db /home/pi/NanoClaw/groups/dm-with-minyangchow/.mnemon/memory.db \
  --interval 5min \
  --unit-prefix dc-bridge-test \
  --execute-bridges \
  >"$TMP_DIR/bridge-timer-render.out"
bridge_runner="$bridge_timer_render_dir/dc-pi-run-bridges-dc-bridge-test.sh"
bridge_timer="$bridge_timer_render_dir/dc-bridge-test-codex-bridge.timer"
bridge_unit="$bridge_timer_render_dir/dc-bridge-test-codex-bridge.service"
[ -f "$bridge_runner" ] || fail "bridge timer render writes runner"
[ -f "$bridge_timer" ] || fail "bridge timer render writes timer"
[ -f "$bridge_unit" ] || fail "bridge timer render writes unit"
assert_contains "$bridge_runner" "dc:memory-bridge" "bridge runner includes memory bridge"
assert_contains "$bridge_runner" "dc:codex-bridge" "bridge runner includes codex bridge"
assert_contains "$bridge_runner" "--execute" "bridge runner can execute queued bridge work"
assert_contains "$bridge_timer" "OnUnitActiveSec=5min" "bridge timer uses configured interval"
assert_contains "$bridge_unit" "ExecStart=/bin/bash" "bridge unit calls runner"
assert_contains "$TMP_DIR/bridge-timer-render.out" "Bridge jobs execute queued work." "bridge timer render reports execute mode"

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
assert_contains "$goal_out" "pnpm run pi:ssh-restore-state" "codex goal includes SSH state restore"
assert_contains "$goal_out" "pnpm run pi:ssh-start-runtime" "codex goal includes SSH runtime start"
assert_contains "$goal_out" "--proof-text" "codex goal includes Pi WhatsApp persistence proof"
assert_contains "$goal_out" "Do not mark the goal complete" "codex goal includes completion guard"
assert_contains "$goal_out" "02-06-26" "codex goal includes migration date"
assert_contains "$goal_out" "process DC bridge work on the Pi" "codex goal keeps Pi-side bridge work explicit"

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
assert_contains "$plan_out" "pnpm run pi:ssh-restore-state" "cutover plan includes SSH state restore"
assert_contains "$plan_out" "pnpm run pi:ssh-start-runtime" "cutover plan includes SSH runtime start"
assert_contains "$plan_out" "pnpm run pi:ssh-admin -- doctor" "cutover plan includes Pi doctor check"
assert_contains "$plan_out" "--proof-text" "cutover plan includes Pi WhatsApp persistence proof"
assert_contains "$plan_out" "Post-Cutover Bridge Work" "cutover plan includes post-cutover bridge work"
assert_contains "$plan_out" "pnpm run pi:ssh-admin -- process-bridges" "cutover plan defaults to Pi-side bridge processing"

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
  NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex \
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
[ -f "$rehearsal_dir/operator-env.sh" ] || fail "cutover rehearsal writes operator env"
[ -f "$rehearsal_dir/codex-goal.md" ] || fail "cutover rehearsal writes codex goal"
[ -f "$rehearsal_dir/cutover-plan.txt" ] || fail "cutover rehearsal writes cutover plan"
[ -f "$rehearsal_dir/ssh-bootstrap-dry-run.txt" ] || fail "cutover rehearsal writes ssh bootstrap dry-run"
[ -f "$rehearsal_dir/ssh-restore-state-dry-run.txt" ] || fail "cutover rehearsal writes ssh state restore dry-run"
[ -f "$rehearsal_dir/ssh-start-runtime-dry-run.txt" ] || fail "cutover rehearsal writes ssh runtime start dry-run"
assert_contains "$rehearsal_dir/codex-goal.md" "/goal" "cutover rehearsal includes goal prompt"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_HOST=nanoclaw-pi.local" "cutover rehearsal operator env includes Pi host"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex" "cutover rehearsal operator env includes Codex projects root"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_SSH_CONNECT_TIMEOUT=10" "cutover rehearsal operator env includes SSH timeout"
assert_not_contains "$rehearsal_dir/operator-env.sh" "OPENAI_API_KEY" "cutover rehearsal operator env excludes API keys"
assert_not_contains "$rehearsal_dir/operator-env.sh" "WHATSAPP_" "cutover rehearsal operator env excludes WhatsApp env vars"
assert_contains "$rehearsal_dir/cutover-plan.txt" "CUTOVER_PLAN=ready" "cutover rehearsal includes ready cutover plan"
assert_contains "$rehearsal_dir/ssh-bootstrap-dry-run.txt" "PI_SSH_BOOTSTRAP=dry_run" "cutover rehearsal includes bootstrap dry-run"
assert_contains "$rehearsal_dir/ssh-restore-state-dry-run.txt" "PI_SSH_RESTORE_STATE=dry_run" "cutover rehearsal includes state restore dry-run"
assert_contains "$rehearsal_dir/ssh-start-runtime-dry-run.txt" "PI_SSH_START_RUNTIME=dry_run" "cutover rehearsal includes runtime start dry-run"
assert_contains "$rehearsal_dir/summary.md" "No SSH was opened" "cutover rehearsal summary states no SSH"
assert_contains "$rehearsal_dir/summary.md" "operator-env.sh" "cutover rehearsal summary lists operator env artifact"
assert_contains "$rehearsal_dir/summary.md" "ssh-restore-state-dry-run.txt" "cutover rehearsal summary lists state restore artifact"
assert_contains "$rehearsal_dir/summary.md" "ssh-start-runtime-dry-run.txt" "cutover rehearsal summary lists runtime start artifact"

set +e
pnpm run pi:rehearse-cutover -- --strict --output-dir "$TMP_DIR/rehearsal-missing" >"$TMP_DIR/rehearsal-missing.out" 2>"$TMP_DIR/rehearsal-missing.err"
rehearsal_missing_code="$?"
set -e
assert_exit_code 1 "$rehearsal_missing_code" "strict cutover rehearsal fails when values are missing"
assert_contains "$TMP_DIR/rehearsal-missing.out" "PI_CUTOVER_REHEARSAL=missing_values" "strict cutover rehearsal reports missing values"
assert_contains "$TMP_DIR/rehearsal-missing.out" "No SSH was opened" "strict cutover rehearsal remains non-mutating"

readiness_root="$TMP_DIR/Distributed-Cognition"
mkdir -p "$readiness_root/.dc-index"
readiness_dir="$TMP_DIR/readiness"
pnpm run pi:mac-readiness -- \
  --local-root "$readiness_root" \
  --out-dir "$TMP_DIR/export" \
  --output-dir "$readiness_dir" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main \
  --migration-date 02-06-26 \
  --skip-health \
  --skip-public-readiness \
  >"$TMP_DIR/readiness.out"
assert_contains "$TMP_DIR/readiness.out" "PI_MAC_READINESS=" "mac readiness reports status"
assert_contains "$TMP_DIR/readiness.out" "No SSH was opened" "mac readiness is non-mutating"
[ -f "$readiness_dir/summary.md" ] || fail "mac readiness writes summary"
[ -f "$readiness_dir/git-status.txt" ] || fail "mac readiness writes git status"
[ -f "$readiness_dir/public-readiness.txt" ] || fail "mac readiness writes public-readiness artifact"
[ -f "$readiness_dir/health.json" ] || fail "mac readiness writes health artifact"
[ -f "$readiness_dir/mac-preflight.txt" ] || fail "mac readiness writes mac preflight"
[ -f "$readiness_dir/rehearsal/summary.md" ] || fail "mac readiness writes nested rehearsal summary"
assert_contains "$readiness_dir/public-readiness.txt" "Skipped" "mac readiness can skip public readiness"
assert_contains "$readiness_dir/health.json" "Skipped" "mac readiness can skip health"
assert_contains "$readiness_dir/rehearsal/summary.md" "Status: \`ready\`" "mac readiness nested rehearsal is ready with complete values"

set +e
pnpm run pi:mac-readiness -- --strict --output-dir "$TMP_DIR/readiness-missing" --skip-health --skip-public-readiness >"$TMP_DIR/readiness-missing.out" 2>"$TMP_DIR/readiness-missing.err"
readiness_missing_code="$?"
set -e
assert_exit_code 1 "$readiness_missing_code" "strict mac readiness fails when values are missing"
assert_contains "$TMP_DIR/readiness-missing.out" "PI_MAC_READINESS=missing_values" "strict mac readiness reports missing values"
assert_contains "$TMP_DIR/readiness-missing.out" "No SSH was opened" "strict mac readiness remains non-mutating"

verify_dir="$TMP_DIR/verify-cutover"
pnpm run pi:verify-cutover -- \
  --local-root "$TMP_DIR/Distributed-Cognition" \
  --out-dir "$TMP_DIR/export" \
  --output-dir "$verify_dir" \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --unit-name nanoclaw-v2-test.service \
  --include-logs \
  --lines 12 \
  --proof-text "DC Pi cutover proof 02-06-26-1200" \
  --proof-since-minutes 45 \
  >"$TMP_DIR/verify-cutover.out"
assert_contains "$TMP_DIR/verify-cutover.out" "PI_CUTOVER_VERIFY=dry_run" "cutover verification dry-run reports status"
assert_contains "$TMP_DIR/verify-cutover.out" "No SSH was opened" "cutover verification dry-run is non-mutating"
[ -f "$verify_dir/summary.md" ] || fail "cutover verification writes summary"
[ -f "$verify_dir/mac-stopped-check.txt" ] || fail "cutover verification writes Mac stopped check"
[ -f "$verify_dir/pi-status.txt" ] || fail "cutover verification writes Pi status check"
[ -f "$verify_dir/pi-health.txt" ] || fail "cutover verification writes Pi health check"
[ -f "$verify_dir/pi-dashboard.txt" ] || fail "cutover verification writes Pi dashboard check"
[ -f "$verify_dir/pi-logs.txt" ] || fail "cutover verification writes optional logs check"
[ -f "$verify_dir/pi-whatsapp-proof.txt" ] || fail "cutover verification writes WhatsApp persistence proof"
[ -f "$verify_dir/manual-whatsapp-checklist.md" ] || fail "cutover verification writes WhatsApp checklist"
assert_contains "$verify_dir/mac-stopped-check.txt" "pnpm run pi:mac-preflight" "cutover verification checks Mac stopped state"
assert_contains "$verify_dir/pi-status.txt" "pnpm run pi:ssh-admin -- status" "cutover verification checks Pi status"
[ -f "$verify_dir/pi-bridge-timers.txt" ] || fail "cutover verification writes Pi bridge timer check"
assert_contains "$verify_dir/pi-bridge-timers.txt" "pnpm run pi:ssh-admin -- bridge-timers" "cutover verification checks Pi bridge timers"
assert_contains "$verify_dir/pi-health.txt" "pnpm run pi:ssh-admin -- health" "cutover verification checks Pi health"
assert_contains "$verify_dir/pi-whatsapp-proof.txt" "Status: \`dry_run\`" "cutover verification can dry-run WhatsApp proof"
assert_contains "$verify_dir/pi-whatsapp-proof.txt" "DC Pi cutover proof 02-06-26-1200" "cutover verification records proof phrase"
assert_contains "$verify_dir/summary.md" "pi-bridge-timers.txt" "cutover verification summary lists bridge timer proof"
assert_contains "$verify_dir/summary.md" "pi-whatsapp-proof.txt" "cutover verification summary lists WhatsApp proof"
assert_contains "$verify_dir/manual-whatsapp-checklist.md" "Do not mark the migration complete" "cutover verification keeps WhatsApp proof explicit"
assert_contains "$verify_dir/manual-whatsapp-checklist.md" "--proof-text" "cutover verification checklist explains proof rerun"

set +e
pnpm run pi:verify-cutover -- --strict --output-dir "$TMP_DIR/verify-missing" >"$TMP_DIR/verify-missing.out" 2>"$TMP_DIR/verify-missing.err"
verify_missing_code="$?"
pnpm run pi:verify-cutover -- --execute --output-dir "$TMP_DIR/verify-execute-missing" >"$TMP_DIR/verify-execute-missing.out" 2>"$TMP_DIR/verify-execute-missing.err"
verify_execute_missing_code="$?"
set -e
assert_exit_code 1 "$verify_missing_code" "strict cutover verification fails when values are missing"
assert_exit_code 2 "$verify_execute_missing_code" "execute cutover verification fails before SSH when values are missing"
assert_contains "$TMP_DIR/verify-missing.out" "PI_CUTOVER_VERIFY=missing_values" "strict cutover verification reports missing values"
assert_contains "$TMP_DIR/verify-missing.out" "No SSH was opened" "strict cutover verification remains non-mutating"
assert_contains "$TMP_DIR/verify-execute-missing.out" "PI_CUTOVER_VERIFY=missing_values" "execute cutover verification reports missing values before SSH"

pnpm run pi:verify-cutover -- --help >"$TMP_DIR/verify-cutover-help.out"
assert_contains "$TMP_DIR/verify-cutover-help.out" "--proof-text" "cutover verification help documents proof text"
assert_contains "$TMP_DIR/verify-cutover-help.out" "--proof-since-minutes" "cutover verification help documents proof window"
assert_contains "$TMP_DIR/verify-cutover-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "cutover verification help documents SSH timeout env"

pnpm run pi:ssh-admin -- --help >"$TMP_DIR/ssh-admin-help.out"
assert_contains "$TMP_DIR/ssh-admin-help.out" "Required options, unless the matching environment defaults are set" "ssh admin help documents env defaults"
assert_contains "$TMP_DIR/ssh-admin-help.out" "BatchMode=yes" "ssh admin help documents -o style ssh options"
assert_contains "$TMP_DIR/ssh-admin-help.out" "doctor" "ssh admin help documents doctor action"
assert_contains "$TMP_DIR/ssh-admin-help.out" "bridge-timers" "ssh admin help documents bridge timer action"
assert_contains "$TMP_DIR/ssh-admin-help.out" "process-bridges" "ssh admin help documents Pi-side bridge processing"
assert_contains "$TMP_DIR/ssh-admin-help.out" "--execute-bridges" "ssh admin help documents bridge execute flag"
assert_contains "$TMP_DIR/ssh-admin-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh admin help documents SSH timeout env"

pnpm run pi:ssh-preflight -- --help >"$TMP_DIR/ssh-preflight-help.out"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "Required options, unless the matching environment defaults are set" "ssh preflight help documents env defaults"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "BatchMode=yes" "ssh preflight help documents -o style ssh options"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh preflight help documents SSH timeout env"

pnpm run pi:ssh-bootstrap -- --help >"$TMP_DIR/ssh-bootstrap-help.out"
assert_contains "$TMP_DIR/ssh-bootstrap-help.out" "dry-run by default" "ssh bootstrap help documents dry-run default"
assert_contains "$TMP_DIR/ssh-bootstrap-help.out" "--execute" "ssh bootstrap help documents execute mode"
assert_contains "$TMP_DIR/ssh-bootstrap-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh bootstrap help documents SSH timeout env"

pnpm run pi:ssh-restore-state -- --help >"$TMP_DIR/ssh-restore-help.out"
assert_contains "$TMP_DIR/ssh-restore-help.out" "dry-run by default" "ssh restore help documents dry-run default"
assert_contains "$TMP_DIR/ssh-restore-help.out" "verifies the checksum on the Pi" "ssh restore help documents remote checksum verification"
assert_contains "$TMP_DIR/ssh-restore-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh restore help documents SSH timeout env"

pnpm run pi:ssh-start-runtime -- --help >"$TMP_DIR/ssh-start-runtime-help.out"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "dry-run by default" "ssh start runtime help documents dry-run default"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "systemd installation/startup" "ssh start runtime help documents systemd startup"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "--skip-bridge-timers" "ssh start runtime help documents bridge timer skip"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "--execute-bridges" "ssh start runtime help documents bridge timer execute mode"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh start runtime help documents SSH timeout env"

set +e
pnpm run pi:ssh-admin -- status >"$TMP_DIR/ssh-admin-missing.out" 2>"$TMP_DIR/ssh-admin-missing.err"
admin_missing_code="$?"
pnpm run pi:ssh-admin -- doctor \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  >"$TMP_DIR/ssh-admin-doctor-missing-root.out" 2>"$TMP_DIR/ssh-admin-doctor-missing-root.err"
doctor_missing_root_code="$?"
pnpm run pi:ssh-admin -- process-bridges \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  >"$TMP_DIR/ssh-admin-bridges-missing-codex.out" 2>"$TMP_DIR/ssh-admin-bridges-missing-codex.err"
bridges_missing_codex_code="$?"
pnpm run pi:ssh-preflight >"$TMP_DIR/ssh-preflight-missing.out" 2>"$TMP_DIR/ssh-preflight-missing.err"
preflight_missing_code="$?"
pnpm run pi:ssh-bootstrap >"$TMP_DIR/ssh-bootstrap-missing.out" 2>"$TMP_DIR/ssh-bootstrap-missing.err"
bootstrap_missing_code="$?"
pnpm run pi:ssh-restore-state >"$TMP_DIR/ssh-restore-missing.out" 2>"$TMP_DIR/ssh-restore-missing.err"
restore_missing_code="$?"
pnpm run pi:ssh-start-runtime >"$TMP_DIR/ssh-start-runtime-missing.out" 2>"$TMP_DIR/ssh-start-runtime-missing.err"
start_runtime_missing_code="$?"
set -e
assert_exit_code 2 "$admin_missing_code" "ssh admin fails before SSH when target values are missing"
assert_exit_code 2 "$doctor_missing_root_code" "ssh admin doctor fails before SSH when second-brain root is missing"
assert_exit_code 2 "$bridges_missing_codex_code" "ssh admin process-bridges fails before SSH when Codex projects root is missing"
assert_exit_code 2 "$preflight_missing_code" "ssh preflight fails before SSH when target values are missing"
assert_exit_code 2 "$bootstrap_missing_code" "ssh bootstrap fails before SSH when target values are missing"
assert_exit_code 2 "$restore_missing_code" "ssh restore fails before SSH when target values are missing"
assert_exit_code 2 "$start_runtime_missing_code" "ssh start runtime fails before SSH when target values are missing"
assert_contains "$TMP_DIR/ssh-admin-missing.err" "Missing required --host" "ssh admin missing host is explicit"
assert_contains "$TMP_DIR/ssh-admin-doctor-missing-root.err" "doctor requires --second-brain-root" "ssh admin doctor missing second-brain root is explicit"
assert_contains "$TMP_DIR/ssh-admin-bridges-missing-codex.err" "process-bridges requires --codex-projects-root" "ssh admin process-bridges missing Codex root is explicit"
assert_contains "$TMP_DIR/ssh-preflight-missing.err" "Missing required --host" "ssh preflight missing host is explicit"
assert_contains "$TMP_DIR/ssh-bootstrap-missing.err" "Missing required --host" "ssh bootstrap missing host is explicit"
assert_contains "$TMP_DIR/ssh-restore-missing.err" "Missing required --host" "ssh restore missing host is explicit"
assert_contains "$TMP_DIR/ssh-start-runtime-missing.err" "Missing required --host" "ssh start runtime missing host is explicit"

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
  NANOCLAW_PI_SSH_CONNECT_TIMEOUT=7 \
  pnpm run pi:ssh-bootstrap -- \
    >"$TMP_DIR/ssh-bootstrap-env.out"
assert_contains "$TMP_DIR/ssh-bootstrap-env.out" "PI_SSH_BOOTSTRAP=dry_run" "ssh bootstrap accepts environment defaults"
assert_contains "$TMP_DIR/ssh-bootstrap-env.out" "SSH connect timeout: 7s" "ssh bootstrap uses SSH timeout env"

bundle_src="$TMP_DIR/bundle-src"
mkdir -p "$bundle_src/state"
printf 'test state only\n' >"$bundle_src/state/README.txt"
bundle_path="$TMP_DIR/nanoclaw-pi-state-test.tar.gz"
tar -C "$bundle_src" -czf "$bundle_path" .
if command -v shasum >/dev/null 2>&1; then
  (cd "$TMP_DIR" && shasum -a 256 "$(basename "$bundle_path")" >"$(basename "$bundle_path").sha256")
else
  (cd "$TMP_DIR" && sha256sum "$(basename "$bundle_path")" >"$(basename "$bundle_path").sha256")
fi
checksum_path="$bundle_path.sha256"

pnpm run pi:ssh-restore-state -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --bundle "$bundle_path" \
  --force \
  --cleanup-remote \
  >"$TMP_DIR/ssh-restore-dry-run.out"
assert_contains "$TMP_DIR/ssh-restore-dry-run.out" "PI_SSH_RESTORE_STATE=dry_run" "ssh restore dry-run does not SSH"
assert_contains "$TMP_DIR/ssh-restore-dry-run.out" "No SSH was opened" "ssh restore dry-run is non-mutating"
assert_contains "$TMP_DIR/ssh-restore-dry-run.out" "pi-import-state.sh" "ssh restore dry-run shows import command"
assert_contains "$TMP_DIR/ssh-restore-dry-run.out" "pnpm run build" "ssh restore dry-run shows build command"

env \
  NANOCLAW_PI_HOST=nanoclaw-pi.local \
  NANOCLAW_PI_USER=pi \
  NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw \
  NANOCLAW_PI_STATE_BUNDLE="$bundle_path" \
  NANOCLAW_PI_STATE_CHECKSUM="$checksum_path" \
  pnpm run pi:ssh-restore-state -- \
    >"$TMP_DIR/ssh-restore-env.out"
assert_contains "$TMP_DIR/ssh-restore-env.out" "PI_SSH_RESTORE_STATE=dry_run" "ssh restore accepts environment defaults"

pnpm run pi:ssh-start-runtime -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --rclone-remote dropbox: \
  --rclone-folder Distributed-Cognition \
  --bridge-interval 5min \
  --unit-name nanoclaw-v2-test.service \
  >"$TMP_DIR/ssh-start-runtime-dry-run.out"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "PI_SSH_START_RUNTIME=dry_run" "ssh start runtime dry-run does not SSH"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "No SSH was opened" "ssh start runtime dry-run is non-mutating"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "pi-install-dropbox-sync.sh" "ssh start runtime dry-run shows rclone timer install"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "dc:ensure-docker-access" "ssh start runtime dry-run shows Docker access update"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "pi-install-systemd.sh" "ssh start runtime dry-run shows systemd install"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "pi-install-bridge-timers.sh" "ssh start runtime dry-run shows Pi bridge timer install"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "dc:health" "ssh start runtime dry-run shows health check"

env \
  NANOCLAW_PI_HOST=nanoclaw-pi.local \
  NANOCLAW_PI_USER=pi \
  NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw \
  NANOCLAW_PI_SECOND_BRAIN_ROOT=/home/pi/Distributed-Cognition \
  NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex \
  pnpm run pi:ssh-start-runtime -- \
    >"$TMP_DIR/ssh-start-runtime-env.out"
assert_contains "$TMP_DIR/ssh-start-runtime-env.out" "PI_SSH_START_RUNTIME=dry_run" "ssh start runtime accepts environment defaults"

echo "PI_MIGRATION_HELPERS=ok"
