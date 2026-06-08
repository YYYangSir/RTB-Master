#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root_env="$project_root/.env"
api_env="$project_root/apps/api-server/.env"

if [ ! -f "$root_env" ]; then
  cp "$project_root/.env.example" "$root_env"
  printf '[created] %s\n' "$root_env"
fi

if ! grep -q '^SHADOW_DATABASE_URL=' "$root_env"; then
  printf '\nSHADOW_DATABASE_URL=mysql://auction:local-development-only@127.0.0.1:3306/auction_shadow\n' >> "$root_env"
  printf '[updated] added SHADOW_DATABASE_URL to %s\n' "$root_env"
fi

if [ -e "$api_env" ] && [ ! -L "$api_env" ]; then
  printf '[error] %s exists and is not a symbolic link\n' "$api_env" >&2
  exit 1
fi

ln -sfn "../../.env" "$api_env"
printf '[linked] %s -> ../../.env\n' "$api_env"
