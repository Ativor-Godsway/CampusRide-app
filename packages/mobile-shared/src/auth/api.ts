import type { UserRole } from "@rida/shared";
import { api, rawApi } from "./apiClient";

export type OtpPurpose = "SIGNUP" | "LOGIN";

export interface AuthDriverProfile {
  id: string;
  carMake: string | null;
  carModel: string | null;
  carColor: string | null;
  plate: string | null;
  photoUrl: string | null;
  isApproved: boolean;
  isOnline: boolean;
}

export interface AuthUser {
  id: string;
  phone: string;
  name: string;
  role: UserRole;
  /** Phase 4 safety: the single contact notified by an SOS. Null until set. */
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  /** Populated for DRIVER accounts (from /me with include: { driver: true }). */
  driver?: AuthDriverProfile | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SignupResponse extends AuthTokens {
  user: AuthUser;
}

export interface LoginResponse extends AuthTokens {
  user: AuthUser;
}

export async function requestOtp(phone: string, purpose: OtpPurpose): Promise<void> {
  await api.post("/auth/request-otp", { phone, purpose });
}

export async function verifyOtp(
  phone: string,
  code: string,
  purpose: OtpPurpose,
): Promise<{ verifiedToken: string }> {
  const res = await api.post<{ verifiedToken: string }>("/auth/verify-otp", {
    phone,
    code,
    purpose,
  });
  return res.data;
}

export async function signup(input: {
  phone: string;
  name: string;
  role: Exclude<UserRole, "ADMIN">;
  verifiedToken: string;
}): Promise<SignupResponse> {
  const res = await api.post<SignupResponse>("/auth/signup", input);
  return res.data;
}

export async function login(input: {
  phone: string;
  verifiedToken: string;
}): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>("/auth/login", input);
  return res.data;
}

/** Uses rawApi (no interceptors) to avoid recursive refresh-on-401 loops. */
export async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
  const res = await rawApi.post<AuthTokens>("/auth/refresh", { refreshToken });
  return res.data;
}

export async function logout(refreshToken: string): Promise<void> {
  await rawApi.post("/auth/logout", { refreshToken }).catch(() => undefined);
}

/**
 * Permanently closes the signed-in account (DELETE /me).
 *
 * The server anonymizes the account rather than deleting the row — ride and
 * payment history is preserved — and revokes every refresh token, so the
 * caller MUST clear local credentials afterwards (AuthContext.deleteAccount
 * does this by reusing the sign-out path).
 *
 * Unlike logout this deliberately does NOT swallow errors: the server
 * refuses with 409 while a ride is still in flight, and the user needs to
 * see that instead of being dropped to the welcome screen as if it worked.
 */
export async function deleteAccount(): Promise<void> {
  await api.delete("/me");
}

export interface UpdateProfileInput {
  name?: string;
  /** Pass null for BOTH contact fields to clear the emergency contact. */
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

/**
 * Partial profile update (PATCH /me). Omitted fields are left unchanged.
 * `phone` is intentionally absent: it is the login identity and changing it
 * requires re-verifying the new number, which is a separate flow.
 */
export async function updateProfile(input: UpdateProfileInput): Promise<AuthUser> {
  const res = await api.patch<{ user: AuthUser }>("/me", input);
  return res.data.user;
}

export async function getMe(): Promise<{ user: AuthUser }> {
  const res = await api.get<{ user: AuthUser }>("/me");
  return res.data;
}
