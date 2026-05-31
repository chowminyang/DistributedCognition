#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
EXECUTE="false"
FORCE="false"
TIMEOUT_SECONDS="8"

usage() {
  cat <<'EOF'
Usage: bash scripts/dc-stop-host.sh [options]

Stops the Mac-side NanoClaw host for a Raspberry Pi cutover.

By default this is a dry run. It prints only process IDs and working
directories, not command lines, so secrets accidentally present in argv are not
echoed back into logs.

Options:
  --execute             Actually stop matching screen sessions and host PIDs.
  --force               After TERM, send KILL to remaining matching PIDs.
  --timeout <seconds>   Seconds to wait after TERM. Default: 8.
  -h, --help            Show this help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --execute)
      EXECUTE="true"
      shift
      ;;
    --force)
      FORCE="true"
      shift
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-}"
      [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || { echo "--timeout must be an integer" >&2; exit 2; }
      shift 2
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

have() {
  command -v "$1" >/dev/null 2>&1
}

canonical_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

pid_cwd() {
  local pid="$1"
  local cwd=""

  if have lsof; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  fi

  if [ -z "$cwd" ] && [ -e "/proc/$pid/cwd" ] && have readlink; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  fi

  [ -n "$cwd" ] || return 1
  canonical_dir "$cwd"
}

find_host_pids() {
  have pgrep || return 0

  local candidates
  candidates="$(pgrep -f '(^|[ /])(node|tsx)([ ]|.*[ ])(dist/index\.js|src/index\.ts)' 2>/dev/null || true)"
  [ -n "$candidates" ] || return 0

  local pid cwd
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" != "$$" ] || continue
    [ "$pid" != "${PPID:-}" ] || continue
    cwd="$(pid_cwd "$pid" 2>/dev/null || true)"
    [ "$cwd" = "$PROJECT_ROOT" ] || continue
    printf '%s\n' "$pid"
  done <<EOF
$candidates
EOF
}

find_screen_sessions() {
  have screen || return 0

  { screen -ls 2>/dev/null || true; } |
    awk '
      /[0-9]+\./ {
        for (i = 1; i <= NF; i += 1) {
          if ($i ~ /^[0-9]+\./ && tolower($i) ~ /(nanoclaw|distributed|cognition)/) {
            print $i
          }
        }
      }
    '
}

unique_lines() {
  awk 'NF && !seen[$0]++'
}

HOST_PIDS="$(find_host_pids | unique_lines)"
SCREEN_SESSIONS="$(find_screen_sessions | unique_lines)"

echo "Mac NanoClaw host stop helper"
echo "Project: $PROJECT_ROOT"
echo "Mode: $([ "$EXECUTE" = "true" ] && echo execute || echo dry-run)"
echo

echo "== Matching screen sessions =="
if [ -n "$SCREEN_SESSIONS" ]; then
  while IFS= read -r session; do
    [ -n "$session" ] && echo "screen: $session"
  done <<EOF
$SCREEN_SESSIONS
EOF
else
  echo "none"
fi

echo
echo "== Matching host PIDs =="
if [ -n "$HOST_PIDS" ]; then
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    echo "pid: $pid cwd: $PROJECT_ROOT"
  done <<EOF
$HOST_PIDS
EOF
else
  echo "none"
fi

if [ "$EXECUTE" != "true" ]; then
  echo
  echo "Dry run only. Rerun with --execute during final Raspberry Pi cutover."
  exit 0
fi

echo
echo "== Stopping =="
if [ -n "$SCREEN_SESSIONS" ]; then
  while IFS= read -r session; do
    [ -n "$session" ] || continue
    if screen -S "$session" -X quit 2>/dev/null; then
      echo "stopped screen: $session"
    else
      echo "warn: could not stop screen: $session" >&2
    fi
  done <<EOF
$SCREEN_SESSIONS
EOF
fi

if [ -n "$HOST_PIDS" ]; then
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      echo "sent TERM to pid: $pid"
    fi
  done <<EOF
$HOST_PIDS
EOF

  sleep "$TIMEOUT_SECONDS"

  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" 2>/dev/null; then
      if [ "$FORCE" = "true" ]; then
        kill -KILL "$pid" 2>/dev/null || true
        echo "sent KILL to pid: $pid"
      else
        echo "warn: pid still running after TERM: $pid" >&2
      fi
    fi
  done <<EOF
$HOST_PIDS
EOF
fi

REMAINING="$(find_host_pids | unique_lines)"
if [ -n "$REMAINING" ]; then
  echo "HOST_STOP=warn remaining_pids=$(printf '%s' "$REMAINING" | wc -l | tr -d ' ')"
  exit 1
fi

echo "HOST_STOP=ok"
