#!/usr/bin/env bash
set -euo pipefail

missing=0

check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    printf '[ok] %s: ' "$name"
    "$name" --version | head -n 1
  else
    printf '[missing] %s\n' "$name"
    missing=1
  fi
}

check_command node
check_command pnpm
check_command docker
check_command git

if [ "$missing" -ne 0 ]; then
  printf '\nInstall the missing tools before running the full development stack.\n'
  exit 1
fi

printf '\nEnvironment check passed.\n'

