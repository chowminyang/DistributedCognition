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

`dc:stop-host` is dry-run by default; the `--execute` flag is intentional for the final cutover. It only targets NanoClaw host processes whose working directory is this checkout, and screen sessions named for NanoClaw / Distributed Cognition. The export script writes a secret bundle and a matching `.sha256` file. Treat the bundle like a password because it contains `.env` and WhatsApp auth. After exporting, do not restart the Mac NanoClaw host unless you intentionally roll back from the Pi.

## First Boot On The Pi

Use Raspberry Pi Imager to enable SSH before first boot, or enable it with `sudo raspi-config` after connecting a keyboard. Set a memorable hostname such as `nanoclaw-pi`.

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

From the Mac, copy the state bundle to the Pi:

```bash
scp "$HOME/Desktop/dc-pi-migration"/nanoclaw-pi-state-*.tar.gz pi@nanoclaw-pi.local:~
scp "$HOME/Desktop/dc-pi-migration"/nanoclaw-pi-state-*.sha256 pi@nanoclaw-pi.local:~
```

On the Pi:

```bash
cd ~
sha256sum -c nanoclaw-pi-state-*.sha256
cd ~/NanoClaw
bash scripts/pi-import-state.sh ~/nanoclaw-pi-state-*.tar.gz --force
pnpm run build
```

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

The installer writes a unit named from the checkout path, such as `nanoclaw-v2-ab12cd34.service`, and enables it for boot.

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
- Whether Docker `hello-world` succeeds without `sudo`.
- The exported bundle path if the restore has not happened yet.

Run the SSH preflight from the Mac before restoring state or starting the Pi service:

```bash
cd /Users/minyangchow/Documents/NanoClaw
export NANOCLAW_PI_HOST=nanoclaw-pi.local
export NANOCLAW_PI_USER=pi
export NANOCLAW_PI_PROJECT_ROOT=/home/pi/NanoClaw
export NANOCLAW_PI_SECOND_BRAIN_ROOT=/home/pi/Distributed-Cognition
export NANOCLAW_PI_CODEX_PROJECTS_ROOT=/home/pi/Codex
export NANOCLAW_PI_RCLONE_REMOTE=dropbox:

pnpm run pi:ssh-preflight
```

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
pnpm run pi:ssh-admin -- status
pnpm run pi:ssh-admin -- health
pnpm run pi:ssh-admin -- restart
pnpm run pi:ssh-admin -- logs --lines 80
```

The supported actions are `status`, `health`, `dashboard`, `logs`, `follow-logs`, `start`, `stop`, `restart`, and `update`. `status` avoids printing full process command lines. `logs` and `follow-logs` may include private WhatsApp/reflection content, so use them only on your own trusted Mac/Pi.

## Rollback

If the Pi is not healthy:

```bash
ssh pi@nanoclaw-pi.local
sudo systemctl stop 'nanoclaw-v2-*.service'
```

Then start the old Mac service again. Do not leave both services running against the same WhatsApp account.

## Notes

- For a new Pi, use 64-bit Raspberry Pi OS unless there is a reason not to.
- Keep the Pi on reliable power. A small UPS is worthwhile if this becomes daily infrastructure.
- Avoid putting `.env`, `store/auth/`, or `data/v2.db` into Dropbox automatic sync. Those contain secrets and active SQLite state.
- If you want recurring encrypted offsite backups of full NanoClaw state, add that as a separate backup job after the Pi is stable.
