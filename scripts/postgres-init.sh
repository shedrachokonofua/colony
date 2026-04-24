#!/bin/bash
# Postgres init: creates the additional databases listed in
# POSTGRES_MULTIPLE_DATABASES (comma-separated). The primary user/database from
# POSTGRES_USER/POSTGRES_DB already exists by the time this runs.
set -euo pipefail

if [ -z "${POSTGRES_MULTIPLE_DATABASES:-}" ]; then
  echo "POSTGRES_MULTIPLE_DATABASES not set — nothing to create"
  exit 0
fi

create_database() {
  local db="$1"
  echo "Creating database '$db' owned by '$POSTGRES_USER'..."
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE "$db" OWNER "$POSTGRES_USER"'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
EOSQL
}

IFS=',' read -ra DBS <<< "$POSTGRES_MULTIPLE_DATABASES"
for db in "${DBS[@]}"; do
  create_database "$(echo "$db" | xargs)"
done

echo "Postgres init complete."
