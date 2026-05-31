#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dc-pi-helper-tests.XXXXXX")"
MAC_GUARD_PID=""

cleanup() {
  if [ -n "${MAC_GUARD_PID:-}" ] && kill -0 "$MAC_GUARD_PID" 2>/dev/null; then
    kill "$MAC_GUARD_PID" 2>/dev/null || true
    wait "$MAC_GUARD_PID" 2>/dev/null || true
  fi
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
  scripts/dc-stop-host.sh
  scripts/pi-codex-goal.sh
  scripts/pi-cutover-plan.sh
  scripts/pi-discover.sh
  scripts/pi-first-boot-checklist.sh
  scripts/pi-mac-readiness.sh
  scripts/pi-operator-env-check.sh
  scripts/pi-rehearse-cutover.sh
  scripts/pi-ssh-target-guard.sh
  scripts/pi-ssh-admin.sh
  scripts/pi-ssh-bootstrap.sh
  scripts/pi-ssh-key-check.sh
  scripts/pi-ssh-key-setup.sh
  scripts/pi-ssh-preflight.sh
  scripts/pi-ssh-restore-state.sh
  scripts/pi-ssh-start-runtime.sh
  scripts/pi-verify-cutover.sh
  scripts/pi-mac-export-preflight.sh
  scripts/pi-export-state.sh
  scripts/pi-import-state.sh
  scripts/pi-install-bridge-timers.sh
  scripts/pi-inspect-state-bundle.sh
  scripts/pi-install-systemd.sh
  scripts/pi-install-dropbox-sync.sh
)

for helper_script in "${helper_scripts[@]}"; do
  bash -n "$helper_script"
done
ok "shell syntax is valid"
assert_contains "docs/distributed-cognition.md" "--bridge-execute-mode memory" "Distributed Cognition guide documents Pi memory bridge mode"
assert_contains "docs/distributed-cognition.md" "Mac Codex app-visible" "Distributed Cognition guide documents Mac-visible handoff path"

pnpm run pi:install-systemd -- --help >"$TMP_DIR/pi-install-systemd-help.out"
assert_contains "$TMP_DIR/pi-install-systemd-help.out" "Installs NanoClaw as a systemd service" "pi install systemd help accepts pnpm separator"

pnpm run pi:install-dropbox-sync -- --help >"$TMP_DIR/pi-install-dropbox-sync-help.out"
assert_contains "$TMP_DIR/pi-install-dropbox-sync-help.out" "Installs a user-level systemd timer" "pi install Dropbox sync help accepts pnpm separator"

pnpm run pi:import -- --help >"$TMP_DIR/pi-import-help.out"
assert_contains "$TMP_DIR/pi-import-help.out" "Restores a NanoClaw Raspberry Pi migration bundle" "pi import help accepts pnpm separator"

pnpm run pi:discover -- --help >"$TMP_DIR/pi-discover-help.out"
assert_contains "$TMP_DIR/pi-discover-help.out" "non-mutating local-network discovery" "pi discovery help documents purpose"
assert_contains "$TMP_DIR/pi-discover-help.out" "No SSH is opened" "pi discovery help documents no SSH"

pnpm run pi:operator-env-check -- --help >"$TMP_DIR/pi-operator-env-check-help.out"
assert_contains "$TMP_DIR/pi-operator-env-check-help.out" "Validates the non-secret Raspberry Pi operator environment" "pi operator env check help documents purpose"
assert_contains "$TMP_DIR/pi-operator-env-check-help.out" "does not source files, open SSH" "pi operator env check help documents no sourcing or SSH"

pnpm run pi:ssh-key-check -- --help >"$TMP_DIR/pi-ssh-key-check-help.out"
assert_contains "$TMP_DIR/pi-ssh-key-check-help.out" "Mac Codex has the local SSH pieces" "pi ssh key check help documents purpose"
assert_contains "$TMP_DIR/pi-ssh-key-check-help.out" "--test-login" "pi ssh key check help documents login test"
assert_contains "$TMP_DIR/pi-ssh-key-check-help.out" "distributed_cognition_pi_ed25519" "pi ssh key check help documents dedicated key preference"

pnpm run pi:ssh-key-setup -- --help >"$TMP_DIR/pi-ssh-key-setup-help.out"
assert_contains "$TMP_DIR/pi-ssh-key-setup-help.out" "Creates the dedicated Mac SSH identity" "pi ssh key setup help documents purpose"
assert_contains "$TMP_DIR/pi-ssh-key-setup-help.out" "--execute" "pi ssh key setup help documents execute flag"
assert_contains "$TMP_DIR/pi-ssh-key-setup-help.out" "distributed_cognition_pi_ed25519" "pi ssh key setup help documents default key"

pnpm run pi:first-boot-checklist -- --help >"$TMP_DIR/pi-first-boot-checklist-help.out"
assert_contains "$TMP_DIR/pi-first-boot-checklist-help.out" "first-boot checklist" "pi first boot checklist help documents purpose"
assert_contains "$TMP_DIR/pi-first-boot-checklist-help.out" "does not create SSH keys" "pi first boot checklist help documents non-mutating behavior"
assert_contains "$TMP_DIR/pi-first-boot-checklist-help.out" "NANOCLAW_PI_HOST" "pi first boot checklist help documents env defaults"

first_boot_no_key_home="$TMP_DIR/first-boot-no-key-home"
mkdir -p "$first_boot_no_key_home"
HOME="$first_boot_no_key_home" pnpm run pi:first-boot-checklist -- >"$TMP_DIR/pi-first-boot-no-key.out"
assert_contains "$TMP_DIR/pi-first-boot-no-key.out" "PI_FIRST_BOOT_CHECKLIST=needs_ssh_key" "pi first boot checklist reports missing key"
assert_contains "$TMP_DIR/pi-first-boot-no-key.out" "No SSH was opened" "pi first boot checklist is non-mutating"
assert_contains "$TMP_DIR/pi-first-boot-no-key.out" "Raspberry Pi Imager Settings" "pi first boot checklist includes imager settings"
assert_contains "$TMP_DIR/pi-first-boot-no-key.out" "pnpm run pi:ssh-key-setup -- --execute" "pi first boot checklist suggests key setup"
assert_contains "$TMP_DIR/pi-first-boot-no-key.out" "pnpm run pi:discover -- --host nanoclaw-pi.local" "pi first boot checklist suggests discovery"
assert_contains "$TMP_DIR/pi-first-boot-no-key.out" "ssh-copy-id -i" "pi first boot checklist includes public key copy command"
[ ! -e "$first_boot_no_key_home/.ssh/distributed_cognition_pi_ed25519" ] || fail "pi first boot checklist created a private key"
ok "pi first boot checklist does not create a private key"

set +e
HOME="$first_boot_no_key_home" pnpm run pi:first-boot-checklist -- --strict >"$TMP_DIR/pi-first-boot-strict.out" 2>"$TMP_DIR/pi-first-boot-strict.err"
first_boot_strict_code="$?"
pnpm run pi:first-boot-checklist -- --host localhost >"$TMP_DIR/pi-first-boot-localhost.out" 2>"$TMP_DIR/pi-first-boot-localhost.err"
first_boot_localhost_code="$?"
set -e
assert_exit_code 1 "$first_boot_strict_code" "strict pi first boot checklist fails when dedicated key is missing"
assert_contains "$TMP_DIR/pi-first-boot-strict.out" "PI_FIRST_BOOT_CHECKLIST=needs_ssh_key" "strict pi first boot checklist reports missing key"
assert_exit_code 2 "$first_boot_localhost_code" "pi first boot checklist refuses localhost Pi host"
assert_contains "$TMP_DIR/pi-first-boot-localhost.err" "target the Mac/local machine rather than the Raspberry Pi" "pi first boot checklist guard explains localhost refusal"

first_boot_ready_home="$TMP_DIR/first-boot-ready-home"
mkdir -p "$first_boot_ready_home/.ssh"
printf 'ssh-ed25519 ready-public-key distributed-cognition-test\n' >"$first_boot_ready_home/.ssh/distributed_cognition_pi_ed25519.pub"
HOME="$first_boot_ready_home" pnpm run pi:first-boot-checklist -- \
  --host nanoclaw-pi.local \
  --user pi \
  >"$TMP_DIR/pi-first-boot-ready.out"
assert_contains "$TMP_DIR/pi-first-boot-ready.out" "PI_FIRST_BOOT_CHECKLIST=ready" "pi first boot checklist reports ready when public key exists"
assert_contains "$TMP_DIR/pi-first-boot-ready.out" "Hostname: \`nanoclaw-pi\`" "pi first boot checklist derives imager hostname"
assert_not_contains "$TMP_DIR/pi-first-boot-ready.out" "pnpm run pi:ssh-key-setup -- --execute" "pi first boot checklist skips key setup when public key exists"

ssh_key_setup_home="$TMP_DIR/ssh-key-setup-home"
mkdir -p "$ssh_key_setup_home"
HOME="$ssh_key_setup_home" pnpm run pi:ssh-key-setup -- >"$TMP_DIR/pi-ssh-key-setup-dry-run.out"
assert_contains "$TMP_DIR/pi-ssh-key-setup-dry-run.out" "PI_SSH_KEY_SETUP=dry_run" "pi ssh key setup is dry-run by default"
assert_contains "$TMP_DIR/pi-ssh-key-setup-dry-run.out" "No SSH was opened" "pi ssh key setup is non-mutating by default"
assert_contains "$TMP_DIR/pi-ssh-key-setup-dry-run.out" "pnpm run pi:ssh-key-setup -- --execute" "pi ssh key setup prints execute command"
[ ! -e "$ssh_key_setup_home/.ssh/distributed_cognition_pi_ed25519" ] || fail "pi ssh key setup dry-run created a private key"
ok "pi ssh key setup dry-run does not create a private key"

fake_ssh_keygen_bin="$TMP_DIR/fake-ssh-keygen-bin"
mkdir -p "$fake_ssh_keygen_bin"
cat >"$fake_ssh_keygen_bin/ssh-keygen" <<'FAKE_SSH_KEYGEN'
#!/usr/bin/env bash
set -euo pipefail
args=" $* "
if [[ "$args" == *" -y "* ]]; then
  printf 'ssh-ed25519 fake-public-key distributed-cognition-test\n'
  exit 0
fi
output_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -f)
      output_file="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$output_file" ] || { echo "missing -f" >&2; exit 2; }
printf 'fake private key\n' >"$output_file"
printf 'ssh-ed25519 fake-public-key distributed-cognition-test\n' >"$output_file.pub"
FAKE_SSH_KEYGEN
chmod +x "$fake_ssh_keygen_bin/ssh-keygen"

ssh_key_setup_execute_home="$TMP_DIR/ssh-key-setup-execute-home"
mkdir -p "$ssh_key_setup_execute_home"
PATH="$fake_ssh_keygen_bin:$PATH" HOME="$ssh_key_setup_execute_home" pnpm run pi:ssh-key-setup -- --execute >"$TMP_DIR/pi-ssh-key-setup-execute.out"
assert_contains "$TMP_DIR/pi-ssh-key-setup-execute.out" "PI_SSH_KEY_SETUP=created" "pi ssh key setup creates dedicated key with execute"
[ -f "$ssh_key_setup_execute_home/.ssh/distributed_cognition_pi_ed25519" ] || fail "pi ssh key setup execute did not create private key"
[ -f "$ssh_key_setup_execute_home/.ssh/distributed_cognition_pi_ed25519.pub" ] || fail "pi ssh key setup execute did not create public key"
ok "pi ssh key setup execute creates keypair in fake home"
PATH="$fake_ssh_keygen_bin:$PATH" HOME="$ssh_key_setup_execute_home" pnpm run pi:ssh-key-setup -- --execute >"$TMP_DIR/pi-ssh-key-setup-existing.out"
assert_contains "$TMP_DIR/pi-ssh-key-setup-existing.out" "PI_SSH_KEY_SETUP=exists" "pi ssh key setup refuses to overwrite existing key"

ssh_key_home="$TMP_DIR/ssh-key-home"
mkdir -p "$ssh_key_home/.ssh"
printf 'test private key placeholder\n' >"$ssh_key_home/.ssh/id_ed25519"
printf 'ssh-ed25519 test-public-key distributed-cognition-test\n' >"$ssh_key_home/.ssh/id_ed25519.pub"
chmod 600 "$ssh_key_home/.ssh/id_ed25519"
chmod 644 "$ssh_key_home/.ssh/id_ed25519.pub"
HOME="$ssh_key_home" pnpm run pi:ssh-key-check -- \
  --host nanoclaw-pi.local \
  --user pi \
  --ssh-timeout 8 \
  >"$TMP_DIR/pi-ssh-key-check-local.out"
assert_contains "$TMP_DIR/pi-ssh-key-check-local.out" "PI_SSH_KEY_CHECK=local_ready" "pi ssh key check reports local readiness"
assert_contains "$TMP_DIR/pi-ssh-key-check-local.out" "No SSH was opened" "pi ssh key check is non-mutating by default"
assert_contains "$TMP_DIR/pi-ssh-key-check-local.out" "BatchMode=yes" "pi ssh key check dry-run includes non-interactive batch mode"
assert_contains "$TMP_DIR/pi-ssh-key-check-local.out" "StrictHostKeyChecking=accept-new" "pi ssh key check dry-run includes host key default"
assert_contains "$TMP_DIR/pi-ssh-key-check-local.out" "ConnectTimeout=8" "pi ssh key check dry-run includes configured timeout"

dedicated_key_home="$TMP_DIR/dedicated-key-home"
mkdir -p "$dedicated_key_home/.ssh"
printf 'dedicated private key placeholder\n' >"$dedicated_key_home/.ssh/distributed_cognition_pi_ed25519"
printf 'ssh-ed25519 dedicated-public-key distributed-cognition-test\n' >"$dedicated_key_home/.ssh/distributed_cognition_pi_ed25519.pub"
printf 'default private key placeholder\n' >"$dedicated_key_home/.ssh/id_ed25519"
printf 'ssh-ed25519 default-public-key distributed-cognition-test\n' >"$dedicated_key_home/.ssh/id_ed25519.pub"
chmod 600 "$dedicated_key_home/.ssh/distributed_cognition_pi_ed25519" "$dedicated_key_home/.ssh/id_ed25519"
chmod 644 "$dedicated_key_home/.ssh/distributed_cognition_pi_ed25519.pub" "$dedicated_key_home/.ssh/id_ed25519.pub"
HOME="$dedicated_key_home" pnpm run pi:ssh-key-check -- \
  --host nanoclaw-pi.local \
  --user pi \
  >"$TMP_DIR/pi-ssh-key-check-dedicated.out"
assert_contains "$TMP_DIR/pi-ssh-key-check-dedicated.out" "first_identity=$dedicated_key_home/.ssh/distributed_cognition_pi_ed25519" "pi ssh key check prefers dedicated DC identity"

no_key_home="$TMP_DIR/no-key-home"
mkdir -p "$no_key_home/.ssh"
set +e
HOME="$no_key_home" pnpm run pi:ssh-key-check -- --strict >"$TMP_DIR/pi-ssh-key-check-no-key.out" 2>"$TMP_DIR/pi-ssh-key-check-no-key.err"
ssh_key_no_key_code="$?"
set -e
assert_exit_code 1 "$ssh_key_no_key_code" "strict pi ssh key check fails when no key exists"
assert_contains "$TMP_DIR/pi-ssh-key-check-no-key.out" "PI_SSH_KEY_CHECK=missing_key" "pi ssh key check reports missing key"
assert_contains "$TMP_DIR/pi-ssh-key-check-no-key.out" "pnpm run pi:ssh-key-setup -- --execute" "pi ssh key check suggests setup helper"
assert_contains "$TMP_DIR/pi-ssh-key-check-no-key.out" "distributed_cognition_pi_ed25519" "pi ssh key check suggests dedicated key generation"
assert_contains "$TMP_DIR/pi-ssh-key-check-no-key.out" 'export NANOCLAW_PI_SSH_IDENTITY_FILE="$HOME/.ssh/distributed_cognition_pi_ed25519"' "pi ssh key check suggests identity-file env"
assert_contains "$TMP_DIR/pi-ssh-key-check-no-key.out" 'ssh-copy-id -i "$NANOCLAW_PI_SSH_IDENTITY_FILE.pub"' "pi ssh key check suggests copying dedicated public key"

fake_ssh_key_bin="$TMP_DIR/fake-ssh-key-bin"
mkdir -p "$fake_ssh_key_bin"
cat >"$fake_ssh_key_bin/ssh" <<'FAKE_SSH_KEY_LOGIN'
#!/usr/bin/env bash
set -euo pipefail
[ -z "${FAKE_SSH_KEY_ARGS:-}" ] || printf '%s\n' "$@" >"$FAKE_SSH_KEY_ARGS"
echo "PI_SSH_KEY_LOGIN=ok"
echo "remote_host=fake-pi"
echo "remote_user=pi"
FAKE_SSH_KEY_LOGIN
chmod +x "$fake_ssh_key_bin/ssh"
PATH="$fake_ssh_key_bin:$PATH" HOME="$ssh_key_home" FAKE_SSH_KEY_ARGS="$TMP_DIR/pi-ssh-key-login-args.txt" pnpm run pi:ssh-key-check -- \
  --host nanoclaw-pi.local \
  --user pi \
  --test-login \
  >"$TMP_DIR/pi-ssh-key-check-login.out"
assert_contains "$TMP_DIR/pi-ssh-key-check-login.out" "PI_SSH_KEY_CHECK=login_ok" "pi ssh key check can prove fake non-interactive login"
assert_contains "$TMP_DIR/pi-ssh-key-login-args.txt" "BatchMode=yes" "pi ssh key login passes batch mode"
assert_contains "$TMP_DIR/pi-ssh-key-login-args.txt" "StrictHostKeyChecking=accept-new" "pi ssh key login passes host key default"

operator_env_root="$TMP_DIR/operator-env-root"
mkdir -p "$operator_env_root"
cat >"$TMP_DIR/operator-env-complete.sh" <<OPERATOR_ENV_COMPLETE
# Distributed Cognition Pi Operator Environment
export DC_SECOND_BRAIN_ROOT=$operator_env_root
export NANOCLAW_PI_HOST=nanoclaw-pi.local
export NANOCLAW_PI_USER=pi
export NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw
export NANOCLAW_PI_SECOND_BRAIN_ROOT=/home/pi/Distributed-Cognition
export NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex
export NANOCLAW_PI_RCLONE_REMOTE=dropbox:
export NANOCLAW_PI_SSH_CONNECT_TIMEOUT=10
export NANOCLAW_PI_BRIDGE_EXECUTE_MODE=memory
export NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE=memory
export NANOCLAW_PI_EXPECTED_COMMIT=abcdef1234567890
export NANOCLAW_PI_REPO_URL=https://github.com/chowminyang/DistributedCognition.git
export NANOCLAW_PI_BRANCH=main
export NANOCLAW_PI_MIGRATION_DATE=02-06-26
OPERATOR_ENV_COMPLETE
pnpm run pi:operator-env-check -- \
  --operator-env "$TMP_DIR/operator-env-complete.sh" \
  --strict \
  >"$TMP_DIR/pi-operator-env-check-ready.out"
assert_contains "$TMP_DIR/pi-operator-env-check-ready.out" "PI_OPERATOR_ENV_CHECK=ready" "pi operator env check accepts complete values"
assert_contains "$TMP_DIR/pi-operator-env-check-ready.out" "No SSH was opened" "pi operator env check is non-mutating"
assert_contains "$TMP_DIR/pi-operator-env-check-ready.out" "pi_target=pi@nanoclaw-pi.local" "pi operator env check parses the operator env file"

cat >"$TMP_DIR/operator-env-missing.sh" <<'OPERATOR_ENV_MISSING'
# Distributed Cognition Pi Operator Environment
# Missing: Pi host or IP
# export NANOCLAW_PI_HOST=<set-this>
export NANOCLAW_PI_USER=pi
OPERATOR_ENV_MISSING
set +e
pnpm run pi:operator-env-check -- --operator-env "$TMP_DIR/operator-env-missing.sh" --strict >"$TMP_DIR/pi-operator-env-check-missing.out" 2>"$TMP_DIR/pi-operator-env-check-missing.err"
operator_env_missing_code="$?"
pnpm run pi:operator-env-check -- \
  --local-root "$operator_env_root" \
  --pi-host localhost \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --pi-rclone-remote dropbox: \
  --ssh-timeout 10 \
  --bridge-execute-mode memory \
  --expected-bridge-execute-mode memory \
  --expected-commit abcdef1234567890 \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main \
  --migration-date 02-06-26 \
  >"$TMP_DIR/pi-operator-env-check-localhost.out" 2>"$TMP_DIR/pi-operator-env-check-localhost.err"
operator_env_localhost_code="$?"
set -e
assert_exit_code 1 "$operator_env_missing_code" "strict pi operator env check fails when values are missing"
assert_exit_code 1 "$operator_env_localhost_code" "pi operator env check fails when Pi host is localhost"
assert_contains "$TMP_DIR/pi-operator-env-check-missing.out" "PI_OPERATOR_ENV_CHECK=missing_values" "pi operator env check reports missing values"
assert_contains "$TMP_DIR/pi-operator-env-check-missing.out" "operator env still has unresolved line" "pi operator env check reports unresolved operator env lines"
assert_contains "$TMP_DIR/pi-operator-env-check-localhost.out" "PI_OPERATOR_ENV_CHECK=fail" "pi operator env check reports failure status"
assert_contains "$TMP_DIR/pi-operator-env-check-localhost.out" "target the Mac rather than the Pi" "pi operator env check refuses localhost"

fake_discovery_bin="$TMP_DIR/fake-discovery-bin"
mkdir -p "$fake_discovery_bin"
cat >"$fake_discovery_bin/getent" <<'FAKE_GETENT'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "hosts" ] && [ "${2:-}" = "nanoclaw-pi.local" ]; then
  printf '192.168.1.43 nanoclaw-pi.local\n'
  exit 0
fi
exit 2
FAKE_GETENT
cat >"$fake_discovery_bin/dns-sd" <<'FAKE_DNS_SD'
#!/usr/bin/env bash
set -euo pipefail
printf 'Browsing for _ssh._tcp.local.\n'
printf 'DATE TIME Add 2 4 local. Raspberry Pi SSH\n'
FAKE_DNS_SD
cat >"$fake_discovery_bin/arp" <<'FAKE_ARP'
#!/usr/bin/env bash
set -euo pipefail
printf '? (192.168.1.42) at b8:27:eb:aa:bb:cc on en0 ifscope [ethernet]\n'
FAKE_ARP
chmod +x "$fake_discovery_bin/getent" "$fake_discovery_bin/dns-sd" "$fake_discovery_bin/arp"
PATH="$fake_discovery_bin:$PATH" pnpm run pi:discover -- --timeout 1 --host nanoclaw-pi.local >"$TMP_DIR/pi-discover.out"
assert_contains "$TMP_DIR/pi-discover.out" "PI_DISCOVERY=ok" "pi discovery reports ok status"
assert_contains "$TMP_DIR/pi-discover.out" "No SSH was opened. No state was changed." "pi discovery is non-mutating"
assert_contains "$TMP_DIR/pi-discover.out" "nanoclaw-pi.local" "pi discovery checks requested host"
assert_contains "$TMP_DIR/pi-discover.out" "192.168.1.43" "pi discovery reports resolved host"
assert_contains "$TMP_DIR/pi-discover.out" "Raspberry Pi SSH" "pi discovery reports SSH service browse"
assert_contains "$TMP_DIR/pi-discover.out" "192.168.1.42" "pi discovery reports Raspberry Pi ARP candidate"
assert_contains "$TMP_DIR/pi-discover.out" "pnpm run pi:mac-readiness -- --include-ssh-preflight" "pi discovery suggests readiness preflight"

fake_rclone_bin="$TMP_DIR/fake-rclone-bin"
mkdir -p "$fake_rclone_bin"
cat >"$fake_rclone_bin/rclone" <<'FAKE_RCLONE'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  listremotes)
    printf 'other:\n'
    ;;
  config)
    printf '__RCLONE_CONFIG_CALLED__\n'
    exit 43
    ;;
  *)
    exit 0
    ;;
esac
FAKE_RCLONE
cat >"$fake_rclone_bin/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
exit 0
FAKE_SYSTEMCTL
chmod +x "$fake_rclone_bin/rclone" "$fake_rclone_bin/systemctl"
HOME="$TMP_DIR/pi-home" PATH="$fake_rclone_bin:$PATH" bash scripts/pi-install-dropbox-sync.sh \
  --local "$TMP_DIR/pi-home/Distributed-Cognition" \
  --remote dropbox:Distributed-Cognition \
  --interval 9min \
  --mode copy \
  >"$TMP_DIR/pi-install-dropbox-sync.out" \
  2>"$TMP_DIR/pi-install-dropbox-sync.err"
assert_contains "$TMP_DIR/pi-install-dropbox-sync.err" "Warning: rclone remote dropbox: is not configured yet." "pi Dropbox sync warns when rclone remote is missing"
assert_contains "$TMP_DIR/pi-install-dropbox-sync.err" "Run 'rclone config'" "pi Dropbox sync prints rclone config instruction literally"
assert_not_contains "$TMP_DIR/pi-install-dropbox-sync.err" "__RCLONE_CONFIG_CALLED__" "pi Dropbox sync warning does not execute rclone config"
assert_contains "$TMP_DIR/pi-install-dropbox-sync.out" "Mode: copy" "pi Dropbox sync renders timer without starting it"

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
assert_contains "$TMP_DIR/bridge-timer-render.out" "Bridge execute mode: all" "bridge timer render reports all execute mode"
assert_contains "$TMP_DIR/bridge-timer-render.out" "Bridge jobs execute queued memory, Codex, and action work." "bridge timer render reports all queue execution"

bridge_timer_memory_dir="$TMP_DIR/bridge-timer-memory-render"
bash scripts/pi-install-bridge-timers.sh \
  --output-dir "$bridge_timer_memory_dir" \
  --root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --interval 5min \
  --unit-prefix dc-bridge-memory-test \
  --bridge-execute-mode memory \
  >"$TMP_DIR/bridge-timer-memory-render.out"
bridge_memory_runner="$bridge_timer_memory_dir/dc-pi-run-bridges-dc-bridge-memory-test.sh"
[ -f "$bridge_memory_runner" ] || fail "bridge timer memory render writes runner"
assert_contains "$bridge_memory_runner" "BRIDGE_EXECUTE_MODE=memory" "bridge runner records memory execute mode"
assert_contains "$bridge_timer_memory_dir/dc-bridge-memory-test-codex-bridge.service" "ExecStart=/bin/bash" "bridge memory render writes codex unit"
assert_contains "$TMP_DIR/bridge-timer-memory-render.out" "Bridge execute mode: memory" "bridge timer render reports memory mode"
assert_contains "$TMP_DIR/bridge-timer-memory-render.out" "Memory bridge executes queued work; Codex/action bridge jobs stay dry-run" "bridge timer memory mode keeps Codex/action dry-run"

action_bridge_root="$TMP_DIR/action-bridge-root"
mkdir -p "$action_bridge_root"
env \
  NANOCLAW_PI_HOST=nanoclaw-pi.local \
  NANOCLAW_PI_USER=pi \
  NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw \
  NANOCLAW_PI_SECOND_BRAIN_ROOT=/home/pi/Distributed-Cognition \
  NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex \
  NANOCLAW_PI_EXPECTED_COMMIT=test-expected-commit \
  pnpm run dc:action-bridge -- init --root "$action_bridge_root" \
    >"$TMP_DIR/action-bridge-init.out"
action_bridge_config="$action_bridge_root/.dc-index/action-bridge.config.json"
[ -f "$action_bridge_config" ] || fail "action bridge init writes config"
assert_contains "$action_bridge_config" '"launchMode": "app-server"' "action bridge defaults to app-visible Codex app-server mode"
assert_contains "$action_bridge_config" '"remoteRuntime"' "action bridge config includes remote runtime section"
assert_contains "$action_bridge_config" '"host": "nanoclaw-pi.local"' "action bridge config captures Pi host context"
assert_contains "$action_bridge_config" '"adminCommand": "pnpm run pi:ssh-admin --"' "action bridge config captures Pi admin helper"

goal_out="$TMP_DIR/codex-goal.out"
pnpm run pi:codex-goal -- \
  --local-root "$TMP_DIR/Distributed-Cognition" \
  --out-dir "$TMP_DIR/export" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --operator-env "$TMP_DIR/operator-env.sh" \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main \
  --migration-date 02-06-26 \
  >"$goal_out"
assert_contains "$goal_out" "/goal" "codex goal starts with slash goal"
assert_contains "$goal_out" "Mac Codex is the control plane" "codex goal names Mac control plane"
assert_contains "$goal_out" "Raspberry Pi is the final always-on Distributed Cognition runtime" "codex goal names Pi runtime"
assert_contains "$goal_out" "Pi operator env file: $TMP_DIR/operator-env.sh" "codex goal records operator env path"
assert_contains "$goal_out" "source \"$TMP_DIR/operator-env.sh\"" "codex goal tells Mac Codex to source operator env"
assert_contains "$goal_out" "If it still has commented \"# Missing:\" lines" "codex goal tells Codex to ask for missing operator env values"
assert_contains "$goal_out" "non-secret Pi control-plane environment" "codex goal tells operator to set Pi environment"
assert_contains "$goal_out" "NANOCLAW_PI_EXPECTED_COMMIT" "codex goal sets expected Pi commit from operator env or current checkout"
assert_contains "$goal_out" "Do not run commands with unresolved <placeholder> values" "codex goal guards against placeholder execution"
assert_contains "$goal_out" "pnpm run pi:ssh-preflight -- --host" "codex goal includes explicit SSH preflight values"
assert_contains "$goal_out" "pnpm run pi:ssh-bootstrap" "codex goal includes SSH bootstrap"
assert_contains "$goal_out" "pnpm run pi:ssh-restore-state" "codex goal includes SSH state restore"
assert_contains "$goal_out" "pnpm run pi:ssh-start-runtime" "codex goal includes SSH runtime start"
assert_contains "$goal_out" "--bridge-execute-mode memory" "codex goal defaults Pi bridge timers to memory mode"
assert_contains "$goal_out" "bridge-timers --expected-bridge-execute-mode memory" "codex goal verifies installed bridge timer memory mode"
assert_contains "$goal_out" "execute path must refuse to start while the Mac NanoClaw host is still running" "codex goal includes Mac host runtime guard"
assert_contains "$goal_out" "Mac NanoClaw Docker agent containers are still running" "codex goal includes Mac Docker runtime guard"
assert_contains "$goal_out" "Mac runtime lock under logs/pi-cutover/" "codex goal includes Mac runtime lock"
assert_contains "$goal_out" "--proof-text" "codex goal includes Pi WhatsApp persistence proof"
assert_contains "$goal_out" "--expected-commit" "codex goal includes expected commit verification"
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
assert_contains "$plan_out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT=10" "cutover plan exports SSH timeout"
assert_contains "$plan_out" "pnpm run pi:ssh-key-check -- --test-login" "cutover plan proves SSH key login before preflight"
assert_contains "$plan_out" "pnpm run pi:ssh-preflight" "cutover plan includes SSH preflight"
assert_contains "$plan_out" "pnpm run pi:ssh-restore-state" "cutover plan includes SSH state restore"
assert_contains "$plan_out" "pnpm run pi:ssh-start-runtime" "cutover plan includes SSH runtime start"
assert_contains "$plan_out" "NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE=memory" "cutover plan exports expected bridge timer mode"
assert_contains "$plan_out" "--bridge-execute-mode memory" "cutover plan defaults Pi bridge timers to memory mode"
assert_contains "$plan_out" 'bridge-timers --expected-bridge-execute-mode "$NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE"' "cutover plan verifies installed bridge timer mode through env"
assert_contains "$plan_out" "Mac NanoClaw host or NanoClaw Docker agent containers appear to be running" "cutover plan documents Mac host and Docker runtime guard"
assert_contains "$plan_out" "logs/pi-cutover/mac-runtime-disabled.lock" "cutover plan documents Mac runtime lock"
assert_contains "$plan_out" "pnpm run pi:ssh-admin -- doctor" "cutover plan includes Pi doctor check"
assert_contains "$plan_out" "--proof-text" "cutover plan includes Pi WhatsApp persistence proof"
assert_contains "$plan_out" "NANOCLAW_PI_EXPECTED_COMMIT" "cutover plan records expected Pi commit"
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
mkdir -p "$TMP_DIR/Distributed-Cognition"
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
[ -f "$rehearsal_dir/operator-env-check.txt" ] || fail "cutover rehearsal writes operator env check"
[ -f "$rehearsal_dir/codex-goal.md" ] || fail "cutover rehearsal writes codex goal"
[ -f "$rehearsal_dir/cutover-plan.txt" ] || fail "cutover rehearsal writes cutover plan"
[ -f "$rehearsal_dir/ssh-bootstrap-dry-run.txt" ] || fail "cutover rehearsal writes ssh bootstrap dry-run"
[ -f "$rehearsal_dir/ssh-restore-state-dry-run.txt" ] || fail "cutover rehearsal writes ssh state restore dry-run"
[ -f "$rehearsal_dir/ssh-start-runtime-dry-run.txt" ] || fail "cutover rehearsal writes ssh runtime start dry-run"
assert_contains "$rehearsal_dir/codex-goal.md" "/goal" "cutover rehearsal includes goal prompt"
assert_contains "$rehearsal_dir/codex-goal.md" "Pi operator env file: $rehearsal_dir/operator-env.sh" "cutover rehearsal codex goal names operator env"
assert_contains "$rehearsal_dir/codex-goal.md" "source \"$rehearsal_dir/operator-env.sh\"" "cutover rehearsal codex goal sources operator env"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_HOST=nanoclaw-pi.local" "cutover rehearsal operator env includes Pi host"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex" "cutover rehearsal operator env includes Codex projects root"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_SSH_CONNECT_TIMEOUT=10" "cutover rehearsal operator env includes SSH timeout"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_BRIDGE_EXECUTE_MODE=memory" "cutover rehearsal operator env defaults bridge mode to memory"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE=memory" "cutover rehearsal operator env records expected bridge timer mode"
assert_contains "$rehearsal_dir/operator-env.sh" "export NANOCLAW_PI_EXPECTED_COMMIT=" "cutover rehearsal operator env includes expected Pi commit"
assert_not_contains "$rehearsal_dir/operator-env.sh" "OPENAI_API_KEY" "cutover rehearsal operator env excludes API keys"
assert_not_contains "$rehearsal_dir/operator-env.sh" "WHATSAPP_" "cutover rehearsal operator env excludes WhatsApp env vars"
assert_contains "$rehearsal_dir/operator-env-check.txt" "PI_OPERATOR_ENV_CHECK=ready" "cutover rehearsal validates complete operator env"
assert_contains "$rehearsal_dir/cutover-plan.txt" "CUTOVER_PLAN=ready" "cutover rehearsal includes ready cutover plan"
assert_contains "$rehearsal_dir/ssh-bootstrap-dry-run.txt" "PI_SSH_BOOTSTRAP=dry_run" "cutover rehearsal includes bootstrap dry-run"
assert_contains "$rehearsal_dir/ssh-restore-state-dry-run.txt" "PI_SSH_RESTORE_STATE=dry_run" "cutover rehearsal includes state restore dry-run"
assert_contains "$rehearsal_dir/ssh-start-runtime-dry-run.txt" "PI_SSH_START_RUNTIME=dry_run" "cutover rehearsal includes runtime start dry-run"
assert_contains "$rehearsal_dir/ssh-start-runtime-dry-run.txt" "--bridge-execute-mode memory" "cutover rehearsal runtime dry-run uses memory bridge mode"
assert_contains "$rehearsal_dir/summary.md" "No SSH was opened" "cutover rehearsal summary states no SSH"
assert_contains "$rehearsal_dir/summary.md" "operator-env.sh" "cutover rehearsal summary lists operator env artifact"
assert_contains "$rehearsal_dir/summary.md" "operator-env-check.txt" "cutover rehearsal summary lists operator env check artifact"
assert_contains "$rehearsal_dir/summary.md" "pi:operator-env-check" "cutover rehearsal summary includes operator env check command"
assert_contains "$rehearsal_dir/summary.md" "Pi bridge execute mode: \`memory\`" "cutover rehearsal summary records bridge mode"
assert_contains "$rehearsal_dir/summary.md" "Expected Pi commit" "cutover rehearsal summary records expected Pi commit"
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
readiness_remote="$TMP_DIR/readiness-remote.git"
git init --bare --initial-branch=main "$readiness_remote" >/dev/null
git push "$readiness_remote" HEAD:refs/heads/main >/dev/null 2>&1
HOME="$ssh_key_home" pnpm run pi:mac-readiness -- \
  --local-root "$readiness_root" \
  --out-dir "$TMP_DIR/export" \
  --output-dir "$readiness_dir" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url "$readiness_remote" \
  --branch main \
  --migration-date 02-06-26 \
  --skip-health \
  --skip-public-readiness \
  >"$TMP_DIR/readiness.out"
assert_contains "$TMP_DIR/readiness.out" "PI_MAC_READINESS=" "mac readiness reports status"
assert_contains "$TMP_DIR/readiness.out" "No SSH was opened" "mac readiness is non-mutating"
[ -f "$readiness_dir/summary.md" ] || fail "mac readiness writes summary"
[ -f "$readiness_dir/git-status.txt" ] || fail "mac readiness writes git status"
[ -f "$readiness_dir/git-revision-check.txt" ] || fail "mac readiness writes git revision check"
[ -f "$readiness_dir/public-readiness.txt" ] || fail "mac readiness writes public-readiness artifact"
[ -f "$readiness_dir/health.json" ] || fail "mac readiness writes health artifact"
[ -f "$readiness_dir/mac-preflight.txt" ] || fail "mac readiness writes mac preflight"
[ -f "$readiness_dir/pi-first-boot-checklist.txt" ] || fail "mac readiness writes pi first boot checklist artifact"
[ -f "$readiness_dir/pi-discovery.txt" ] || fail "mac readiness writes pi discovery artifact"
[ -f "$readiness_dir/ssh-key-setup.txt" ] || fail "mac readiness writes ssh key setup dry-run artifact"
[ -f "$readiness_dir/ssh-key-check.txt" ] || fail "mac readiness writes ssh key check artifact"
[ -f "$readiness_dir/operator-env-check.txt" ] || fail "mac readiness writes operator env check artifact"
[ -f "$readiness_dir/ssh-preflight.txt" ] || fail "mac readiness writes ssh preflight artifact"
[ -f "$readiness_dir/next-action.md" ] || fail "mac readiness writes next action artifact"
[ -f "$readiness_dir/rehearsal/operator-env.sh" ] || fail "mac readiness writes nested operator env"
[ -f "$readiness_dir/rehearsal/operator-env-check.txt" ] || fail "mac readiness writes nested operator env check"
[ -f "$readiness_dir/rehearsal/summary.md" ] || fail "mac readiness writes nested rehearsal summary"
assert_contains "$readiness_dir/public-readiness.txt" "Skipped" "mac readiness can skip public readiness"
assert_contains "$readiness_dir/health.json" "Skipped" "mac readiness can skip health"
assert_contains "$readiness_dir/ssh-preflight.txt" "Skipped: --include-ssh-preflight was not supplied" "mac readiness skips SSH preflight by default"
assert_contains "$readiness_dir/pi-first-boot-checklist.txt" "PI_FIRST_BOOT_CHECKLIST=needs_ssh_key" "mac readiness includes first boot checklist"
assert_contains "$readiness_dir/pi-first-boot-checklist.txt" "No SSH was opened" "mac readiness first boot checklist is non-mutating"
assert_contains "$readiness_dir/next-action.md" "Create the dedicated Mac-to-Pi SSH key" "mac readiness next action explains dedicated key gate"
assert_contains "$readiness_dir/next-action.md" "pi-first-boot-checklist.txt" "mac readiness next action points to first boot checklist"
assert_contains "$readiness_dir/next-action.md" "Keep WhatsApp active on only one host" "mac readiness next action records WhatsApp invariant"
assert_contains "$readiness_dir/pi-discovery.txt" "PI_DISCOVERY=ok" "mac readiness includes non-mutating Pi discovery"
assert_contains "$readiness_dir/ssh-key-setup.txt" "PI_SSH_KEY_SETUP=dry_run" "mac readiness includes SSH key setup dry-run"
assert_contains "$readiness_dir/ssh-key-setup.txt" "No SSH was opened" "mac readiness SSH key setup is non-mutating"
assert_contains "$readiness_dir/ssh-key-check.txt" "PI_SSH_KEY_CHECK=local_ready" "mac readiness includes local SSH key check"
assert_contains "$readiness_dir/git-revision-check.txt" "GIT_REMOTE_COMMIT=ok" "mac readiness verifies expected commit is on configured branch"
assert_contains "$readiness_dir/summary.md" "git-revision-check.txt" "mac readiness summary lists git revision check"
assert_contains "$readiness_dir/summary.md" "pi-first-boot-checklist.txt" "mac readiness summary lists pi first boot checklist artifact"
assert_contains "$readiness_dir/summary.md" "pi-discovery.txt" "mac readiness summary lists pi discovery artifact"
assert_contains "$readiness_dir/summary.md" "ssh-key-setup.txt" "mac readiness summary lists ssh key setup artifact"
assert_contains "$readiness_dir/summary.md" "ssh-key-check.txt" "mac readiness summary lists ssh key check artifact"
assert_contains "$readiness_dir/summary.md" "operator-env-check.txt" "mac readiness summary lists operator env check artifact"
assert_contains "$readiness_dir/summary.md" "ssh-preflight.txt" "mac readiness summary lists ssh preflight artifact"
assert_contains "$readiness_dir/summary.md" "next-action.md" "mac readiness summary lists next action artifact"
assert_contains "$readiness_dir/summary.md" "rehearsal/operator-env.sh" "mac readiness summary lists nested operator env"
assert_contains "$readiness_dir/summary.md" "rehearsal/operator-env-check.txt" "mac readiness summary lists nested operator env check"
assert_contains "$readiness_dir/summary.md" "Expected Pi commit" "mac readiness summary records expected Pi commit"
assert_contains "$readiness_dir/rehearsal/codex-goal.md" "Pi operator env file: $readiness_dir/rehearsal/operator-env.sh" "mac readiness nested goal names operator env"
assert_contains "$readiness_dir/rehearsal/codex-goal.md" "pi:operator-env-check" "mac readiness nested goal validates operator env"
assert_contains "$readiness_dir/rehearsal/operator-env.sh" "export NANOCLAW_PI_BRIDGE_EXECUTE_MODE=memory" "mac readiness nested rehearsal carries bridge memory mode"
assert_contains "$readiness_dir/rehearsal/operator-env.sh" "export NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE=memory" "mac readiness nested rehearsal carries expected bridge timer mode"
assert_contains "$readiness_dir/rehearsal/operator-env.sh" "export NANOCLAW_PI_EXPECTED_COMMIT=" "mac readiness nested rehearsal carries expected commit"
assert_contains "$readiness_dir/operator-env-check.txt" "PI_OPERATOR_ENV_CHECK=ready" "mac readiness validates operator env before optional SSH"
assert_contains "$readiness_dir/rehearsal/summary.md" "Status: \`ready\`" "mac readiness nested rehearsal is ready with complete values"

fake_bin="$TMP_DIR/fake-bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
echo "MOCK_SSH_PREFLIGHT=ok"
echo "PREFLIGHT_RESULT=ok failures=0 warnings=0"
FAKE_SSH
chmod +x "$fake_bin/ssh"
readiness_ssh_dir="$TMP_DIR/readiness-with-ssh"
PATH="$fake_bin:$PATH" HOME="$ssh_key_home" pnpm run pi:mac-readiness -- \
  --local-root "$readiness_root" \
  --out-dir "$TMP_DIR/export" \
  --output-dir "$readiness_ssh_dir" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url "$readiness_remote" \
  --branch main \
  --migration-date 02-06-26 \
  --skip-health \
  --skip-public-readiness \
  --skip-remote-check \
  --include-ssh-preflight \
  >"$TMP_DIR/readiness-with-ssh.out"
assert_contains "$readiness_ssh_dir/ssh-preflight.txt" "MOCK_SSH_PREFLIGHT=ok" "mac readiness can include SSH preflight"
assert_contains "$readiness_ssh_dir/ssh-preflight.txt" "--ssh-option ConnectTimeout=10" "mac readiness passes SSH preflight timeout explicitly"
assert_contains "$readiness_ssh_dir/summary.md" "SSH preflight was attempted" "mac readiness summary distinguishes SSH preflight mode"
assert_contains "$TMP_DIR/readiness-with-ssh.out" "SSH preflight was attempted" "mac readiness stdout distinguishes SSH preflight mode"

no_ssh_bin="$TMP_DIR/no-ssh-bin"
mkdir -p "$no_ssh_bin"
cat >"$no_ssh_bin/ssh" <<'NO_SSH'
#!/usr/bin/env bash
set -euo pipefail
touch "${NO_SSH_SENTINEL:?}"
echo "ssh should not have been called" >&2
exit 99
NO_SSH
chmod +x "$no_ssh_bin/ssh"
no_ssh_sentinel="$TMP_DIR/no-ssh-called"
readiness_unsafe_host_dir="$TMP_DIR/readiness-unsafe-host"
set +e
PATH="$no_ssh_bin:$PATH" NO_SSH_SENTINEL="$no_ssh_sentinel" pnpm run pi:mac-readiness -- \
  --local-root "$readiness_root" \
  --out-dir "$TMP_DIR/export" \
  --output-dir "$readiness_unsafe_host_dir" \
  --pi-host localhost \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url "$readiness_remote" \
  --branch main \
  --migration-date 02-06-26 \
  --skip-health \
  --skip-public-readiness \
  --skip-remote-check \
  --include-ssh-preflight \
  >"$TMP_DIR/readiness-unsafe-host.out" \
  2>"$TMP_DIR/readiness-unsafe-host.err"
readiness_unsafe_host_code="$?"
set -e
assert_exit_code 1 "$readiness_unsafe_host_code" "mac readiness refuses unsafe localhost Pi host before SSH"
assert_contains "$readiness_unsafe_host_dir/operator-env-check.txt" "PI_OPERATOR_ENV_CHECK=fail" "mac readiness records unsafe operator env failure"
assert_contains "$readiness_unsafe_host_dir/ssh-preflight.txt" "Skipped: operator environment check did not report ready" "mac readiness skips SSH preflight when operator env is unsafe"
[ ! -e "$no_ssh_sentinel" ] || fail "mac readiness opened SSH despite unsafe Pi host"

set +e
pnpm run pi:mac-readiness -- --strict --output-dir "$TMP_DIR/readiness-missing" --skip-health --skip-public-readiness --skip-remote-check >"$TMP_DIR/readiness-missing.out" 2>"$TMP_DIR/readiness-missing.err"
readiness_missing_code="$?"
set -e
assert_exit_code 1 "$readiness_missing_code" "strict mac readiness fails when values are missing"
assert_contains "$TMP_DIR/readiness-missing.out" "PI_MAC_READINESS=missing_values" "strict mac readiness reports missing values"
assert_contains "$TMP_DIR/readiness-missing.out" "operator_env=$TMP_DIR/readiness-missing/rehearsal/operator-env.sh" "strict mac readiness prints fillable operator env path"
assert_contains "$TMP_DIR/readiness-missing.out" "No SSH was opened" "strict mac readiness remains non-mutating"
[ -f "$TMP_DIR/readiness-missing/rehearsal/operator-env.sh" ] || fail "strict mac readiness writes missing-value operator env"
[ -f "$TMP_DIR/readiness-missing/operator-env-check.txt" ] || fail "strict mac readiness writes operator env check"
[ -f "$TMP_DIR/readiness-missing/rehearsal/operator-env-check.txt" ] || fail "strict mac readiness writes missing-value operator env check"
[ -f "$TMP_DIR/readiness-missing/pi-first-boot-checklist.txt" ] || fail "strict mac readiness writes pi first boot checklist artifact"
[ -f "$TMP_DIR/readiness-missing/pi-discovery.txt" ] || fail "strict mac readiness writes pi discovery artifact"
[ -f "$TMP_DIR/readiness-missing/ssh-key-setup.txt" ] || fail "strict mac readiness writes ssh key setup dry-run artifact"
[ -f "$TMP_DIR/readiness-missing/next-action.md" ] || fail "strict mac readiness writes next action artifact"
assert_contains "$TMP_DIR/readiness-missing/summary.md" "Fillable Operator Environment" "strict mac readiness explains fillable operator env"
assert_contains "$TMP_DIR/readiness-missing/summary.md" "Check \`pi-discovery.txt\` for passive local-network hints" "strict mac readiness points to pi discovery"
assert_contains "$TMP_DIR/readiness-missing/summary.md" "rehearsal/operator-env.sh" "strict mac readiness summary points to operator env"
assert_contains "$TMP_DIR/readiness-missing/pi-discovery.txt" "No SSH was opened. No state was changed." "strict mac readiness discovery is non-mutating"
assert_contains "$TMP_DIR/readiness-missing/pi-first-boot-checklist.txt" "PI_FIRST_BOOT_CHECKLIST=" "strict mac readiness includes first boot checklist artifact"
assert_contains "$TMP_DIR/readiness-missing/pi-first-boot-checklist.txt" "Raspberry Pi Imager Settings" "strict mac readiness first boot checklist includes imager settings"
assert_contains "$TMP_DIR/readiness-missing/ssh-key-setup.txt" "PI_SSH_KEY_SETUP=" "strict mac readiness includes SSH key setup artifact"
assert_contains "$TMP_DIR/readiness-missing/summary.md" "pi-first-boot-checklist.txt" "strict mac readiness summary lists first boot checklist artifact"
assert_contains "$TMP_DIR/readiness-missing/summary.md" "ssh-key-setup.txt" "strict mac readiness summary lists ssh key setup artifact"
assert_contains "$TMP_DIR/readiness-missing/summary.md" "next-action.md" "strict mac readiness summary lists next action artifact"
assert_contains "$TMP_DIR/readiness-missing/next-action.md" "Create the dedicated Mac-to-Pi SSH key" "strict mac readiness next action explains key gate"
assert_contains "$TMP_DIR/readiness-missing/rehearsal/operator-env.sh" "# Missing: Pi host or IP" "strict mac readiness operator env marks missing Pi host"
assert_contains "$TMP_DIR/readiness-missing/rehearsal/operator-env.sh" "# Missing: Pi Codex projects folder" "strict mac readiness operator env marks missing Pi Codex projects root"
assert_contains "$TMP_DIR/readiness-missing/rehearsal/operator-env.sh" "export NANOCLAW_PI_EXPECTED_COMMIT=" "strict mac readiness operator env still records expected commit"
assert_contains "$TMP_DIR/readiness-missing/operator-env-check.txt" "PI_OPERATOR_ENV_CHECK=missing_values" "strict mac readiness operator env check reports missing values"
assert_contains "$TMP_DIR/readiness-missing/rehearsal/operator-env-check.txt" "PI_OPERATOR_ENV_CHECK=missing_values" "strict mac readiness nested operator env check reports missing values"

pnpm run pi:mac-readiness -- --help >"$TMP_DIR/readiness-help.out"
assert_contains "$TMP_DIR/readiness-help.out" "--include-ssh-preflight" "mac readiness help documents optional SSH preflight"
assert_contains "$TMP_DIR/readiness-help.out" "--skip-discovery" "mac readiness help documents optional Pi discovery skip"

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
[ -f "$verify_dir/mac-runtime-lock.txt" ] || fail "cutover verification writes Mac runtime lock check"
[ -f "$verify_dir/pi-status.txt" ] || fail "cutover verification writes Pi status check"
[ -f "$verify_dir/pi-health.txt" ] || fail "cutover verification writes Pi health check"
[ -f "$verify_dir/pi-dashboard.txt" ] || fail "cutover verification writes Pi dashboard check"
[ -f "$verify_dir/pi-logs.txt" ] || fail "cutover verification writes optional logs check"
[ -f "$verify_dir/pi-whatsapp-proof.txt" ] || fail "cutover verification writes WhatsApp persistence proof"
[ -f "$verify_dir/manual-whatsapp-checklist.md" ] || fail "cutover verification writes WhatsApp checklist"
assert_contains "$verify_dir/mac-stopped-check.txt" "pnpm run pi:mac-preflight" "cutover verification checks Mac stopped state"
assert_contains "$verify_dir/mac-runtime-lock.txt" "Expected lock path" "cutover verification checks Mac runtime lock"
assert_contains "$verify_dir/mac-runtime-lock.txt" "logs/pi-cutover/mac-runtime-disabled.lock" "cutover verification names Mac runtime lock path"
assert_contains "$verify_dir/pi-status.txt" "pnpm run pi:ssh-admin -- status" "cutover verification checks Pi status"
assert_contains "$verify_dir/pi-status.txt" "--expected-commit" "cutover verification checks expected Pi commit"
[ -f "$verify_dir/pi-bridge-timers.txt" ] || fail "cutover verification writes Pi bridge timer check"
assert_contains "$verify_dir/pi-bridge-timers.txt" "pnpm run pi:ssh-admin -- bridge-timers" "cutover verification checks Pi bridge timers"
assert_contains "$verify_dir/pi-bridge-timers.txt" "--expected-bridge-execute-mode memory" "cutover verification checks Pi bridge timer mode"
assert_contains "$verify_dir/pi-health.txt" "pnpm run pi:ssh-admin -- health" "cutover verification checks Pi health"
assert_contains "$verify_dir/pi-whatsapp-proof.txt" "Status: \`dry_run\`" "cutover verification can dry-run WhatsApp proof"
assert_contains "$verify_dir/pi-whatsapp-proof.txt" "DC Pi cutover proof 02-06-26-1200" "cutover verification records proof phrase"
assert_contains "$verify_dir/summary.md" "pi-bridge-timers.txt" "cutover verification summary lists bridge timer proof"
assert_contains "$verify_dir/summary.md" "mac-runtime-lock.txt" "cutover verification summary lists Mac runtime lock proof"
assert_contains "$verify_dir/summary.md" "Expected Pi commit" "cutover verification summary records expected Pi commit"
assert_contains "$verify_dir/summary.md" "Expected Pi bridge timer mode: \`memory\`" "cutover verification summary records expected bridge timer mode"
assert_contains "$verify_dir/summary.md" "pi-whatsapp-proof.txt" "cutover verification summary lists WhatsApp proof"
assert_contains "$verify_dir/manual-whatsapp-checklist.md" "Do not mark the migration complete" "cutover verification keeps WhatsApp proof explicit"
assert_contains "$verify_dir/manual-whatsapp-checklist.md" "--proof-text" "cutover verification checklist explains proof rerun"

set +e
pnpm run pi:verify-cutover -- --strict --output-dir "$TMP_DIR/verify-missing" >"$TMP_DIR/verify-missing.out" 2>"$TMP_DIR/verify-missing.err"
verify_missing_code="$?"
pnpm run pi:verify-cutover -- --execute --output-dir "$TMP_DIR/verify-execute-missing" >"$TMP_DIR/verify-execute-missing.out" 2>"$TMP_DIR/verify-execute-missing.err"
verify_execute_missing_code="$?"
PATH="$no_ssh_bin:$PATH" NO_SSH_SENTINEL="$no_ssh_sentinel" pnpm run pi:verify-cutover -- \
  --strict \
  --local-root "$TMP_DIR/Distributed-Cognition" \
  --out-dir "$TMP_DIR/export" \
  --output-dir "$TMP_DIR/verify-localhost" \
  --host localhost \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  >"$TMP_DIR/verify-localhost.out" \
  2>"$TMP_DIR/verify-localhost.err"
verify_localhost_code="$?"
set -e
assert_exit_code 1 "$verify_missing_code" "strict cutover verification fails when values are missing"
assert_exit_code 2 "$verify_execute_missing_code" "execute cutover verification fails before SSH when values are missing"
assert_exit_code 2 "$verify_localhost_code" "cutover verification refuses localhost before SSH"
assert_contains "$TMP_DIR/verify-missing.out" "PI_CUTOVER_VERIFY=missing_values" "strict cutover verification reports missing values"
assert_contains "$TMP_DIR/verify-missing.out" "No SSH was opened" "strict cutover verification remains non-mutating"
assert_contains "$TMP_DIR/verify-execute-missing.out" "PI_CUTOVER_VERIFY=missing_values" "execute cutover verification reports missing values before SSH"
assert_contains "$TMP_DIR/verify-localhost.err" "Refusing unsafe Pi host" "cutover verification unsafe host error is explicit"
[ ! -e "$no_ssh_sentinel" ] || fail "cutover verification opened SSH despite unsafe Pi host"

pnpm run pi:verify-cutover -- --help >"$TMP_DIR/verify-cutover-help.out"
assert_contains "$TMP_DIR/verify-cutover-help.out" "--proof-text" "cutover verification help documents proof text"
assert_contains "$TMP_DIR/verify-cutover-help.out" "--proof-since-minutes" "cutover verification help documents proof window"
assert_contains "$TMP_DIR/verify-cutover-help.out" "--expected-commit" "cutover verification help documents expected commit"
assert_contains "$TMP_DIR/verify-cutover-help.out" "--expected-bridge-execute-mode" "cutover verification help documents expected bridge timer mode"
assert_contains "$TMP_DIR/verify-cutover-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "cutover verification help documents SSH timeout env"
assert_contains "$TMP_DIR/verify-cutover-help.out" "StrictHostKeyChecking=accept-new" "cutover verification help documents non-interactive SSH host key default"

pnpm run pi:ssh-admin -- --help >"$TMP_DIR/ssh-admin-help.out"
assert_contains "$TMP_DIR/ssh-admin-help.out" "Required options, unless the matching environment defaults are set" "ssh admin help documents env defaults"
assert_contains "$TMP_DIR/ssh-admin-help.out" "BatchMode=yes" "ssh admin help documents -o style ssh options"
assert_contains "$TMP_DIR/ssh-admin-help.out" "StrictHostKeyChecking=accept-new" "ssh admin help documents default host key handling"
assert_contains "$TMP_DIR/ssh-admin-help.out" "doctor" "ssh admin help documents doctor action"
assert_contains "$TMP_DIR/ssh-admin-help.out" "bridge-timers" "ssh admin help documents bridge timer action"
assert_contains "$TMP_DIR/ssh-admin-help.out" "process-bridges" "ssh admin help documents Pi-side bridge processing"
assert_contains "$TMP_DIR/ssh-admin-help.out" "--bridge-execute-mode" "ssh admin help documents bridge mode option"
assert_contains "$TMP_DIR/ssh-admin-help.out" "--expected-bridge-execute-mode" "ssh admin help documents expected bridge timer mode option"
assert_contains "$TMP_DIR/ssh-admin-help.out" "--execute-memory-bridge" "ssh admin help documents memory-only bridge execution"
assert_contains "$TMP_DIR/ssh-admin-help.out" "--execute-bridges" "ssh admin help documents bridge execute flag"
assert_contains "$TMP_DIR/ssh-admin-help.out" "--expected-commit" "ssh admin help documents expected commit"
assert_contains "$TMP_DIR/ssh-admin-help.out" "--allow-mac-host-running" "ssh admin help documents Mac host guard override"
assert_contains "$TMP_DIR/ssh-admin-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh admin help documents SSH timeout env"
assert_contains "$TMP_DIR/ssh-admin-help.out" "NANOCLAW_PI_BRIDGE_EXECUTE_MODE" "ssh admin help documents bridge mode env"
assert_contains "$TMP_DIR/ssh-admin-help.out" "NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE" "ssh admin help documents expected bridge timer mode env"

pnpm run pi:ssh-preflight -- --help >"$TMP_DIR/ssh-preflight-help.out"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "Required options, unless the matching environment defaults are set" "ssh preflight help documents env defaults"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "BatchMode=yes" "ssh preflight help documents -o style ssh options"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "StrictHostKeyChecking=accept-new" "ssh preflight help documents default host key handling"
assert_contains "$TMP_DIR/ssh-preflight-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh preflight help documents SSH timeout env"

pnpm run pi:ssh-bootstrap -- --help >"$TMP_DIR/ssh-bootstrap-help.out"
assert_contains "$TMP_DIR/ssh-bootstrap-help.out" "dry-run by default" "ssh bootstrap help documents dry-run default"
assert_contains "$TMP_DIR/ssh-bootstrap-help.out" "--execute" "ssh bootstrap help documents execute mode"
assert_contains "$TMP_DIR/ssh-bootstrap-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh bootstrap help documents SSH timeout env"

pnpm run pi:ssh-restore-state -- --help >"$TMP_DIR/ssh-restore-help.out"
assert_contains "$TMP_DIR/ssh-restore-help.out" "dry-run by default" "ssh restore help documents dry-run default"
assert_contains "$TMP_DIR/ssh-restore-help.out" "verifies the checksum on the Pi" "ssh restore help documents remote checksum verification"
assert_contains "$TMP_DIR/ssh-restore-help.out" "--allow-mac-host-running" "ssh restore help documents Mac host guard override"
assert_contains "$TMP_DIR/ssh-restore-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh restore help documents SSH timeout env"

pnpm run pi:ssh-start-runtime -- --help >"$TMP_DIR/ssh-start-runtime-help.out"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "dry-run by default" "ssh start runtime help documents dry-run default"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "systemd installation/startup" "ssh start runtime help documents systemd startup"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "--skip-bridge-timers" "ssh start runtime help documents bridge timer skip"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "--bridge-execute-mode" "ssh start runtime help documents bridge mode option"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "--execute-memory-bridge" "ssh start runtime help documents memory-only bridge timer mode"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "--execute-bridges" "ssh start runtime help documents bridge timer execute mode"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "--allow-mac-host-running" "ssh start runtime help documents Mac host guard override"
assert_contains "$TMP_DIR/ssh-start-runtime-help.out" "NANOCLAW_PI_SSH_CONNECT_TIMEOUT" "ssh start runtime help documents SSH timeout env"

pnpm run pi:export -- --help >"$TMP_DIR/pi-export-help.out"
assert_contains "$TMP_DIR/pi-export-help.out" "--no-runtime-lock" "pi export help documents runtime lock opt-out"
assert_contains "$TMP_DIR/pi-export-help.out" "NANOCLAW_ALLOW_MAC_RUNTIME_AFTER_PI_EXPORT" "pi export help documents runtime lock override"

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

set +e
PATH="$no_ssh_bin:$PATH" NO_SSH_SENTINEL="$no_ssh_sentinel" pnpm run pi:ssh-preflight -- \
  --host localhost \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  >"$TMP_DIR/ssh-preflight-localhost.out" \
  2>"$TMP_DIR/ssh-preflight-localhost.err"
preflight_localhost_code="$?"
PATH="$no_ssh_bin:$PATH" NO_SSH_SENTINEL="$no_ssh_sentinel" pnpm run pi:ssh-admin -- status \
  --host localhost \
  --user pi \
  --path /home/pi/NanoClaw \
  >"$TMP_DIR/ssh-admin-localhost.out" \
  2>"$TMP_DIR/ssh-admin-localhost.err"
admin_localhost_code="$?"
PATH="$no_ssh_bin:$PATH" NO_SSH_SENTINEL="$no_ssh_sentinel" pnpm run pi:ssh-bootstrap -- \
  --host localhost \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  >"$TMP_DIR/ssh-bootstrap-localhost.out" \
  2>"$TMP_DIR/ssh-bootstrap-localhost.err"
bootstrap_localhost_code="$?"
PATH="$no_ssh_bin:$PATH" NO_SSH_SENTINEL="$no_ssh_sentinel" pnpm run pi:ssh-start-runtime -- \
  --host localhost \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  >"$TMP_DIR/ssh-start-runtime-localhost.out" \
  2>"$TMP_DIR/ssh-start-runtime-localhost.err"
start_runtime_localhost_code="$?"
set -e
assert_exit_code 2 "$preflight_localhost_code" "ssh preflight refuses localhost before SSH"
assert_exit_code 2 "$admin_localhost_code" "ssh admin refuses localhost before SSH"
assert_exit_code 2 "$bootstrap_localhost_code" "ssh bootstrap refuses localhost before SSH"
assert_exit_code 2 "$start_runtime_localhost_code" "ssh start runtime refuses localhost before SSH"
assert_contains "$TMP_DIR/ssh-preflight-localhost.err" "Refusing unsafe Pi host" "ssh preflight unsafe host error is explicit"
assert_contains "$TMP_DIR/ssh-admin-localhost.err" "Refusing unsafe Pi host" "ssh admin unsafe host error is explicit"
assert_contains "$TMP_DIR/ssh-bootstrap-localhost.err" "Refusing unsafe Pi host" "ssh bootstrap unsafe host error is explicit"
assert_contains "$TMP_DIR/ssh-start-runtime-localhost.err" "Refusing unsafe Pi host" "ssh start runtime unsafe host error is explicit"
[ ! -e "$no_ssh_sentinel" ] || fail "SSH helper opened SSH despite unsafe Pi host"

fake_admin_bin="$TMP_DIR/fake-admin-bin"
mkdir -p "$fake_admin_bin"
cat >"$fake_admin_bin/ssh" <<'FAKE_ADMIN_SSH'
#!/usr/bin/env bash
set -euo pipefail
[ -z "${FAKE_ADMIN_SSH_ARGS:-}" ] || printf '%s\n' "$@" >"$FAKE_ADMIN_SSH_ARGS"
cat >/dev/null
echo "MOCK_SSH_ADMIN=ok"
FAKE_ADMIN_SSH
chmod +x "$fake_admin_bin/ssh"
PATH="$fake_admin_bin:$PATH" FAKE_ADMIN_SSH_ARGS="$TMP_DIR/ssh-admin-args.txt" NANOCLAW_PI_SSH_CONNECT_TIMEOUT=7 pnpm run pi:ssh-admin -- process-bridges \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --bridge-execute-mode memory \
  --limit 2 \
  >"$TMP_DIR/ssh-admin-memory-mode.out"
assert_contains "$TMP_DIR/ssh-admin-memory-mode.out" "Bridge execute mode: memory" "ssh admin reports memory bridge mode"
assert_contains "$TMP_DIR/ssh-admin-memory-mode.out" "Bridge limit: 2" "ssh admin reports bridge limit"
assert_contains "$TMP_DIR/ssh-admin-memory-mode.out" "MOCK_SSH_ADMIN=ok" "ssh admin opens SSH after local memory-mode validation"
assert_contains "$TMP_DIR/ssh-admin-args.txt" "BatchMode=yes" "ssh admin passes non-interactive SSH batch mode by default"
assert_contains "$TMP_DIR/ssh-admin-args.txt" "StrictHostKeyChecking=accept-new" "ssh admin accepts first-seen Pi host keys by default"
assert_contains "$TMP_DIR/ssh-admin-args.txt" "ServerAliveInterval=15" "ssh admin passes SSH keepalive interval by default"
assert_contains "$TMP_DIR/ssh-admin-args.txt" "ServerAliveCountMax=2" "ssh admin passes SSH keepalive limit by default"
assert_contains "$TMP_DIR/ssh-admin-args.txt" "ConnectTimeout=7" "ssh admin passes configured SSH connect timeout"

fake_bridge_admin_bin="$TMP_DIR/fake-bridge-admin-bin"
mkdir -p "$fake_bridge_admin_bin"
fake_bridge_runner="$TMP_DIR/fake-dc-bridge-runner.sh"
cat >"$fake_bridge_runner" <<'FAKE_BRIDGE_RUNNER'
#!/usr/bin/env bash
set -euo pipefail
BRIDGE_EXECUTE_MODE=memory
FAKE_BRIDGE_RUNNER
cat >"$fake_bridge_admin_bin/ssh" <<'FAKE_BRIDGE_SSH'
#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift 2
      ;;
    *@*)
      shift
      break
      ;;
    *)
      shift
      ;;
  esac
done
[ "${1:-}" = "bash -s" ] && shift
[ "${1:-}" = "--" ] && shift
bash -s -- "$@"
FAKE_BRIDGE_SSH
cat >"$fake_bridge_admin_bin/systemctl" <<'FAKE_BRIDGE_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  list-timers)
    printf 'dc-bridge-test-memory-bridge.timer\n'
    printf 'dc-bridge-test-codex-bridge.timer\n'
    printf 'dc-bridge-test-action-bridge.timer\n'
    ;;
  list-unit-files)
    printf 'dc-bridge-test-memory-bridge.timer enabled\n'
    printf 'dc-bridge-test-codex-bridge.timer enabled\n'
    printf 'dc-bridge-test-action-bridge.timer enabled\n'
    ;;
  show)
    unit="${2:-}"
    service="${unit%.timer}.service"
    value="false"
    for arg in "$@"; do
      [ "$arg" = "--value" ] && value="true"
    done
    if [ "$value" = "true" ]; then
      printf '%s\n' "$service"
    else
      printf 'Unit=%s\n' "$service"
      printf 'Result=success\n'
    fi
    ;;
  cat)
    service="${2:-}"
    job="${service#dc-bridge-test-}"
    job="${job%.service}"
    printf 'ExecStart=/bin/bash %s %s\n' "${FAKE_DC_BRIDGE_RUNNER:?}" "$job"
    ;;
  is-enabled)
    printf 'enabled\n'
    ;;
  is-active)
    printf 'active\n'
    ;;
  *)
    exit 0
    ;;
esac
FAKE_BRIDGE_SYSTEMCTL
chmod +x "$fake_bridge_runner" "$fake_bridge_admin_bin/ssh" "$fake_bridge_admin_bin/systemctl"
PATH="$fake_bridge_admin_bin:$PATH" FAKE_DC_BRIDGE_RUNNER="$fake_bridge_runner" pnpm run pi:ssh-admin -- bridge-timers \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --expected-bridge-execute-mode memory \
  >"$TMP_DIR/ssh-admin-bridge-timers-memory.out"
assert_contains "$TMP_DIR/ssh-admin-bridge-timers-memory.out" "PI_BRIDGE_EXECUTE_MODE=ok expected=memory actual=memory" "ssh admin verifies installed bridge timer memory mode"
assert_contains "$TMP_DIR/ssh-admin-bridge-timers-memory.out" "PI_BRIDGE_TIMERS=ok count=3" "ssh admin verifies bridge timer count through remote systemctl"

set +e
PATH="$fake_bridge_admin_bin:$PATH" FAKE_DC_BRIDGE_RUNNER="$fake_bridge_runner" pnpm run pi:ssh-admin -- bridge-timers \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --expected-bridge-execute-mode all \
  >"$TMP_DIR/ssh-admin-bridge-timers-wrong-mode.out" \
  2>"$TMP_DIR/ssh-admin-bridge-timers-wrong-mode.err"
bridge_wrong_mode_code="$?"
set -e
assert_exit_code 1 "$bridge_wrong_mode_code" "ssh admin bridge timer check fails on wrong installed mode"
assert_contains "$TMP_DIR/ssh-admin-bridge-timers-wrong-mode.out" "PI_BRIDGE_EXECUTE_MODE=fail expected=all actual=memory" "ssh admin bridge timer wrong mode is explicit"

set +e
pnpm run pi:ssh-admin -- process-bridges \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --bridge-execute-mode nope \
  >"$TMP_DIR/ssh-admin-invalid-bridge-mode.out" \
  2>"$TMP_DIR/ssh-admin-invalid-bridge-mode.err"
invalid_admin_bridge_mode_code="$?"
set -e
assert_exit_code 2 "$invalid_admin_bridge_mode_code" "ssh admin rejects invalid bridge execute mode before SSH"
assert_contains "$TMP_DIR/ssh-admin-invalid-bridge-mode.err" "--bridge-execute-mode must be dry-run, memory, or all" "ssh admin invalid bridge mode is explicit"

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
mkdir -p "$bundle_src/state/data" "$bundle_src/state/store/auth" "$bundle_src/state/groups/dc" "$bundle_src/home-config/nanoclaw"
cat >"$bundle_src/state/.env" <<'EOF'
DISTRIBUTED_COGNITION_WHATSAPP_JID=6588216840@s.whatsapp.net
OPENAI_API_KEY=test-only
EOF
printf 'sqlite placeholder\n' >"$bundle_src/state/data/v2.db"
printf '{"creds":"test-only"}\n' >"$bundle_src/state/store/auth/creds.json"
printf '# test group\n' >"$bundle_src/state/groups/dc/CLAUDE.md"
printf '{"roots":[]}\n' >"$bundle_src/home-config/nanoclaw/mount-allowlist.json"
printf '{"senders":[]}\n' >"$bundle_src/home-config/nanoclaw/sender-allowlist.json"
printf 'test manifest\n' >"$bundle_src/MANIFEST.txt"
bundle_path="$TMP_DIR/nanoclaw-pi-state-test.tar.gz"
tar -C "$bundle_src" -czf "$bundle_path" .
if command -v shasum >/dev/null 2>&1; then
  (cd "$TMP_DIR" && shasum -a 256 "$(basename "$bundle_path")" >"$(basename "$bundle_path").sha256")
else
  (cd "$TMP_DIR" && sha256sum "$(basename "$bundle_path")" >"$(basename "$bundle_path").sha256")
fi
checksum_path="$bundle_path.sha256"

pnpm run pi:inspect-state-bundle -- \
  --bundle "$bundle_path" \
  --checksum "$checksum_path" \
  >"$TMP_DIR/inspect-state-bundle.out"
assert_contains "$TMP_DIR/inspect-state-bundle.out" "STATE_BUNDLE_INSPECT=ok" "state bundle inspector accepts complete test bundle"
assert_contains "$TMP_DIR/inspect-state-bundle.out" "SHA-256 checksum matches" "state bundle inspector verifies checksum"
assert_contains "$TMP_DIR/inspect-state-bundle.out" "state/store/auth is present" "state bundle inspector verifies WhatsApp auth path"

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
assert_contains "$TMP_DIR/ssh-restore-dry-run.out" "Mac host guard: enforced" "ssh restore dry-run reports Mac host guard"
assert_contains "$TMP_DIR/ssh-restore-dry-run.out" "STATE_BUNDLE_INSPECT=ok" "ssh restore dry-run inspects local state bundle"
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

set +e
PATH="$no_ssh_bin:$PATH" NO_SSH_SENTINEL="$no_ssh_sentinel" pnpm run pi:ssh-restore-state -- \
  --host localhost \
  --user pi \
  --path /home/pi/NanoClaw \
  --bundle "$bundle_path" \
  --execute \
  >"$TMP_DIR/ssh-restore-localhost.out" \
  2>"$TMP_DIR/ssh-restore-localhost.err"
restore_localhost_code="$?"
set -e
assert_exit_code 2 "$restore_localhost_code" "ssh restore refuses localhost before SSH"
assert_contains "$TMP_DIR/ssh-restore-localhost.err" "Refusing unsafe Pi host" "ssh restore unsafe host error is explicit"
[ ! -e "$no_ssh_sentinel" ] || fail "ssh restore opened SSH despite unsafe Pi host"

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
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "Mac host guard: enforced" "ssh start runtime dry-run reports Mac host guard"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "bridge execute mode: dry-run" "ssh start runtime dry-run reports bridge dry-run mode"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "--bridge-execute-mode dry-run" "ssh start runtime dry-run command includes bridge mode"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "pi-install-dropbox-sync.sh" "ssh start runtime dry-run shows rclone timer install"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "dc:ensure-docker-access" "ssh start runtime dry-run shows Docker access update"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "pi-install-systemd.sh" "ssh start runtime dry-run shows systemd install"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "pi-install-bridge-timers.sh" "ssh start runtime dry-run shows Pi bridge timer install"
assert_contains "$TMP_DIR/ssh-start-runtime-dry-run.out" "dc:health" "ssh start runtime dry-run shows health check"

pnpm run pi:ssh-start-runtime -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --rclone-remote dropbox: \
  --bridge-execute-mode memory \
  >"$TMP_DIR/ssh-start-runtime-memory-dry-run.out"
assert_contains "$TMP_DIR/ssh-start-runtime-memory-dry-run.out" "bridge execute mode: memory" "ssh start runtime reports memory bridge mode"
assert_contains "$TMP_DIR/ssh-start-runtime-memory-dry-run.out" "--bridge-execute-mode memory" "ssh start runtime dry-run command includes memory mode"

fake_docker_bin="$TMP_DIR/fake-docker-bin"
mkdir -p "$fake_docker_bin"
cat >"$fake_docker_bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "ps" ]; then
  joined=" $* "
  if [[ "$joined" == *Status* ]]; then
    printf 'dc-sidecar-test\tnanoclaw-agent-v2-dc-test:latest\tUp 2 minutes\n'
  else
    printf 'dc-sidecar-test\n'
  fi
  exit 0
fi
echo "unexpected fake docker call: $*" >&2
exit 42
FAKE_DOCKER
chmod +x "$fake_docker_bin/docker"

PATH="$fake_docker_bin:$PATH" bash scripts/dc-stop-host.sh >"$TMP_DIR/dc-stop-host-docker-dry-run.out"
assert_contains "$TMP_DIR/dc-stop-host-docker-dry-run.out" "Matching Docker containers" "dc stop host reports Docker container section"
assert_contains "$TMP_DIR/dc-stop-host-docker-dry-run.out" "dc-sidecar-test" "dc stop host detects NanoClaw Docker containers by image"
assert_contains "$TMP_DIR/dc-stop-host-docker-dry-run.out" "nanoclaw-agent-v2-dc-test" "dc stop host reports NanoClaw Docker image"

set +e
PATH="$fake_docker_bin:$PATH" pnpm run pi:mac-preflight -- \
  --root "$TMP_DIR/Distributed-Cognition" \
  --out-dir "$TMP_DIR/export" \
  --require-stopped \
  >"$TMP_DIR/mac-preflight-docker-running.out" \
  2>"$TMP_DIR/mac-preflight-docker-running.err"
mac_preflight_docker_code="$?"
PATH="$fake_docker_bin:$PATH" pnpm run pi:export -- \
  --out-dir "$TMP_DIR/export-docker-running" \
  >"$TMP_DIR/pi-export-docker-running.out" \
  2>"$TMP_DIR/pi-export-docker-running.err"
pi_export_docker_code="$?"
PATH="$fake_docker_bin:$PATH" pnpm run pi:import -- \
  "$bundle_path" \
  >"$TMP_DIR/pi-import-docker-running.out" \
  2>"$TMP_DIR/pi-import-docker-running.err"
pi_import_docker_code="$?"
PATH="$fake_docker_bin:$PATH" pnpm run pi:ssh-restore-state -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --bundle "$bundle_path" \
  --force \
  --cleanup-remote \
  --execute \
  >"$TMP_DIR/ssh-restore-docker-guard.out" \
  2>"$TMP_DIR/ssh-restore-docker-guard.err"
restore_docker_guard_code="$?"
PATH="$fake_docker_bin:$PATH" pnpm run pi:ssh-start-runtime -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --execute \
  >"$TMP_DIR/ssh-start-runtime-docker-guard.out" \
  2>"$TMP_DIR/ssh-start-runtime-docker-guard.err"
docker_guard_code="$?"
PATH="$fake_docker_bin:$PATH" pnpm run pi:ssh-admin -- restart \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  >"$TMP_DIR/ssh-admin-restart-docker-guard.out" \
  2>"$TMP_DIR/ssh-admin-restart-docker-guard.err"
admin_docker_guard_code="$?"
set -e
assert_exit_code 1 "$mac_preflight_docker_code" "mac export preflight fails when NanoClaw Docker container is running and stopped state is required"
assert_contains "$TMP_DIR/mac-preflight-docker-running.out" "NanoClaw Docker agent containers are still running" "mac export preflight reports running Docker containers"
assert_exit_code 1 "$pi_export_docker_code" "pi export refuses while NanoClaw Docker container is running"
assert_contains "$TMP_DIR/pi-export-docker-running.err" "NanoClaw Docker agent containers are still running" "pi export reports running Docker containers"
assert_contains "$TMP_DIR/pi-export-docker-running.err" "dc-sidecar-test" "pi export names image-matched Docker container"
assert_exit_code 1 "$pi_import_docker_code" "pi import refuses while NanoClaw Docker container is running"
assert_contains "$TMP_DIR/pi-import-docker-running.err" "NanoClaw Docker agent containers are still running" "pi import reports running Docker containers"
assert_contains "$TMP_DIR/pi-import-docker-running.err" "dc-sidecar-test" "pi import names image-matched Docker container"
assert_exit_code 1 "$restore_docker_guard_code" "ssh restore execute refuses while Mac Docker container is running"
assert_contains "$TMP_DIR/ssh-restore-docker-guard.err" "Matching Docker containers" "ssh restore Docker guard reports matching containers"
assert_contains "$TMP_DIR/ssh-restore-docker-guard.err" "dc-sidecar-test" "ssh restore Docker guard names image-matched container"
assert_exit_code 1 "$docker_guard_code" "ssh start runtime refuses while Mac Docker container is running"
assert_contains "$TMP_DIR/ssh-start-runtime-docker-guard.err" "Matching Docker containers" "ssh start runtime Docker guard reports matching containers"
assert_contains "$TMP_DIR/ssh-start-runtime-docker-guard.err" "dc-sidecar-test" "ssh start runtime Docker guard names image-matched container"
assert_exit_code 1 "$admin_docker_guard_code" "ssh admin restart refuses while Mac Docker container is running"
assert_contains "$TMP_DIR/ssh-admin-restart-docker-guard.err" "Matching Docker containers" "ssh admin Docker guard reports matching containers"
assert_contains "$TMP_DIR/ssh-admin-restart-docker-guard.err" "dc-sidecar-test" "ssh admin Docker guard names image-matched container"

node -e 'setInterval(() => {}, 1000)' dist/index.js >/dev/null 2>&1 &
MAC_GUARD_PID="$!"
sleep 1
set +e
pnpm run pi:ssh-restore-state -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --bundle "$bundle_path" \
  --force \
  --cleanup-remote \
  --execute \
  >"$TMP_DIR/ssh-restore-mac-guard.out" \
  2>"$TMP_DIR/ssh-restore-mac-guard.err"
restore_mac_guard_code="$?"
kill "$MAC_GUARD_PID" 2>/dev/null || true
wait "$MAC_GUARD_PID" 2>/dev/null || true
MAC_GUARD_PID=""
set -e
assert_exit_code 1 "$restore_mac_guard_code" "ssh restore execute refuses while Mac host is running"
assert_contains "$TMP_DIR/ssh-restore-mac-guard.err" "Refusing to restore Pi state while the Mac NanoClaw host appears to be running" "ssh restore Mac guard explains refusal"
assert_contains "$TMP_DIR/ssh-restore-mac-guard.err" "WhatsApp/Baileys state should be exported/restored only after the Mac runtime is stopped" "ssh restore Mac guard protects WhatsApp state transfer"

node -e 'setInterval(() => {}, 1000)' dist/index.js >/dev/null 2>&1 &
MAC_GUARD_PID="$!"
sleep 1
set +e
pnpm run pi:ssh-start-runtime -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --execute \
  >"$TMP_DIR/ssh-start-runtime-mac-guard.out" \
  2>"$TMP_DIR/ssh-start-runtime-mac-guard.err"
mac_guard_code="$?"
kill "$MAC_GUARD_PID" 2>/dev/null || true
wait "$MAC_GUARD_PID" 2>/dev/null || true
MAC_GUARD_PID=""
set -e
assert_exit_code 1 "$mac_guard_code" "ssh start runtime execute refuses while Mac host is running"
assert_contains "$TMP_DIR/ssh-start-runtime-mac-guard.err" "Refusing to start the Pi runtime while the Mac NanoClaw host appears to be running" "ssh start runtime Mac guard explains refusal"
assert_contains "$TMP_DIR/ssh-start-runtime-mac-guard.err" "WhatsApp/Baileys must run from only one host at a time" "ssh start runtime Mac guard protects WhatsApp single-host invariant"

node -e 'setInterval(() => {}, 1000)' dist/index.js >/dev/null 2>&1 &
MAC_GUARD_PID="$!"
sleep 1
set +e
pnpm run pi:ssh-admin -- start \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  >"$TMP_DIR/ssh-admin-start-mac-guard.out" \
  2>"$TMP_DIR/ssh-admin-start-mac-guard.err"
admin_mac_guard_code="$?"
kill "$MAC_GUARD_PID" 2>/dev/null || true
wait "$MAC_GUARD_PID" 2>/dev/null || true
MAC_GUARD_PID=""
set -e
assert_exit_code 1 "$admin_mac_guard_code" "ssh admin start refuses while Mac host is running"
assert_contains "$TMP_DIR/ssh-admin-start-mac-guard.err" "Refusing to start the Pi runtime while the Mac NanoClaw host appears to be running" "ssh admin start guard explains refusal"
assert_contains "$TMP_DIR/ssh-admin-start-mac-guard.err" "WhatsApp/Baileys must run from only one host at a time" "ssh admin start guard protects WhatsApp single-host invariant"

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
