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
