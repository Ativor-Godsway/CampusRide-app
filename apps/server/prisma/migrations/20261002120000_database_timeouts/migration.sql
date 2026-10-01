-- Time limits on the database itself, so a stuck transaction can never make
-- other requests wait for minutes. (A 29-minute stall was seen in testing.)
--
-- What happens without them: when Prisma gives up on an interactive
-- transaction (P2028, its own timeout), the database session keeps its row
-- locks until Prisma's ROLLBACK arrives. With lock_timeout and
-- statement_timeout at 0 (no limit), anything waiting on those rows waits
-- for as long as that takes. Neon's default only ends an idle transaction
-- after 5 minutes; plain Postgres never does.
--
--   lock_timeout = 10s       waiting for a row lock gives up after 10 s
--                            (the request fails with a 500; the driver app
--                            retries quietly — every action is idempotent)
--   statement_timeout = 30s  no single statement runs longer than 30 s
--   idle_in_transaction_session_timeout = 60s
--                            a session left inside a transaction with
--                            nothing happening is ended after 60 s, which
--                            releases its locks
--
-- NOT a schema change: database settings only, no table or row touched.
-- They apply to NEW connections, so restart the server after deploying.
-- The migration role must own the database (true on our Neon branches);
-- if it doesn't, this warns instead of failing, and the settings must be
-- applied by the owner with the same three ALTER DATABASE statements.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET lock_timeout = %L', current_database(), '10s');
  EXECUTE format('ALTER DATABASE %I SET statement_timeout = %L', current_database(), '30s');
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '60s');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'database_timeouts: not applied (the migration role does not own database %). Ask the owner to run: ALTER DATABASE % SET lock_timeout = ''10s''; ALTER DATABASE % SET statement_timeout = ''30s''; ALTER DATABASE % SET idle_in_transaction_session_timeout = ''60s'';',
    current_database(), current_database(), current_database(), current_database();
END $$;
