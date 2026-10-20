import { useState } from "react";
import { Pressable, StyleSheet, Text as RNText } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Button } from "../design/components/Button";
import { Chip } from "../design/components/Chip";
import { PhoneInput } from "../design/components/PhoneInput";
import { Text, resolveFigtree } from "../design/components/Text";
import { TOAST_MS, useToast } from "../design/components/Toast";
import { fonts } from "../design/fonts";

/**
 * The design-system components' behaviour (docs/design-system.md): Figtree
 * by family not fontWeight, the phone field's formatting and paste, haptics
 * only where the spec asks, and the toast's 3 seconds.
 */

jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

const styleOf = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

describe("Text", () => {
  it("renders each weight as its own Figtree family, never a fontWeight", async () => {
    await render(
      <>
        <Text variant="title1">Title</Text>
        <Text variant="body" style={{ fontWeight: "700" }}>
          Bold override
        </Text>
        <Text variant="h2">Old heading</Text>
      </>,
    );
    expect(styleOf(screen.getByText("Title"))).toMatchObject({
      fontFamily: fonts.extrabold,
      fontSize: 28,
    });
    const bold = styleOf(screen.getByText("Bold override"));
    expect(bold.fontFamily).toBe(fonts.bold);
    expect(bold.fontWeight).toBeUndefined();
    expect(styleOf(screen.getByText("Old heading"))).toMatchObject({
      fontFamily: fonts.bold,
      fontSize: 22,
    });
  });

  it("leaves a non-Figtree family (system monospace) as it is", () => {
    expect(resolveFigtree({ fontFamily: "Menlo", fontWeight: "700" })).toEqual({
      fontFamily: "Menlo",
      fontWeight: "700",
    });
  });

  it("caps Dynamic Type at 1.3x on display sizes only, and sets tabular digits on request", async () => {
    await render(
      <>
        <Text variant="display" tabular>
          GH₵15
        </Text>
        <Text variant="body">Body</Text>
      </>,
    );
    const display = screen.getByText("GH₵15");
    expect(display.props.maxFontSizeMultiplier).toBe(1.3);
    expect(styleOf(display).fontVariant).toEqual(["tabular-nums"]);
    expect(screen.getByText("Body").props.maxFontSizeMultiplier).toBeUndefined();
  });
});

function PhoneField() {
  const [digits, setDigits] = useState("");
  return (
    <>
      <PhoneInput digits={digits} onChangeDigits={setDigits} />
      <RNText testID="digits">{digits}</RNText>
    </>
  );
}

describe("PhoneInput", () => {
  it("shows typed digits as 54 860 8146", async () => {
    await render(<PhoneField />);
    await fireEvent.changeText(screen.getByLabelText("Phone number"), "548608146");
    expect(screen.getByLabelText("Phone number").props.value).toBe("54 860 8146");
    expect(screen.getByTestId("digits")).toHaveTextContent("548608146");
  });

  it.each(["0548608146", "+233 54 860 8146", "054 860 8146"])(
    "reads a pasted %j",
    async (pasted) => {
      await render(<PhoneField />);
      await fireEvent.changeText(screen.getByLabelText("Phone number"), pasted);
      expect(screen.getByTestId("digits")).toHaveTextContent("548608146");
    },
  );
});

describe("Button", () => {
  beforeEach(() => jest.clearAllMocks());

  it("gives a light tap on primary only", async () => {
    const onPress = jest.fn();
    await render(
      <>
        <Button label="Request Shared" onPress={onPress} />
        <Button label="Edit profile" variant="neutral" onPress={onPress} />
      </>,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Edit profile" }));
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole("button", { name: "Request Shared" }));
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("does nothing when disabled, and says so to screen readers", async () => {
    const onPress = jest.fn();
    await render(<Button label="Continue" disabled onPress={onPress} />);
    const button = screen.getByRole("button", { name: "Continue" });
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
  });

  it("still accepts the old variant names", async () => {
    await render(
      <>
        <Button label="Skip" variant="ghost" />
        <Button label="Cancel it" variant="dangerSecondary" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Skip" })).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Cancel it" })).toBeOnTheScreen();
  });
});

describe("Chip", () => {
  it("is a checkbox with its selected state, and taps give a selection haptic", async () => {
    jest.clearAllMocks();
    const onPress = jest.fn();
    await render(<Chip label="Shared" selected onPress={onPress} />);
    const chip = screen.getByRole("checkbox", { name: "Shared" });
    expect(chip).toBeChecked();
    await fireEvent.press(chip);
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

function ToastHost() {
  const { showToast, toast } = useToast();
  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => showToast("Kwame is in the car")}>
        <RNText>Show</RNText>
      </Pressable>
      {toast}
    </>
  );
}

// expo-router puts a SafeAreaProvider at the root of the app; the toast sits under the status bar.
const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function ToastScreen() {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ToastHost />
    </SafeAreaProvider>
  );
}

describe("Toast", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("shows for 3 seconds, and a new one replaces the old", async () => {
    await render(<ToastScreen />);
    await fireEvent.press(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByText("Kwame is in the car")).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(TOAST_MS - 100);
    });
    await fireEvent.press(screen.getByRole("button", { name: "Show" }));
    expect(screen.getAllByText("Kwame is in the car")).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(TOAST_MS + 500);
    });
    expect(screen.queryByText("Kwame is in the car")).toBeNull();
  });
});
