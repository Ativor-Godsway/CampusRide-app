/**
 * @gorhom/bottom-sheet as a still panel at the bottom: open at its starting
 * snap point (or sized to its content), with the handle. No dragging.
 */
import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import { ScrollView, TextInput, View, type StyleProp, type ViewStyle } from "react-native";

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
  onChange?: (index: number) => void;
  backdropComponent?: unknown;
  children?: ReactNode;
  [key: string]: unknown;
}

function height(point: string | number | undefined): number | undefined {
  if (point === undefined) return undefined;
  if (typeof point === "number") return point;
  return point.endsWith("%") ? (parseFloat(point) / 100) * SCREEN_HEIGHT : parseFloat(point);
}

const BottomSheet = forwardRef(function BottomSheet(props: SheetProps, ref) {
  const {
    index = 0,
    snapPoints,
    enableDynamicSizing,
    maxDynamicContentSize,
    backgroundStyle,
    handleIndicatorStyle,
    style,
    onChange,
    children,
  } = props;
  useImperativeHandle(ref, () => ({
    snapToIndex: noop,
    snapToPosition: noop,
    expand: noop,
    collapse: noop,
    close: noop,
    forceClose: noop,
  }));
  // The real sheet reports where it opened.
  useEffect(() => {
    onChange?.(index);
  }, [index, onChange]);
  if (index < 0) return null;
  const fixed =
    snapPoints && !enableDynamicSizing
      ? height(snapPoints[Math.min(index, snapPoints.length - 1)])
      : undefined;
  return (
    <View
      style={[
        {
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
        fixed !== undefined ? { height: fixed } : { maxHeight: maxDynamicContentSize },
        backgroundStyle,
        style,
      ]}
    >
      <View style={{ alignItems: "center", paddingVertical: 10 }}>
        <View
          style={[
            { width: 36, height: 5, borderRadius: 3, backgroundColor: "#E5E9E7" },
            handleIndicatorStyle,
          ]}
        />
      </View>
      <View style={{ flexShrink: 1, flexGrow: fixed !== undefined ? 1 : 0 }}>{children}</View>
    </View>
  );
});

export default BottomSheet;
export const BottomSheetView = View;
export const BottomSheetScrollView = ScrollView;
export const BottomSheetFlatList = ScrollView;
export const BottomSheetTextInput = TextInput;
export const BottomSheetBackdrop = () => null;
export const BottomSheetModal = BottomSheet;
export const BottomSheetModalProvider = ({ children }: { children?: ReactNode }) => <>{children}</>;
export const BottomSheetFooter = View;
export const useBottomSheet = () => ({
  snapToIndex: noop,
  close: noop,
  expand: noop,
  collapse: noop,
});
export type BottomSheetBackdropProps = Record<string, unknown>;
