import { View, StyleSheet } from "react-native";
import type { ReactNode } from "react";
import { spacing } from "../tokens";
import type { IllustrationName } from "../illustrations";
import { Illustration } from "./Illustration";
import { Text } from "./Text";

export interface EmptyStateProps {
  title: string;
  message?: string;
  icon?: ReactNode;
  /** 3D artwork shown above the title (takes priority over `icon`). */
  illustration?: IllustrationName;
  action?: ReactNode;
}

/** Centered placeholder for empty lists / not-yet-available screens. */
export function EmptyState({ title, message, icon, illustration, action }: EmptyStateProps) {
  return (
    <View style={styles.container}>
      {illustration ? (
        <Illustration name={illustration} size={150} float style={styles.icon} />
      ) : icon ? (
        <View style={styles.icon}>{icon}</View>
      ) : null}
      <Text variant="h3" style={styles.title}>
        {title}
      </Text>
      {message ? (
        <Text variant="body" color="muted" style={styles.message}>
          {message}
        </Text>
      ) : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  icon: {
    marginBottom: spacing.lg,
  },
  title: {
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  message: {
    textAlign: "center",
  },
  action: {
    marginTop: spacing.xl,
    width: "100%",
  },
});
