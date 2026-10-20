import { Linking, StyleSheet, View } from "react-native";
import { OTHER_APP, type UserRole } from "@rida/shared";
import { Button } from "./Button";
import { Illustration } from "./Illustration";
import { Screen } from "./Screen";
import { Text } from "./Text";
import { spacing } from "../tokens";

export interface RoleMismatchScreenProps {
  /** The role this app expects the signed-in user to have. */
  expectedRole: Exclude<UserRole, "ADMIN">;
  /** Signs out, so they can sign in with a different number. */
  onSignOut: () => Promise<void>;
}

const COPY: Record<
  Exclude<UserRole, "ADMIN">,
  { title: string; message: string; other: "RIDER" | "DRIVER" }
> = {
  DRIVER: {
    title: "This number is registered as a rider",
    message: "Book rides with it in the CampusRide rider app, or use a different number to drive.",
    other: "RIDER",
  },
  RIDER: {
    title: "This number is registered as a driver",
    message: "Drive with it in the CampusRide Driver app, or use a different number to ride.",
    other: "DRIVER",
  },
};

/**
 * Opens the other CampusRide app by its scheme; when it isn't installed (the
 * phone can't open the link), the website, where the apps are found. No
 * canOpenURL: on iOS that would need the scheme declared in the app's
 * Info.plist.
 */
export async function openOtherApp(role: "RIDER" | "DRIVER"): Promise<void> {
  const app = OTHER_APP[role];
  try {
    await Linking.openURL(app.url);
  } catch {
    await Linking.openURL(app.fallbackUrl).catch(() => undefined);
  }
}

/**
 * A signed-in account whose role doesn't match this app. Each app serves
 * one role; this offers the other app, or another number.
 */
export function RoleMismatchScreen({ expectedRole, onSignOut }: RoleMismatchScreenProps) {
  const copy = COPY[expectedRole];
  return (
    <Screen edges={["top", "bottom"]} style={styles.page}>
      <View style={styles.center}>
        <Illustration name="carStandard" width={220} />
        <Text variant="title2" accessibilityRole="header" style={styles.centered}>
          {copy.title}
        </Text>
        <Text variant="body" color="secondary" style={styles.centered}>
          {copy.message}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button
          label={`Open the ${OTHER_APP[copy.other].name}`}
          onPress={() => void openOtherApp(copy.other)}
        />
        <Button label="Use a different number" variant="text" onPress={() => void onSignOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: {
    paddingBottom: spacing[4],
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[3],
  },
  centered: {
    textAlign: "center",
  },
  actions: {
    gap: spacing[2],
  },
});
