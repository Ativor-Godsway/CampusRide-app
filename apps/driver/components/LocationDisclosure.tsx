import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
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

/** One icon for each of DRIVER_LOCATION_DISCLOSURE.details, in order. */
const DETAIL_ICONS: (keyof typeof Ionicons.glyphMap)[] = [
  "people-outline",
  "flash-outline",
  "power-outline",
  "time-outline",
];

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
          <ScrollView contentContainerStyle={styles.body}>
            <Text variant="title1" accessibilityRole="header">
              {DRIVER_LOCATION_DISCLOSURE.title}
            </Text>
            {/* Google Play's required wording, word for word. */}
            <Text variant="body" color="secondary">
              {DRIVER_LOCATION_DISCLOSURE.body}
            </Text>
            <View style={styles.details}>
              {DRIVER_LOCATION_DISCLOSURE.details.map((line, i) => (
                <View key={line} style={styles.row}>
                  <View style={styles.icon}>
                    <Ionicons
                      name={DETAIL_ICONS[i] ?? "checkmark"}
                      size={20}
                      color={colors.green700}
                    />
                  </View>
                  <Text variant="body" style={styles.flex}>
                    {line}
                  </Text>
                </View>
              ))}
            </View>
            <Text variant="subhead" color="secondary">
              {DRIVER_LOCATION_DISCLOSURE.hint}
            </Text>
          </ScrollView>
          <View style={styles.actions}>
            <Button label={DRIVER_LOCATION_DISCLOSURE.accept} onPress={() => answer(true)} />
            <Button
              label={DRIVER_LOCATION_DISCLOSURE.decline}
              variant="text"
              onPress={() => answer(false)}
            />
          </View>
        </SafeAreaView>
      </Modal>
    </DisclosureContext.Provider>
  );
}

const styles = StyleSheet.create({
  // White page, left-aligned (docs/design-system.md).
  screen: { flex: 1, backgroundColor: colors.surface, paddingHorizontal: spacing.gutter },
  body: { flexGrow: 1, justifyContent: "center", gap: spacing[4], paddingVertical: spacing[6] },
  details: { gap: spacing[3] },
  row: { flexDirection: "row", gap: spacing[3], alignItems: "center" },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.green50,
  },
  flex: { flex: 1 },
  actions: { gap: spacing[2], paddingBottom: spacing[4] },
});
