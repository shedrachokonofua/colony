-- Cluster-wide roles for the colony database (design.md §19, ADR-002).
--
-- These are NOLOGIN group roles. Service users (the Postgres user the apps
-- connect as) get membership in the appropriate role and switch into it via
-- SET ROLE — see packages/db/src/index.ts createPool({ role }).
--
-- Role creation is idempotent so running migrations against a cluster that
-- already has these roles (shared dev cluster, re-init after partial run) is
-- safe.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'colony_writer') THEN
    CREATE ROLE colony_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'colony_reader') THEN
    CREATE ROLE colony_reader NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO colony_writer, colony_reader;

-- Default privileges for objects created by the migration role going forward.
-- Per-table grants in the schema migration still apply explicitly so a reader
-- of the schema migration can see exactly what was granted.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO colony_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO colony_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO colony_writer, colony_reader;
