import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Screen, Text, colors, radii, spacing } from "../../design";

export interface AuthPageProps {
  title: string;
  /** A sentence under the title (a string, or Text with links). */
  body?: ReactNode;
  /** Shows the round back button. */
  onBack?: () => void;
  children?: ReactNode;
  /** The screen's one action, kept just above the keyboard. */
  footer?: ReactNode;
}

/**
 * The white sign-in page (docs/mockups/02-rider-phone.png, 03-rider-code.png):
 * a 44px round back button, a title1 question, one body line, the field,
 * and the action pinned to the bottom. Screen's keyboard handling lifts the
 * footer above the keyboard.
 */
export function AuthPage({ title, body, onBack, children, footer }: AuthPageProps) {
  return (
    <Screen edges={["top", "bottom"]} style={styles.page}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={4}
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
        >
          <Ionicons name="arrow-back" size={22} color={colors.ink} />
        </Pressable>
      ) : null}
      <Text variant="title1" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {typeof body === "string" ? (
        <Text variant="body" color="secondary" style={styles.body}>
          {body}
        </Text>
      ) : body ? (
        <View style={styles.body}>{body}</View>
      ) : null}
      <View style={styles.content}>{children}</View>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: {
    paddingBottom: spacing[4],
  },
  back: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing[8],
  },
  backPressed: {
    backgroundColor: colors.surface3,
  },
  title: {
    marginBottom: spacing[2],
  },
  body: {
    marginBottom: spacing[8],
  },
  content: {
    flex: 1,
  },
  footer: {
    gap: spacing[2],
  },
});
