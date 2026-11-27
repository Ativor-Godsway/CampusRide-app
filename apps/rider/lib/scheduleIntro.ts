import { useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { shouldShowScheduleIntro } from "@rida/shared";

/**
 * The "Book your ride ahead" intro (@rida/shared shouldShowScheduleIntro): on
 * a fresh launch — this module's state resets only when the app's JavaScript
 * starts, not when it comes back from the background — until the rider books
 * a scheduled ride (the server stops asking), taps "Don't show again", or 5
 * days pass since it first showed; never when an admin turned it off.
 */

const FIRST_SHOWN_KEY = "campusride.scheduleIntro.firstShownAt";
const DISMISSED_KEY = "campusride.scheduleIntro.dismissed";

let handledThisLaunch = false;

/** Tests only. */
export function resetScheduleIntroForTests(): void {
  handledThisLaunch = false;
}

export type IntroClose = "schedule" | "later" | "never";

export function useScheduleIntro(serverShow: boolean | undefined): { visible: boolean; close: (how: IntroClose) => void } {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (serverShow === undefined || handledThisLaunch) return;
    handledThisLaunch = true;
    let cancelled = false;
    void (async () => {
      const [first, dismissed] = await Promise.all([
        SecureStore.getItemAsync(FIRST_SHOWN_KEY).catch(() => null),
        SecureStore.getItemAsync(DISMISSED_KEY).catch(() => null),
      ]);
      const now = Date.now();
      const show = shouldShowScheduleIntro({
        serverShow,
        freshLaunch: true,
        shownThisLaunch: false,
        dismissedForever: dismissed === "1",
        firstShownAt: first && Number.isFinite(Number(first)) ? Number(first) : null,
        now,
      });
      if (!show || cancelled) return;
      if (!first) await SecureStore.setItemAsync(FIRST_SHOWN_KEY, String(now)).catch(() => undefined);
      setVisible(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [serverShow]);

  const close = (how: IntroClose) => {
    setVisible(false);
    if (how === "never") void SecureStore.setItemAsync(DISMISSED_KEY, "1").catch(() => undefined);
  };
  return { visible, close };
}
