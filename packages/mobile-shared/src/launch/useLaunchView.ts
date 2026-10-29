import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LAUNCH_STATUS_PATH,
  MY_LAUNCH_STATUS_PATH,
  launchViewAt,
  readLaunchStatus,
  type HeldLaunchStatus,
  type LaunchView,
} from "@rida/shared";
import { api, rawApi } from "../auth/apiClient";
import { useAuth } from "../auth/AuthContext";

/**
 * Launch mode in the apps (@rida/shared launch/launchMode.ts): whether to
 * show the countdown to the public launch, and how long is left.
 *
 * A signed-in rider asks GET /me/launch-status, which also says whether they
 * can ride already (early access: no countdown for them); anyone else asks
 * the public GET /launch-status. Asked on opening, when the app comes back
 * to the foreground, every minute during a countdown and every 5 minutes
 * otherwise (so a countdown turned on later shows up without a restart).
 *
 * The countdown runs on the server's clock (the offset measured when the
 * answer arrived), so a phone set to the wrong time still counts down
 * correctly — and ends at the launch moment by itself, with no new answer
 * needed. A failed or unreadable answer shows no countdown: the server still
 * decides who can book.
 */

const MINUTE_MS = 60_000;

export const launchStatusQueryKey = (who: "me" | "public") => ["launch-status", who] as const;

export async function fetchLaunchStatus(who: "me" | "public"): Promise<HeldLaunchStatus | null> {
  const response =
    who === "me" ? await api.get<unknown>(MY_LAUNCH_STATUS_PATH) : await rawApi.get<unknown>(LAUNCH_STATUS_PATH);
  return readLaunchStatus(response.data, Date.now());
}

export function useLaunchView(): LaunchView {
  const { isAuthenticated, user } = useAuth();
  const who = isAuthenticated && user?.role === "RIDER" ? "me" : "public";
  const { data } = useQuery({
    queryKey: launchStatusQueryKey(who),
    queryFn: () => fetchLaunchStatus(who),
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.mode === "COUNTDOWN" ? MINUTE_MS : 5 * MINUTE_MS),
  });

  const [now, setNow] = useState(() => Date.now());
  const held = data ?? null;

  // Wake when the minute shown changes, and at the launch moment itself.
  // Straight away when what's shown is out of date (a new answer arrived, or
  // the app slept through a minute or the launch).
  useEffect(() => {
    const fresh = launchViewAt(held, Date.now());
    if (fresh.kind !== "countdown" && launchViewAt(held, now).kind !== "countdown") return;
    const upToDate = Math.abs(Date.now() - now) <= 1_000;
    const wait =
      fresh.kind === "countdown" && upToDate ? (fresh.remainingMs % MINUTE_MS || MINUTE_MS) + 20 : 0;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [held, now]);

  return launchViewAt(held, now);
}
