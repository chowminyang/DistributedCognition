#!/usr/bin/env bash
set -euo pipefail

LOCAL_DIR="$HOME/Distributed-Cognition"
REMOTE="dropbox:Distributed-Cognition"
INTERVAL="5min"
MODE="copy"
START="false"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-install-dropbox-sync.sh [options]

Installs a user-level systemd timer that updates Dropbox from a local
Distributed Cognition folder using rclone.

Options:
  --local <path>         Local folder. Default: ~/Distributed-Cognition
  --remote <remote:path> Dropbox remote path. Default: dropbox:Distributed-Cognition
  --interval <duration>  Timer interval. Default: 5min
  --mode <copy|sync>     copy is non-destructive; sync mirrors deletions. Default: copy
  --start                Enable and start the timer now.
  -h, --help             Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local)
      LOCAL_DIR="${2:-}"
      [ -n "$LOCAL_DIR" ] || { echo "Missing value for --local" >&2; exit 2; }
      shift 2
      ;;
    --remote)
      REMOTE="${2:-}"
      [ -n "$REMOTE" ] || { echo "Missing value for --remote" >&2; exit 2; }
      shift 2
      ;;
    --interval)
      INTERVAL="${2:-}"
      [ -n "$INTERVAL" ] || { echo "Missing value for --interval" >&2; exit 2; }
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      [ "$MODE" = "copy" ] || [ "$MODE" = "sync" ] || { echo "--mode must be copy or sync" >&2; exit 2; }
      shift 2
      ;;
    --start)
      START="true"
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

command -v rclone >/dev/null 2>&1 || { echo "rclone not found. Install it with apt or rclone's install docs." >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found" >&2; exit 1; }

LOCAL_DIR="${LOCAL_DIR/#\~/$HOME}"
mkdir -p "$LOCAL_DIR" "$HOME/.config/systemd/user" "$HOME/.local/state/nanoclaw"

REMOTE_NAME="${REMOTE%%:*}:"
if ! rclone listremotes | grep -Fx "$REMOTE_NAME" >/dev/null 2>&1; then
  cat >&2 <<EOF
Warning: rclone remote $REMOTE_NAME is not configured yet.
Run `rclone config` and create a Dropbox remote before starting the timer.
EOF
fi

RCLONE_BIN="$(command -v rclone)"
SERVICE="$HOME/.config/systemd/user/nanoclaw-dropbox-sync.service"
TIMER="$HOME/.config/systemd/user/nanoclaw-dropbox-sync.timer"
LOG_FILE="$HOME/.local/state/nanoclaw/dropbox-sync.log"

cat > "$SERVICE" <<EOF
[Unit]
Description=NanoClaw Distributed Cognition Dropbox update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$RCLONE_BIN $MODE "$LOCAL_DIR" "$REMOTE" --create-empty-src-dirs --links --fast-list --log-file "$LOG_FILE" --log-level INFO
EOF

cat > "$TIMER" <<EOF
[Unit]
Description=Run NanoClaw Dropbox update periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
Persistent=true
Unit=nanoclaw-dropbox-sync.service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload

if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
fi

if [ "$START" = "true" ]; then
  systemctl --user enable --now nanoclaw-dropbox-sync.timer
fi

echo "Installed: $SERVICE"
echo "Installed: $TIMER"
echo "Local: $LOCAL_DIR"
echo "Remote: $REMOTE"
echo "Mode: $MODE"
echo "Log: $LOG_FILE"
if [ "$START" = "true" ]; then
  echo "Started timer: nanoclaw-dropbox-sync.timer"
else
  echo "Start with: systemctl --user enable --now nanoclaw-dropbox-sync.timer"
fi
