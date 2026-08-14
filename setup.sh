#!/usr/bin/env sh
set -eu

umask 077

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
TEMPLATE_FILE="$SCRIPT_DIR/.env.example"
ENV_FILE="$SCRIPT_DIR/.env"

if [ -e "$ENV_FILE" ]; then
  printf '%s\n' "Refusing to overwrite existing $ENV_FILE." >&2
  printf '%s\n' "Edit it directly, or remove it intentionally before running setup again." >&2
  exit 1
fi

if [ ! -r "$TEMPLATE_FILE" ]; then
  printf '%s\n' "Missing environment template: $TEMPLATE_FILE" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' "OpenSSL is required to generate deployment secrets." >&2
  exit 1
fi

POSTGRES_PASSWORD=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 48)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -hex 18)

sed \
  -e "s/replace-with-a-long-random-postgres-password/$POSTGRES_PASSWORD/" \
  -e "s/replace-with-a-long-random-session-secret/$SESSION_SECRET/" \
  -e "s/replace-with-a-long-random-encryption-key/$ENCRYPTION_KEY/" \
  -e "s/replace-with-an-admin-password/$ADMIN_PASSWORD/" \
  "$TEMPLATE_FILE" > "$ENV_FILE"

mkdir -p "$SCRIPT_DIR/inventory_data" "$SCRIPT_DIR/postgres_data"

printf '%s\n' "Created $ENV_FILE, $SCRIPT_DIR/inventory_data, and $SCRIPT_DIR/postgres_data."
printf '%s\n' "Admin username: admin"
printf '%s\n' "Admin password: $ADMIN_PASSWORD"
printf '%s\n' "Store the admin password securely, then start with: docker compose up -d"
