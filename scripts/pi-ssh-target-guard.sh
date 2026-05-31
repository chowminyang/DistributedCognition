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
