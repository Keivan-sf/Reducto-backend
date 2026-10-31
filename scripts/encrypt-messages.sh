#!/usr/bin/env bash
# Stop the API and apply database migrations before running this script.
set +x
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
encryption_enabled="$(node -e 'if (require("node:fs").existsSync(".env")) process.loadEnvFile(".env"); process.stdout.write(String(process.env.MESSAGE_ENCRYPTION === "true"));')"
if [[ "$encryption_enabled" != 'true' ]]; then
  printf 'Message encryption is disabled; set MESSAGE_ENCRYPTION=true to enable it.\n'
  exit 0
fi
master_key=''
trap 'unset master_key' EXIT
IFS= read -r -s -p 'Master key: ' master_key </dev/tty
printf '\n' >/dev/tty
if [[ -z "$master_key" ]]; then
  printf 'Master key must not be empty.\n' >&2
  exit 1
fi
printf '%s' "$master_key" | ./node_modules/.bin/tsx src/db/encrypt-messages.cli.ts
