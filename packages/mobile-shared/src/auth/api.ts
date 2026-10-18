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
  /**
   * An App Store / Google Play review demo account: the apps treat it as on
   * campus wherever the reviewer is (REVIEW_DEMO_POSITION), and its rides are
   * served by the server's simulated people.
   */
  isReviewDemo?: boolean;
  /**
   * When "I'm 18 or older and I agree to the Terms and Privacy Policy" was
   * confirmed, and which terms version. Null for an account from before
   * sign-up asked: the app asks once (TermsConfirmationGate).
   */
  ageConfirmedAt?: string | null;
  termsAcceptedAt?: string | null;
  termsVersion?: string | null;
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
  // Only reachable once the sign-up screen's box is ticked; the server
  // refuses an account without it.
  const res = await api.post<SignupResponse>("/auth/signup", { ...input, ageAndTermsConfirmed: true });
  return res.data;
}

/** Records "I'm 18 or older and I agree to the Terms and Privacy Policy" for the signed-in account (POST /me/terms). */
export async function confirmTerms(): Promise<AuthUser> {
  const res = await api.post<{ user: AuthUser }>("/me/terms", { ageAndTermsConfirmed: true });
  return res.data.user;
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

/** `pushToken`: this install's, so the server stops sending this user's notifications here. */
export async function logout(refreshToken: string, pushToken?: string | null): Promise<void> {
  await rawApi
    .post("/auth/logout", { refreshToken, ...(pushToken ? { pushToken } : {}) })
    .catch(() => undefined);
}

/**
 * Texts a code to the signed-in account's own phone to confirm deleting it
 * (POST /me/deletion-code). Answers with the number, masked, for the screen
 * to say where the code went. Refused with 409 while a ride is going on.
 */
export async function requestDeletionCode(): Promise<{ phone: string }> {
  const res = await api.post<{ sent: boolean; phone: string }>("/me/deletion-code");
  return { phone: res.data.phone };
}

/**
 * Closes the signed-in account with the texted code (DELETE /me). The server
 * revokes every session, so the caller MUST clear local credentials
 * afterwards (AuthContext.deleteAccount does).
 *
 * Unlike logout this deliberately does NOT swallow errors: a wrong code, or
 * a ride still going on, must be shown, not treated as done.
 */
export async function deleteAccount(code: string): Promise<void> {
  await api.delete("/me", { data: { code } });
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
