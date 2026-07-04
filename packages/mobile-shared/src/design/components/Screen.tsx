import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableWithoutFeedback,
  View,
  type ViewProps,
} from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { colors, spacing } from "../tokens";

export interface ScreenProps extends ViewProps {
  /** Wraps content in a ScrollView (for forms / longer content). Defaults to false. */
  scroll?: boolean;
  edges?: readonly Edge[];
  /** Disables the KeyboardAvoidingView + tap-to-dismiss wrapper (for screens with their own custom layout, e.g. full-bleed maps). */
  noKeyboardHandling?: boolean;
  /** Removes the default horizontal/top padding (for full-bleed hero layouts). */
  noPadding?: boolean;
}

/** Safe-area + consistent horizontal padding wrapper — the root of every screen. Handles keyboard avoidance and tap-outside-to-dismiss by default. */
export function Screen({
  scroll = false,
  edges = ["top", "bottom"],
  noKeyboardHandling = false,
  noPadding = false,
  style,
  children,
  ...rest
}: ScreenProps) {
  const content = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.grow, !noPadding && styles.content, style]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      {...rest}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, !noPadding && styles.content, style]} {...rest}>
      {children}
    </View>
  );

  const body = noKeyboardHandling ? (
    content
  ) : (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        {content}
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );

  return (
    <SafeAreaView style={styles.flex} edges={edges}>
      {body}
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
  grow: {
    flexGrow: 1,
  },
});
