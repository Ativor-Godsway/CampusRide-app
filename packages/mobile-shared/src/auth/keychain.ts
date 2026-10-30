import * as SecureStore from "expo-secure-store";

/**
 * Reading and writing the phone's keychain (expo-secure-store) for things
 * the apps also need in the background.
 *
 * On an iPhone a keychain read can fail for a moment: while the phone is
 * locked (for an item saved "when unlocked", the default), before its first
 * unlock after a restart, or while iOS is still bringing the app back from
 * the background. Expo reports it as "Calling the 'getValueWithKeyAsync'
 * function has failed" (Sentry CAMPUSRIDE-DRIVER-2). A failed read is never
 * "nothing saved": callers treat it as "not known yet" and try again.
 */

/** Readable while the phone is locked, once it has been unlocked after a restart (iOS; Android ignores it). */
export const KEYCHAIN_BACKGROUND_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** Waits before each further try of a read that failed; then the failure is the caller's. */
export const KEYCHAIN_READ_RETRY_DELAYS_MS = [250, 1_000] as const;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The saved value, or null when nothing is saved. A failed read is tried
 * again after a short wait (KEYCHAIN_READ_RETRY_DELAYS_MS); if it still
 * fails, this rejects — which means "can't tell now", never "signed out".
 */
export async function readKeychain(key: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch (error) {
      const delay = KEYCHAIN_READ_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await pause(delay);
    }
  }
}
