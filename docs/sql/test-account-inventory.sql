-- READ-ONLY inventory of test-fixture accounts in a database.
-- Nothing here writes. Safe to run against production.
--
-- Run each block separately in the Neon SQL editor and review before any
-- cleanup. See docs/incident-2026-09-24-test-rows-in-production.md.

-- ── 1. How big is the problem, and which fixture generator made each row? ───
SELECT
  CASE
    WHEN phone LIKE '+233-2a-test-%'   THEN 'ride fixtures (createTestUser)'
    WHEN phone LIKE '+233-auth-test-%' THEN 'auth fixtures (uniqueTestPhone)'
    WHEN phone LIKE '+2330%'           THEN 'new-style fixture (reserved prefix)'
    WHEN phone !~ '^\+233[0-9]{9}$' AND phone NOT LIKE 'deleted:%'
                                       THEN 'OTHER non-Ghanaian — inspect by hand'
    ELSE 'looks like a real account'
  END AS bucket,
  count(*)                       AS accounts,
  min("createdAt")::date         AS first_seen,
  max("createdAt")::date         AS last_seen
FROM "User"
GROUP BY 1
ORDER BY 2 DESC;

-- ── 2. What is attached to the unambiguous test accounts? ───────────────────
-- This is the set the cleanup script targets: phones that cannot be real.
WITH test_users AS (
  SELECT id, phone, name, role
  FROM "User"
  WHERE phone LIKE '+233-2a-test-%'
     OR phone LIKE '+233-auth-test-%'
)
SELECT
  (SELECT count(*) FROM test_users)                                              AS test_accounts,
  (SELECT count(*) FROM "Driver"           WHERE "userId"       IN (SELECT id FROM test_users)) AS driver_profiles,
  (SELECT count(*) FROM "Ride"             WHERE "riderId"      IN (SELECT id FROM test_users)) AS rides_as_rider,
  (SELECT count(*) FROM "Ride"             WHERE "driverId"     IN (SELECT id FROM test_users)) AS rides_as_driver,
  (SELECT count(*) FROM "RidePassenger"    WHERE "riderId"      IN (SELECT id FROM test_users)) AS passenger_rows,
  (SELECT count(*) FROM "Payment"          WHERE "riderId"      IN (SELECT id FROM test_users)) AS payments,
  (SELECT count(*) FROM "Rating"           WHERE "raterId"      IN (SELECT id FROM test_users)
                                              OR "rateeId"      IN (SELECT id FROM test_users)) AS ratings,
  (SELECT count(*) FROM "CommissionLedger" WHERE "driverUserId" IN (SELECT id FROM test_users)) AS commission_rows,
  (SELECT count(*) FROM "RideRejection"    WHERE "driverUserId" IN (SELECT id FROM test_users)) AS rejections,
  (SELECT count(*) FROM "RefreshToken"     WHERE "userId"       IN (SELECT id FROM test_users)) AS refresh_tokens,
  (SELECT count(*) FROM "OtpCode"          WHERE phone IN (SELECT phone FROM test_users))       AS otp_codes;

-- ── 3. THE IMPORTANT ONE: do test rides touch real accounts? ────────────────
-- A ride with a test rider and a REAL driver (or vice versa) cannot simply be
-- deleted — it is attached to a real person's history. Expect 0. If not,
-- inspect each one before running any cleanup.
WITH test_users AS (
  SELECT id FROM "User"
  WHERE phone LIKE '+233-2a-test-%' OR phone LIKE '+233-auth-test-%'
)
SELECT r.id AS ride_id, r.status, r."createdAt"::date,
       rider.phone  AS rider_phone,  rider.name  AS rider_name,
       driver.phone AS driver_phone, driver.name AS driver_name
FROM "Ride" r
JOIN "User" rider  ON rider.id  = r."riderId"
LEFT JOIN "User" driver ON driver.id = r."driverId"
WHERE (r."riderId"  IN (SELECT id FROM test_users) AND r."driverId" IS NOT NULL
                                                   AND r."driverId" NOT IN (SELECT id FROM test_users))
   OR (r."driverId" IN (SELECT id FROM test_users) AND r."riderId"  NOT IN (SELECT id FROM test_users))
ORDER BY r."createdAt";

-- Same question for shared rides: a test passenger sitting in a real ride.
WITH test_users AS (
  SELECT id FROM "User"
  WHERE phone LIKE '+233-2a-test-%' OR phone LIKE '+233-auth-test-%'
)
SELECT p.id AS passenger_row, p."rideId", u.phone AS passenger_phone
FROM "RidePassenger" p
JOIN "User" u ON u.id = p."riderId"
WHERE p."riderId" IN (SELECT id FROM test_users)
  AND p."rideId" IN (
    SELECT "rideId" FROM "RidePassenger"
    WHERE "riderId" NOT IN (SELECT id FROM test_users)
  )
ORDER BY p."rideId";

-- ── 4. Money attached to test accounts ──────────────────────────────────────
-- Commission rows are platform debt; payments are financial record. Both
-- should be 0 for fixtures. Anything here means a fixture transacted, and the
-- cleanup needs a decision rather than a script.
WITH test_users AS (
  SELECT id, phone FROM "User"
  WHERE phone LIKE '+233-2a-test-%' OR phone LIKE '+233-auth-test-%'
)
SELECT 'commission' AS kind, c.id, c."amountPesewas" AS amount, u.phone
FROM "CommissionLedger" c JOIN test_users u ON u.id = c."driverUserId"
UNION ALL
SELECT 'payment', p.id, p.amount, u.phone
FROM "Payment" p JOIN test_users u ON u.id = p."riderId";

-- ── 5. GROUP B — the ambiguous rows the cleanup will NOT touch ──────────────
-- ussdHandler.test.ts used to generate structurally VALID numbers (23320…),
-- and findOrCreateRiderByPhone names every row it creates "USSD Rider". These
-- are therefore indistinguishable from genuine USSD riders by name alone.
-- Review this list by hand; do not delete by name.
SELECT u.id, u.phone, u."createdAt",
       (SELECT count(*) FROM "Ride" r WHERE r."riderId" = u.id) AS rides,
       (SELECT count(*) FROM "RidePassenger" p WHERE p."riderId" = u.id) AS passenger_rows
FROM "User" u
WHERE u.name = 'USSD Rider'
  AND u.phone ~ '^\+233[0-9]{9}$'
ORDER BY u."createdAt";
