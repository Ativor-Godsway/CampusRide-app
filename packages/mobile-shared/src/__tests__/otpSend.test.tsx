import { act, fireEvent, screen } from "expo-router/testing-library";
import * as SecureStore from "expo-secure-store";
import { installFakeServer, type FakeServer } from "./fakeServer";
import { freshLaunch, pathname, renderApp } from "./routes";

/**
 * "Send code" on a slow or sleeping server. The request can time out on the
 * phone after the server has already texted the code; a second press then
 * meets the one-code-a-minute cooldown. Neither is a failure the person
 * caused, and neither may read like a limit reached: both go to the code
 * screen, where the code they got can be entered.
 */

let server: FakeServer;

beforeEach(async () => {
  jest.useFakeTimers();
  (SecureStore as unknown as { __store: Map<string, string> }).__store.clear();
  await freshLaunch();
  server = installFakeServer("RIDER");
  server.otpCooldownSeconds = 60;
});

afterEach(() => jest.useRealTimers());

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

async function pressSendCode() {
  await renderApp("rider");
  await fireEvent.press(await screen.findByText("Continue with phone number"));
  await fireEvent.changeText(await screen.findByLabelText("Phone number"), "0241234567");
  await fireEvent.press(screen.getByText("Send code"));
}

describe("Send code without an answer", () => {
  it("a timeout goes to the code screen: 'If you got a code, enter it here', with the resend countdown", async () => {
    server.loseResponses = { path: "POST /auth/request-otp", count: 1 };
    await pressSendCode();
    expect(await screen.findByText("If you got a code, enter it here.")).toBeTruthy();
    expect(pathname()).toBe("/auth/otp");
    expect(screen.getByText(/^Resend in 1:00$/)).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(screen.queryByText(/Too many attempts/)).toBeNull();
  });

  it("the code that did arrive signs them in from there", async () => {
    server.loseResponses = { path: "POST /auth/request-otp", count: 1 };
    await pressSendCode();
    await fireEvent.changeText(await screen.findByLabelText("Verification code, 6 digits"), "123456");
    await screen.findByText("Home screen");
  });

  it("no answer at all (offline): the code screen too, never 'Something went wrong'", async () => {
    server.outage = "network";
    await pressSendCode();
    expect(await screen.findByText("If you got a code, enter it here.")).toBeTruthy();
  });
});

describe("pressing Send code again within the minute", () => {
  it("goes to the code screen counting down the server's wait, not 'limit reached'", async () => {
    // The first press timed out on the phone, but the code went out.
    server.loseResponses = { path: "POST /auth/request-otp", count: 1 };
    await renderApp("rider");
    await fireEvent.press(await screen.findByText("Continue with phone number"));
    await fireEvent.changeText(await screen.findByLabelText("Phone number"), "0241234567");
    await fireEvent.press(screen.getByText("Send code"));
    await screen.findByText("If you got a code, enter it here.");
    // Back, and Send code again 15 seconds later.
    await fireEvent.press(screen.getByLabelText("Change the number"));
    await wait(15_000);
    await fireEvent.press(await screen.findByText("Send code"));

    expect(await screen.findByText("We sent you a code a moment ago. If you got it, enter it here.")).toBeTruthy();
    expect(screen.getByText(/^Resend in 0:4[45]$/)).toBeTruthy();
    expect(screen.queryByText(/Too many attempts/)).toBeNull();
  });

  it("Resend that times out: the countdown starts again, no error", async () => {
    server.loseResponses = { path: "POST /auth/request-otp", count: 2 };
    await pressSendCode();
    await screen.findByText("If you got a code, enter it here.");
    // The countdown ends; Resend times out on the phone but the code goes out.
    await wait(61_000);
    await fireEvent.press(screen.getByText("Resend code"));
    expect(await screen.findByText(/^Resend in 1:00$/)).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });

  it("Resend that meets the cooldown says how long to wait, as a countdown", async () => {
    // A server whose wait is longer than the app's countdown.
    server.otpCooldownSeconds = 90;
    await pressSendCode();
    await screen.findByText(/^Resend in/);
    await wait(61_000);
    await fireEvent.press(screen.getByText("Resend code"));
    expect(await screen.findByText(/^Wait 0:(29|30) before asking for a new code\.$/)).toBeTruthy();
    expect(screen.getByText(/^Resend in 0:(29|30)$/)).toBeTruthy();
    expect(screen.queryByText(/Too many attempts/)).toBeNull();
  });
});
