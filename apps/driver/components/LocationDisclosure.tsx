import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { DRIVER_LOCATION_DISCLOSURE } from "@rida/shared";
import { Button, Text, colors, spacing } from "@rida/mobile-shared";

/**
 * Google Play's "prominent disclosure" for background location: a full-screen
 * explanation, shown BEFORE the system's location prompt, that the driver
 * accepts or declines (Continue / Not now). Nothing is asked of the system
 * until they tap Continue. Shown when going online if location hasn't been
 * allowed yet (lib/presence.tsx), never at install.
 */
type Ask = () => Promise<boolean>;

const DisclosureContext = createContext<Ask | null>(null);

export function useLocationDisclosure(): Ask {
  const ask = useContext(DisclosureContext);
  if (!ask) throw new Error("useLocationDisclosure must be used inside LocationDisclosureProvider");
  return ask;
}

export function LocationDisclosureProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);

  const ask = useCallback<Ask>(
    () =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setVisible(true);
      }),
    [],
  );

  const answer = (accepted: boolean) => {
    setVisible(false);
    resolver.current?.(accepted);
    resolver.current = null;
  };

  return (
    <DisclosureContext.Provider value={ask}>
      {children}
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => answer(false)}
      >
        <SafeAreaView style={styles.screen}>
          <View style={styles.body}>
            <View style={styles.icon}>
              <Ionicons name="location" size={44} color={colors.primary[500]} />
            </View>
            <Text variant="h2" style={styles.center}>
              {DRIVER_LOCATION_DISCLOSURE.title}
            </Text>
            <Text variant="body" style={styles.center}>
              {DRIVER_LOCATION_DISCLOSURE.body}
            </Text>
            <View style={styles.details}>
              {DRIVER_LOCATION_DISCLOSURE.details.map((line) => (
                <View key={line} style={styles.row}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.primary[500]} />
                  <Text variant="bodySmall" style={styles.flex}>
                    {line}
                  </Text>
                </View>
              ))}
            </View>
          </View>
          <View style={styles.actions}>
            <Button label={DRIVER_LOCATION_DISCLOSURE.accept} onPress={() => answer(true)} />
            <Button
              label={DRIVER_LOCATION_DISCLOSURE.decline}
              variant="ghost"
              onPress={() => answer(false)}
            />
          </View>
        </SafeAreaView>
      </Modal>
    </DisclosureContext.Provider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.white, paddingHorizontal: spacing.xl },
  body: { flex: 1, justifyContent: "center", gap: spacing.lg },
  icon: {
    alignSelf: "center",
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary[50],
  },
  center: { textAlign: "center" },
  details: { gap: spacing.sm, marginTop: spacing.sm },
  row: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  flex: { flex: 1 },
  actions: { gap: spacing.sm, paddingBottom: spacing.lg },
});
