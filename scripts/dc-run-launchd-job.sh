#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: bash scripts/dc-run-launchd-job.sh <job-name> <second-brain-root> <command> [args...]

Runs a Distributed Cognition launchd job with a per-job lock so periodic
health/dashboard/bridge runs do not overlap.
EOF
}

if [ "$#" -lt 3 ]; then
  usage >&2
  exit 2
fi

JOB_NAME="$1"
SECOND_BRAIN_ROOT="$2"
shift 2

case "$JOB_NAME" in
  health|dashboard|memory-bridge|codex-bridge|action-bridge) ;;
  *)
    echo "Unsupported Distributed Cognition launchd job: $JOB_NAME" >&2
    exit 2
    ;;
esac

LOG_DIR="$PROJECT_ROOT/logs/launchd"
LOCK_DIR="$LOG_DIR/$JOB_NAME.lock"
mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') $JOB_NAME already running; skipping this tick"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

export DC_SECOND_BRAIN_ROOT="$SECOND_BRAIN_ROOT"
export TZ="${TZ:-Asia/Singapore}"

cd "$PROJECT_ROOT"
"$@"
