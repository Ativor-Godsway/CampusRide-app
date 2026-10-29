import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AppState,
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
  const { height, width } = useWindowDimensions();
  const [footerHeight, setFooterHeight] = useState(0);
  const bottomPad = Math.max(insets.bottom, spacing[5]);

  // A modal sheet is mounted only while it is open or closing, and always
  // mounts at index 0: gorhom opens a sheet at its mount index once its layout
  // is measured, whereas snapToIndex (and close) called before then do nothing.
  // A sheet that mounted closed and was opened with snapToIndex too early —
  // or one that mounted already visible, like the trip-complete sheet — stayed
  // shut, with nothing on screen to open it.
  const [mounted, setMounted] = useState(visible);
  if (modal && visible && !mounted) setMounted(true);
  /** Whether the sheet has reached its open position since it mounted. */
  const opened = useRef(false);

  useEffect(() => {
    if (!modal || !mounted) return;
    // Reopened while still closing: the layout is measured by now.
    if (visible) ref.current?.snapToIndex(0);
    // Closed before it finished opening, when close() would do nothing.
    else if (!opened.current) setMounted(false);
    else ref.current?.close();
  }, [modal, mounted, visible]);

  // A map sheet (not modal) is never meant to close. On Android it was seen
  // gone after login (the location prompt pauses the app, a 3-button nav bar
  // changes the insets, a slow phone stalls the UI thread while Google Maps
  // loads), leaving only the map. So it goes back to its place when the app
  // returns to the foreground, when the window changes size, and if it ever
  // reports itself closed. snapToIndex before the layout is measured does
  // nothing, which is harmless here.
  // Back where it last settled (a sheet the rider pulled up stays up).
  const settledAt = useRef(index);
  const restore = useCallback(() => {
    if (!modal) requestAnimationFrame(() => ref.current?.snapToIndex(settledAt.current));
  }, [modal]);

  useEffect(() => {
    if (modal) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") restore();
    });
    return () => sub.remove();
  }, [modal, restore]);

  const firstSize = useRef(true);
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false;
      return;
    }
    restore();
  }, [height, width, restore]);

  const handleChange = useCallback(
    (at: number, position: number) => {
      if (at >= 0) {
        opened.current = true;
        settledAt.current = at;
      } else restore();
      onChange?.(at, position);
    },
    [onChange, restore],
  );

  const handleClose = useCallback(() => {
    opened.current = false;
    setMounted(false);
    onDismiss?.();
  }, [onDismiss]);

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

  // One flat style: gorhom merges a style array with StyleSheet.compose, which
  // takes two styles and drops the rest — contentStyle (the third) was lost.
  const padding = StyleSheet.flatten([
    styles.content,
    { paddingBottom: footer ? footerHeight + spacing[3] : bottomPad },
    contentStyle,
  ]);

  if (modal && !mounted) return null;

  return (
    <GorhomSheet
      ref={ref}
      index={modal ? 0 : index}
      snapPoints={snapPoints}
      enableDynamicSizing={!snapPoints}
      maxDynamicContentSize={height * maxHeightRatio}
      enablePanDownToClose={modal && dismissible}
      onClose={modal ? handleClose : undefined}
      onChange={handleChange}
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
