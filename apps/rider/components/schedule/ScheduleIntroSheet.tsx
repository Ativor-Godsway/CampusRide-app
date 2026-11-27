import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SCHEDULE_INTRO_STEPS } from "@rida/shared";
import { Button, FadeIn, Text, colors, illustrations, radii, spacing, useReduceMotion } from "@rida/mobile-shared";
import type { IntroClose } from "../../lib/scheduleIntro";

const ICONS: Record<(typeof SCHEDULE_INTRO_STEPS)[number]["key"], keyof typeof Ionicons.glyphMap> = {
  ahead: "calendar-outline",
  join: "people-outline",
  ontime: "time-outline",
};

/** Between each step's entrance, ms. */
const STAGGER_MS = 140;

/**
 * "Book your ride ahead": a sheet over Home with the shared-car illustration,
 * three steps that come in one after another (at once with Reduce Motion),
 * "Schedule a ride", "Maybe later" and "Don't show again".
 */
export function ScheduleIntroSheet({ visible, onClose }: { visible: boolean; onClose: (how: IntroClose) => void }) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? "fade" : "slide"} onRequestClose={() => onClose("later")} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={() => onClose("later")} accessibilityLabel="Close" accessibilityRole="button" />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing[4]) + spacing[2] }]} accessibilityViewIsModal>
        <View style={styles.handle} />
        <Image source={illustrations.carShared} style={styles.art} resizeMode="contain" accessibilityIgnoresInvertColors />
        <Text variant="title2" accessibilityRole="header" style={styles.title}>
          Book your ride ahead
        </Text>
        <View style={styles.steps}>
          {SCHEDULE_INTRO_STEPS.map((step, i) => (
            <FadeIn key={step.key} delay={reduceMotion ? 0 : 120 + i * STAGGER_MS} style={styles.step}>
              <View style={styles.icon}>
                <Ionicons name={ICONS[step.key]} size={22} color={colors.green700} />
              </View>
              <View style={styles.stepText}>
                <Text variant="bodyStrong">{step.title}</Text>
                <Text variant="subhead" color="secondary">
                  {step.body}
                </Text>
              </View>
            </FadeIn>
          ))}
        </View>
        <View style={styles.buttons}>
          <Button label="Schedule a ride" icon="calendar-outline" onPress={() => onClose("schedule")} />
          <Button label="Maybe later" variant="neutral" onPress={() => onClose("later")} />
          <Pressable onPress={() => onClose("never")} accessibilityRole="button" hitSlop={8} style={styles.never}>
            <Text variant="subhead" color="tertiary">
              Don't show again
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[3],
  },
  handle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.surface3, marginBottom: spacing[3] },
  art: { alignSelf: "center", width: 200, height: 120 },
  title: { textAlign: "center", marginTop: spacing[2] },
  steps: { gap: spacing[4], marginTop: spacing[5], marginBottom: spacing[5] },
  step: { flexDirection: "row", gap: spacing[3], alignItems: "flex-start" },
  icon: { width: 44, height: 44, borderRadius: radii.md, backgroundColor: colors.green50, alignItems: "center", justifyContent: "center" },
  stepText: { flex: 1, gap: 2 },
  buttons: { gap: spacing[2] },
  never: { alignSelf: "center", paddingVertical: spacing[2] },
});
