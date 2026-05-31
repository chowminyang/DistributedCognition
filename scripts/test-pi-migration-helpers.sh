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
  if grep -Fq "$pattern" "$file"; then
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

bash -n \
  scripts/pi-cutover-plan.sh \
  scripts/pi-ssh-admin.sh \
  scripts/pi-ssh-preflight.sh \
  scripts/pi-mac-export-preflight.sh \
  scripts/pi-export-state.sh \
  scripts/pi-import-state.sh \
  scripts/pi-install-systemd.sh \
  scripts/pi-install-dropbox-sync.sh
ok "shell syntax is valid"

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

pnpm run pi:ssh-admin -- --help >"$TMP_DIR/ssh-admin-help.out"
assert_contains "$TMP_DIR/ssh-admin-help.out" "Required options, unless the matching environment defaults are set" "ssh admin help documents env defaults"
assert_contains "$TMP_DIR/ssh-admin-help.out" "BatchMode=yes" "ssh admin help documents -o style ssh options"

pnpm run pi:ssh-preflight -- --help >"$TMP_DIR/ssh-preflight-help.out"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "Required options, unless the matching environment defaults are set" "ssh preflight help documents env defaults"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "BatchMode=yes" "ssh preflight help documents -o style ssh options"

set +e
pnpm run pi:ssh-admin -- status >"$TMP_DIR/ssh-admin-missing.out" 2>"$TMP_DIR/ssh-admin-missing.err"
admin_missing_code="$?"
pnpm run pi:ssh-preflight >"$TMP_DIR/ssh-preflight-missing.out" 2>"$TMP_DIR/ssh-preflight-missing.err"
preflight_missing_code="$?"
set -e
assert_exit_code 2 "$admin_missing_code" "ssh admin fails before SSH when target values are missing"
assert_exit_code 2 "$preflight_missing_code" "ssh preflight fails before SSH when target values are missing"
assert_contains "$TMP_DIR/ssh-admin-missing.err" "Missing required --host" "ssh admin missing host is explicit"
assert_contains "$TMP_DIR/ssh-preflight-missing.err" "Missing required --host" "ssh preflight missing host is explicit"

echo "PI_MIGRATION_HELPERS=ok"
