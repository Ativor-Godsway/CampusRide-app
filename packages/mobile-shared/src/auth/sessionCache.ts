import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { focusManager, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./AuthContext";

/**
 * React Query's "window focus" means nothing on a phone until it is told
 * about AppState. Call once at module level in an app's root layout: coming
 * back from the background then refetches active queries (an active ride's
 * status, the active-ride banner, a driver's current trip).
 */
export function installAppStateFocusManager(): void {
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener("change", (state) =>
      setFocused(state === "active"),
    );
    return () => subscription.remove();
  });
}

/**
 * Clears every cached query when the signed-in account changes (log out, or
 * someone else logging in on the same phone), so one person's ride or trip
 * can never show up for another. Not on the first sign-in of a launch, which
 * has nothing stale to clear. Mount inside QueryClientProvider + AuthProvider.
 */
export function useClearQueryCacheOnAccountChange(onChange?: () => void): void {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const previous = useRef(user?.id ?? null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const current = user?.id ?? null;
    if (previous.current !== null && previous.current !== current) {
      queryClient.clear();
      onChangeRef.current?.();
    }
    previous.current = current;
  }, [user?.id, queryClient]);
}
