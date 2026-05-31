#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

require_gitignore_pattern() {
  local pattern="$1"
  if grep -Fxq "$pattern" "$PROJECT_ROOT/.gitignore"; then
    ok ".gitignore contains $pattern"
  else
    fail ".gitignore is missing $pattern"
  fi
}

tracked_secret_like_lines() {
  git -C "$PROJECT_ROOT" ls-files -z --cached --others --exclude-standard -- \
    . \
    ':!package-lock.json' \
    ':!pnpm-lock.yaml' \
    ':!docs/distributed-cognition.md' \
    ':!config-examples/raspberry-pi.env' |
    xargs -0 grep -n -I -E \
      '(sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-api03-[A-Za-z0-9_-]{20,}|OPENAI_API_KEY=(sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,})|ANTHROPIC_API_KEY=sk-ant-api03-[A-Za-z0-9_-]{20,}|WHATSAPP_ALLOWED_JID=[0-9]{8,}@s\.whatsapp\.net|WHATSAPP_PHONE_NUMBER=[0-9]{8,})' || true
}

tracked_runtime_paths() {
  git -C "$PROJECT_ROOT" ls-files --cached --others --exclude-standard | while IFS= read -r path; do
    case "$path" in
      .env|.env.local|.env.*.local|store/*|data/*|logs/*|output/*|Distributed-Cognition/*|second-brain/*|action-outputs/*|.dc-index/*)
        printf '%s\n' "$path"
        ;;
    esac
  done
}

cd "$PROJECT_ROOT"

echo "Distributed Cognition public-readiness check"
echo "Project: $PROJECT_ROOT"
echo

echo "== Git Ignore Boundary =="
for pattern in \
  ".env" \
  ".env*" \
  "store/" \
  "data/" \
  "logs/" \
  "output/" \
  "*.opus" \
  "groups/*" \
  ".playwright-mcp/"; do
  require_gitignore_pattern "$pattern"
done

echo
echo "== Public Candidate Runtime State =="
tracked_runtime="$(tracked_runtime_paths)"
if [ -n "$tracked_runtime" ]; then
  fail "runtime/private paths are tracked or ready to be staged:"
  printf '%s\n' "$tracked_runtime" | sed 's/^/  /'
else
  ok "no public-candidate runtime/private state paths found"
fi

echo
echo "== Secret-Like Public Candidate Content =="
secret_hits="$(tracked_secret_like_lines)"
if [ -n "$secret_hits" ]; then
  fail "public-candidate files contain secret-like or private WhatsApp values:"
  printf '%s\n' "$secret_hits" | sed 's/^/  /'
else
  ok "no obvious public-candidate API keys or concrete WhatsApp allowlist values found"
fi

echo
echo "== Local Artifact Status =="
untracked_visible="$(git status --short --untracked-files=all --ignored=no | grep -E '^\?\? \.playwright-mcp/' || true)"
if [ -n "$untracked_visible" ]; then
  fail ".playwright-mcp is visible as an untracked public artifact"
else
  ok ".playwright-mcp is ignored or absent"
fi

if [ -e "$PROJECT_ROOT/.env" ]; then
  ok ".env exists locally but is ignored"
else
  warn ".env is absent locally; this is fine for public readiness, but runtime needs it"
fi

if [ -d "$PROJECT_ROOT/store/auth" ]; then
  ok "WhatsApp auth exists locally but is ignored"
else
  warn "store/auth is absent locally; Pi migration may require re-pairing"
fi

echo
echo "== Remotes =="
if git remote get-url distributed-cognition >/tmp/dc-public-remote.$$ 2>/dev/null; then
  remote_url="$(cat /tmp/dc-public-remote.$$)"
  case "$remote_url" in
    https://github.com/*/DistributedCognition.git|git@github.com:*/DistributedCognition.git)
      ok "distributed-cognition remote points at DistributedCognition on GitHub"
      ;;
    *)
      warn "distributed-cognition remote exists but is unexpected: $remote_url"
      ;;
  esac
else
  warn "distributed-cognition remote is not configured"
fi
rm -f /tmp/dc-public-remote.$$

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "PUBLIC_READINESS=fail failures=$FAILURES warnings=$WARNINGS"
  exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
  echo "PUBLIC_READINESS=warn failures=0 warnings=$WARNINGS"
else
  echo "PUBLIC_READINESS=ok failures=0 warnings=0"
fi
