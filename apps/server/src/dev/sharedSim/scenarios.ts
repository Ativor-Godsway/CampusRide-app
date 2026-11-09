/**
 * Whole shared-ride trips, step by step, with several drivers and riders,
 * through the real server (world.ts). Each scenario checks the dispatch
 * rules (services/ride/requestFit.ts) as a driver's phone sees them — the
 * pop-up (ride:broadcast), the requests list, the "gone" events — and logs
 * a readable timeline. Run by sharedRides.simulation.test.ts and by
 * `npm run simulate:shared`.
 */
import { DISPATCH_WINDOW_MS, DRIVER_EVENTS, RIDE_EVENTS, getSharedFarePerRider, splitFare } from "@rida/shared";
import { createRide } from "../../services/ride/createRide";
import { check, type SimDriver, type SimRider, type World } from "./world";

export interface Scenario {
  key: string;
  title: string;
  run: (world: World) => Promise<void>;
}

const label = (rider: SimRider) => `${rider.name}'s request`;

/** The driver is offered it: a pop-up (ride:broadcast) after `since`, and it's in their list. */
async function expectShown(world: World, driver: SimDriver, rider: SimRider, since: number, why = ""): Promise<void> {
  const id = rider.requestId!;
  check(await driver.poppedUp(id, since), `${driver.name} should get a pop-up for ${label(rider)}${why ? ` (${why})` : ""}`);
  check((await driver.list()).includes(id), `${driver.name}'s list should show ${label(rider)}${why ? ` (${why})` : ""}`);
  world.log(`${driver.name} sees ${label(rider)} — pop-up and list${why ? ` (${why})` : ""}`);
}

/** The driver is NOT offered it: no pop-up after `since`, and not in their list. */
async function expectHidden(world: World, driver: SimDriver, rider: SimRider, since: number, why: string): Promise<void> {
  const id = rider.requestId!;
  check(await driver.neverPoppedUp(id, since), `${driver.name} should get no pop-up for ${label(rider)} (${why})`);
  check(!(await driver.list()).includes(id), `${driver.name}'s list should not show ${label(rider)} (${why})`);
  world.log(`${driver.name} is not shown ${label(rider)} (${why})`);
}

/** Rider after rider books Shared and the driver accepts each (the first one claims, the rest are added). */
async function fillCar(world: World, driver: SimDriver, riders: SimRider[]): Promise<void> {
  for (const rider of riders) {
    const since = Date.now();
    await rider.request("SHARED");
    await expectShown(world, driver, rider, since);
    world.tick(3);
    const answer = await driver.accept(rider.requestId!, label(rider));
    check(answer.ok, `${driver.name} should be able to accept ${label(rider)}: ${answer.message}`);
    world.tick(5);
  }
  world.log(`${driver.name}'s car: ${4 - (await driver.freeSeats())} of 4 seats taken`);
}

async function riders(world: World, names: string[]): Promise<SimRider[]> {
  const out: SimRider[] = [];
  for (const n of names) out.push(await world.rider(n));
  return out;
}

export const SCENARIOS: Scenario[] = [
  {
    key: "a",
    title: "4 riders fill one car one by one; a 5th request is not shown to it",
    async run(world) {
      const a = await world.driver("Driver A");
      const b = await world.driver("Driver B");
      const [r1, r2, r3, r4, r5] = await riders(world, ["Rider 1", "Rider 2", "Rider 3", "Rider 4", "Rider 5"]);
      await fillCar(world, a, [r1!, r2!, r3!, r4!]);
      check((await a.freeSeats()) === 0, "Driver A's car should be full");
      world.log("Driver A's car is full");
      const since = Date.now();
      await r5!.request("SHARED");
      await expectHidden(world, a, r5!, since, "car full");
      await expectShown(world, b, r5!, since, "Driver B has no trip");
    },
  },
  {
    key: "b",
    title: "Car full, one drop-off: the 5th request appears at once and can be accepted",
    async run(world) {
      const a = await world.driver("Driver A");
      const [r1, r2, r3, r4, r5] = await riders(world, ["Rider 1", "Rider 2", "Rider 3", "Rider 4", "Rider 5"]);
      await fillCar(world, a, [r1!, r2!, r3!, r4!]);
      for (const r of [r1!, r2!, r3!, r4!]) {
        await a.pickUp(r);
        world.tick(20);
      }
      let since = Date.now();
      await r5!.request("SHARED");
      await expectHidden(world, a, r5!, since, "car full");
      world.tick(60);
      since = Date.now();
      await a.dropOff(r1!);
      check(
        (await a.hear(DRIVER_EVENTS.REQUESTS_CHANGED, () => true, since)) !== null,
        "Driver A's app should be told its requests changed",
      );
      await expectShown(world, a, r5!, since, "a seat freed — live");
      world.tick(4);
      const answer = await a.accept(r5!.requestId!, label(r5!));
      check(answer.ok, `Driver A should be able to accept ${label(r5!)}: ${answer.message}`);
      check((await a.freeSeats()) === 0, "Driver A's car should be full again");
      check((await r5!.screen()) === "in a shared car", "Rider 5 should be in Driver A's car");
    },
  },
  {
    key: "c",
    title: "All pickups done, 2 drop-offs left, 2 free seats: a new Shared request is shown and merged",
    async run(world) {
      const a = await world.driver("Driver A");
      const [r1, r2, r3, r4, r5] = await riders(world, ["Rider 1", "Rider 2", "Rider 3", "Rider 4", "Rider 5"]);
      await fillCar(world, a, [r1!, r2!, r3!, r4!]);
      for (const r of [r1!, r2!, r3!, r4!]) {
        await a.pickUp(r);
        world.tick(15);
      }
      await a.dropOff(r1!);
      world.tick(60);
      await a.dropOff(r2!);
      world.tick(10);
      check((await a.freeSeats()) === 2, "2 seats should be free");
      world.log("Driver A: only drop-offs left (Rider 3, Rider 4), 2 seats free");
      const since = Date.now();
      await r5!.request("SHARED");
      await expectShown(world, a, r5!, since, "2 free seats, drop-offs only");
      const answer = await a.accept(r5!.requestId!, label(r5!));
      check(answer.ok, `Driver A should be able to merge ${label(r5!)}: ${answer.message}`);
      check((await a.freeSeats()) === 1, "1 seat should be left");
    },
  },
  {
    key: "d",
    title: "A 2-seat request: not shown with 1 free seat, shown with 2",
    async run(world) {
      const a = await world.driver("Driver A");
      const [r1, r2, r3, r4] = await riders(world, ["Rider 1", "Rider 2", "Rider 3", "Rider 4"]);
      await fillCar(world, a, [r1!, r2!, r3!]);
      check((await a.freeSeats()) === 1, "1 seat should be free");
      // No app can ask for 2 seats yet: booked through the same service the routes use.
      const since = Date.now();
      const { pickup, dropoff } = world.zones;
      const ride = await createRide(world.prisma, {
        riderId: r4!.id,
        type: "SHARED",
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        occupancy: 2,
        paymentMethod: "CASH",
      });
      r4!.requestId = ride.id;
      world.rideIds.add(ride.id);
      world.log("Rider 4 requests a ride (Shared, 2 seats)");
      await expectHidden(world, a, r4!, since, "needs 2 seats, 1 free");
      const refused = await a.accept(ride.id, label(r4!));
      check(!refused.ok && refused.message === "No longer fits your car.", `the add should be refused: ${refused.message}`);
      await a.pickUp(r1!);
      world.tick(30);
      const freed = Date.now();
      await a.dropOff(r1!);
      await expectShown(world, a, r4!, freed, "2 seats free now — live");
    },
  },
  {
    key: "e",
    title: "Ride alone: shown to an empty car only, never to a car with riders",
    async run(world) {
      const empty = await world.driver("Driver A");
      const busy = await world.driver("Driver B");
      const [r1, r2] = await riders(world, ["Rider 1", "Rider 2"]);
      await fillCar(world, busy, [r1!]);
      const since = Date.now();
      await r2!.request("LONE");
      await expectShown(world, empty, r2!, since, "no riders");
      await expectHidden(world, busy, r2!, since, "Ride alone needs an empty car; Driver B has a rider");
      const answer = await empty.accept(r2!.requestId!, label(r2!));
      check(answer.ok, `Driver A should take the Ride alone: ${answer.message}`);
    },
  },
  {
    key: "f",
    title: "Pop-up times out after 20 s: still listed until the search ends, then gone; rider gets 'no drivers'",
    async run(world) {
      const a = await world.driver("Driver A");
      const [r1] = await riders(world, ["Rider 1"]);
      const since = Date.now();
      await r1!.request("SHARED");
      await expectShown(world, a, r1!, since);
      await world.advance(20_000);
      await a.pass(r1!.requestId!, "TIMED_OUT", label(r1!));
      const listed = await a.listed(r1!.requestId!);
      check(listed, "the request should stay in Driver A's list after the pop-up timed out");
      check(listed.offerTimedOut === true, "and be flagged so it doesn't pop up again");
      world.log("Driver A's list still shows Rider 1's request (no new pop-up)");
      await world.advance(40_000);
      check((await a.list()).includes(r1!.requestId!), "still listed 60 s in");
      check((await r1!.screen()) === "searching", "Rider 1 should still be searching 60 s in");
      world.log("60 s in: still in Driver A's list; Rider 1 still searching");
      const ending = Date.now();
      await world.advance(DISPATCH_WINDOW_MS - 60_000 + 1_000);
      check((await a.heardClosed(r1!.requestId!, ending)) === "EXPIRED", "Driver A should hear the request expired");
      check(!(await a.list()).includes(r1!.requestId!), "gone from Driver A's list when the search ends");
      check(
        (await r1!.hear(RIDE_EVENTS.STATUS, (p) => p.status === "AWAITING_RIDER_DECISION", ending)) !== null,
        "Rider 1's phone should hear the search ended",
      );
      check((await r1!.screen()) === "no drivers", "Rider 1 should see 'no drivers'");
      world.log("Search over: gone from Driver A's list; Rider 1 sees 'no drivers'");
    },
  },
  {
    key: "g",
    title: "A driver rejects: gone from their list, still in another driver's",
    async run(world) {
      const a = await world.driver("Driver A");
      const b = await world.driver("Driver B");
      const [r1] = await riders(world, ["Rider 1"]);
      const since = Date.now();
      await r1!.request("SHARED");
      await expectShown(world, a, r1!, since);
      await expectShown(world, b, r1!, since);
      world.tick(4);
      await a.pass(r1!.requestId!, "DECLINED", label(r1!));
      check(!(await a.list()).includes(r1!.requestId!), "gone from Driver A's list");
      check((await b.list()).includes(r1!.requestId!), "still in Driver B's list");
      world.log("Gone from Driver A's list; still in Driver B's");
    },
  },
  {
    key: "h",
    title: "Two drivers accept at the same time: exactly one wins, the other sees 'Already taken'",
    async run(world) {
      const a = await world.driver("Driver A");
      const b = await world.driver("Driver B");
      const [r1, r2, r3] = await riders(world, ["Rider 1", "Rider 2", "Rider 3"]);
      const since = Date.now();
      await r1!.request("SHARED");
      await expectShown(world, a, r1!, since);
      await expectShown(world, b, r1!, since);
      const answers = await Promise.all([a.accept(r1!.requestId!, label(r1!)), b.accept(r1!.requestId!, label(r1!))]);
      check(answers.filter((x) => x.ok).length === 1, "exactly one driver should get it");
      const lost = answers.find((x) => !x.ok)!;
      check(lost.reason === "TAKEN" && lost.message === "Already taken by another driver.", `the other should hear 'Already taken': ${lost.message}`);

      // The same race between two Shared cars adding one rider.
      const winner = answers[0]!.ok ? a : b;
      const other = winner === a ? b : a;
      await fillCar(world, other, [r2!]);
      const later = Date.now();
      await r3!.request("SHARED");
      await expectShown(world, winner, r3!, later);
      await expectShown(world, other, r3!, later);
      const adds = await Promise.all([winner.accept(r3!.requestId!, label(r3!)), other.accept(r3!.requestId!, label(r3!))]);
      check(adds.filter((x) => x.ok).length === 1, "exactly one car should get Rider 3");
      const lostAdd = adds.find((x) => !x.ok)!;
      check(lostAdd.message === "Already taken by another driver.", `the other car should hear 'Already taken': ${lostAdd.message}`);
    },
  },
  {
    key: "i",
    title: "The rider cancels while drivers see it: removed from every list at once",
    async run(world) {
      const a = await world.driver("Driver A");
      const b = await world.driver("Driver B");
      const [r1, r2] = await riders(world, ["Rider 1", "Rider 2"]);
      await fillCar(world, b, [r1!]);
      const since = Date.now();
      await r2!.request("SHARED");
      await expectShown(world, a, r2!, since, "no trip");
      await expectShown(world, b, r2!, since, "Shared car with 3 free seats");
      world.tick(10);
      const cancelled = Date.now();
      await r2!.cancel();
      check((await a.heardClosed(r2!.requestId!, cancelled)) === "CANCELLED", "Driver A should hear it was cancelled");
      check((await b.heardClosed(r2!.requestId!, cancelled)) === "CANCELLED", "Driver B should hear it was cancelled");
      check(!(await a.list()).includes(r2!.requestId!), "gone from Driver A's list");
      check(!(await b.list()).includes(r2!.requestId!), "gone from Driver B's list");
      world.log("Gone from Driver A's and Driver B's lists at once");
    },
  },
  {
    key: "j",
    title: "Seats freed by a cancel, a no-show and an undone drop-off: requests reappear (or go) correctly",
    async run(world) {
      const a = await world.driver("Driver A");
      const [r1, r2, r3, r4, r5, r6, r7] = await riders(world, ["Rider 1", "Rider 2", "Rider 3", "Rider 4", "Rider 5", "Rider 6", "Rider 7"]);
      await fillCar(world, a, [r1!, r2!, r3!, r4!]);

      // A cancel.
      let since = Date.now();
      await r5!.request("SHARED");
      await expectHidden(world, a, r5!, since, "car full");
      since = Date.now();
      check((await a.seat(r1!, "cancel")).status === 200, "Driver A should cancel Rider 1's seat");
      await expectShown(world, a, r5!, since, "seat freed by a cancel — live");
      check((await a.accept(r5!.requestId!, label(r5!))).ok, "Driver A should take Rider 5");

      // A no-show (3 minutes after arriving).
      check((await a.seat(r2!, "arrived")).status === 200, "Driver A should arrive for Rider 2");
      await world.advance(3 * 60_000 + 5_000);
      since = Date.now();
      await r6!.request("SHARED");
      await expectHidden(world, a, r6!, since, "car full");
      since = Date.now();
      check((await a.seat(r2!, "no-show")).status === 200, "Driver A should mark Rider 2 a no-show");
      await expectShown(world, a, r6!, since, "seat freed by a no-show — live");
      check((await a.accept(r6!.requestId!, label(r6!))).ok, "Driver A should take Rider 6");

      // An undone drop-off takes the seat back.
      await a.pickUp(r3!);
      world.tick(30);
      await a.dropOff(r3!);
      since = Date.now();
      await r7!.request("SHARED");
      await expectShown(world, a, r7!, since, "Rider 3's seat is free");
      since = Date.now();
      check((await a.seat(r3!, "undo-dropoff")).status === 200, "Driver A should undo Rider 3's drop-off");
      check((await a.hear(DRIVER_EVENTS.REQUESTS_CHANGED, () => true, since)) !== null, "the app should be told to refetch");
      check(!(await a.list()).includes(r7!.requestId!), "Rider 7 should leave the list: the car is full again");
      world.log("Car full again: Rider 7's request leaves Driver A's list");
      const refused = await a.accept(r7!.requestId!, label(r7!));
      check(!refused.ok && refused.message === "No longer fits your car.", `adding Rider 7 now should be refused: ${refused.message}`);

      // An undone pickup frees no seat; the seat freed again is offered again.
      await a.pickUp(r4!);
      check((await a.seat(r4!, "undo-pickup")).status === 200, "Driver A should undo Rider 4's pickup");
      check(!(await a.list()).includes(r7!.requestId!), "an undone pickup frees no seat");
      since = Date.now();
      await a.dropOff(r3!);
      await expectShown(world, a, r7!, since, "Rider 3 dropped off again — live");
      check((await a.accept(r7!.requestId!, label(r7!))).ok, "Driver A should take Rider 7");
      const undo = await a.seat(r3!, "undo-dropoff");
      check(undo.status === 409 && undo.body.code === "CAR_FULL", "an undo that would seat a fifth rider is refused");
    },
  },
  {
    key: "k",
    title: "Pickups and drop-offs in any order with riders merging midway: fares, per-seat trip end, ledger and commission",
    async run(world) {
      const d = await world.driver("Driver A");
      const [r1, r2, r3] = await riders(world, ["Rider 1", "Rider 2", "Rider 3"]);
      await fillCar(world, d, [r1!, r2!]);
      const carId = r1!.requestId!;
      await d.pickUp(r2!); // out of order: Rider 2 first
      world.tick(40);
      await d.pickUp(r1!);
      world.tick(120);
      await d.dropOff(r1!); // Rider 1 off first, Rider 2 rides on
      const r1Done = await r1!.hear(RIDE_EVENTS.COMPLETED, (p) => p.rideId === carId, 0);
      check(r1Done, "Rider 1's trip should end at their own drop-off");
      check((await world.prisma.ride.findUniqueOrThrow({ where: { id: carId } })).status === "IN_PROGRESS", "the car carries on");
      world.log("Rider 1's trip is over (fare summary sent); the car carries on");

      const since = Date.now();
      await r3!.request("SHARED");
      await expectShown(world, d, r3!, since, "merging midway");
      check((await d.accept(r3!.requestId!, label(r3!))).ok, "Driver A should merge Rider 3 mid-trip");
      await d.pickUp(r3!);
      world.tick(90);
      await d.dropOff(r3!); // Rider 3 off before Rider 2
      world.tick(60);
      await d.dropOff(r2!); // the last drop-off ends the trip

      const car = await world.prisma.ride.findUniqueOrThrow({ where: { id: carId }, include: { passengers: true } });
      check(car.status === "COMPLETED", `the trip should be COMPLETED, is ${car.status}`);
      const fare = getSharedFarePerRider(1);
      for (const seat of car.passengers) {
        check(seat.status === "DROPPED_OFF", "every seat dropped off");
        check(seat.fareCharged === fare, `each rider pays the quoted ${fare} pesewas, got ${seat.fareCharged}`);
      }
      const total = fare * 3;
      const { commission, driverShare } = splitFare(total);
      // Written just after the last drop-off's reply.
      const ledger = await world.until(() => world.prisma.commissionLedger.findUnique({ where: { rideId: carId } }));
      check(ledger?.amountPesewas === commission, `cash-owed ledger should be ${commission}, got ${ledger?.amountPesewas}`);
      check(ledger.driverUserId === d.id, "owed by Driver A");
      for (const r of [r1!, r2!, r3!]) {
        const mine = r.fareSummaries().filter((s) => s.rideId === carId);
        check(mine.length >= 1 && mine.every((s) => s.yourFarePesewas === fare), `${r.name} should be told their own fare (${fare})`);
      }
      const summary = await d.earnings();
      check(summary.commissionOwedPesewas === commission, `driver owes ${commission}, history says ${summary.commissionOwedPesewas}`);
      check(summary.netPesewas === driverShare, `driver keeps ${driverShare}, history says ${summary.netPesewas}`);
      world.log(
        `Trip complete: 3 riders × GH₵${(fare / 100).toFixed(2)} = GH₵${(total / 100).toFixed(2)}; ` +
          `commission owed GH₵${(commission / 100).toFixed(2)}; Driver A keeps GH₵${(driverShare / 100).toFixed(2)}`,
      );
    },
  },
  {
    key: "l",
    title: "A driver goes offline mid-search: the request is no longer shown to them",
    async run(world) {
      const a = await world.driver("Driver A");
      const b = await world.driver("Driver B");
      const c = await world.driver("Driver C");
      const [r1, r2] = await riders(world, ["Rider 1", "Rider 2"]);
      await fillCar(world, c, [r1!]);
      const since = Date.now();
      await r2!.request("SHARED");
      await expectShown(world, a, r2!, since);
      await expectShown(world, b, r2!, since);
      await expectShown(world, c, r2!, since, "Shared car with free seats");
      world.tick(8);
      await a.goOffline();
      await c.goOffline();
      check(!(await a.list()).includes(r2!.requestId!), "offline Driver A gets nothing");
      check(!(await c.list()).includes(r2!.requestId!), "offline Driver C (mid-trip) gets nothing");
      check((await c.accept(r2!.requestId!, label(r2!))).status === 403, "an offline driver can't add a rider");
      check((await b.list()).includes(r2!.requestId!), "still in Driver B's list");
      world.log("Offline drivers see nothing; still in Driver B's list");
    },
  },
];
