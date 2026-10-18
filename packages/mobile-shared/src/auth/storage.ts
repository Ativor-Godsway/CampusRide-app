import * as SecureStore from "expo-secure-store";

/**
 * The refresh token, kept in the phone's keychain (expo-secure-store) so the
 * session survives the app being closed — and in memory, which is the
 * source of truth while the app runs.
 *
 * Why both: the server rotates the token on every refresh. If the newest
 * token only lived on disk, a disk write that failed (an iPhone's keychain
 * is unreadable while the phone is locked, which is exactly when a driver's
 * app refreshes in the background) would leave the app presenting the old,
 * already-used token next time, and the server would end the session. The
 * memory copy is always the newest; a failed write is simply tried again.
 */
const REFRESH_TOKEN_KEY = "rida.session.refreshToken";
/** Where the token lived before; read once, then moved to the key above. */
const LEGACY_REFRESH_TOKEN_KEY = "rida.refreshToken";

/**
 * Readable while the phone is locked, once it has been unlocked after a
 * restart (iOS; Android ignores it). The default, "when unlocked", made the
 * driver app's background refresh fail on a locked phone. A new key name,
 * because iOS keeps an existing item's original setting when it is updated.
 */
const WRITE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** undefined: not read from disk yet. */
let current: string | null | undefined;
/** The value of `current` still has to reach the disk. */
let unsaved = false;

async function persist(): Promise<void> {
  if (!unsaved) return;
  const value = current;
  if (value) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, value, WRITE_OPTIONS);
    await SecureStore.deleteItemAsync(LEGACY_REFRESH_TOKEN_KEY).catch(() => {});
  } else {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
    await SecureStore.deleteItemAsync(LEGACY_REFRESH_TOKEN_KEY);
  }
  // Only if nothing changed meanwhile; otherwise the newer value is next.
  if (current === value) unsaved = false;
}

function persistSoon(): void {
  // A failure leaves `unsaved` set, and the next read or write tries again.
  void persist().catch(() => {});
}

/**
 * The newest refresh token, or null when signed out. Rejects only when the
 * keychain could not be read at all (iPhone locked) — which is "don't know",
 * never "signed out".
 */
export async function getStoredRefreshToken(): Promise<string | null> {
  if (current !== undefined) {
    if (unsaved) persistSoon();
    return current;
  }
  const stored =
    (await SecureStore.getItemAsync(REFRESH_TOKEN_KEY)) ?? (await SecureStore.getItemAsync(LEGACY_REFRESH_TOKEN_KEY));
  // A write or clear may have happened while the disk was being read.
  if (current === undefined) current = stored;
  return current;
}

/**
 * Records a new refresh token. It is in use at once; the write to disk is
 * awaited, but its failure is not an error for the caller (see above).
 */
export async function setStoredRefreshToken(token: string): Promise<void> {
  current = token;
  unsaved = true;
  await persist().catch(() => {});
}

/** Forgets the refresh token (sign-out). Never rejects. */
export async function clearStoredRefreshToken(): Promise<void> {
  current = null;
  unsaved = true;
  await persist().catch(() => {});
}

/** Tests only: forget the in-memory copy, as a fresh app launch would. */
export function forgetRefreshTokenInMemory(): void {
  current = undefined;
  unsaved = false;
}
