import { useEffect, useState } from "react";
import { APP_CONFIG_PATH, DEFAULT_SUPPORT_PHONE, supportPhoneFromConfig } from "@rida/shared";
import { rawApi } from "../auth/apiClient";
import { ListRow } from "../design";
import { callPhone } from "./contact";

/** The last number the server gave, for the rest of this session. */
let known: string | null = null;

/**
 * The number "Call support" dials: the server's (GET /app/config,
 * SUPPORT_PHONE on Render), else the built-in +233548608146 — no
 * connection, a server error or no answer within 5 s. Never throws.
 */
export async function fetchSupportPhone(): Promise<string> {
  try {
    const { data } = await rawApi.get<unknown>(APP_CONFIG_PATH, { timeout: 5_000 });
    known = supportPhoneFromConfig(data);
    return known;
  } catch {
    return known ?? DEFAULT_SUPPORT_PHONE;
  }
}

/** The support number to show and dial: the built-in one until the server answers. */
export function useSupportPhone(): string {
  const [phone, setPhone] = useState(known ?? DEFAULT_SUPPORT_PHONE);
  useEffect(() => {
    let mounted = true;
    void fetchSupportPhone().then((next) => {
      if (mounted) setPhone(next);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return phone;
}

/** Account › "Call support": one tap opens the phone's dialler with the number. */
export function CallSupportRow({ divider = false }: { divider?: boolean }) {
  const phone = useSupportPhone();
  return (
    <ListRow
      divider={divider}
      title="Call support"
      leading={<ListRow.Icon name="call-outline" />}
      onPress={() => void callPhone(phone, "CampusRide support")}
      accessibilityHint="Opens your phone to call CampusRide support"
    />
  );
}

/** Tests only: as a fresh launch. */
export function resetSupportPhoneForTests(): void {
  known = null;
}
