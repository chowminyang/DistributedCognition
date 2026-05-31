#!/usr/bin/env bash
set -euo pipefail

TIMEOUT_SECONDS="${NANOCLAW_PI_DISCOVERY_TIMEOUT:-3}"
SKIP_MDNS="false"
SKIP_ARP="false"
REQUESTED_HOSTS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/pi-discover.sh [options]

Runs a non-mutating local-network discovery pass for a Raspberry Pi target.
It may resolve common .local hostnames, browse advertised SSH services, and
scan the local ARP cache for Raspberry Pi MAC address prefixes.

No SSH is opened. No files, WhatsApp state, Docker state, or Pi state are
changed.

Options:
  --host <name>       Hostname to check. Can be repeated.
                      Defaults include nanoclaw-pi.local, raspberrypi.local,
                      and distributed-cognition.local.
  --timeout <seconds> Per-command timeout. Default: 3.
  --skip-mdns         Skip dns-sd SSH service browsing.
  --skip-arp          Skip ARP cache scan.
  -h, --help          Show this help.

Environment defaults:
  NANOCLAW_PI_DISCOVERY_HOSTS    Optional comma/space-separated hostnames.
  NANOCLAW_PI_DISCOVERY_TIMEOUT  Per-command timeout.
EOF
}

add_host() {
  local candidate="$1"
  local existing=""
  [ -n "$candidate" ] || return 0
  for existing in "${REQUESTED_HOSTS[@]}"; do
    [ "$existing" = "$candidate" ] && return 0
  done
  REQUESTED_HOSTS+=("$candidate")
}

run_with_timeout() {
  local seconds="$1"
  shift

  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return "$?"
  fi

  "$@" &
  local child_pid="$!"
  (
    sleep "$seconds"
    kill "$child_pid" 2>/dev/null || true
  ) &
  local watcher_pid="$!"

  set +e
  wait "$child_pid"
  local status="$?"
  set -e

  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
  return "$status"
}

print_command_status() {
  local name="$1"
  local status="$2"
  if [ "$status" -eq 0 ]; then
    printf '%s=ok\n' "$name"
  else
    printf '%s=warn exit=%s\n' "$name" "$status"
  fi
}

resolve_host_with_getent() {
  local host="$1"
  local output=""
  local status=0

  command -v getent >/dev/null 2>&1 || return 127

  set +e
  output="$(run_with_timeout "$TIMEOUT_SECONDS" getent hosts "$host" 2>&1)"
  status="$?"
  set -e

  if [ "$status" -eq 0 ] && [ -n "$output" ]; then
    printf 'host=%s method=getent status=ok\n' "$host"
    printf '%s\n' "$output" | sed 's/^/  /'
    return 0
  fi

  printf 'host=%s method=getent status=miss exit=%s\n' "$host" "$status"
  [ -n "$output" ] && printf '%s\n' "$output" | sed 's/^/  /'
  return 1
}

resolve_host_with_dscacheutil() {
  local host="$1"
  local output=""
  local status=0

  command -v dscacheutil >/dev/null 2>&1 || return 127

  set +e
  output="$(run_with_timeout "$TIMEOUT_SECONDS" dscacheutil -q host -a name "$host" 2>&1)"
  status="$?"
  set -e

  if [ "$status" -eq 0 ] && printf '%s\n' "$output" | grep -Eq 'ip_address:|ipv6_address:'; then
    printf 'host=%s method=dscacheutil status=ok\n' "$host"
    printf '%s\n' "$output" | sed 's/^/  /'
    return 0
  fi

  printf 'host=%s method=dscacheutil status=miss exit=%s\n' "$host" "$status"
  [ -n "$output" ] && printf '%s\n' "$output" | sed 's/^/  /'
  return 1
}

resolve_host() {
  local host="$1"

  if command -v getent >/dev/null 2>&1; then
    resolve_host_with_getent "$host" && return 0
  fi

  if command -v dscacheutil >/dev/null 2>&1; then
    resolve_host_with_dscacheutil "$host" && return 0
  fi

  if ! command -v getent >/dev/null 2>&1 && ! command -v dscacheutil >/dev/null 2>&1; then
    printf 'host=%s status=skipped reason=no_getent_or_dscacheutil\n' "$host"
  fi

  return 1
}

browse_ssh_services() {
  local output=""
  local status=0

  if [ "$SKIP_MDNS" = "true" ]; then
    printf 'SSH_SERVICE_BROWSE=skipped reason=skip_mdns\n'
    return 0
  fi

  if ! command -v dns-sd >/dev/null 2>&1; then
    printf 'SSH_SERVICE_BROWSE=skipped reason=dns_sd_not_found\n'
    return 0
  fi

  set +e
  output="$(run_with_timeout "$TIMEOUT_SECONDS" dns-sd -B _ssh._tcp local 2>&1)"
  status="$?"
  set -e

  if [ -n "$output" ]; then
    print_command_status "SSH_SERVICE_BROWSE" "$status"
    printf '%s\n' "$output" | sed 's/^/  /'
  else
    printf 'SSH_SERVICE_BROWSE=warn reason=no_output exit=%s\n' "$status"
  fi
}

scan_arp_for_pi() {
  local output=""
  local candidates=""
  local oui_pattern='b8:27:eb|dc:a6:32|e4:5f:01|d8:3a:dd|2c:cf:67|28:cd:c1|88:a2:9e'

  if [ "$SKIP_ARP" = "true" ]; then
    printf 'ARP_RASPBERRY_PI_CANDIDATES=skipped reason=skip_arp\n'
    return 0
  fi

  if ! command -v arp >/dev/null 2>&1; then
    printf 'ARP_RASPBERRY_PI_CANDIDATES=skipped reason=arp_not_found\n'
    return 0
  fi

  set +e
  output="$(arp -a 2>&1)"
  set -e

  candidates="$(printf '%s\n' "$output" | awk -v pattern="$oui_pattern" 'tolower($0) ~ pattern {print}')"
  if [ -n "$candidates" ]; then
    printf 'ARP_RASPBERRY_PI_CANDIDATES=ok\n'
    printf '%s\n' "$candidates" | sed 's/^/  /'
  else
    printf 'ARP_RASPBERRY_PI_CANDIDATES=none\n'
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      [ -n "${2:-}" ] || { echo "Missing value for --host" >&2; exit 2; }
      add_host "$2"
      shift 2
      ;;
    --timeout)
      [ -n "${2:-}" ] || { echo "Missing value for --timeout" >&2; exit 2; }
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --skip-mdns)
      SKIP_MDNS="true"
      shift
      ;;
    --skip-arp)
      SKIP_ARP="true"
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

if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$TIMEOUT_SECONDS" -lt 1 ]; then
  echo "--timeout must be a positive integer number of seconds" >&2
  exit 2
fi

if [ -n "${NANOCLAW_PI_DISCOVERY_HOSTS:-}" ]; then
  hosts_env="${NANOCLAW_PI_DISCOVERY_HOSTS//,/ }"
  for host in $hosts_env; do
    add_host "$host"
  done
fi

add_host "nanoclaw-pi.local"
add_host "raspberrypi.local"
add_host "distributed-cognition.local"

host_resolution_hits=0

printf 'PI_DISCOVERY=ok\n'
printf 'Generated: `%s`\n\n' "$(date '+%d-%m-%y, %H:%M')"
printf 'This is a non-mutating local-network discovery pass for the Raspberry Pi target.\n'
printf 'No SSH was opened. No state was changed.\n\n'

printf '## Host Resolution\n\n'
printf 'Timeout per command: `%ss`\n' "$TIMEOUT_SECONDS"
printf 'Hosts checked:'
for host in "${REQUESTED_HOSTS[@]}"; do
  printf ' `%s`' "$host"
done
printf '\n\n'

for host in "${REQUESTED_HOSTS[@]}"; do
  if resolve_host "$host"; then
    host_resolution_hits=$((host_resolution_hits + 1))
  fi
done

if [ "$host_resolution_hits" -gt 0 ]; then
  printf '\nHOST_RESOLUTION=ok hits=%s\n\n' "$host_resolution_hits"
else
  printf '\nHOST_RESOLUTION=none\n\n'
fi

printf '## SSH Service Browse\n\n'
browse_ssh_services
printf '\n'

printf '## ARP Raspberry Pi Candidates\n\n'
scan_arp_for_pi
printf '\n'

cat <<'EOF'
## Suggested Next Step

If a likely host or IP appears above, set:

```bash
export NANOCLAW_PI_HOST="<hostname-or-ip>"
```

Then rerun:

```bash
pnpm run pi:mac-readiness -- --include-ssh-preflight
```

If nothing appears, use Raspberry Pi Imager, your router's client list, or a
keyboard/monitor on the Pi to confirm SSH is enabled and run `hostname -I`.
EOF
