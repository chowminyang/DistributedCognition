#!/usr/bin/env bash
set -euo pipefail

BUNDLE=""
CHECKSUM=""
STRICT="false"

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-inspect-state-bundle.sh --bundle <bundle.tar.gz> [options]

Inspects a NanoClaw Raspberry Pi state bundle before restoring it on the Pi.
This is read-only: it does not extract into the checkout, copy secrets, open
SSH, or change runtime state.

Checks:
  - bundle filename and checksum file shape;
  - SHA-256 checksum validity when a checksum file is present;
  - unsafe archive entries such as absolute paths or path traversal;
  - expected NanoClaw state paths such as .env, data/, store/, groups/;
  - WhatsApp auth and allowlist indicators for migration readiness.

Options:
  --bundle <path>      Local nanoclaw-pi-state-*.tar.gz bundle.
  --checksum <path>    Local checksum file. Default: <bundle>.sha256.
  --strict             Treat warnings as failures.
  -h, --help           Show this help.
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
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

warn_count=0
fail_count=0

ok() {
  printf 'OK - %s\n' "$1"
}

warn() {
  warn_count=$((warn_count + 1))
  printf 'WARN - %s\n' "$1"
}

fail() {
  fail_count=$((fail_count + 1))
  printf 'FAIL - %s\n' "$1"
}

archive_has_entry() {
  local pattern="$1"
  grep -Eq "$pattern" "$ENTRY_LIST"
}

archive_has_env_key() {
  local key_pattern="$1"
  local env_entry
  env_entry="$(grep -E '^(\./)?state/\.env$' "$ENTRY_LIST" | head -n 1 || true)"
  [ -n "$env_entry" ] || return 1
  tar -xOzf "$BUNDLE" "$env_entry" 2>/dev/null | grep -Eq "$key_pattern"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle)
      BUNDLE="${2:-}"
      [ -n "$BUNDLE" ] || { echo "Missing value for --bundle" >&2; exit 2; }
      shift 2
      ;;
    --checksum)
      CHECKSUM="${2:-}"
      [ -n "$CHECKSUM" ] || { echo "Missing value for --checksum" >&2; exit 2; }
      shift 2
      ;;
    --strict)
      STRICT="true"
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

[ -n "$BUNDLE" ] || { echo "Missing required --bundle" >&2; usage >&2; exit 2; }
BUNDLE="$(expand_local_path "$BUNDLE")"
if [ -z "$CHECKSUM" ]; then
  CHECKSUM="$BUNDLE.sha256"
fi
CHECKSUM="$(expand_local_path "$CHECKSUM")"

echo "NanoClaw Pi state bundle inspection"
echo "Bundle: $BUNDLE"
echo "Checksum: $CHECKSUM"
echo

if [ ! -f "$BUNDLE" ]; then
  echo "STATE_BUNDLE_INSPECT=fail failures=1 warnings=0"
  echo "Bundle not found: $BUNDLE" >&2
  exit 1
fi

BUNDLE_BASE="$(basename "$BUNDLE")"
CHECKSUM_BASE="$(basename "$CHECKSUM")"

case "$BUNDLE_BASE" in
  nanoclaw-pi-state-*.tar.gz)
    ok "bundle filename matches nanoclaw-pi-state-*.tar.gz"
    ;;
  *)
    fail "unexpected bundle filename; expected nanoclaw-pi-state-*.tar.gz"
    ;;
esac

case "$CHECKSUM_BASE" in
  *.sha256)
    ok "checksum filename ends with .sha256"
    ;;
  *)
    fail "unexpected checksum filename; expected .sha256"
    ;;
esac

if [ -f "$CHECKSUM" ]; then
  if command -v shasum >/dev/null 2>&1; then
    expected="$(awk '{print $1}' "$CHECKSUM" | head -n 1)"
    actual="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"
    if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
      ok "SHA-256 checksum matches"
    else
      fail "SHA-256 checksum mismatch"
    fi
  elif command -v sha256sum >/dev/null 2>&1; then
    expected="$(awk '{print $1}' "$CHECKSUM" | head -n 1)"
    actual="$(sha256sum "$BUNDLE" | awk '{print $1}')"
    if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
      ok "SHA-256 checksum matches"
    else
      fail "SHA-256 checksum mismatch"
    fi
  else
    warn "no SHA-256 tool found; checksum could not be verified locally"
  fi
else
  warn "checksum file missing; SSH restore requires it before copying to the Pi"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ENTRY_LIST="$TMP_DIR/bundle-entries.txt"

if tar -tzf "$BUNDLE" >"$ENTRY_LIST" 2>"$TMP_DIR/tar-list.err"; then
  ok "bundle can be listed"
else
  fail "bundle cannot be listed as gzip tar archive"
  sed 's/^/tar: /' "$TMP_DIR/tar-list.err" >&2 || true
fi

if [ -s "$ENTRY_LIST" ]; then
  unsafe_entries=()
  while IFS= read -r entry; do
    case "$entry" in
      /*|../*|*/../*|*/..)
        unsafe_entries+=("$entry")
        ;;
    esac
  done <"$ENTRY_LIST"

  if [ "${#unsafe_entries[@]}" -eq 0 ]; then
    ok "no unsafe archive entries found"
  else
    fail "unsafe archive entries found"
    printf '  %s\n' "${unsafe_entries[@]}"
  fi

  if archive_has_entry '^(\./)?MANIFEST\.txt$'; then
    ok "MANIFEST.txt is present"
  else
    warn "MANIFEST.txt missing"
  fi

  if archive_has_entry '^(\./)?state/\.env$'; then
    ok "state/.env is present"
    if archive_has_env_key '^(WHATSAPP_ALLOWED_JID|WHATSAPP_ALLOWLIST_JID|DISTRIBUTED_COGNITION_WHATSAPP_JID)='; then
      ok "WhatsApp sender allowlist key is present in state/.env"
    else
      warn "state/.env does not show a known WhatsApp sender allowlist key"
    fi
  else
    warn "state/.env missing; Pi restore will not have provider/WhatsApp env settings"
  fi

  for item in data store groups; do
    if archive_has_entry "^(\./)?state/$item(/|$)"; then
      ok "state/$item is present"
    else
      warn "state/$item missing"
    fi
  done

  if archive_has_entry '^(\./)?state/store/auth(/|$)'; then
    ok "state/store/auth is present for WhatsApp session restore"
  else
    warn "state/store/auth missing; Pi may need WhatsApp re-pairing"
  fi

  if archive_has_entry '^(\./)?home-config/nanoclaw/mount-allowlist\.json$'; then
    ok "mount allowlist is present"
  else
    warn "mount allowlist missing from home-config/nanoclaw"
  fi

  if archive_has_entry '^(\./)?home-config/nanoclaw/sender-allowlist\.json$'; then
    ok "sender allowlist file is present"
  else
    warn "sender allowlist file missing from home-config/nanoclaw"
  fi
fi

echo
if [ "$fail_count" -gt 0 ]; then
  echo "STATE_BUNDLE_INSPECT=fail failures=$fail_count warnings=$warn_count"
  exit 1
fi

if [ "$warn_count" -gt 0 ]; then
  if [ "$STRICT" = "true" ]; then
    echo "STATE_BUNDLE_INSPECT=fail failures=0 warnings=$warn_count strict=true"
    exit 1
  fi
  echo "STATE_BUNDLE_INSPECT=warn failures=0 warnings=$warn_count"
  exit 0
fi

echo "STATE_BUNDLE_INSPECT=ok failures=0 warnings=0"
