/**
 * The pickup wait fee, client side (@rida/shared rides/waitFee.ts): every
 * request says this JavaScript shows the wait timer (the server only charges
 * a fee a rider was warned about), and countdowns follow the server's clock
 * from the Date header, not the phone's.
 */
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { CLIENT_FEATURES_HEADER } from "@rida/shared";
import { api, serverNow, setServerClockOffsetForTests } from "../auth/apiClient";

function answer(headers: Record<string, string>, seen: InternalAxiosRequestConfig[]): AxiosAdapter {
  return async (config) => {
    seen.push(config);
    return { data: {}, status: 200, statusText: "OK", headers, config };
  };
}

afterEach(() => setServerClockOffsetForTests(0));

it("sends the wait-fee feature header", async () => {
  const seen: InternalAxiosRequestConfig[] = [];
  await api.get("/rides/1", { adapter: answer({}, seen) });
  expect(seen[0]!.headers[CLIENT_FEATURES_HEADER]).toBe("wait-fee");
});

it("follows the server's clock from the Date header", async () => {
  const serverTime = Date.now() + 3 * 60_000; // the phone is 3 minutes slow
  await api.get("/rides/1", { adapter: answer({ date: new Date(serverTime).toUTCString() }, []) });
  expect(Math.abs(serverNow() - serverTime)).toBeLessThan(1_500);
});

it("keeps the phone's clock without a Date header", async () => {
  await api.get("/rides/1", { adapter: answer({}, []) });
  expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50);
});
