-- Lock down audit_log to insert-only for the writer role (design.md §7,
-- COL-0.6 acceptance).
--
-- The migration role (typically the Postgres owner) keeps full privileges so
-- future migrations can ALTER the table. Application traffic always runs
-- through SET ROLE colony_writer (see packages/db/src/index.ts), so the role
-- grants are what enforce the invariant in production.
--
-- This migration also applies the role grants for the rest of the schema in
-- one place so a reader can audit "what colony_writer can do" without
-- crawling every CREATE TABLE.

-- Reader: full SELECT across the schema.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO colony_reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO colony_reader;

-- Writer: full read/write across the schema, then narrow audit_log.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO colony_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO colony_writer;

-- audit_log is append-only. The writer role keeps SELECT + INSERT only.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM colony_writer;
