#!/usr/bin/env bash

assert_pi_ssh_target() {
  local host="$1"
  local user="$2"

  if [ -z "$host" ]; then
    echo "Missing required --host" >&2
    exit 2
  fi

  if [ -z "$user" ]; then
    echo "Missing required --user" >&2
    exit 2
  fi

  if [[ "$host" == *"@"* || "$host" =~ [[:space:]] ]]; then
    echo "Refusing unsafe Pi host: use a hostname or IP without user@ prefix or whitespace" >&2
    exit 2
  fi

  case "$host" in
    localhost|127.*|::1|0.0.0.0)
      echo "Refusing unsafe Pi host '$host': this would target the Mac/local machine rather than the Raspberry Pi" >&2
      exit 2
      ;;
  esac

  if ! [[ "$user" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Refusing unsafe Pi SSH user: use only letters, numbers, dot, underscore, or dash" >&2
    exit 2
  fi
}

add_default_pi_ssh_options() {
  local ssh_connect_timeout="${1:-}"

  add_ssh_option "BatchMode=yes"
  add_ssh_option "StrictHostKeyChecking=accept-new"
  add_ssh_option "ServerAliveInterval=15"
  add_ssh_option "ServerAliveCountMax=2"

  if [ -n "$ssh_connect_timeout" ]; then
    [[ "$ssh_connect_timeout" =~ ^[0-9]+$ ]] || { echo "NANOCLAW_PI_SSH_CONNECT_TIMEOUT must be a positive integer" >&2; exit 2; }
    [ "$ssh_connect_timeout" -gt 0 ] || { echo "NANOCLAW_PI_SSH_CONNECT_TIMEOUT must be greater than 0" >&2; exit 2; }
    add_ssh_option "ConnectTimeout=$ssh_connect_timeout"
  fi
}
