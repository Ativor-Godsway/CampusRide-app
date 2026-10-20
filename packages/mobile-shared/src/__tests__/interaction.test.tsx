import { useState } from "react";
import { Text as RNText } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { wrongCodeMessage } from "../auth/errorMessage";
import { OtpInput } from "../design/components/OtpInput";
import { SlideToConfirm } from "../design/components/SlideToConfirm";

/**
 * The interaction components (docs/design-system.md): the code boxes'
 * paste, auto-submit and wrong-code reset, and the slider's screen-reader
 * path. Dragging itself is native (gesture-handler) and its decisions are
 * tested in @rida/shared (driver/slideToConfirm).
 */

jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

beforeEach(() => jest.clearAllMocks());

const FIELD = "Verification code, 6 digits";

function Code({
  onComplete,
  error = null,
}: {
  onComplete?: (c: string) => void;
  error?: string | null;
}) {
  const [value, setValue] = useState("");
  return (
    <>
      <OtpInput
        value={value}
        onChange={setValue}
        onComplete={onComplete}
        error={error}
        autoFocus={false}
      />
      <RNText testID="value">{value}</RNText>
    </>
  );
}

describe("OtpInput", () => {
  it("fills every box from a pasted or autofilled code and checks it at once", async () => {
    const onComplete = jest.fn();
    await render(<Code onComplete={onComplete} />);
    await fireEvent.changeText(screen.getByLabelText(FIELD), "Your code: 416 641");
    expect(screen.getByTestId("value")).toHaveTextContent("416641");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("416641");
    for (const d of ["4", "1", "6"]) expect(screen.getAllByText(d).length).toBeGreaterThan(0);
  });

  it("waits for the 6th digit, and keeps digits only", async () => {
    const onComplete = jest.fn();
    await render(<Code onComplete={onComplete} />);
    await fireEvent.changeText(screen.getByLabelText(FIELD), "41a6");
    expect(screen.getByTestId("value")).toHaveTextContent("416");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("a wrong code: warning haptic, the message, then cleared for another try", async () => {
    jest.useFakeTimers();
    function Wrong() {
      const [value, setValue] = useState("416641");
      return (
        <>
          <OtpInput
            value={value}
            onChange={setValue}
            error="That code didn't match."
            autoFocus={false}
          />
          <RNText testID="value">{value}</RNText>
        </>
      );
    }
    await render(<Wrong />);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith("warning");
    expect(screen.getByText("That code didn't match.")).toBeOnTheScreen();
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(screen.getByTestId("value")).toHaveTextContent("");
    jest.useRealTimers();
  });
});

describe("SlideToConfirm", () => {
  it("completes from the screen reader's activate action, with a medium haptic and the done label", async () => {
    const onConfirm = jest.fn();
    await render(
      <SlideToConfirm label="Kwame picked up" doneLabel="Picked up" onConfirm={onConfirm} />,
    );
    const slider = screen.getByRole("button", { name: "Kwame picked up" });
    await fireEvent(slider, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith("medium");
    expect(screen.getByText("Picked up")).toBeOnTheScreen();
    // Done once: a second activate does nothing.
    await fireEvent(screen.getByRole("button", { name: "Picked up" }), "accessibilityAction", {
      nativeEvent: { actionName: "activate" },
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("wrongCodeMessage", () => {
  const refused = (error: string, status = 400) => ({ response: { status, data: { error } } });

  it("says plainly what was wrong with the code", () => {
    expect(wrongCodeMessage(refused("Invalid or missing OTP for +233…"))).toBe(
      "That code didn't match. Check the SMS and try again.",
    );
    expect(wrongCodeMessage(refused("OTP for +233… has expired"))).toMatch(/expired/);
    expect(wrongCodeMessage(refused("Too many incorrect attempts for +233…"))).toMatch(
      /Too many tries/,
    );
  });

  it("leaves other failures alone, so the typed code isn't cleared", () => {
    expect(wrongCodeMessage(new Error("Network Error"))).toBeNull();
    expect(wrongCodeMessage(refused("Server error", 500))).toBeNull();
  });
});
