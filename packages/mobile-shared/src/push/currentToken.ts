import * as SecureStore from "expo-secure-store";

/**
 * This install's push token once it has been registered with the server, so
 * log out (AuthContext.signOut) can tell the server to stop sending this
 * user's notifications here. Its own module, with no native imports, so the
 * auth code doesn't depend on expo-notifications.
 */
let currentPushToken: string | null = null;

export function setCurrentPushToken(token: string | null): void {
  currentPushToken = token;
}

export function getCurrentPushToken(): string | null {
  return currentPushToken;
}

/**
 * The last token this install sent to the server: for whom, and when. A
 * launch, the token listener or the permission screen sends it again only
 * when the token or the person changed (registration.ts). Kept in memory
 * and in the keychain, so a relaunch doesn't resend it either.
 */
export interface SentPushToken {
  userId: string;
  token: string;
  /** Epoch ms. */
  sentAt: number;
}

const SENT_KEY = "rida.push.sentToken";

/** undefined: not read from the keychain yet. */
let sent: SentPushToken | null | undefined;

function parseSent(raw: string | null): SentPushToken | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SentPushToken>;
    return typeof value.userId === "string" &&
      typeof value.token === "string" &&
      typeof value.sentAt === "number"
      ? { userId: value.userId, token: value.token, sentAt: value.sentAt }
      : null;
  } catch {
    return null;
  }
}

export async function getSentPushToken(): Promise<SentPushToken | null> {
  if (sent !== undefined) return sent;
  // An unreadable keychain (iPhone locked) counts as "not sent": one extra send.
  const raw = await SecureStore.getItemAsync(SENT_KEY).catch(() => null);
  // A write made meanwhile is newer than what was on disk.
  if (sent === undefined) sent = parseSent(raw);
  return sent;
}

export async function setSentPushToken(record: SentPushToken): Promise<void> {
  sent = record;
  await SecureStore.setItemAsync(SENT_KEY, JSON.stringify(record), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  }).catch(() => {});
}

/**
 * The session ended on this phone (log out, account deleted): the server has
 * dropped this install's token, so the next sign-in must send it again.
 */
export async function forgetPushRegistration(): Promise<void> {
  currentPushToken = null;
  sent = null;
  await SecureStore.deleteItemAsync(SENT_KEY).catch(() => {});
}

/** Tests only: as a fresh launch, nothing in memory. */
export function resetPushTokenMemoryForTests(): void {
  currentPushToken = null;
  sent = undefined;
}
