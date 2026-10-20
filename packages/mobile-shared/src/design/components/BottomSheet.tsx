import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import GorhomSheet, {
  BottomSheetBackdrop,
  BottomSheetFooter,
  BottomSheetScrollView,
  BottomSheetView,
  type BottomSheetBackdropProps,
  type BottomSheetFooterProps,
} from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radii, shadows, spacing } from "../tokens";

/** Inputs inside a sheet must be this one, so the sheet rises above the keyboard. */
export { BottomSheetTextInput } from "@gorhom/bottom-sheet";

/** The scrim token (ink at 45%) as gorhom's backdrop takes it: a colour and an opacity. */
const SCRIM_OPACITY = 0.45;

export interface BottomSheetProps {
  children: ReactNode;
  /** e.g. ["35%", "70%"]. Leave out to size the sheet to its content. */
  snapPoints?: (string | number)[];
  /** The snap point a map sheet opens at. */
  index?: number;
  /** Tallest a content-sized sheet may grow, as a share of the screen. */
  maxHeightRatio?: number;
  /**
   * A confirm sheet (cancel, SOS, rating, lists): dims the screen with the
   * scrim and opens and closes with `visible`. Never open one over another:
   * swap the content in place instead.
   */
  modal?: boolean;
  /** Modal only: open or closed. */
  visible?: boolean;
  /** Modal only: closed by a tap outside, a pull down, or a closing action. */
  onDismiss?: () => void;
  /** Modal only: false when the action is required (no tap outside, no pull down). */
  dismissible?: boolean;
  /** The one primary action, pinned to the bottom above the safe area. */
  footer?: ReactNode;
  /** Content scrolls inside the sheet (long lists). */
  scrollable?: boolean;
  /** Where the sheet settled: its snap index and top position on screen. */
  onChange?: (index: number, position: number) => void;
  contentStyle?: StyleProp<ViewStyle>;
  /** For VoiceOver / TalkBack, e.g. "Cancel this ride". */
  accessibilityLabel?: string;
}

/**
 * docs/design-system.md, "BottomSheet": the white sheet that holds every map
 * screen's content and every confirm step, on @gorhom/bottom-sheet. Top
 * corners radius-xl (28), shadow-sheet, a 36×5 handle, 20 side padding.
 *
 * Map sheets have no scrim and leave the map usable. Text fields inside use
 * BottomSheetTextInput: with keyboardBehavior "interactive" the sheet then
 * moves up with the keyboard instead of being covered by it.
 */
export function BottomSheet({
  children,
  snapPoints,
  index = 0,
  maxHeightRatio = 0.9,
  modal = false,
  visible = false,
  onDismiss,
  dismissible = true,
  footer,
  scrollable = false,
  onChange,
  contentStyle,
  accessibilityLabel,
}: BottomSheetProps) {
  const ref = useRef<GorhomSheet>(null);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [footerHeight, setFooterHeight] = useState(0);
  const bottomPad = Math.max(insets.bottom, spacing[5]);

  useEffect(() => {
    if (!modal) return;
    if (visible) ref.current?.snapToIndex(0);
    else ref.current?.close();
  }, [modal, visible]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={SCRIM_OPACITY}
        style={[props.style, { backgroundColor: colors.ink }]}
        pressBehavior={dismissible ? "close" : "none"}
      />
    ),
    [dismissible],
  );

  const renderFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props} bottomInset={0}>
        <View
          style={[styles.footer, { paddingBottom: bottomPad }]}
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        >
          {footer}
        </View>
      </BottomSheetFooter>
    ),
    [footer, bottomPad],
  );

  const padding = [
    styles.content,
    { paddingBottom: footer ? footerHeight + spacing[3] : bottomPad },
    contentStyle,
  ];

  return (
    <GorhomSheet
      ref={ref}
      index={modal ? -1 : index}
      snapPoints={snapPoints}
      enableDynamicSizing={!snapPoints}
      maxDynamicContentSize={height * maxHeightRatio}
      enablePanDownToClose={modal && dismissible}
      onClose={modal ? onDismiss : undefined}
      onChange={onChange}
      backdropComponent={modal ? renderBackdrop : undefined}
      footerComponent={footer ? renderFooter : undefined}
      backgroundStyle={styles.background}
      handleIndicatorStyle={styles.handle}
      style={styles.shadow}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      accessibilityLabel={accessibilityLabel}
    >
      {scrollable ? (
        <BottomSheetScrollView contentContainerStyle={padding} accessibilityViewIsModal={modal}>
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={padding} accessibilityViewIsModal={modal}>
          {children}
        </BottomSheetView>
      )}
    </GorhomSheet>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
  },
  shadow: {
    ...shadows.sheet,
  },
  handle: {
    width: 36,
    height: 5,
    borderRadius: radii.full,
    backgroundColor: colors.surface3,
  },
  content: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[1],
  },
  footer: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing[3],
    backgroundColor: colors.surface,
  },
});
