/**
 * @gorhom/bottom-sheet as a still panel at the bottom: open at its starting
 * snap point (or sized to its content), with the handle, the scrim behind a
 * modal sheet and the pinned footer. Opens and closes like the real one
 * (index, snapToIndex, close), but can't be dragged.
 */
import { forwardRef, useEffect, useImperativeHandle, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

const SCREEN_HEIGHT = 844;
const noop = () => undefined;

interface SheetProps {
  index?: number;
  snapPoints?: (string | number)[];
  enableDynamicSizing?: boolean;
  maxDynamicContentSize?: number;
  backgroundStyle?: StyleProp<ViewStyle>;
  handleIndicatorStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  onChange?: (index: number, position: number) => void;
  onClose?: () => void;
  backdropComponent?: (props: BackdropProps) => ReactNode;
  footerComponent?: (props: Record<string, unknown>) => ReactNode;
  children?: ReactNode;
  [key: string]: unknown;
}

interface BackdropProps {
  style?: StyleProp<ViewStyle>;
  /** The stub's own: what a tap on the scrim does. */
  close?: () => void;
  [key: string]: unknown;
}

function height(point: string | number | undefined): number | undefined {
  if (point === undefined) return undefined;
  if (typeof point === "number") return point;
  return point.endsWith("%") ? (parseFloat(point) / 100) * SCREEN_HEIGHT : parseFloat(point);
}

const BottomSheet = forwardRef(function BottomSheet(props: SheetProps, ref) {
  const {
    index: initial = 0,
    snapPoints,
    enableDynamicSizing,
    maxDynamicContentSize,
    backgroundStyle,
    handleIndicatorStyle,
    style,
    onChange,
    onClose,
    backdropComponent,
    footerComponent,
    children,
  } = props;
  const [index, setIndex] = useState(initial);
  const close = () => {
    setIndex(-1);
    onClose?.();
  };
  useImperativeHandle(ref, () => ({
    snapToIndex: (i: number) => setIndex(i),
    snapToPosition: noop,
    expand: () => setIndex(0),
    collapse: () => setIndex(0),
    close,
    forceClose: close,
  }));

  const fixed =
    snapPoints && !enableDynamicSizing
      ? height(snapPoints[Math.min(Math.max(index, 0), snapPoints.length - 1)])
      : undefined;

  // The real sheet reports where it settled: its index and its top on screen.
  useEffect(() => {
    if (index >= 0) onChange?.(index, SCREEN_HEIGHT - (fixed ?? SCREEN_HEIGHT * 0.45));
  }, [index, fixed, onChange]);

  if (index < 0) return null;
  return (
    <>
      {backdropComponent?.({ style: StyleSheet.absoluteFill, close })}
      <View
        style={[
          styles.sheet,
          fixed !== undefined ? { height: fixed } : { maxHeight: maxDynamicContentSize },
          backgroundStyle,
          style,
        ]}
      >
        <View style={styles.handleRow}>
          <View style={[styles.handle, handleIndicatorStyle]} />
        </View>
        <View style={{ flexShrink: 1, flexGrow: fixed !== undefined ? 1 : 0 }}>{children}</View>
        {footerComponent?.({})}
      </View>
    </>
  );
});

export default BottomSheet;
export const BottomSheetView = View;
export const BottomSheetScrollView = ScrollView;
export const BottomSheetFlatList = ScrollView;
export const BottomSheetTextInput = TextInput;
/** The scrim: the backdrop's own colour at its opacity. */
export function BottomSheetBackdrop({
  style,
  opacity = 0.5,
  close,
  pressBehavior,
}: BackdropProps & { opacity?: number; pressBehavior?: string }) {
  return (
    <Pressable
      onPress={pressBehavior === "close" ? close : undefined}
      style={[{ backgroundColor: "#000" }, style, { opacity }]}
    />
  );
}
export const BottomSheetModal = BottomSheet;
export const BottomSheetModalProvider = ({ children }: { children?: ReactNode }) => <>{children}</>;
/** Pinned over the bottom of the sheet, as the real one is (the content leaves room for it). */
export const BottomSheetFooter = ({ children }: { children?: ReactNode }) => (
  <View style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>{children}</View>
);
export const useBottomSheet = () => ({
  snapToIndex: noop,
  close: noop,
  expand: noop,
  collapse: noop,
});
export type BottomSheetBackdropProps = BackdropProps;
export type BottomSheetFooterProps = Record<string, unknown>;

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: "#0F1311",
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -6 },
  },
  handleRow: { alignItems: "center", paddingVertical: 10 },
  handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: "#E5E9E7" },
});
