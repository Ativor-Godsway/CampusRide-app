import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_FEE_SETTINGS,
  arrivedWithWaitText,
  fareWithWait,
  hasClientFeature,
  seatWaitForApp,
  waitClock,
  waitFeeDue,
  waitFeeSettingsProblem,
  waitView,
  type SeatWait,
} from "./waitFee";
import { pushText } from "../push/notifications";
import { formatCedis } from "../format/currency";

const START = Date.parse("2026-11-25T10:00:00.000Z");
const at = (s: number) => START + s * 1000;
const running: SeatWait = {
  timerStarted: true,
  startedAt: new Date(START).toISOString(),
  freeUntil: new Date(at(150)).toISOString(),
  feePesewas: 200,
};

describe("the wait fee rules", () => {
  it("defaults: 2:30 free, GH 2, no-show after 5 min", () => {
    expect(DEFAULT_WAIT_FEE_SETTINGS).toEqual({ freeWaitSeconds: 150, feePesewas: 200, noShowMinutes: 5 });
    expect(waitFeeSettingsProblem(DEFAULT_WAIT_FEE_SETTINGS)).toBeNull();
  });

  it("counts the free wait down, then adds the fee once", () => {
    expect(waitView(running, at(1))).toMatchObject({ phase: "FREE", addedPesewas: 0 });
    expect(waitClock(waitView(running, at(1))!.freeLeftMs)).toBe("2:29");
    expect(waitView(running, at(149.5))).toMatchObject({ phase: "FREE", addedPesewas: 0 });
    expect(waitView(running, at(150))).toMatchObject({ phase: "OVER", addedPesewas: 200, freeLeftMs: 0 });
    expect(waitView(running, at(900))).toMatchObject({ phase: "OVER", addedPesewas: 200 });
  });

  it("the fare shown: 7 -> 9, far 9 -> 11, Ride alone 15 -> 17, only after 2:30", () => {
    expect(fareWithWait(700, running, at(149))).toBe(700);
    expect(fareWithWait(700, running, at(150))).toBe(900);
    expect(fareWithWait(900, running, at(200))).toBe(1100);
    expect(fareWithWait(1500, running, at(200))).toBe(1700);
    // No wait (picked up: the fee is already in the stored fare).
    expect(fareWithWait(900, null, at(200))).toBe(900);
    expect(fareWithWait(null, running, at(200))).toBeNull();
  });

  it("no fee to come: the countdown still runs, nothing is added", () => {
    const noFee = { ...running, feePesewas: null };
    expect(waitView(noFee, at(200))).toMatchObject({ phase: "OVER", feePesewas: null, addedPesewas: 0 });
    expect(fareWithWait(700, noFee, at(200))).toBe(700);
  });

  it("an arrival without a timer (driver not near)", () => {
    expect(waitView({ timerStarted: false, startedAt: null, freeUntil: null, feePesewas: null }, at(10))).toMatchObject({ phase: "NOT_STARTED" });
  });

  it("the server owes the fee only if the rider was warned before the free wait ended", () => {
    const seat = {
      waitStartedAt: new Date(START),
      freeWaitEndsAt: new Date(at(150)),
      waitFeeAmount: 200,
      riderWarnedAt: new Date(at(2)),
    };
    expect(waitFeeDue(seat, new Date(at(149)))).toBe(0);
    expect(waitFeeDue(seat, new Date(at(150)))).toBe(200);
    expect(waitFeeDue({ ...seat, riderWarnedAt: null }, new Date(at(300)))).toBe(0);
    expect(waitFeeDue({ ...seat, riderWarnedAt: new Date(at(151)) }, new Date(at(300)))).toBe(0);
    expect(waitFeeDue({ ...seat, waitFeeAmount: null }, new Date(at(300)))).toBe(0);
  });

  it("the apps see the wait only while ARRIVED, the fee only if warned", () => {
    const stored = { waitStartedAt: new Date(START), freeWaitEndsAt: new Date(at(150)), waitFeeAmount: 200, riderWarnedAt: new Date(START) };
    expect(seatWaitForApp({ ...stored, status: "ARRIVED" })).toEqual(running);
    expect(seatWaitForApp({ ...stored, status: "PICKED_UP" })).toBeNull();
    expect(seatWaitForApp({ ...stored, riderWarnedAt: null, status: "ARRIVED" })?.feePesewas).toBeNull();
    expect(seatWaitForApp({ waitStartedAt: null, freeWaitEndsAt: null, waitFeeAmount: null, riderWarnedAt: null, status: "ARRIVED" })).toMatchObject({
      timerStarted: false,
    });
  });

  it("settings are checked", () => {
    expect(waitFeeSettingsProblem({ freeWaitSeconds: 29, feePesewas: 200, noShowMinutes: 5 })).not.toBeNull();
    expect(waitFeeSettingsProblem({ freeWaitSeconds: 150, feePesewas: -1, noShowMinutes: 5 })).not.toBeNull();
    expect(waitFeeSettingsProblem({ freeWaitSeconds: 150, feePesewas: 0, noShowMinutes: 5 })).toBeNull();
    expect(waitFeeSettingsProblem({ freeWaitSeconds: 150, feePesewas: 200, noShowMinutes: 0 })).not.toBeNull();
    expect(waitFeeSettingsProblem({ freeWaitSeconds: 400, feePesewas: 200, noShowMinutes: 5 })).not.toBeNull();
    expect(waitFeeSettingsProblem({ freeWaitSeconds: 150.5, feePesewas: 200, noShowMinutes: 5 })).not.toBeNull();
  });

  it("the arrival push states the free wait and the fee", () => {
    expect(arrivedWithWaitText(150, 200)).toBe(`Your driver has arrived. Free wait: 2:30, then ${formatCedis(200)} extra.`);
    expect(pushText("DRIVER_ARRIVED", { freeWait: { seconds: 150, feePesewas: 200 } }).body).toBe(arrivedWithWaitText(150, 200));
    expect(pushText("DRIVER_ARRIVED", { driverName: "Kofi Mensah" }).body).toBe("Kofi is at your pickup.");
  });

  it("reads the apps' feature header", () => {
    expect(hasClientFeature("wait-fee", "wait-fee")).toBe(true);
    expect(hasClientFeature("other, Wait-Fee", "wait-fee")).toBe(true);
    expect(hasClientFeature(undefined, "wait-fee")).toBe(false);
    expect(hasClientFeature("waitfee", "wait-fee")).toBe(false);
  });
});
