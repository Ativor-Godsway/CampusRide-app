-- Canonicalize User.phone to "+233XXXXXXXXX".
--
-- WHY: the auth routes stored whatever the user typed, while the USSD path
-- normalized first. So the same person could exist twice — a real app account
-- in local form ("0548608146") and a shadow "USSD Rider" auto-provisioned by
-- findOrCreateRiderByPhone when it normalized their number and found no match.
-- Production held three such pairs. This merges them, backfills the column,
-- and adds a constraint so it cannot drift again.
--
-- THIS MIGRATION RUNS UNATTENDED ON DEPLOY, so it asserts its preconditions
-- and RAISES rather than guessing. Every check below was verified by hand
-- against production first (all zero); if reality has drifted since, the
-- deploy fails loudly with the offending rows named and nothing is changed.
--
-- Deliberately NOT touching deleted accounts: DELETE /me rewrites phone to
-- "deleted:<userId>" (see services/auth/deleteAccount.ts), which is not a
-- dialable number by design and must stay exactly as it is.

-- ── 1. Identify the duplicate pairs ─────────────────────────────────────────
-- survivor = the real, named, earlier account (local form)
-- shadow   = the auto-provisioned USSD row holding the canonical spelling
CREATE TEMP TABLE phone_merge_pairs AS
WITH dup AS (
  SELECT id, phone, name,
         regexp_replace(phone, '^(\+?233|0)', '') AS subscriber
  FROM "User"
  WHERE "deletedAt" IS NULL
    AND phone NOT LIKE 'deleted:%'
    AND regexp_replace(phone, '^(\+?233|0)', '') IN (
      SELECT regexp_replace(phone, '^(\+?233|0)', '')
      FROM "User"
      WHERE "deletedAt" IS NULL AND phone NOT LIKE 'deleted:%'
      GROUP BY 1 HAVING count(*) > 1
    )
)
SELECT s.subscriber,
       s.id AS survivor_id, s.phone AS survivor_phone, s.name AS survivor_name,
       h.id AS shadow_id,   h.phone AS shadow_phone,   h.name AS shadow_name
FROM dup s
JOIN dup h ON h.subscriber = s.subscriber AND h.id <> s.id
WHERE s.phone NOT LIKE '+233%' AND h.phone LIKE '+233%';

-- ── 2. Refuse to run on data we have not verified ───────────────────────────
DO $$
DECLARE
  bad_count  int;
  bad_detail text;
BEGIN
  -- 2a. More than two rows for one subscriber: not a shape we reasoned about.
  SELECT count(*) INTO bad_count
  FROM (
    SELECT regexp_replace(phone, '^(\+?233|0)', '') AS subscriber
    FROM "User"
    WHERE "deletedAt" IS NULL AND phone NOT LIKE 'deleted:%'
    GROUP BY 1 HAVING count(*) > 2
  ) x;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'phone canonicalisation: % subscriber(s) have more than 2 accounts; merge by hand first', bad_count;
  END IF;

  -- 2b. Every colliding subscriber must have produced exactly one pair.
  SELECT count(*) INTO bad_count
  FROM (
    SELECT regexp_replace(phone, '^(\+?233|0)', '') AS subscriber
    FROM "User"
    WHERE "deletedAt" IS NULL AND phone NOT LIKE 'deleted:%'
    GROUP BY 1 HAVING count(*) > 1
  ) c
  WHERE c.subscriber NOT IN (SELECT subscriber FROM phone_merge_pairs);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'phone canonicalisation: % colliding subscriber(s) are not one-local-plus-one-canonical; inspect before migrating', bad_count;
  END IF;

  -- 2c. Merging must not make one user both rider and driver of a ride.
  SELECT count(*) INTO bad_count
  FROM phone_merge_pairs p
  JOIN "Ride" r
    ON (r."riderId" = p.shadow_id   AND r."driverId" = p.survivor_id)
    OR (r."driverId" = p.shadow_id  AND r."riderId"  = p.survivor_id);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'phone canonicalisation: % ride(s) would end up with the same user as rider and driver', bad_count;
  END IF;

  -- 2d. The shadow must be what we think it is: no money, no ratings, no
  --     driver identity. Anything else is a real second account, not an
  --     artifact, and a human has to decide what happens to it.
  SELECT count(*), string_agg(DISTINCT p.shadow_phone, ', ')
    INTO bad_count, bad_detail
  FROM phone_merge_pairs p
  WHERE EXISTS (SELECT 1 FROM "Payment"          x WHERE x."riderId"      = p.shadow_id)
     OR EXISTS (SELECT 1 FROM "Rating"           x WHERE x."raterId" = p.shadow_id OR x."rateeId" = p.shadow_id)
     OR EXISTS (SELECT 1 FROM "CommissionLedger" x WHERE x."driverUserId" = p.shadow_id)
     OR EXISTS (SELECT 1 FROM "Driver"           x WHERE x."userId"       = p.shadow_id)
     OR EXISTS (SELECT 1 FROM "Ride"             x WHERE x."driverId"     = p.shadow_id);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'phone canonicalisation: % shadow account(s) carry payments/ratings/commission/driver data (%); merge by hand', bad_count, bad_detail;
  END IF;

  -- 2e. Every surviving row must actually normalize. A phone we cannot parse
  --     would fail the CHECK at the end and abort mid-migration; fail here
  --     instead, where the message is useful.
  SELECT count(*), string_agg(phone, ', ') INTO bad_count, bad_detail
  FROM "User"
  WHERE "deletedAt" IS NULL
    AND phone NOT LIKE 'deleted:%'
    AND replace(replace(phone, ' ', ''), '-', '') !~ '^(\+233|233|0)[0-9]{9}$';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'phone canonicalisation: % phone(s) are not Ghanaian numbers and cannot be canonicalised (%)', bad_count, bad_detail;
  END IF;
END $$;

-- ── 3. Move the shadow's history onto the real account ──────────────────────
-- Shadows only ever hold rides and passenger rows (asserted in 2d above).
UPDATE "Ride" r
   SET "riderId" = p.survivor_id
  FROM phone_merge_pairs p
 WHERE r."riderId" = p.shadow_id;

UPDATE "RidePassenger" rp
   SET "riderId" = p.survivor_id
  FROM phone_merge_pairs p
 WHERE rp."riderId" = p.shadow_id;

UPDATE "RideRejection" rr
   SET "driverUserId" = p.survivor_id
  FROM phone_merge_pairs p
 WHERE rr."driverUserId" = p.shadow_id;

-- ── 4. Remove the shadow account ────────────────────────────────────────────
-- RefreshToken cascades on user removal, but be explicit: any session on the
-- shadow identity must end here rather than linger against a vanished user id.
DELETE FROM "RefreshToken" t USING phone_merge_pairs p WHERE t."userId" = p.shadow_id;
DELETE FROM "User"         u USING phone_merge_pairs p WHERE u.id      = p.shadow_id;

-- ── 5. Canonicalize every remaining live account ────────────────────────────
-- The shadow is gone, so the canonical spelling is now free for the survivor
-- to take. Order matters: doing this before step 4 would violate the unique
-- index on User.phone.
UPDATE "User"
   SET phone = '+233' || right(replace(replace(phone, ' ', ''), '-', ''), 9)
 WHERE "deletedAt" IS NULL
   AND phone NOT LIKE 'deleted:%'
   AND phone NOT LIKE '+233%';

-- Strip stray spaces/dashes from rows that were already "+233…".
UPDATE "User"
   SET phone = replace(replace(phone, ' ', ''), '-', '')
 WHERE "deletedAt" IS NULL
   AND phone LIKE '+233%'
   AND phone <> replace(replace(phone, ' ', ''), '-', '');

-- ── 6. Prove it worked, inside the same transaction ─────────────────────────
DO $$
DECLARE bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM "User"
  WHERE "deletedAt" IS NULL AND phone NOT LIKE 'deleted:%' AND phone !~ '^\+233[0-9]{9}$';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'phone canonicalisation: % row(s) still not canonical after backfill', bad_count;
  END IF;

  SELECT count(*) INTO bad_count
  FROM (
    SELECT regexp_replace(phone, '^(\+?233|0)', '')
    FROM "User" WHERE "deletedAt" IS NULL AND phone NOT LIKE 'deleted:%'
    GROUP BY 1 HAVING count(*) > 1
  ) x;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'phone canonicalisation: % duplicate subscriber(s) remain after merge', bad_count;
  END IF;
END $$;

-- ── 7. Stop it drifting again ───────────────────────────────────────────────
-- Prisma cannot express a CHECK in schema.prisma, so this lives here and is
-- documented on the model. The 'deleted:%' arm is REQUIRED: without it every
-- future DELETE /me would fail, because it rewrites phone to "deleted:<id>".
ALTER TABLE "User"
  ADD CONSTRAINT "User_phone_canonical_check"
  CHECK (phone LIKE '+233%' OR phone LIKE 'deleted:%');

DROP TABLE phone_merge_pairs;
