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

/** GET with the session token (the dashboard's many reads). */
function get<T>(token: string, path: string): Promise<T> {
  return request<T>(path, {}, token);
}

function post<T>(token: string, path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) }, token);
}

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

// ── Dashboard v2 (routes/adminDashboard.ts, adminInsights.ts, adminPeople.ts) ──
// Every number follows docs/admin-metrics.md. Money is integer pesewas;
// times are ISO strings. Lists carry masked phones ("+233*****146").

export type LaunchModeName = "OFF" | "COUNTDOWN" | "LIVE";

export interface Summary {
  openSos: number;
  driversNeedingApproval: number;
  cashOutstandingPesewas: number;
  launchMode: LaunchModeName;
  database: "ok" | "down";
  generatedAt: string;
}

export const getSummary = (token: string) => get<Summary>(token, "/admin/summary");

export interface SearchResult {
  kind: "ride" | "rider" | "driver";
  id: string;
  title: string;
  subtitle: string;
}

export const search = (token: string, q: string) => get<{ results: SearchResult[] }>(token, `/admin/search?q=${encodeURIComponent(q)}`);

export interface RideRow {
  id: string;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  status: string;
  type: "LONE" | "SHARED";
  source: string;
  paymentMethod: string;
  seats: number;
  fareTotal: number | null;
  fareFinal: boolean;
  rider: { id: string; name: string; maskedPhone: string | null };
  driver: { id: string; driverId: string | null; name: string; plate: string | null } | null;
  pickup: string;
  dropoff: string;
  pickupZone: { id: string; name: string };
  dropoffZone: { id: string; name: string };
  cancelReason: string | null;
  cancelledBy: "rider" | "driver" | "system" | null;
  riderCancelReason: string | null;
  riderCancelReasonLabel: string | null;
  riderCancelNote: string | null;
  riderCancelFlagged: boolean;
}

export interface Overview {
  generatedAt: string;
  requests: { count: number; previousCount: number; gotDriver: number };
  completed: { trips: number; sharedTrips: number; faresPesewas: number; commissionPesewas: number };
  cashOutstandingPesewas: number;
  hourly: { requests: number[]; driversOnline: number[] };
  noDriver: { count: number; firstHour: number | null; lastHour: number | null; topZones: string[] };
  latestRides: RideRow[];
}

export const getOverview = (token: string, period: string) => get<Overview>(token, `/admin/overview?${period}`);

export interface LivePosition {
  latitude: number;
  longitude: number;
  heading: number | null;
  at: string | null;
  /** False: the last position on record, not a live one. */
  live: boolean;
}

export interface LiveDriver {
  userId: string;
  driverId: string;
  name: string;
  plate: string | null;
  status: "WAITING" | "ON_TRIP";
  rideId: string | null;
  position: LivePosition | null;
  seenAt: string | null;
  app: { connected: boolean; state: "foreground" | "background" | null } | null;
}

export interface LiveRequest {
  rideId: string;
  riderId: string;
  riderName: string;
  type: "LONE" | "SHARED";
  requestedAt: string;
  pickup: { latitude: number; longitude: number; label: string } | null;
  pickupLabel: string;
  dropoffLabel: string;
  offeredTo: number;
  declined: number;
  timedOut: number;
}

export interface LiveTrip {
  rideId: string;
  driverUserId: string;
  status: string;
  type: "LONE" | "SHARED";
  riders: number;
  stops: Array<{ kind: "pickup" | "dropoff"; latitude: number; longitude: number; label: string; done: boolean }>;
}

export interface Live {
  generatedAt: string;
  boardAt: string;
  drivers: LiveDriver[];
  requests: LiveRequest[];
  trips: LiveTrip[];
  counts: { online: number; onTrip: number; waitingDrivers: number; ridersWaiting: number; tripsRunning: number };
}

export const getLive = (token: string) => get<Live>(token, "/admin/live");

export interface RideQuery {
  period?: string;
  status?: string;
  type?: string;
  zoneId?: string;
  driverId?: string;
  riderPhone?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface RidePage {
  rides: RideRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function getRidePage(token: string, query: RideQuery): Promise<RidePage> {
  const params = new URLSearchParams(query.period ?? "");
  for (const key of ["status", "type", "zoneId", "driverId", "riderPhone", "q"] as const) {
    if (query[key]) params.set(key, query[key]!);
  }
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  return get(token, `/admin/rides?${params.toString()}`);
}

export interface RideDetail {
  ride: RideRow & {
    pickupPin: { latitude: number; longitude: number; label: string; note: string | null } | null;
    dropoffPin: { latitude: number; longitude: number; label: string } | null;
    routePolyline: string | null;
    mergedIntoRideId: string | null;
  };
  timeline: Array<{ at: string; kind: string; text: string }>;
  offers: Array<{ driver: { id: string; name: string }; offeredAt: string; outcome: string | null; responseMs: number | null }>;
  seats: Array<{
    id: string;
    rider: { id: string; name: string; maskedPhone: string | null };
    status: string;
    farePesewas: number | null;
    pickup: string;
    dropoff: string;
    pickupPin: { latitude: number; longitude: number } | null;
    dropoffPin: { latitude: number; longitude: number } | null;
    joinedAt: string;
    arrivedAt: string | null;
    noShowAt: string | null;
  }>;
  ratings: Array<{ stars: number; comment: string | null; createdAt: string; rater: { id: string; name: string; role: string }; ratee: { id: string; name: string; role: string } }>;
  sos: Array<{ id: string; createdAt: string; riderId: string; smsDelivered: boolean; supportNotified: boolean; handledAt: string | null }>;
  trackingLinks: Array<{ riderName: string; createdAt: string; active: boolean }>;
  mergedRides: Array<{ id: string; riderName: string }>;
}

export const getRideDetail = (token: string, id: string) => get<RideDetail>(token, `/admin/rides/${encodeURIComponent(id)}`);

export interface ZoneSupply {
  zoneId: string;
  name: string;
  requests: number;
  noDriver: number;
  medianTimeToDriverMs: number | null;
  need: number;
  window: string | null;
  windows: Array<{ label: string; requests: number; noDriver: number; need: number }>;
}

export interface SupplyDemand {
  generatedAt: string;
  requests: number;
  previousRequests: number;
  gotDriver: number;
  gotDriverRate: number | null;
  medianTimeToDriverMs: number | null;
  noDriver: number;
  heat: { noDriver: number[][]; requests: number[][] };
  hourly: { requests: number[]; driverHours: number[] };
  zones: ZoneSupply[];
  suggestion: string | null;
}

export const getSupplyDemand = (token: string, period: string) => get<SupplyDemand>(token, `/admin/supply-demand?${period}`);

export interface Cancellations {
  generatedAt: string;
  cancellations: number;
  requests: number;
  rate: number | null;
  byWho: { rider: number; driver: number; system: number };
  beforeMatch: number;
  afterMatch: number;
  byHour: number[];
  reasons: Array<{ reason: string; label: string; count: number }>;
  rides: RideRow[];
}

export const getCancellations = (token: string, period: string, who?: string) =>
  get<Cancellations>(token, `/admin/cancellations?${period}${who ? `&who=${who}` : ""}`);

export interface PlacesActivity {
  generatedAt: string;
  pickups: Array<{ latitude: number; longitude: number; count: number }>;
  dropoffs: Array<{ latitude: number; longitude: number; count: number }>;
  places: Array<{ name: string; pickups: number; dropoffs: number; noDriver: number }>;
}

export const getPlacesActivity = (token: string, period: string) => get<PlacesActivity>(token, `/admin/places/activity?${period}`);

export interface DriverRow {
  driverId: string;
  userId: string;
  name: string;
  maskedPhone: string | null;
  plate: string | null;
  car: string | null;
  photoUrl: string | null;
  isApproved: boolean;
  isOnline: boolean;
  suspended: boolean;
  onTrip: boolean;
  joinedAt: string;
  trips: number;
  hoursOnlineMs: number;
  earnedPesewas: number;
  offers: number;
  acceptanceRate: number | null;
  avgReplyMs: number | null;
  rating: number | null;
  ratings: number;
}

export interface DriverList {
  generatedAt: string;
  drivers: DriverRow[];
  counts: { all: number; online: number; needsApproval: number; suspended: number };
}

export const getDrivers = (token: string, period: string) => get<DriverList>(token, `/admin/drivers?${period}`);

export interface DriverDetail {
  generatedAt: string;
  driver: {
    driverId: string;
    userId: string;
    name: string;
    phone: string | null;
    carMake: string | null;
    carModel: string | null;
    carColor: string | null;
    plate: string | null;
    photoUrl: string | null;
    isApproved: boolean;
    isOnline: boolean;
    suspendedAt: string | null;
    suspendedReason: string | null;
    joinedAt: string;
  };
  period: {
    trips: number;
    faresPesewas: number;
    commissionPesewas: number;
    earnedPesewas: number;
    hoursOnlineMs: number;
    offers: number;
    accepted: number;
    declined: number;
    timedOut: number;
    acceptanceRate: number | null;
    avgReplyMs: number | null;
    cancelledByDriver: number;
  };
  rating: number | null;
  ratings: number;
  balance: { owedPesewas: number; paidPesewas: number; balancePesewas: number; oldestUnpaidAt: string | null };
  recentTrips: RideRow[];
  sessions: Array<{ startedAt: string; endedAt: string | null; endReason: string | null; ms: number }>;
  offers: Array<{ rideId: string; offeredAt: string; outcome: string | null; responseMs: number | null }>;
  trailDays: string[];
}

export const getDriverDetail = (token: string, id: string, period: string) =>
  get<DriverDetail>(token, `/admin/drivers/${encodeURIComponent(id)}?${period}`);

export interface TrailPoint {
  latitude: number;
  longitude: number;
  at: string;
  onTrip: boolean;
}

export const getDriverTrail = (token: string, id: string, day: string) =>
  get<{ day: string; points: TrailPoint[] }>(token, `/admin/drivers/${encodeURIComponent(id)}/trail?day=${day}`);

export const suspendDriver = (token: string, id: string, reason: string) => post<{ suspended: true }>(token, `/admin/drivers/${encodeURIComponent(id)}/suspend`, { reason });
export const unsuspendDriver = (token: string, id: string, reason: string) => post<{ suspended: false }>(token, `/admin/drivers/${encodeURIComponent(id)}/unsuspend`, { reason });

export interface CashDriverRow {
  userId: string;
  driverId: string;
  name: string;
  plate: string | null;
  owedInPeriodPesewas: number;
  paidInPeriodPesewas: number;
  balancePesewas: number;
  oldestUnpaidAt: string | null;
  status: "PAID" | "PART_PAID" | "NOT_PAID";
}

export interface CashOwed {
  generatedAt: string;
  outstandingPesewas: number;
  driversOwing: number;
  oldestUnpaidAt: string | null;
  earnedInPeriodPesewas: number;
  faresInPeriodPesewas: number;
  paidInPeriodPesewas: number;
  paymentsInPeriod: number;
  drivers: CashDriverRow[];
}

export const getCash = (token: string, period: string) => get<CashOwed>(token, `/admin/cash?${period}`);

export type CashMethod = "CASH" | "MOMO" | "OTHER";

export interface CashPayment {
  id: string;
  driver: { id: string; name: string };
  amountPesewas: number;
  method: CashMethod;
  note: string | null;
  paidAt: string;
  createdAt: string;
  recordedBy: { id: string; name: string };
  reversesId: string | null;
  reversalReason: string | null;
  reversedBy: { id: string; at: string; reason: string | null } | null;
}

export function getPayments(token: string, q: { period?: string; driverId?: string; page?: number; pageSize?: number }) {
  const params = new URLSearchParams(q.period ?? "");
  if (q.driverId) params.set("driverId", q.driverId);
  if (q.page) params.set("page", String(q.page));
  if (q.pageSize) params.set("pageSize", String(q.pageSize));
  return get<{ payments: CashPayment[]; total: number; page: number; pageSize: number }>(token, `/admin/cash/payments?${params.toString()}`);
}

export const recordPayment = (token: string, input: { driverId: string; amountPesewas: number; method: CashMethod; note: string | null; paidAt: string }) =>
  post<{ payment: { id: string } }>(token, "/admin/cash/payments", input);
export const reversePayment = (token: string, id: string, reason: string) => post(token, `/admin/cash/payments/${encodeURIComponent(id)}/reverse`, { reason });

export interface RiderRow {
  id: string;
  name: string;
  maskedPhone: string | null;
  joinedAt: string;
  rides: number;
  lastRideAt: string | null;
  earlyAccess: boolean;
}

export interface RiderList {
  generatedAt: string;
  riders: number;
  newInPeriod: number;
  activeInPeriod: number;
  riddenEver: number;
  returning: number;
  returningRate: number | null;
  signupsPerDay: Array<{ day: string; count: number }>;
  list: RiderRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function getRiders(token: string, period: string, q: string, page: number): Promise<RiderList> {
  const params = new URLSearchParams(period);
  if (q.trim()) params.set("q", q.trim());
  params.set("page", String(page));
  return get(token, `/admin/riders?${params.toString()}`);
}

export interface RiderDetail {
  rider: { id: string; name: string; phone: string | null; joinedAt: string; closed: boolean; earlyAccessAt: string | null; hasEmergencyContact: boolean };
  stats: { requests: number; completed: number; cancelled: number };
  rides: RideRow[];
  ratingsGiven: Array<{ stars: number; comment: string | null; createdAt: string; rideId: string; ratee: { id: string; name: string } }>;
  sos: Array<{ id: string; rideId: string; createdAt: string; handledAt: string | null }>;
}

export const getRiderDetail = (token: string, id: string) => get<RiderDetail>(token, `/admin/riders/${encodeURIComponent(id)}`);

export interface SosRow {
  id: string;
  createdAt: string;
  rideId: string;
  rideStatus: string;
  route: string;
  rider: { id: string; name: string; maskedPhone: string | null };
  driver: { id: string; name: string } | null;
  latitude: number | null;
  longitude: number | null;
  hasContact: boolean;
  smsDelivered: boolean;
  supportNotified: boolean;
  handledAt: string | null;
  handledBy: { id: string; name: string } | null;
  handledNote: string | null;
}

export interface Safety {
  generatedAt: string;
  openCount: number;
  sos: SosRow[];
  earlierSos: Array<{ rideId: string; riderName: string; createdAt: string }>;
  lowRatings: Array<{
    id: string;
    stars: number;
    comment: string | null;
    createdAt: string;
    rideId: string;
    rater: { id: string; name: string; role: string };
    ratee: { id: string; name: string; role: string; driverId: string | null };
  }>;
}

export const getSafety = (token: string, period: string) => get<Safety>(token, `/admin/safety?${period}`);
export const handleSos = (token: string, id: string, note: string) => post(token, `/admin/sos/${encodeURIComponent(id)}/handle`, { note });

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  actor: { id: string; name: string } | null;
  target: string;
  reason: string | null;
}

export function getAudit(token: string, q: { action?: string; q?: string; actor?: string; page?: number }) {
  const params = new URLSearchParams();
  if (q.action) params.set("action", q.action);
  if (q.actor) params.set("actor", q.actor);
  if (q.q) params.set("q", q.q);
  params.set("page", String(q.page ?? 1));
  return get<{ entries: AuditEntry[]; actions: string[]; total: number; page: number; pageSize: number }>(token, `/admin/audit?${params.toString()}`);
}

export interface SystemInfo {
  minVersions: Record<"rider" | "driver", Record<"ios" | "android", { minVersion: string | null; storeUrl: string | null } | null>>;
  reviewDemo: { enabled: boolean; problems: string[] };
  server: { commit: string | null; startedAt: string; environment: string };
}

export const getSystem = (token: string) => get<SystemInfo>(token, "/admin/system");

/** The campus zones (the same list the apps get), for filters. */
export const getZones = (token: string) => get<{ zones: Array<{ id: string; name: string }> }>(token, "/zones");
