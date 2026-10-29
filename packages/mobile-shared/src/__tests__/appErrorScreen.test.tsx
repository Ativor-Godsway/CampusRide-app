import { fireEvent, render, screen } from "@testing-library/react-native";
import * as SplashScreen from "expo-splash-screen";
import { AppErrorScreen } from "../errors/AppErrorScreen";

jest.mock("expo-splash-screen", () => ({
  hide: jest.fn(),
  preventAutoHideAsync: jest.fn(async () => true),
  setOptions: jest.fn(),
}));

/** A screen that threw shows a way on, never a blank (white or splash) screen. */
describe("AppErrorScreen", () => {
  it("says what happened in plain words and retries the screen", async () => {
    const retry = jest.fn(async () => undefined);
    await render(<AppErrorScreen error={new Error("boom")} retry={retry} where="driver-trip" />);

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByText(/boom/)).toBeNull();
    await fireEvent.press(screen.getByText("Try again"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("offers the second way out, e.g. Home from the trip screen", async () => {
    const goHome = jest.fn();
    await render(
      <AppErrorScreen
        error={new Error("boom")}
        retry={jest.fn()}
        where="driver-trip"
        secondary={{ label: "Go to Home", onPress: goHome }}
      />,
    );
    await fireEvent.press(screen.getByText("Go to Home"));
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it("takes the splash screen down once it's laid out", async () => {
    await render(<AppErrorScreen error={new Error("boom")} retry={jest.fn()} where="driver-root" />);
    await fireEvent(screen.getByTestId("app-error-screen"), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } },
    });
    expect(SplashScreen.hide).toHaveBeenCalled();
  });
});
