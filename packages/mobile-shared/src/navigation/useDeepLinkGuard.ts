import { useEffect } from "react";
import * as Linking from "expo-linking";
import { isAllowedDeepLink, type DeepLinkPolicy } from "@rida/shared";

/**
 * Drops inbound deep links that are not on the app's allowlist.
 *
 * Registering a custom scheme lets any other app, web page or QR code launch
 * us with a URL of its choosing. Expo Router would route whatever arrives, so
 * without this a hostile link could push a user onto an arbitrary screen with
 * arbitrary params. The policy lives in @rida/shared (isAllowedDeepLink),
 * which is where the parsing and traversal rules are tested.
 *
 * Disallowed links are IGNORED, not rewritten: the app simply opens at its
 * own start screen, which is the behaviour with no link at all.
 *
 * Note this runs alongside Expo Router's own handling rather than replacing
 * it, so it is a backstop for the initial URL and subsequent `url` events.
 * `onBlocked` exists so the host app can log or surface the rejection.
 */
export function useDeepLinkGuard(
  policy: DeepLinkPolicy,
  onBlocked?: (url: string) => void,
): void {
  useEffect(() => {
    let cancelled = false;

    const handle = (url: string | null) => {
      if (cancelled || !url) return;
      if (isAllowedDeepLink(url, policy)) return;
      onBlocked?.(url);
    };

    // The URL that cold-started the app, if any.
    void Linking.getInitialURL().then(handle);

    // Links delivered while the app is already running.
    const subscription = Linking.addEventListener("url", ({ url }) => handle(url));

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [policy, onBlocked]);
}
