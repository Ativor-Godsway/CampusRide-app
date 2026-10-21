import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Application from "expo-application";
import {
  APP_MIN_VERSION_PATH,
  NO_UPDATE_REQUIRED,
  UPDATE_CHECK_TIMEOUT_MS,
  nextUpdateRequirement,
  updateRequirement,
  type AppKind,
  type UpdateRequirement,
} from "@rida/shared";
import { rawApi } from "../auth/apiClient";

export type UpdateCheck = { ok: true; requirement: UpdateRequirement } | { ok: false };

/**
 * One ask of GET /app/min-version, compared with the store version of the
 * app on this phone (not app.json's: an over-the-air update can't change
 * what's installed). Never throws: no connection, a server error or no
 * answer within 5 s is `{ ok: false }`, and the person is let in.
 */
export async function checkForRequiredUpdate(app: AppKind): Promise<UpdateCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Update check timed out")), UPDATE_CHECK_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      rawApi.get<unknown>(APP_MIN_VERSION_PATH, { timeout: UPDATE_CHECK_TIMEOUT_MS }),
      timeout,
    ]);
    return {
      ok: true,
      requirement: updateRequirement(response.data, app, Platform.OS, Application.nativeApplicationVersion),
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether this app must be updated from the store: checked on launch and
 * every time the app comes back to the foreground. Starts as "not
 * required", and a failed check leaves the last answer as it was
 * (nextUpdateRequirement in @rida/shared).
 */
export function useUpdateRequirement(app: AppKind): UpdateRequirement {
  const [requirement, setRequirement] = useState<UpdateRequirement>(NO_UPDATE_REQUIRED);

  useEffect(() => {
    let mounted = true;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      const result = await checkForRequiredUpdate(app);
      checking = false;
      if (mounted) setRequirement((previous) => nextUpdateRequirement(previous, result));
    };
    void check();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void check();
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [app]);

  return requirement;
}
