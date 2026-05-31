#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$PROJECT_ROOT/systemd/nanoclaw.service.template"
START="false"
UNIT_NAME=""
OUTPUT_DIR=""

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-install-systemd.sh [options]

Installs NanoClaw as a systemd service on Raspberry Pi OS/Linux.

Options:
  --start                Start/restart the service after installing it.
  --unit-name <name>     Override generated unit name. Default: nanoclaw-v2-<slug>.
  --output-dir <path>    Render the unit into a directory without installing it.
  -h, --help             Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --start)
      START="true"
      shift
      ;;
    --unit-name)
      UNIT_NAME="${2:-}"
      [ -n "$UNIT_NAME" ] || { echo "Missing value for --unit-name" >&2; exit 2; }
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      [ -n "$OUTPUT_DIR" ] || { echo "Missing value for --output-dir" >&2; exit 2; }
      shift 2
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

[ -f "$TEMPLATE" ] || { echo "Missing template: $TEMPLATE" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node not found on PATH" >&2; exit 1; }

if [ -z "$OUTPUT_DIR" ] && [ ! -f "$PROJECT_ROOT/dist/index.js" ]; then
  echo "dist/index.js not found; building first"
  (cd "$PROJECT_ROOT" && pnpm run build)
fi

hash_project_root() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$PROJECT_ROOT" | shasum -a 1 | awk '{print substr($1,1,8)}'
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$PROJECT_ROOT" | sha1sum | awk '{print substr($1,1,8)}'
  else
    basename "$PROJECT_ROOT" | tr -cd '[:alnum:]' | cut -c1-8
  fi
}

if [ -z "$UNIT_NAME" ]; then
  UNIT_NAME="nanoclaw-v2-$(hash_project_root)"
fi
if [ -n "$OUTPUT_DIR" ]; then
  mkdir -p "$OUTPUT_DIR"
  UNIT_FILE="$OUTPUT_DIR/$UNIT_NAME.service"
else
  command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found" >&2; exit 1; }
  UNIT_FILE="/etc/systemd/system/$UNIT_NAME.service"
fi

TARGET_USER="${SUDO_USER:-$(id -un)}"
resolve_home() {
  local user="$1"
  local home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$user" | cut -d: -f6)"
  fi
  if [ -z "$home" ] && [ "$user" = "$(id -un)" ]; then
    home="$HOME"
  fi
  printf '%s\n' "$home"
}

TARGET_HOME="$(resolve_home "$TARGET_USER")"
[ -n "$TARGET_HOME" ] || TARGET_HOME="$HOME"
NODE_PATH="$(command -v node)"
NODE_DIR="$(cd "$(dirname "$NODE_PATH")" && pwd)"
TZ_VALUE="${TZ:-Asia/Singapore}"

escape_sed() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

TMP_UNIT="$(mktemp)"
sed \
  -e "s/{{PROJECT_ROOT}}/$(escape_sed "$PROJECT_ROOT")/g" \
  -e "s/{{NODE_PATH}}/$(escape_sed "$NODE_PATH")/g" \
  -e "s/{{NODE_DIR}}/$(escape_sed "$NODE_DIR")/g" \
  -e "s/{{USER}}/$(escape_sed "$TARGET_USER")/g" \
  -e "s/{{HOME}}/$(escape_sed "$TARGET_HOME")/g" \
  -e "s/{{TZ}}/$(escape_sed "$TZ_VALUE")/g" \
  "$TEMPLATE" > "$TMP_UNIT"

if [ -n "$OUTPUT_DIR" ]; then
  install -m 0644 "$TMP_UNIT" "$UNIT_FILE"
else
  sudo install -m 0644 "$TMP_UNIT" "$UNIT_FILE"
fi
rm -f "$TMP_UNIT"

if [ -n "$OUTPUT_DIR" ]; then
  echo "Rendered: $UNIT_FILE"
  exit 0
fi

sudo systemctl daemon-reload
sudo systemctl enable "$UNIT_NAME.service"

if ! sudo -u "$TARGET_USER" docker info >/dev/null 2>&1; then
  cat >&2 <<EOF
Warning: docker info failed as $TARGET_USER.
If Docker was just installed, run:
  sudo usermod -aG docker $TARGET_USER
  newgrp docker
Then log out and back in before relying on the service.
EOF
fi

if [ "$START" = "true" ]; then
  sudo systemctl restart "$UNIT_NAME.service"
fi

echo "Installed: $UNIT_FILE"
echo "Enabled: $UNIT_NAME.service"
if [ "$START" = "true" ]; then
  echo "Started: $UNIT_NAME.service"
fi
echo "Logs:"
echo "  journalctl -u $UNIT_NAME.service -f"
echo "  tail -f $PROJECT_ROOT/logs/nanoclaw.log $PROJECT_ROOT/logs/nanoclaw.error.log"
