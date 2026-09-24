/**
 * Thin fetch wrapper around the CampusRide API. Deliberately tiny — the admin
 * app hits a handful of endpoints and adding a data-fetching library would be
 * more moving parts than the whole screen count justifies.
 */

const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
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

  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
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
  createdAt: string;
  completedAt: string | null;
  rider: { id: string; name: string; phone: string } | null;
  driver: { id: string; name: string; phone: string } | null;
  pickupZone: { id: string; name: string } | null;
  dropoffZone: { id: string; name: string } | null;
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
