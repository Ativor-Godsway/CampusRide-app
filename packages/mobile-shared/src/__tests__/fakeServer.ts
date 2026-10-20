import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { api, rawApi } from "../auth/apiClient";
import type { AuthUser } from "../auth/api";

/**
 * A stand-in for the CampusRide server, plugged into the app's real axios
 * clients, so the tests run the real auth code (interceptors, single-flight
 * refresh, AuthProvider) against it. Its refresh-token rules copy the real
 * server's (apps/server/src/services/auth/authService.ts): every refresh
 * rotates the token, and presenting an already-used token is "reuse" —
 * revoking the whole login — unless it is a retry inside the grace window.
 */

export type Outage = "network" | "timeout" | "server-error" | "not-found" | null;

interface StoredToken {
  token: string;
  familyId: string;
  revokedAt: number | null;
  /** When this token was replaced by a rotation (null: not rotated). */
  rotatedAt: number | null;
  successor: string | null;
}

export interface FakeServer {
  user: AuthUser;
  /** Whether the number has an account: POST /auth/verify-code signs in, or says "newAccount". */
  registered: boolean;
  /** Simulated time, in ms, for the grace window. */
  now: number;
  /** Every request path, in order ("POST /auth/refresh"). */
  calls: string[];
  /** Makes every request fail this way until set back to null. */
  outage: Outage;
  /**
   * The server does the work but the phone never hears back: the next N
   * requests to this path succeed on the server, then fail as a timeout.
   */
  loseResponses: { path: string; count: number } | null;
  /** Expire every access token issued so far (the 30-minute expiry). */
  expireAccessTokens(): void;
  /** Revoke every refresh token (an admin, or account deletion). */
  revokeAll(): void;
  /** Delete the account: its tokens stop working everywhere. */
  deleteAccount(): void;
  /** Answers to requests on this path take this long (simulated time). */
  slow: { path: string; ms: number } | null;
  /** Extra routes for a test: return a body, or undefined for 404. */
  routes: Record<string, (body: unknown) => unknown>;
  refreshTokenReuseGraceMs: number;
  /** The refresh tokens this server considers live. */
  liveRefreshTokens(): string[];
  /** Issues a session as a login would, without the screens. */
  issue(): { accessToken: string; refreshToken: string };
}

const REUSE_GRACE_MS = 2 * 60 * 1000;

function makeUser(role: AuthUser["role"]): AuthUser {
  return {
    id: "user-1",
    phone: "+233241234567",
    name: "Ama Test",
    role,
    ageConfirmedAt: "2026-10-01T00:00:00.000Z",
    termsAcceptedAt: "2026-10-01T00:00:00.000Z",
    termsVersion: "2026-10-17",
    driver:
      role === "DRIVER"
        ? {
            id: "driver-1",
            carMake: "Toyota",
            carModel: "Vitz",
            carColor: "Silver",
            plate: "GR 1234-26",
            photoUrl: "https://example.test/photo.jpg",
            isApproved: true,
            isOnline: false,
          }
        : null,
  };
}

export function installFakeServer(role: AuthUser["role"] = "RIDER"): FakeServer {
  let counter = 0;
  const refreshTokens = new Map<string, StoredToken>();
  const accessTokens = new Map<string, { expired: boolean }>();
  let accountDeleted = false;

  function issueTokens(familyId?: string) {
    counter += 1;
    const accessToken = `access-${counter}`;
    const refreshToken = `refresh-${counter}`;
    accessTokens.set(accessToken, { expired: false });
    refreshTokens.set(refreshToken, {
      token: refreshToken,
      familyId: familyId ?? refreshToken,
      revokedAt: null,
      rotatedAt: null,
      successor: null,
    });
    return { accessToken, refreshToken };
  }

  function revokeFamily(familyId: string) {
    for (const t of refreshTokens.values()) {
      if (t.familyId === familyId && t.revokedAt === null) t.revokedAt = server.now;
    }
  }

  const server: FakeServer = {
    user: makeUser(role),
    registered: true,
    now: 1_000_000,
    calls: [],
    outage: null,
    loseResponses: null,
    slow: null,
    refreshTokenReuseGraceMs: REUSE_GRACE_MS,
    routes: {},
    expireAccessTokens() {
      for (const t of accessTokens.values()) t.expired = true;
    },
    revokeAll() {
      for (const t of refreshTokens.values()) if (t.revokedAt === null) t.revokedAt = server.now;
    },
    deleteAccount() {
      accountDeleted = true;
      server.revokeAll();
    },
    liveRefreshTokens() {
      return [...refreshTokens.values()].filter((t) => t.revokedAt === null).map((t) => t.token);
    },
    issue: () => issueTokens(),
  };

  function authorized(config: InternalAxiosRequestConfig): boolean {
    const header = String(config.headers?.Authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const known = accessTokens.get(token);
    return Boolean(known && !known.expired && !accountDeleted);
  }

  function handle(method: string, path: string, body: Record<string, unknown>, config: InternalAxiosRequestConfig): [number, unknown] {
    const key = `${method} ${path}`;
    switch (key) {
      case "POST /auth/request-otp":
        return [200, { ok: true }];
      case "POST /auth/verify-otp":
        return [200, { verifiedToken: "verified" }];
      case "POST /auth/verify-code":
        return server.registered
          ? [200, { status: "signedIn", ...issueTokens(), user: server.user }]
          : [200, { status: "newAccount", verifiedToken: "verified" }];
      case "POST /auth/login":
      case "POST /auth/signup":
        return [200, { ...issueTokens(), user: server.user }];
      case "POST /auth/refresh": {
        const stored = refreshTokens.get(String(body.refreshToken));
        if (!stored || accountDeleted) return [401, { error: "Invalid refresh token" }];
        if (stored.revokedAt !== null) {
          // The real server's rule: a retry of a rotation whose answer never
          // arrived is honoured inside the grace window; anything else is reuse.
          const successor = stored.successor ? refreshTokens.get(stored.successor) : undefined;
          const retry =
            server.refreshTokenReuseGraceMs > 0 &&
            stored.rotatedAt !== null &&
            server.now - stored.rotatedAt <= server.refreshTokenReuseGraceMs &&
            successor !== undefined &&
            successor.revokedAt === null;
          if (!retry) {
            revokeFamily(stored.familyId);
            return [401, { error: "Invalid refresh token" }];
          }
          successor.revokedAt = server.now;
          successor.rotatedAt = server.now;
          const next = issueTokens(stored.familyId);
          successor.successor = next.refreshToken;
          return [200, next];
        }
        stored.revokedAt = server.now;
        stored.rotatedAt = server.now;
        const next = issueTokens(stored.familyId);
        stored.successor = next.refreshToken;
        return [200, next];
      }
      case "POST /auth/logout": {
        const stored = refreshTokens.get(String(body.refreshToken));
        if (stored) stored.revokedAt = server.now;
        return [200, { ok: true }];
      }
      default: {
        if (!authorized(config)) return [401, { error: "Invalid or expired access token" }];
        if (key === "GET /me") return [200, { user: server.user }];
        const route = server.routes[key];
        if (!route) return [404, { error: "Not found" }];
        return [200, route(body)];
      }
    }
  }

  const adapter: AxiosAdapter = async (config) => {
    const method = (config.method ?? "get").toUpperCase();
    const path = (config.url ?? "").replace(/^https?:\/\/[^/]+/, "");
    server.calls.push(`${method} ${path}`);
    const fail = (status: number | null, message: string) => {
      const error = Object.assign(new Error(message), {
        isAxiosError: true,
        config,
        code: status === null ? (message === "timeout" ? "ECONNABORTED" : "ERR_NETWORK") : undefined,
        response:
          status === null
            ? undefined
            : ({ status, data: { error: message }, headers: {}, config, statusText: "" } as AxiosResponse),
      });
      return Promise.reject(error);
    };
    if (server.outage === "network") return fail(null, "Network Error");
    if (server.outage === "timeout") return fail(null, "timeout");
    if (server.outage === "server-error") return fail(502, "Bad gateway");
    if (server.outage === "not-found") return fail(404, "Not Found");

    if (server.slow && server.slow.path === `${method} ${path}`) {
      const ms = server.slow.ms;
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }
    const body = typeof config.data === "string" && config.data ? JSON.parse(config.data) : (config.data ?? {});
    const [status, data] = handle(method, path, body, config);

    if (server.loseResponses && server.loseResponses.path === `${method} ${path}` && server.loseResponses.count > 0) {
      server.loseResponses.count -= 1;
      return fail(null, "timeout");
    }
    if (status >= 400) {
      return Promise.reject(
        Object.assign(new Error(`Request failed with status code ${status}`), {
          isAxiosError: true,
          config,
          response: { status, data, headers: {}, config, statusText: "" } as AxiosResponse,
        }),
      );
    }
    return { status, data, headers: {}, config, statusText: "OK" } as AxiosResponse;
  };

  api.defaults.adapter = adapter;
  rawApi.defaults.adapter = adapter;
  return server;
}
