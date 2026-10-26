import { useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BottomSheet } from "../design/components/BottomSheet";

/**
 * A modal BottomSheet must open however it is shown — including mounted
 * already visible, as the trip-complete sheet is. gorhom's own sheet can't run
 * here, so a stand-in keeps the one rule that matters (read from
 * @gorhom/bottom-sheet 5.x): a sheet opens at its mount `index` once its
 * layout is measured, but snapToIndex and close called before then do nothing.
 * In these tests the layout is never measured, as on the first frames on a
 * phone. Also: the screen's contentStyle must survive gorhom's style merging.
 */

type MockSheetProps = {
  index?: number;
  children?: import("react").ReactNode;
  onChange?: (index: number, position: number) => void;
  onClose?: () => void;
};

type MockStyle = import("react-native").StyleProp<import("react-native").ViewStyle>;

const mockCalls: string[] = [];
/** The latest props the sheet got, to end its close animation by hand. */
const mockSheet: { onClose?: () => void } = {};

jest.mock("@gorhom/bottom-sheet", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  const Sheet = React.forwardRef(function Sheet(props: MockSheetProps, ref) {
    // The mount path: open at the mount index (no measuring needed here).
    const [open] = React.useState((props.index ?? 0) >= 0);
    const { onChange } = props;
    mockSheet.onClose = props.onClose;
    React.useEffect(() => {
      if (open) onChange?.(0, 0);
    }, [open, onChange]);
    React.useImperativeHandle(ref, () => ({
      // Before layout: recorded, but nothing moves.
      snapToIndex: (i: number) => mockCalls.push(`snapToIndex(${i})`),
      close: () => mockCalls.push("close"),
    }));
    return React.createElement(
      View,
      { testID: "sheet", accessibilityState: { expanded: open } },
      props.children,
    );
  });
  const Pass = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  // As gorhom does: an array style goes through StyleSheet.compose, which
  // keeps only the first two entries.
  const { StyleSheet } = jest.requireActual<typeof import("react-native")>("react-native");
  const Content = ({ style, children }: { style?: unknown; children?: React.ReactNode }) =>
    React.createElement(
      View,
      {
        testID: "content",
        style: (Array.isArray(style)
          ? (StyleSheet.compose as (...s: unknown[]) => unknown)(...style)
          : style) as MockStyle,
      },
      children,
    );
  return {
    __esModule: true,
    default: Sheet,
    BottomSheetBackdrop: Pass,
    BottomSheetFooter: Pass,
    BottomSheetScrollView: Pass,
    BottomSheetView: Content,
    BottomSheetTextInput: View,
  };
});

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function inApp(node: React.ReactNode) {
  return <SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>;
}

const isOpen = () => screen.getByTestId("sheet").props.accessibilityState.expanded as boolean;

beforeEach(() => {
  mockCalls.length = 0;
});

describe("BottomSheet (modal)", () => {
  it("opens when it mounts already visible (the trip-complete sheet)", async () => {
    await render(
      inApp(
        <BottomSheet modal visible dismissible={false}>
          <Text>You&apos;ve arrived</Text>
        </BottomSheet>,
      ),
    );
    expect(isOpen()).toBe(true);
    expect(screen.getByText("You've arrived")).toBeTruthy();
  });

  it("renders nothing while closed, and opens when shown later", async () => {
    function Screen() {
      const [visible, setVisible] = useState(false);
      return (
        <>
          <Pressable onPress={() => setVisible(true)}>
            <Text>Safety</Text>
          </Pressable>
          <BottomSheet modal visible={visible} onDismiss={() => setVisible(false)}>
            <Text>Share trip</Text>
          </BottomSheet>
        </>
      );
    }
    await render(inApp(<Screen />));
    expect(screen.queryByTestId("sheet")).toBeNull();

    await fireEvent.press(screen.getByText("Safety"));
    expect(isOpen()).toBe(true);
    expect(screen.getByText("Share trip")).toBeTruthy();
  });

  it("animates closed when hidden, then unmounts and tells the screen", async () => {
    const onDismiss = jest.fn();
    const sheet = (visible: boolean) =>
      inApp(
        <BottomSheet modal visible={visible} onDismiss={onDismiss}>
          <Text>Stops</Text>
        </BottomSheet>,
      );
    const { rerender } = await render(sheet(true));
    await rerender(sheet(false));
    expect(mockCalls).toContain("close");
    expect(screen.getByTestId("sheet")).toBeTruthy();

    // gorhom calls onClose when the close animation ends.
    await act(async () => mockSheet.onClose?.());
    expect(screen.queryByTestId("sheet")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the screen's contentStyle (the gap between rows)", async () => {
    await render(
      inApp(
        <BottomSheet contentStyle={{ gap: 16 }}>
          <Text>Where to?</Text>
        </BottomSheet>,
      ),
    );
    expect(StyleSheet.flatten(screen.getByTestId("content").props.style)).toMatchObject({
      gap: 16,
    });
  });
});
