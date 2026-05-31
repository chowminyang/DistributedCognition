# Raspberry Pi Migration Runbook

This is the handoff plan for moving this NanoClaw / Distributed Cognition install to a Raspberry Pi that runs 24 hours a day.

The intended shape:

- NanoClaw code lives on the Pi, for example `/home/pi/NanoClaw`.
- NanoClaw runtime state stays local to the Pi: `.env`, `data/`, `store/`, and `groups/`.
- WhatsApp uses the same settings by restoring `.env` and `store/auth/`.
- The selected second-brain folder is local on the Pi, for example `/home/pi/Distributed-Cognition`.
- Dropbox is updated by an external `rclone` timer, not by NanoClaw itself.
- Docker images are rebuilt on the Pi. Do not copy Docker images from the Mac.
- Codex on the Mac remains your control plane: use SSH from the Mac to inspect, update, restart, and debug the Pi.
- Distributed Cognition itself runs fully on the Pi after cutover. Do not leave the Mac NanoClaw host running against the same WhatsApp session.

## What Moves

Move these from the Mac:

- `.env`: assistant name, WhatsApp private-mode settings, provider settings.
- `store/auth/`: Baileys WhatsApp auth/session state.
- `data/`: central SQLite DB, sessions, attachments, circuit breaker state.
- `groups/`: per-agent group config, memory, and container configuration.
- `~/.config/nanoclaw/mount-allowlist.json` and `sender-allowlist.json`, if present.

Do not automatically sync these secret/runtime folders to Dropbox. Use the state bundle scripts for deliberate transfers and backups.

## Before Tuesday, 02-06-26

On the Mac:

```bash
cd /Users/minyangchow/Documents/NanoClaw
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run pi:test-helpers
pnpm run dc:public-readiness
```

Check that the Mac automation is healthy before cutover:

```bash
pnpm run dc:install-launchd -- status
pnpm run dc:health -- --root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition"
pnpm run pi:mac-preflight -- \
  --root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --out-dir "$HOME/Desktop/dc-pi-migration"
```

Print the whole read-only cutover plan before you start moving state:

```bash
pnpm run pi:cutover-plan -- \
  --local-root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url "<DistributedCognition repo URL>"
```

This command is deliberately non-mutating. It does not SSH, stop the Mac host, copy state, install packages, or start the Pi service. Use it to check the shape of the migration while the Mac instance is still live.

You can also generate the paste-ready `/goal` prompt for the Codex thread that
will control the Pi over SSH:

```bash
pnpm run pi:codex-goal -- \
  --local-root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main
```

The generated prompt tells Codex to inspect current state, use dry-run helpers
first, ask before final Mac stop/export, keep WhatsApp active on only one host,
and verify that DC replies from the Pi before marking the goal complete.

To bundle the `/goal`, a non-secret Mac operator environment file, the
read-only cutover checklist, and the SSH dry-runs for bootstrap, state restore,
and runtime start into one timestamped rehearsal folder:

```bash
pnpm run pi:rehearse-cutover -- \
  --local-root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main
```

The rehearsal writes to `output/pi-cutover-rehearsal/DD-MM-YY-HHMM/` by
default. It opens no SSH connection, stops no local service, exports no state,
and does not touch WhatsApp auth. Use this before Tuesday so the Mac Codex
thread can start from a concrete bundle instead of improvising.
The generated `operator-env.sh` contains only non-secret SSH, path, repo,
branch, date, rclone, SSH timeout, bridge mode, and expected commit values.
Source it from the Mac Codex shell before running the cutover helpers. By
default it sets `NANOCLAW_PI_SSH_CONNECT_TIMEOUT=10`, which keeps Codex from
waiting forever if the Pi hostname or IP is wrong,
`NANOCLAW_PI_BRIDGE_EXECUTE_MODE=memory`, which keeps Mnemon promotion running
on the Pi while Codex/action queues remain reviewable from Mac Codex,
`NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE=memory`, which makes post-cutover
verification fail if the installed systemd bridge timers are not in that mode,
and
`NANOCLAW_PI_EXPECTED_COMMIT`, which lets Pi status/doctor checks prove the
runtime checkout matches the rehearsed Mac commit. The generated `codex-goal.md`
also points to this exact `operator-env.sh`, so the Mac Codex cutover thread can
source one shared non-secret control-plane file before it starts operating over
SSH.

Before opening SSH, validate the filled or sourced operator environment:

```bash
pnpm run pi:operator-env-check -- --operator-env "<path to operator-env.sh>" --strict
```

This does not source the file or open SSH. It checks that required non-secret
Pi values are present, no placeholders remain, the Pi host is not localhost,
Pi paths are absolute, bridge modes are valid, and the expected commit looks
like a git SHA.

The SSH helpers enforce the same target boundary before opening SSH. They
refuse `localhost`, `127.*`, `::1`, `0.0.0.0`, hosts with `user@` prefixes, and
Pi SSH users with unsupported characters.

Because Mac Codex is the operator, the SSH helpers are non-interactive by
default. They pass `BatchMode=yes`, `StrictHostKeyChecking=accept-new`,
`ServerAliveInterval=15`, and `ServerAliveCountMax=2` to `ssh`/`scp`, plus
`ConnectTimeout=<seconds>` when `NANOCLAW_PI_SSH_CONNECT_TIMEOUT` is set. This
means a first-seen Pi host key is added automatically, a changed host key is
rejected, and missing SSH key authentication fails fast instead of hanging for a
password prompt. Set up SSH key login from the Mac before cutover.

You can check the Mac side before you know the Pi values:

```bash
pnpm run pi:first-boot-checklist
pnpm run pi:ssh-key-check
```

`pi:first-boot-checklist` is safe to run before the Pi exists. It prints the
Raspberry Pi Imager settings, planned Pi folders, dedicated SSH public key path,
and the next Mac commands. It does not create SSH keys, open SSH, write files,
copy state, inspect secrets, stop services, or touch WhatsApp runtime state.

If that reports `PI_SSH_KEY_CHECK=missing_key`, create a dedicated
automation-friendly key for this Pi handoff rather than reusing or overwriting a
default personal SSH key:

```bash
pnpm run pi:ssh-key-setup
pnpm run pi:ssh-key-setup -- --execute
export NANOCLAW_PI_SSH_IDENTITY_FILE="$HOME/.ssh/distributed_cognition_pi_ed25519"
```

After the Pi host and user are known, prove non-interactive login explicitly:

```bash
ssh-copy-id -i "$NANOCLAW_PI_SSH_IDENTITY_FILE.pub" pi@nanoclaw-pi.local
pnpm run pi:ssh-key-check -- --host nanoclaw-pi.local --user pi --test-login
```

The login test does not change NanoClaw, Docker, Dropbox, or WhatsApp state. It
may add the first-seen Pi host key to `~/.ssh/known_hosts`.

For a broader one-command readiness snapshot on the Mac, run:

```bash
pnpm run pi:mac-readiness -- \
  --local-root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main
```

This writes `output/pi-mac-readiness/DD-MM-YY-HHMM/` with git status, public
branch commit reachability, public-readiness, DC health, Mac export preflight,
Pi first-boot checklist, SSH-key checks, and the nested rehearsal bundle. It is
safe to run while the Mac instance is live; a warning that the Mac host is
running is expected before final export. The readiness output also prints
`operator_env=.../rehearsal/operator-env.sh`. If Pi values are missing, use that
generated file as the non-secret fillable template: uncomment and set the
missing `NANOCLAW_PI_*` lines, source it from the Mac Codex shell, run
`pi:operator-env-check`, then rerun readiness. The bundle also includes
`pi-first-boot-checklist.txt` and `ssh-key-setup.txt`, both non-mutating dry-runs
showing the exact first-boot and dedicated-key commands to run before Pi SSH
control.

When you are ready to capture the final state, stop the Mac launchd jobs first so SQLite, WhatsApp auth, bridge queues, and delivery ledgers are quiet:

```bash
pnpm run dc:install-launchd -- uninstall
pnpm run dc:stop-host -- --execute
pnpm run pi:mac-preflight -- \
  --root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --out-dir "$HOME/Desktop/dc-pi-migration" \
  --require-stopped
pnpm run pi:export -- --out-dir "$HOME/Desktop/dc-pi-migration"
```

`dc:stop-host` is dry-run by default; the `--execute` flag is intentional for
the final cutover. It only targets NanoClaw host processes whose working
directory is this checkout, screen sessions named for NanoClaw / Distributed
Cognition, and NanoClaw Docker agent containers detected by NanoClaw container
name or `nanoclaw-agent` image. The export script independently refuses to
create the secret bundle if a matching Mac host process or NanoClaw Docker
agent container is still running, then writes a secret bundle and a matching
`.sha256` file. Treat the bundle like a password because it contains `.env` and
WhatsApp auth. After exporting, `pi:export` also writes
`logs/pi-cutover/mac-runtime-disabled.lock`. This makes `pnpm start` / `pnpm dev`
in the Mac checkout refuse to start the WhatsApp runtime by accident. Remove
that lock only for rollback, or set
`NANOCLAW_ALLOW_MAC_RUNTIME_AFTER_PI_EXPORT=true` for a deliberate temporary
override.

## First Boot On The Pi

Use Raspberry Pi Imager to enable SSH before first boot, or enable it with `sudo raspi-config` after connecting a keyboard. Set a memorable hostname such as `nanoclaw-pi`.

From the Mac, you can run a passive discovery pass before you know the exact SSH target:

```bash
pnpm run pi:discover
```

This does not SSH into the Pi and does not change any local, Docker, WhatsApp, or Pi state. It checks common `.local` names, browses advertised SSH services when `dns-sd` is available, and scans the local ARP cache for Raspberry Pi MAC prefixes. If it finds a likely host or IP, set `NANOCLAW_PI_HOST` and rerun `pi:mac-readiness` with `--include-ssh-preflight`.

After SSH works:

```bash
ssh pi@nanoclaw-pi.local
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y git curl build-essential python3 make g++ sqlite3 rclone
```

Install Docker using Docker's current Raspberry Pi instructions. Prefer 64-bit Raspberry Pi OS for a new Pi. Docker's docs say 64-bit ARM should use the Debian `arm64` path, while 32-bit Raspberry Pi OS has a separate Raspberry Pi OS path.

After Docker is installed:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker run hello-world
```

Alternatively, once SSH works, Codex on the Mac can prepare the Pi with the
dry-run-first bootstrap helper:

```bash
cd /Users/minyangchow/Documents/NanoClaw
pnpm run pi:ssh-bootstrap -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --repo-url https://github.com/chowminyang/DistributedCognition.git \
  --branch main
```

That command opens no SSH connection unless `--execute` is added. With
`--execute`, it installs the basic apt packages, clones or updates the repo,
creates the second-brain and Codex folders, runs `bash setup.sh`, runs
`pnpm run build`, renders the systemd unit to `/tmp`, and checks Docker
availability. It still does not copy secrets, import WhatsApp auth, start
NanoClaw, configure rclone, install the rclone timer, or install the systemd
service.

## Restore NanoClaw

Clone the same repository branch on the Pi:

```bash
git clone <repo-url> ~/NanoClaw
cd ~/NanoClaw
bash setup.sh
pnpm run build
```

From the Mac, restore the final state bundle through the SSH helper. Run the
dry run first:

```bash
cd /Users/minyangchow/Documents/NanoClaw
STATE_BUNDLE="$(ls -t "$HOME/Desktop/dc-pi-migration"/nanoclaw-pi-state-*.tar.gz | head -n 1)"

pnpm run pi:inspect-state-bundle -- --bundle "$STATE_BUNDLE"

pnpm run pi:ssh-restore-state -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --bundle "$STATE_BUNDLE" \
  --force \
  --cleanup-remote
```

When the dry-run output is correct and the Mac NanoClaw host is stopped, add
`--execute` to the same command. The execute path refuses while this Mac
checkout appears to be running a NanoClaw host or Docker agent container unless
`--allow-mac-host-running` is used for explicit rollback or emergency work. The
helper inspects the local bundle first, copies the bundle and checksum to the
Pi, verifies the checksum on the Pi, imports state through
`scripts/pi-import-state.sh`, runs `pnpm run build`, and removes the copied
bundle from the Pi when `--cleanup-remote` is supplied. The Pi-side importer
also refuses to restore over a running NanoClaw host process or NanoClaw Docker
agent container unless `--allow-running` is explicitly used for an emergency
best-effort import.

Then configure the Pi runtime with a second dry run:

```bash
pnpm run pi:ssh-start-runtime -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --rclone-remote dropbox:
```

When the dry-run output is correct, add `--execute`. The execute path refuses
to start the Pi runtime if this Mac checkout still appears to be running
NanoClaw or has running NanoClaw Docker agent containers, unless you explicitly
pass `--allow-mac-host-running` for rollback or emergency work. It creates the
selected local folders, installs and starts the rclone timer for
`dropbox:Distributed-Cognition`, updates Docker mount access for Distributed
Cognition, installs and starts the NanoClaw systemd service, installs and
starts Pi-side bridge timers, and runs `pnpm run dc:health` on the Pi.

By default the bridge timers dry-run queued Mnemon, Codex, and action work.
For the recommended Pi cutover mode, add `--bridge-execute-mode memory` so
Mnemon durable-memory promotion runs automatically on the Pi while Codex/action
handoffs remain reviewable from Mac Codex:

```bash
pnpm run pi:ssh-start-runtime -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --rclone-remote dropbox: \
  --bridge-execute-mode memory
```

Use `--execute-bridges` only when you intentionally want memory, Codex, and
action queues to execute automatically on the Pi.

Manual fallback on the Pi:

```bash
cd ~
sha256sum -c nanoclaw-pi-state-*.sha256
cd ~/NanoClaw
bash scripts/pi-inspect-state-bundle.sh --bundle ~/nanoclaw-pi-state-*.tar.gz
bash scripts/pi-import-state.sh ~/nanoclaw-pi-state-*.tar.gz --force
pnpm run build
```

If the manual importer reports a running NanoClaw process or Docker agent
container, stop the Pi service or container first and rerun the import. Use
`--allow-running` only for an emergency best-effort recovery because the bundle
contains WhatsApp auth and SQLite runtime state.

Important WhatsApp cutover rule: only one host should run this WhatsApp session at a time. Keep the Mac service stopped before starting the Pi service. If WhatsApp rejects the restored auth, keep the same `.env` settings and re-pair on the Pi using the pairing code or QR output in `data/`.

## Dropbox With rclone

The safe default is to sync only the Distributed Cognition second-brain folder, not NanoClaw's private runtime state.

Configure a Dropbox remote:

```bash
rclone config
rclone lsd dropbox:
```

Create the local folder and install the sync timer:

```bash
mkdir -p "$HOME/Distributed-Cognition"
cd ~/NanoClaw
bash scripts/pi-install-dropbox-sync.sh \
  --local "$HOME/Distributed-Cognition" \
  --remote dropbox:Distributed-Cognition \
  --interval 5min \
  --start
```

The default sync mode is `copy`, which updates Dropbox from local files without deleting remote files. Use `--mode sync` only when you intentionally want local deletions reflected in Dropbox.

Then mount that local folder into the Distributed Cognition agent:

```bash
pnpm run dc:ensure-docker-access -- \
  --second-brain-root "$HOME/Distributed-Cognition" \
  --codex-projects-root "$HOME/Codex"
```

If the Pi will not have local Codex projects yet, create the parent folder first:

```bash
mkdir -p "$HOME/Codex"
```

## Start 24H Service

Install and start the systemd service:

```bash
cd ~/NanoClaw
bash scripts/pi-install-systemd.sh --start
systemctl list-units 'nanoclaw-v2-*.service' --no-pager
tail -f logs/nanoclaw.log logs/nanoclaw.error.log
```

The installer writes a unit named from the checkout path, such as `nanoclaw-v2-ab12cd34.service`, and enables it for boot. The unit waits up to 60 seconds for `docker info` to work as the service user before starting NanoClaw. If the service keeps restarting with a Docker readiness timeout, confirm Docker is running and the Pi user can run `docker info` without `sudo`.

You can render the unit without installing it when checking a fresh Pi over SSH:

```bash
bash scripts/pi-install-systemd.sh --output-dir /tmp/nanoclaw-systemd-check
cat /tmp/nanoclaw-systemd-check/nanoclaw-v2-*.service
```

## Smoke Tests

Run these on the Pi:

```bash
cd ~/NanoClaw
docker info
pnpm run build
pnpm run dc:health -- --root "$HOME/Distributed-Cognition"
pnpm run dc:dashboard -- --root "$HOME/Distributed-Cognition"
pnpm run dc:retrieval-eval -- --root "$HOME/Distributed-Cognition"
systemctl list-units 'nanoclaw-v2-*.service' --no-pager
journalctl -u 'nanoclaw-v2-*' -n 100 --no-pager
```

Then message the WhatsApp assistant from the allowed JID. Confirm:

- Private mode logs show the configured allowed JID.
- The assistant replies with the same assistant identity and formatting.
- A new raw/processed note lands in `/home/pi/Distributed-Cognition`.
- `rclone` updates `dropbox:Distributed-Cognition`.

## Codex SSH Handoff

When you ask Codex on the Mac to control the Pi, have these ready:

- SSH host: `nanoclaw-pi.local` or the Pi's LAN IP.
- SSH user: usually `pi` or the username created in Raspberry Pi Imager.
- NanoClaw path: usually `/home/pi/NanoClaw`.
- Pi Codex projects path: usually `/home/pi/Codex`; needed for Docker mount
  access and bridge timer setup even when Codex/action queues stay reviewable
  from Mac Codex.
- Whether Docker `hello-world` succeeds without `sudo`.
- The exported bundle path if the restore has not happened yet.

SSH key login from the Mac should already work before final cutover. The helper
commands are designed for Codex-driven, non-interactive SSH and should fail
quickly if key auth or host trust is not ready.

Run the local key check first:

```bash
export NANOCLAW_PI_SSH_IDENTITY_FILE="$HOME/.ssh/distributed_cognition_pi_ed25519"
pnpm run pi:ssh-key-check -- --host nanoclaw-pi.local --user pi --test-login
```

Run the SSH preflight from the Mac before restoring state or starting the Pi service:

```bash
cd /Users/minyangchow/Documents/NanoClaw
export NANOCLAW_PI_HOST=nanoclaw-pi.local
export NANOCLAW_PI_USER=pi
export NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw
export NANOCLAW_PI_SECOND_BRAIN_ROOT=/home/pi/Distributed-Cognition
export NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex
export NANOCLAW_PI_RCLONE_REMOTE=dropbox:
export NANOCLAW_PI_SSH_CONNECT_TIMEOUT=10
export NANOCLAW_PI_BRIDGE_EXECUTE_MODE=memory
export NANOCLAW_PI_EXPECTED_BRIDGE_EXECUTE_MODE=memory
export NANOCLAW_PI_EXPECTED_COMMIT="$(git rev-parse HEAD)"

pnpm run pi:operator-env-check -- --strict
pnpm run pi:ssh-preflight
```

You can also include this SSH check inside the Mac readiness bundle:

```bash
pnpm run pi:mac-readiness -- \
  --local-root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --pi-host nanoclaw-pi.local \
  --pi-user pi \
  --pi-path /home/pi/NanoClaw \
  --pi-second-brain-root /home/pi/Distributed-Cognition \
  --pi-codex-projects-root /home/pi/Codex \
  --include-ssh-preflight
```

Without `--include-ssh-preflight`, the readiness bundle does not open SSH. With
the flag, it opens SSH only for `pi:ssh-preflight`; it still does not mutate Pi
state, start services, copy secrets, export state, or touch WhatsApp auth.

If the Pi is freshly imaged and only SSH is working, run
`pnpm run pi:ssh-bootstrap` first in dry-run mode, then with `--execute`,
before this preflight.

The same values can also be passed inline:

```bash
pnpm run pi:ssh-preflight -- \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --codex-projects-root /home/pi/Codex \
  --rclone-remote dropbox:
```

Replace every path with the actual Pi username and folders you created. The preflight checks SSH, OS/architecture, Node/pnpm, Docker access without `sudo`, project state, second-brain write access, rclone remote configuration, and systemd readiness. It does not copy secrets, install packages, start services, or change NanoClaw runtime state.

After cutover, use the SSH admin helper for routine operations from the Mac:

```bash
pnpm run pi:ssh-admin -- status --expected-commit "$NANOCLAW_PI_EXPECTED_COMMIT"
pnpm run pi:ssh-admin -- bridge-timers --expected-bridge-execute-mode memory
pnpm run pi:ssh-admin -- health
pnpm run pi:ssh-admin -- doctor --expected-commit "$NANOCLAW_PI_EXPECTED_COMMIT"
pnpm run pi:ssh-admin -- process-bridges
pnpm run pi:ssh-admin -- process-bridges --bridge-execute-mode memory
pnpm run pi:ssh-admin -- restart
pnpm run pi:ssh-admin -- logs --lines 80
```

The supported actions are `doctor`, `status`, `bridge-timers`, `health`,
`dashboard`, `logs`, `follow-logs`, `memory-bridge`, `codex-bridge`, `action-bridge`,
`process-bridges`, `start`, `stop`, `restart`, and `update`. Use `doctor` for
the common "is DC really alive on the Pi?" check; it runs status, health, and
dashboard in one SSH session. `status` avoids printing full process command
lines and also lists bridge timers; `bridge-timers` fails explicitly if the Pi
timer loop is missing, and `--expected-bridge-execute-mode memory` also fails
if the installed bridge runner is not configured for memory-only execution. The
`start`, `restart`, and `update` admin actions also
refuse to run if this Mac checkout still appears to be running NanoClaw or has
running NanoClaw Docker agent containers, unless you explicitly pass
`--allow-mac-host-running` for rollback or emergency work.
`logs` and `follow-logs` may include private
WhatsApp/reflection content, so use them only on your own trusted Mac/Pi.

## Post-Cutover Verification

After the final state has been restored, the Mac host remains stopped, and the
Pi systemd service is running, gather the verification bundle from the Mac:

```bash
cd /Users/minyangchow/Documents/NanoClaw
pnpm run pi:verify-cutover -- \
  --local-root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --expected-commit "$NANOCLAW_PI_EXPECTED_COMMIT"
```

The default is a dry run. Add `--execute` only after the values look right:

```bash
pnpm run pi:verify-cutover -- \
  --local-root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --expected-commit "$NANOCLAW_PI_EXPECTED_COMMIT" \
  --execute
```

If `--expected-commit` is omitted, the verifier uses the current local `HEAD`
when available. Passing it explicitly makes the evidence bundle clearer on
migration day.

For the final WhatsApp persistence proof, generate one unique harmless proof
phrase, send it from the allowlisted 1:1 WhatsApp chat, then rerun the verifier
with the same phrase:

```bash
PROOF_TEXT="DC Pi cutover proof $(date '+%d-%m-%y-%H%M')"
# Send WhatsApp: DC, capture this as Pi cutover proof: <value of PROOF_TEXT>
pnpm run pi:verify-cutover -- \
  --local-root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --host nanoclaw-pi.local \
  --user pi \
  --path /home/pi/NanoClaw \
  --second-brain-root /home/pi/Distributed-Cognition \
  --expected-commit "$NANOCLAW_PI_EXPECTED_COMMIT" \
  --proof-text "$PROOF_TEXT" \
  --proof-since-minutes 30 \
  --execute
```

The verifier writes `output/pi-cutover-verification/DD-MM-YY-HHMM/` with:

- Mac stopped-state preflight.
- Mac runtime-lock proof from `logs/pi-cutover/mac-runtime-disabled.lock`.
- Pi service/status output.
- Pi bridge timer and expected bridge mode output.
- Pi `dc:health` output.
- Pi dashboard refresh output.
- Optional Pi WhatsApp persistence proof when `--proof-text` is supplied.
- A manual WhatsApp checklist.

This helper can prove the local stopped state, the local restart-prevention
lock, the expected Pi bridge-timer mode, and Pi health path. With `--proof-text`,
it can also prove that a manually sent WhatsApp capture landed in recent Pi
second-brain files without printing the note body. The visible WhatsApp reply
still needs to be checked from the allowlisted 1:1 chat before the migration is
complete.

## Bridge Work After Cutover

After WhatsApp replies are proven to come from the Pi, keep the Mac
NanoClaw/WhatsApp host stopped. The recommended migration mode is:
Distributed Cognition runs fully on the Pi for WhatsApp capture, second-brain
files, dashboard refreshes, and Mnemon promotion; Mac Codex is the SSH control
plane for monitoring and for app-visible Codex/action handoffs. The Pi bridge
timers installed by `pi:ssh-start-runtime` can run in `memory` mode
periodically; Mac Codex can also trigger a manual dry-run or memory-only
execution over SSH:

```bash
cd /Users/minyangchow/Documents/NanoClaw
pnpm run pi:ssh-admin -- process-bridges
pnpm run pi:ssh-admin -- process-bridges --bridge-execute-mode memory
```

The first command is a dry run at the bridge level. The second command
executes only the Pi-side `dc:memory-bridge`; `dc:codex-bridge` and
`dc:action-bridge` remain dry-run so the queued handoff can still be picked up
from the Mac Codex app. Use `--execute-bridges` only when you intentionally
want all queued bridge work to execute on the Pi.

Optional tradeoff: if you specifically need Codex Desktop/App-visible local
handoff work on the Mac, install only the Mac-side maintenance and bridge jobs
after the Pi WhatsApp runtime is proven. Source the rehearsal `operator-env.sh`
before creating the bridge configs; the Codex/action bridge config templates
will then include a non-secret `remoteRuntime` section so app-visible Mac Codex
threads know DC is running on the Pi and should use SSH/admin helpers rather
than restarting the Mac NanoClaw host.

These launchd jobs run `dc:health`, `dc:dashboard`, `dc:memory-bridge`,
`dc:codex-bridge`, and `dc:action-bridge` on the Mac. They do not start the
WhatsApp adapter or NanoClaw host service.

```bash
cd /Users/minyangchow/Documents/NanoClaw
pnpm run dc:install-launchd -- install \
  --root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition" \
  --projects-root "$HOME/Documents/Codex" \
  --execute-bridges \
  --load
pnpm run dc:install-launchd -- status
```

If the synced folder is at `$HOME/Dropbox/Distributed-Cognition`, use that path
instead. The Pi remains the capture/runtime host; the Mac is only doing
dashboard refreshes and queued local work if you choose this optional path.

## Rollback

If the Pi is not healthy:

```bash
ssh pi@nanoclaw-pi.local
sudo systemctl stop 'nanoclaw-v2-*.service'
```

Then start the old Mac service again. Do not leave both services running against the same WhatsApp account.
If you used the final export path, remove
`logs/pi-cutover/mac-runtime-disabled.lock` first, or set
`NANOCLAW_ALLOW_MAC_RUNTIME_AFTER_PI_EXPORT=true` for the rollback start.

## Notes

- For a new Pi, use 64-bit Raspberry Pi OS unless there is a reason not to.
- Keep the Pi on reliable power. A small UPS is worthwhile if this becomes daily infrastructure.
- Avoid putting `.env`, `store/auth/`, or `data/v2.db` into Dropbox automatic sync. Those contain secrets and active SQLite state.
- If you want recurring encrypted offsite backups of full NanoClaw state, add that as a separate backup job after the Pi is stable.
