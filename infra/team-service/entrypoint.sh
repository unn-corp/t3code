#!/bin/sh
set -eu
umask 077

secret_file=/run/secrets/clerk_secret_key
if [ ! -f "$secret_file" ] || [ ! -r "$secret_file" ]; then
  printf '%s\n' 'The Clerk secret file must exist and be readable; configure sign-in before launching.' >&2
  exit 1
fi

# Keep secret values out of Compose configuration and image metadata. The team
# collaboration startup validates required nonempty Clerk configuration.
T3_TEAM_CLERK_SECRET_KEY=$(cat "$secret_file")
if [ -z "$T3_TEAM_CLERK_SECRET_KEY" ]; then
  printf '%s\n' 'Teams collaboration service requires nonempty T3_TEAM_CLERK_SECRET_KEY.' >&2
  exit 1
fi
export T3_TEAM_CLERK_SECRET_KEY

exec "$@"
