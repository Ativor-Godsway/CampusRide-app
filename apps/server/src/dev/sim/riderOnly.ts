/**
 * The simulator plays RIDERS only. It must never do anything a driver does
 * (claim, "I'm here", pickup, drop-off, cancel a seat, add a rider): those
 * are yours to test on the phone, and a simulator touching the same ride as
 * the driver app is exactly the kind of interference that makes actions look
 * like they fail at random.
 *
 * Every request the simulator sends is checked against this list first.
 */
const RIDER_REQUESTS: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/rides$/ }, // request a ride
  { method: "POST", path: /^\/rides\/[^/]+\/cancel$/ }, // give up waiting
  { method: "POST", path: /^\/rides\/[^/]+\/decision$/ }, // "no driver yet" answer
  { method: "POST", path: /^\/ratings$/ }, // rate the driver afterwards
];

export function isRiderSideRequest(method: string, path: string): boolean {
  return RIDER_REQUESTS.some((r) => r.method === method && r.path.test(path));
}

export function assertRiderSideRequest(method: string, path: string): void {
  if (!isRiderSideRequest(method, path)) {
    throw new Error(`The simulator only acts as a rider; refusing ${method} ${path}`);
  }
}
