import { act, renderHook } from "@testing-library/react-native";
import { RIDE_EVENTS, type RideEtaPayload } from "@rida/shared";
import { SERVER_ETA_FRESH_MS, useServerEta, useSteadyEta } from "../rides/eta";

/**
 * The rider's ETA ("4 min", "Arrives 10:42") stays put while the driver
 * approaches: a new estimate moves it only when it is a minute or more
 * different, and the minutes count down with the clock in between.
 */

type Handler = (payload: RideEtaPayload) => void;
const mockHandlers = new Set<Handler>();
jest.mock("../realtime/socket", () => ({
  getRideSocket: () => ({
    on: (_event: string, h: Handler) => mockHandlers.add(h),
    off: (_event: string, h: Handler) => mockHandlers.delete(h),
  }),
}));

const send = (payload: Partial<RideEtaPayload>) =>
  act(() => {
    for (const h of mockHandlers) h({ rideId: "r1", toward: "pickup", seconds: 240, at: Date.now(), ...payload });
  });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-02T10:00:00Z"));
  mockHandlers.clear();
});
afterEach(() => jest.useRealTimers());

describe("useSteadyEta", () => {
  it("estimates jittering by seconds around a minute boundary don't move it", async () => {
    const { result, rerender } = await renderHook(({ s }: { s: number | null }) => useSteadyEta(s, "r1:pickup"), {
      initialProps: { s: 150 },
    });
    const first = result.current!.arrivalAt;
    for (const s of [140, 160, 145, 155, 149, 151]) {
      await rerender({ s });
      expect(result.current!.arrivalAt).toBe(first);
    }
    expect(Math.round(result.current!.minutes)).toBe(3);
  });

  it("counts down with the clock while the estimate holds, never back up", async () => {
    const { result, rerender } = await renderHook(({ s }: { s: number | null }) => useSteadyEta(s, "k"), {
      initialProps: { s: 300 },
    });
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });
      // The driver's estimate drifts a little each update, as GPS does.
      await rerender({ s: 300 - (i + 1) * 15 + (i % 2 ? 20 : -20) });
      seen.push(Math.round(result.current!.minutes));
    }
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    expect(seen[seen.length - 1]).toBe(3);
  });

  it("moves when the estimate changes by a minute or more, and starts afresh on a new leg", async () => {
    const { result, rerender } = await renderHook(({ s, k }: { s: number | null; k: string }) => useSteadyEta(s, k), {
      initialProps: { s: 120, k: "a" },
    });
    await rerender({ s: 300, k: "a" });
    expect(Math.round(result.current!.minutes)).toBe(5);
    // A missing estimate keeps what's shown.
    await rerender({ s: null, k: "a" });
    expect(Math.round(result.current!.minutes)).toBe(5);
    await rerender({ s: 60, k: "b" });
    expect(Math.round(result.current!.minutes)).toBe(1);
  });
});

describe("useServerEta", () => {
  it("takes this ride's ETA for this leg only, and forgets it once stale", async () => {
    const { result } = await renderHook(() => useServerEta("r1", "pickup"));
    expect(result.current).toBeNull();
    await send({ rideId: "other" });
    await send({ toward: "dropoff" });
    await send({ seconds: -5 });
    expect(result.current).toBeNull();
    await send({ seconds: 200 });
    expect(result.current).toBe(200);
    await act(async () => {
      jest.advanceTimersByTime(SERVER_ETA_FRESH_MS + 1);
    });
    expect(result.current).toBeNull();
  });

  it("listens to nothing without a leg", async () => {
    await renderHook(() => useServerEta("r1", null));
    expect(mockHandlers.size).toBe(0);
    expect(RIDE_EVENTS.ETA).toBe("ride:eta");
  });
});
