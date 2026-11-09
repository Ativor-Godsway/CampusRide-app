import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { DEFAULT_SUPPORT_PHONE } from "@rida/shared";
import { rawApi } from "../auth/apiClient";
import { CallSupportRow, fetchSupportPhone, resetSupportPhoneForTests } from "../contact";

/**
 * Account › "Call support": the number comes from GET /app/config and the
 * row opens the dialler with it — the built-in number when the server
 * can't be reached.
 */

type Answer = { supportPhone: unknown } | "network" | "server-error";
let answer: Answer;
const paths: string[] = [];
const originalAdapter = rawApi.defaults.adapter;

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  paths.push(config.url ?? "");
  if (answer === "network") throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", config });
  if (answer === "server-error") {
    throw Object.assign(new Error("Request failed with status code 503"), {
      config,
      response: { status: 503, data: {}, headers: {}, config, statusText: "" },
    });
  }
  return { data: answer, status: 200, statusText: "OK", headers: {}, config } as AxiosResponse;
};

let opened: string[];

beforeEach(() => {
  resetSupportPhoneForTests();
  paths.length = 0;
  rawApi.defaults.adapter = adapter;
  opened = [];
  jest.spyOn(Linking, "openURL").mockImplementation(async (url: string) => {
    opened.push(url);
    return true;
  });
});

afterEach(() => {
  rawApi.defaults.adapter = originalAdapter;
  jest.restoreAllMocks();
});

async function tapCallSupport() {
  const view = await render(<CallSupportRow />);
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  await act(async () => {
    fireEvent.press(screen.getByText("Call support"));
  });
  return view;
}

describe("Call support", () => {
  it("dials the number the server serves", async () => {
    answer = { supportPhone: "+233201234567" };
    await tapCallSupport();
    expect(paths).toContain("/app/config");
    expect(opened).toEqual(["tel:+233201234567"]);
  });

  it("dials the built-in number when the server can't be reached", async () => {
    for (const outage of ["network", "server-error"] as const) {
      resetSupportPhoneForTests();
      opened = [];
      answer = outage;
      const view = await tapCallSupport();
      expect(opened).toEqual([`tel:${DEFAULT_SUPPORT_PHONE}`]);
      await view.unmount();
    }
  });

  it("dials the built-in number when the server's answer isn't a Ghana number", async () => {
    answer = { supportPhone: "ring us" };
    await tapCallSupport();
    expect(opened).toEqual(["tel:+233548608146"]);
  });

  it("keeps the last number it heard if the server goes away later", async () => {
    answer = { supportPhone: "0201234567" };
    expect(await fetchSupportPhone()).toBe("+233201234567");
    answer = "network";
    expect(await fetchSupportPhone()).toBe("+233201234567");
  });
});
