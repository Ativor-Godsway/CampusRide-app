import { describe, expect, it, vi } from "vitest";
import { loginPhone } from "./loginPhone";

const staging = () => Promise.resolve(true);
const production = () => Promise.resolve(false);

describe("loginPhone", () => {
  it("takes every number the shared parser takes, without asking the server", async () => {
    const ask = vi.fn(production);
    expect(await loginPhone("054 861 7924", ask)).toBe("+233548617924");
    expect(await loginPhone("+233 99 000 0021", ask)).toBe("+233990000021");
    expect(await loginPhone("099 000 0021", ask)).toBe("+233990000021");
    expect(ask).not.toHaveBeenCalled();
  });

  it("takes a bare staging test number only when the server is staging", async () => {
    expect(await loginPhone("99 000 0021", staging)).toBe("+233990000021");
    expect(await loginPhone("990000021", staging)).toBe("+233990000021");
    expect(await loginPhone("99 000 0021", production)).toBeNull();
  });

  it("refuses everything else, even on staging, without asking the server", async () => {
    const ask = vi.fn(staging);
    for (const bad of ["54 861 7924", "548617924", "99 000 002", "99 000 00211", "abc", ""]) {
      expect(await loginPhone(bad, ask)).toBeNull();
    }
    expect(ask).not.toHaveBeenCalled();
  });
});
