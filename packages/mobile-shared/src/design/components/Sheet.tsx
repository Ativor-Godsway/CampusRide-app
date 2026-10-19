import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radii, shadows, spacing } from "../tokens";

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Bottom-sheet primitive built on the core `Modal` (transparent + slide
 * animation) — no native bottom-sheet dependency, so it's Expo Go safe.
 * Used by R3 for map overlays (ride options, driver details, etc).
 */
export function Sheet({ visible, onClose, children }: SheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <SafeAreaView style={styles.sheetWrapper} edges={["bottom"]} pointerEvents="box-none">
        <View style={styles.sheet}>
          <View style={styles.handle} />
          {children}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
  },
  sheetWrapper: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[3],
    paddingBottom: spacing[5],
    ...shadows.sheet,
  },
  handle: {
    width: 36,
    height: 5,
    borderRadius: radii.full,
    backgroundColor: colors.surface3,
    alignSelf: "center",
    marginBottom: spacing[4],
  },
});
