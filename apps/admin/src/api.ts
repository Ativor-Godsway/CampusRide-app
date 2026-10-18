/**
 * Thin fetch wrapper around the CampusRide API. Deliberately tiny — the admin
 * app hits a handful of endpoints and adding a data-fetching library would be
 * more moving parts than the whole screen count justifies.
 */

import { rateLimitMessage } from "@rida/shared";

const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** On a 429: whole seconds until the API will accept the request again. */
    readonly retryAfterSeconds: number | null = null,
    /** The API's machine-readable reason, when it gave one (e.g. "ADMIN_SESSION_ENDED"). */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Admin sessions are short (10-minute access tokens, renewed while in use;
 * 30 idle minutes or 8 hours in total end them — decided by the server). The
 * signed-in session registers these so a request that meets an expired
 * access token renews it once and retries, and a session the server won't
 * renew signs the site out.
 */
export interface SessionHooks {
  refreshToken: () => string | null;
  onRenewed: (tokens: { accessToken: string; refreshToken: string }) => void;
  onEnded: (message: string) => void;
}

let sessionHooks: SessionHooks | null = null;
let renewing: Promise<string | null> | null = null;

export function setSessionHooks(hooks: SessionHooks | null): void {
  sessionHooks = hooks;
}

/** One renewal at a time: refresh tokens are single-use, so parallel 401s share it. */
function renewAccessToken(): Promise<string | null> {
  if (renewing) return renewing;
  renewing = (async () => {
    const refreshToken = sessionHooks?.refreshToken();
    if (!refreshToken) return null;
    try {
      const tokens = await request<{ accessToken: string; refreshToken: string }>("/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
      sessionHooks?.onRenewed(tokens);
      return tokens.accessToken;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) throw err;
      sessionHooks?.onEnded(
        err instanceof ApiError && err.code === "ADMIN_SESSION_ENDED"
          ? "Your admin session has ended (sessions last at most 8 hours). Please sign in again."
          : "You were signed out after a while without activity. Please sign in again.",
      );
      return null;
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

async function request<T>(path: string, init: RequestInit = {}, token?: string, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // Marks the admin site to the API: only an allowed ADMIN account gets a
  // session here, and every sign-in attempt is recorded.
  headers.set("X-CampusRide-Client", "admin");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    // A network-level failure here is nearly always CORS or a server that
    // isn't running; say so rather than surfacing "Failed to fetch".
    throw new ApiError(`Could not reach the API at ${API_URL}. Is the server running?`, 0);
  }

  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};

  if (res.status === 401 && token && !retried) {
    const renewed = await renewAccessToken();
    if (renewed) return request<T>(path, init, renewed, true);
  }

  if (res.status === 429) {
    // "Too many attempts. Try again in 3 minutes." — from the body, or the
    // Retry-After header if a proxy answered.
    const fromBody = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    const seconds =
      typeof fromBody === "number" && fromBody > 0 ? fromBody : Number(res.headers.get("retry-after")) || 60;
    throw new ApiError(rateLimitMessage(seconds), 429, Math.ceil(seconds));
  }

  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    const code = (body as { code?: unknown }).code;
    throw new ApiError(message, res.status, null, typeof code === "string" ? code : null);
  }

  return body as T;
}

// ── Auth (the SAME endpoints the rider/driver apps use) ─────────────────────

export interface AuthUser {
  id: string;
  name: string;
  phone: string;
  role: "RIDER" | "DRIVER" | "ADMIN";
}

export interface LoginResult {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  /** When this admin session ends whatever happens (ISO time). */
  sessionExpiresAt?: string;
}

export function requestOtp(phone: string): Promise<{ ok: true }> {
  return request("/auth/request-otp", {
    method: "POST",
    body: JSON.stringify({ phone, purpose: "LOGIN" }),
  });
}

export function verifyOtp(phone: string, code: string): Promise<{ verifiedToken: string }> {
  return request("/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ phone, code, purpose: "LOGIN" }),
  });
}

export function login(phone: string, verifiedToken: string): Promise<LoginResult> {
  return request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone, verifiedToken }),
  });
}

/** Ends the session on the server too. Best effort: signing out never waits on it. */
export function logout(refreshToken: string): Promise<unknown> {
  return request("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }).catch(() => undefined);
}

// ── Admin ───────────────────────────────────────────────────────────────────

export interface PendingDriver {
  id: string;
  carMake: string | null;
  carModel: string | null;
  carColor: string | null;
  plate: string | null;
  photoUrl: string | null;
  isApproved: boolean;
  createdAt: string;
  user: { id: string; name: string; phone: string };
}

export interface AdminRide {
  id: string;
  status: string;
  type: string;
  source: string;
  occupancy: number;
  fareTotal: number | null;
  paymentStatus: string;
  paymentMethod: string;
  cancelReason: string | null;
  /** What the rider chose in the app's cancel sheet, e.g. "DRIVER_ASKED_TO_CANCEL". */
  riderCancelReason: string | null;
  /** Readable form of riderCancelReason, e.g. "Driver asked me to cancel". */
  riderCancelReasonLabel: string | null;
  riderCancelNote: string | null;
  /** True for reasons that may signal a driver problem. */
  riderCancelFlagged: boolean;
  createdAt: string;
  completedAt: string | null;
  rider: { id: string; name: string; phone: string } | null;
  driver: { id: string; name: string; phone: string } | null;
  pickupZone: { id: string; name: string } | null;
  dropoffZone: { id: string; name: string } | null;
  /** Exact pins (null for rides booked by app builds without them). */
  pickupLabel: string | null;
  dropoffLabel: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
  pickupNote: string | null;
}

export function getPendingDrivers(token: string): Promise<{ drivers: PendingDriver[] }> {
  return request("/admin/drivers/pending", {}, token);
}

export function approveDriver(token: string, driverId: string): Promise<{ driver: PendingDriver }> {
  return request(`/admin/drivers/${driverId}/approve`, { method: "POST", body: "{}" }, token);
}

export function rejectDriver(
  token: string,
  driverId: string,
  reason: string,
): Promise<{ driver: PendingDriver }> {
  return request(
    `/admin/drivers/${driverId}/reject`,
    { method: "POST", body: JSON.stringify(reason ? { reason } : {}) },
    token,
  );
}

export interface RideFilters {
  status?: string;
  from?: string;
  to?: string;
}

export function getRides(token: string, filters: RideFilters): Promise<{ rides: AdminRide[] }> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  // Date inputs give "YYYY-MM-DD"; widen to the whole day so `to` includes it.
  if (filters.from) params.set("from", `${filters.from}T00:00:00.000Z`);
  if (filters.to) params.set("to", `${filters.to}T23:59:59.999Z`);
  const query = params.toString();
  return request(`/admin/rides${query ? `?${query}` : ""}`, {}, token);
}

// ── Campus places ───────────────────────────────────────────────────────────

export type PlaceCategory = "HALL" | "HOSTEL" | "FACULTY" | "GATE" | "FOOD" | "LANDMARK" | "OTHER";

export interface AdminPlace {
  id: string;
  name: string;
  aliases: string[];
  latitude: number;
  longitude: number;
  category: PlaceCategory;
  zoneId: string;
  isActive: boolean;
  /** "osm:way/…" for seeded places, null for ones added here. */
  source: string | null;
  updatedAt: string;
  zone: { name: string };
}

export interface PlaceInput {
  name?: string;
  aliases?: string[];
  latitude?: number;
  longitude?: number;
  category?: PlaceCategory;
  isActive?: boolean;
}

export function getPlaces(token: string, q = ""): Promise<{ places: AdminPlace[] }> {
  return request(`/admin/places${q ? `?q=${encodeURIComponent(q)}` : ""}`, {}, token);
}

export function createPlace(token: string, input: PlaceInput): Promise<{ place: AdminPlace }> {
  return request("/admin/places", { method: "POST", body: JSON.stringify(input) }, token);
}

export function updatePlace(token: string, id: string, input: PlaceInput): Promise<{ place: AdminPlace }> {
  return request(`/admin/places/${id}`, { method: "PATCH", body: JSON.stringify(input) }, token);
}

// ── Rate limits ─────────────────────────────────────────────────────────────

export interface PersonLimit {
  name: string;
  label: string;
  /** Counted against the number itself, or its account. */
  scope: "phone" | "account";
  used: number;
  max: number;
  windowSeconds: number;
  resetsInSeconds: number;
  blocked: boolean;
}

export interface RateLimitLookup {
  phone: string;
  account: { id: string; name: string; role: string } | null;
  limits: PersonLimit[];
}

export function getRateLimits(token: string, phone: string): Promise<RateLimitLookup> {
  return request(`/admin/rate-limits?phone=${encodeURIComponent(phone)}`, {}, token);
}

export function clearRateLimits(
  token: string,
  phone: string,
): Promise<{ phone: string; cleared: PersonLimit[] }> {
  return request("/admin/rate-limits/clear", { method: "POST", body: JSON.stringify({ phone }) }, token);
}

// ── Recent admin logins ─────────────────────────────────────────────────────

export interface AdminLoginEvent {
  id: string;
  at: string;
  /** "success", "failure" or "code_sent". */
  outcome: string;
  /** Why a failure failed, e.g. "bad_code", "not_admin". */
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  account: { id: string; name: string; role: string } | null;
  /** For an attempt with no account: the number, partly masked. */
  target: string | null;
}

export function getRecentLogins(token: string): Promise<{ logins: AdminLoginEvent[] }> {
  return request("/admin/audit/logins?limit=100", {}, token);
}

// ── Account deletion by email ───────────────────────────────────────────────

export interface DeletionLookup {
  phone: string;
  account: { id: string; name: string; role: "RIDER" | "DRIVER" | "ADMIN"; createdAt: string } | null;
  /** Why it can't be deleted right now, when it can't. */
  blocked: { reason: "admin" | "active_ride"; message: string; rideId?: string } | null;
}

export function lookUpForDeletion(token: string, phone: string): Promise<DeletionLookup> {
  return request(`/admin/account-deletion?phone=${encodeURIComponent(phone)}`, {}, token);
}

export function sendDeletionCode(
  token: string,
  phone: string,
): Promise<{ sent: true; phone: string; expiresInMinutes: number }> {
  return request("/admin/account-deletion/code", { method: "POST", body: JSON.stringify({ phone }) }, token);
}

export function verifyDeletionCode(
  token: string,
  phone: string,
  code: string,
): Promise<{ verified: true; confirmToken: string; expiresInMinutes: number }> {
  return request("/admin/account-deletion/verify", { method: "POST", body: JSON.stringify({ phone, code }) }, token);
}

export function deleteAccountByEmail(
  token: string,
  phone: string,
  confirmToken: string,
): Promise<{ deleted: true; role: string; erasedAfter: string }> {
  return request(
    "/admin/account-deletion/delete",
    { method: "POST", body: JSON.stringify({ phone, confirmToken }) },
    token,
  );
}
