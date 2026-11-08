-- When each rider was picked up and dropped off (RidePassenger), so a
-- driver's "Undo" is taken only within its short window. Two nullable
-- columns, no backfill: older seats simply can't be undone. Safe to apply
-- before the code that uses it is deployed: the running server never reads
-- them.
-- AlterTable
ALTER TABLE "RidePassenger" ADD COLUMN     "pickedUpAt" TIMESTAMP(3),
ADD COLUMN     "droppedOffAt" TIMESTAMP(3);
