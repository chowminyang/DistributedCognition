#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECOND_BRAIN_ROOT="${DC_SECOND_BRAIN_ROOT:-}"
OUT_DIR="$PROJECT_ROOT/output"
REQUIRE_STOPPED="false"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-mac-export-preflight.sh [options]

Checks whether the Mac-side NanoClaw / Distributed Cognition state is ready to
export for Raspberry Pi migration. This script does not create the secret state
bundle; run pi:export only after this check is clean enough for cutover.

Options:
  --root <path>            Local Distributed-Cognition second-brain folder.
  --out-dir <path>         Intended export output directory. Default: ./output
  --require-stopped        Fail if the Mac NanoClaw host still appears to run.
  -h, --help               Show this help.

You can also set DC_SECOND_BRAIN_ROOT instead of --root.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      SECOND_BRAIN_ROOT="${2:-}"
      [ -n "$SECOND_BRAIN_ROOT" ] || { echo "Missing value for --root" >&2; exit 2; }
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      [ -n "$OUT_DIR" ] || { echo "Missing value for --out-dir" >&2; exit 2; }
      shift 2
      ;;
    --require-stopped)
      REQUIRE_STOPPED="true"
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

if [ -z "$SECOND_BRAIN_ROOT" ]; then
  cat >&2 <<'EOF'
Missing --root.

Provide the local Dropbox-backed Distributed-Cognition folder, for example:
  --root "$HOME/Library/CloudStorage/Dropbox/Distributed-Cognition"
EOF
  exit 2
fi

SECOND_BRAIN_ROOT="${SECOND_BRAIN_ROOT/#\~/$HOME}"
OUT_DIR="${OUT_DIR/#\~/$HOME}"

FAILURES=0
WARNINGS=0

ok() {
  printf 'OK - %s\n' "$1"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  printf 'WARN - %s\n' "$1"
}

fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL - %s\n' "$1"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

is_nanoclaw_running() {
  pgrep -f "$PROJECT_ROOT/dist/index.js" >/dev/null 2>&1 && return 0
  pgrep -f "$PROJECT_ROOT.*dist/index.js" >/dev/null 2>&1 && return 0
  pgrep -f "node .*dist/index.js" >/dev/null 2>&1 && return 0
  pgrep -f "$PROJECT_ROOT/src/index.ts" >/dev/null 2>&1 && return 0
  pgrep -f "tsx .*src/index.ts" >/dev/null 2>&1 && return 0
  return 1
}

env_has_key() {
  local key="$1"
  [ -f "$PROJECT_ROOT/.env" ] || return 1
  grep -Eq "^${key}=[^[:space:]]+" "$PROJECT_ROOT/.env"
}

echo "Mac export preflight for Raspberry Pi migration"
echo "Project: $PROJECT_ROOT"
echo "Second brain root: $SECOND_BRAIN_ROOT"
echo "Export output dir: $OUT_DIR"
echo

echo "== Commands =="
for command_name in pnpm tar pgrep; do
  if have "$command_name"; then
    ok "$command_name found at $(command -v "$command_name")"
  else
    fail "$command_name not found"
  fi
done
if have shasum || have sha256sum; then
  ok "SHA-256 checksum command is available"
else
  warn "No SHA-256 checksum command found; export can run but checksum will be skipped"
fi

echo
echo "== Second Brain =="
if [ -d "$SECOND_BRAIN_ROOT" ]; then
  ok "second-brain root exists"
  if [ -w "$SECOND_BRAIN_ROOT" ]; then
    ok "second-brain root is writable"
  else
    fail "second-brain root is not writable"
  fi
else
  fail "second-brain root does not exist"
fi

if [ -d "$SECOND_BRAIN_ROOT/.dc-index" ]; then
  ok ".dc-index exists"
else
  warn ".dc-index missing; run pnpm run dc:dashboard before cutover if you want fresh dashboard/index files"
fi

echo
echo "== NanoClaw State To Export =="
for item in .env data store groups; do
  if [ -e "$PROJECT_ROOT/$item" ]; then
    ok "$item exists"
  else
    warn "$item missing; the state bundle will not include it"
  fi
done
if [ -d "$PROJECT_ROOT/store/auth" ]; then
  ok "store/auth exists for WhatsApp session restore"
else
  warn "store/auth missing; the Pi will likely need WhatsApp re-pairing"
fi
if [ -f "$HOME/.config/nanoclaw/mount-allowlist.json" ]; then
  ok "mount allowlist exists"
else
  warn "mount allowlist not found under ~/.config/nanoclaw"
fi
if [ -f "$HOME/.config/nanoclaw/sender-allowlist.json" ]; then
  ok "sender allowlist exists"
elif env_has_key WHATSAPP_ALLOWED_JID || env_has_key WHATSAPP_ALLOWLIST_JID || env_has_key DISTRIBUTED_COGNITION_WHATSAPP_JID; then
  ok "WhatsApp sender allowlist is configured in .env"
else
  warn "sender allowlist not found in ~/.config/nanoclaw or WhatsApp .env allowlist keys"
fi

echo
echo "== Output Directory =="
if mkdir -p "$OUT_DIR" 2>/dev/null; then
  ok "output directory exists or was created"
  if [ -w "$OUT_DIR" ]; then
    ok "output directory is writable"
  else
    fail "output directory is not writable"
  fi
else
  fail "could not create output directory"
fi

echo
echo "== Runtime Quietness =="
if is_nanoclaw_running; then
  if [ "$REQUIRE_STOPPED" = "true" ]; then
    fail "Mac NanoClaw host appears to be running; stop launchd/host before final export"
  else
    warn "Mac NanoClaw host appears to be running; this is OK before rehearsal, not OK for final export"
  fi
else
  ok "Mac NanoClaw host process does not appear to be running"
fi

if have pnpm; then
  if pnpm run dc:install-launchd -- status >/tmp/dc-launchd-status.$$ 2>/tmp/dc-launchd-status.err.$$; then
    if grep -q 'state = running' /tmp/dc-launchd-status.$$; then
      warn "one or more launchd jobs are currently running"
    else
      ok "launchd jobs are loaded but not currently running"
    fi
  else
    warn "could not read launchd status: $(tr '\n' ' ' < /tmp/dc-launchd-status.err.$$)"
  fi
  rm -f /tmp/dc-launchd-status.$$ /tmp/dc-launchd-status.err.$$
fi

if find "$PROJECT_ROOT/logs/launchd" -name '*.lock' -print -quit 2>/dev/null | grep -q .; then
  warn "launchd lock files exist under logs/launchd; check for stale bridge runs before export"
else
  ok "no launchd lock files found"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "MAC_EXPORT_PREFLIGHT=fail failures=$FAILURES warnings=$WARNINGS"
  exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
  echo "MAC_EXPORT_PREFLIGHT=warn failures=0 warnings=$WARNINGS"
else
  echo "MAC_EXPORT_PREFLIGHT=ok failures=0 warnings=0"
fi

echo
echo "Final cutover export command:"
echo "  pnpm run dc:install-launchd -- uninstall"
echo "  pnpm run dc:stop-host -- --execute"
echo "  pnpm run pi:mac-preflight -- --root \"$SECOND_BRAIN_ROOT\" --out-dir \"$OUT_DIR\" --require-stopped"
echo "  pnpm run pi:export -- --out-dir \"$OUT_DIR\""
