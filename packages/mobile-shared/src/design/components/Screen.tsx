import { ScrollView, StyleSheet, View, type ViewProps } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { colors, spacing } from "../tokens";

export interface ScreenProps extends ViewProps {
  /** Wraps content in a ScrollView (for forms / longer content). Defaults to false. */
  scroll?: boolean;
  edges?: readonly Edge[];
}

/** Safe-area + consistent horizontal padding wrapper — the root of every screen. */
export function Screen({ scroll = false, edges = ["top", "bottom"], style, children, ...rest }: ScreenProps) {
  if (scroll) {
    return (
      <SafeAreaView style={styles.flex} edges={edges}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.content, style]}
          keyboardShouldPersistTaps="handled"
          {...rest}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex} edges={edges}>
      <View style={[styles.flex, styles.content, style]} {...rest}>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
});
