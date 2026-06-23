import type { UserRole } from "@rida/shared";
import { Screen } from "./Screen";
import { EmptyState } from "./EmptyState";
import { Button } from "./Button";

export interface RoleMismatchScreenProps {
  /** The role this app expects the signed-in user to have. */
  expectedRole: Exclude<UserRole, "ADMIN">;
  onSignOut: () => Promise<void>;
}

const COPY: Record<Exclude<UserRole, "ADMIN">, { title: string; message: string }> = {
  DRIVER: {
    title: "This number is registered as a rider",
    message: "Open the CampusRide rider app to request rides with this account, or sign out to use a different phone number.",
  },
  RIDER: {
    title: "This number is registered as a driver",
    message: "Open the CampusRide driver app to drive with this account, or sign out to use a different phone number.",
  },
};

/** Blocks access when an authenticated user's role doesn't match this app. Each app build only serves one role and can't redirect into the other. */
export function RoleMismatchScreen({ expectedRole, onSignOut }: RoleMismatchScreenProps) {
  const copy = COPY[expectedRole];

  return (
    <Screen>
      <EmptyState
        title={copy.title}
        message={copy.message}
        action={<Button label="Sign out" variant="secondary" onPress={onSignOut} />}
      />
    </Screen>
  );
}
