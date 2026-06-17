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

export async function getMe(): Promise<{ user: AuthUser }> {
  const res = await api.get<{ user: AuthUser }>("/me");
  return res.data;
}
