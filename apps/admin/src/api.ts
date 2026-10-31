/**
 * Thin fetch wrapper around the CampusRide API. Deliberately tiny — the admin
 * app hits a handful of endpoints and adding a data-fetching library would be
 * more moving parts than the whole screen count justifies.
 */

import { rateLimitMessage, type BroadcastAudience, type BroadcastKind } from "@rida/shared";
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

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
 * Admin sessions (10-minute access tokens, renewed while in use; an idle
 * hour or 12 hours in total end them — decided by the server). The signed-in
 * session registers these so a request that meets an expired access token
 * renews it once and retries, and a session the server won't renew signs the
 * site out.
 */
export interface SessionHooks {
  /** The tokens as stored now: another tab of the site may have renewed them. */
  current: () => { accessToken: string; refreshToken: string | null } | null;
  onRenewed: (tokens: { accessToken: string; refreshToken: string }) => void;
  onEnded: (message: string) => void;
}

let sessionHooks: SessionHooks | null = null;
let renewing: Promise<string | null> | null = null;

export function setSessionHooks(hooks: SessionHooks | null): void {
  sessionHooks = hooks;
}

const RENEW_LOCK = "campusride.admin.renew";

/**
 * Runs `work` while no other tab of the site is renewing (Web Locks; every
 * browser the admin site supports has them). Without the API it just runs.
 */
function inRenewLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request(name: string, cb: () => Promise<T>): Promise<T> } }).locks;
  return locks ? locks.request(RENEW_LOCK, work) : work();
}

/**
 * Renews the access token. One renewal at a time, across every tab: refresh
 * tokens are single-use, and two tabs presenting the same one would look
 * like theft to the server and end the session. A tab that waited while
 * another renewed just takes the tokens it stored.
 */
function renewAccessToken(): Promise<string | null> {
  if (renewing) return renewing;
  const startedWith = sessionHooks?.current()?.refreshToken ?? null;
  renewing = inRenewLock(async () => {
    const now = sessionHooks?.current();
    if (!now?.refreshToken) return null;
    if (now.refreshToken !== startedWith) return now.accessToken;
    try {
      const tokens = await request<{ accessToken: string; refreshToken: string }>("/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: now.refreshToken }),
      });
      sessionHooks?.onRenewed(tokens);
      return tokens.accessToken;
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) throw err;
      // Offline or the server restarting: not a sign-out; the next renewal tries again.
      if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) throw err;
      sessionHooks?.onEnded(
        err instanceof ApiError && err.code === "ADMIN_SESSION_ENDED"
          ? "Your admin session has ended (sessions last at most 12 hours). Please sign in again."
          : "You were signed out after an hour without activity. Please sign in again.",
      );
      return null;
    }
  }).finally(() => {
    renewing = null;
  });
  return renewing;
}

/**
 * Renews the session now, while someone is using the site (auth.tsx calls it
 * every few minutes of activity), so reading one screen for a long time
 * doesn't run out the server's idle hour. Never throws.
 */
export async function keepSessionAlive(): Promise<void> {
  await renewAccessToken().catch(() => null);
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
    // The API's own sentence when it sent one (it says which limit), else the generic one.
    const said = (body as { error?: unknown }).error;
    throw new ApiError(typeof said === "string" && said ? said : rateLimitMessage(seconds), 429, Math.ceil(seconds));
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
  /** Pesewas, from the seats' stored fares; null for a cancelled ride. */
  fareTotal: number | null;
  /** False while the ride is still going on: what its riders will pay so far. */
  fareFinal?: boolean;
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

// ── Settings: launch mode and early access ──────────────────────────────────

export type LaunchMode = "OFF" | "COUNTDOWN" | "LIVE";

export interface LaunchStatus {
  /** In force now: a countdown whose launch time has passed is LIVE. */
  mode: LaunchMode;
  launchAt: string | null;
  serverTime: string;
}

export interface LaunchSettings {
  /** As last saved here. */
  setting: {
    mode: LaunchMode;
    launchAt: string | null;
    updatedAt: string | null;
    updatedBy: { id: string; name: string } | null;
  };
  status: LaunchStatus;
  /** Rider accounts with early access now. */
  earlyAccessRiders: number;
  /** "Send 'CampusRide is live!' when launch mode turns Live", and the send once it has gone out. */
  launchPush: LaunchPushState;
}

export interface LaunchPushState {
  enabled: boolean;
  sent: Broadcast | null;
}

export interface EarlyAccessLookup {
  phone: string;
  account: { id: string; name: string; role: "RIDER" | "DRIVER" | "ADMIN"; earlyAccessAt: string | null } | null;
}

export function getLaunchSettings(token: string): Promise<LaunchSettings> {
  return request("/admin/launch", {}, token);
}

export function saveLaunchMode(
  token: string,
  mode: LaunchMode,
  launchAt: string | null,
): Promise<{ status: LaunchStatus }> {
  return request("/admin/launch", { method: "PUT", body: JSON.stringify({ mode, launchAt }) }, token);
}

export function lookUpEarlyAccess(token: string, phone: string): Promise<EarlyAccessLookup> {
  return request(`/admin/early-access?phone=${encodeURIComponent(phone)}`, {}, token);
}

export function setEarlyAccess(token: string, phone: string, enabled: boolean): Promise<EarlyAccessLookup> {
  return request("/admin/early-access", { method: "POST", body: JSON.stringify({ phone, enabled }) }, token);
}

export function giveEarlyAccessToAllRiders(
  token: string,
): Promise<{ granted: number; earlyAccessRiders: number }> {
  return request("/admin/early-access/all-riders", { method: "POST", body: "{}" }, token);
}

export function setLaunchPush(token: string, enabled: boolean): Promise<{ launchPush: LaunchPushState }> {
  return request("/admin/launch/push", { method: "PUT", body: JSON.stringify({ enabled }) }, token);
}

// ── Notifications ───────────────────────────────────────────────────────────

export interface Broadcast {
  id: string;
  kind: BroadcastKind;
  audienceLabel: string;
  /** One number and tests: the number, masked. */
  maskedPhone: string | null;
  title: string;
  body: string;
  status: "SENDING" | "SENT" | "FAILED" | "INTERRUPTED";
  devices: number;
  /** Accepted for delivery; a failure reported later (~15 minutes) moves to `failed`. */
  delivered: number;
  failed: number;
  createdAt: string;
  finishedAt: string | null;
  /** Null for the launch push (sent by the server). */
  sentBy: { id: string; name: string } | null;
}

export interface CapStatus {
  used: number;
  max: number;
}

export interface BroadcastHistory {
  broadcasts: Broadcast[];
  caps: { broadcast: CapStatus; direct: CapStatus };
}

export interface AudiencePreview {
  devices: number;
  recipient: { name: string; role: "RIDER" | "DRIVER"; maskedPhone: string } | null;
}

export interface TestSendResult {
  devices: number;
  delivered: number;
  failed: number;
  message: string;
}

export function getBroadcasts(token: string): Promise<BroadcastHistory> {
  return request("/admin/notifications", {}, token);
}

export function previewAudience(token: string, audience: BroadcastAudience, phone: string): Promise<AudiencePreview> {
  const query = new URLSearchParams({ audience, ...(audience === "PHONE" ? { phone } : {}) });
  return request(`/admin/notifications/audience?${query.toString()}`, {}, token);
}

export function sendBroadcast(
  token: string,
  input: { audience: BroadcastAudience; phone?: string; title: string; body: string },
): Promise<{ broadcast: Broadcast }> {
  return request("/admin/notifications", { method: "POST", body: JSON.stringify(input) }, token);
}

export function sendTestToMe(token: string, input: { title: string; body: string }): Promise<TestSendResult> {
  return request("/admin/notifications/test", { method: "POST", body: JSON.stringify(input) }, token);
}

// ── Passkeys (Face ID / Touch ID sign-in) ───────────────────────────────────

export interface Passkey {
  id: string;
  name: string;
  /** Synced to the admin's other devices (iCloud Keychain and the like). */
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Signs in with a passkey: the browser offers this site's passkeys (Face ID /
 * Touch ID), and the server starts an admin session for the account the
 * chosen one belongs to. Throws ApiError for a refusal; the browser's own
 * error (cancelled, no passkey) as it is.
 */
export async function signInWithPasskey(): Promise<LoginResult> {
  const { challengeId, options } = await request<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("/auth/passkey/options", { method: "POST", body: "{}" });
  const response = await startAuthentication({ optionsJSON: options });
  return request("/auth/passkey/login", { method: "POST", body: JSON.stringify({ challengeId, response }) });
}

export function getPasskeys(token: string): Promise<{ passkeys: Passkey[] }> {
  return request("/admin/passkeys", {}, token);
}

/** Adds a passkey on this device to the signed-in admin's account. */
export async function addPasskey(token: string, name: string): Promise<{ passkey: Passkey }> {
  const { challengeId, options } = await request<{
    challengeId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }>("/admin/passkeys/options", { method: "POST", body: "{}" }, token);
  const response = await startRegistration({ optionsJSON: options });
  return request("/admin/passkeys", { method: "POST", body: JSON.stringify({ challengeId, response, name }) }, token);
}

export function removePasskey(token: string, id: string): Promise<{ removed: true }> {
  // An empty JSON body: request() always says it sends JSON, and the server refuses that with no body.
  return request(`/admin/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" }, token);
}
