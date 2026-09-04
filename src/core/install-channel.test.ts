import { describe, expect, test } from "bun:test";
import { installChannel, upgradeHint } from "./install-channel.ts";

/**
 * The environment is injected, so nothing here reads or mutates the real
 * `process.env` of whoever runs the suite.
 */

describe("installChannel", () => {
  test("brew unless the npm launcher said otherwise", () => {
    expect(installChannel({})).toBe("brew");
    expect(installChannel({ GROVE_INSTALL_CHANNEL: "npm" })).toBe("npm");
  });

  test("an unknown channel is brew, not a crash", () => {
    expect(installChannel({ GROVE_INSTALL_CHANNEL: "cargo" })).toBe("brew");
    expect(installChannel({ GROVE_INSTALL_CHANNEL: "" })).toBe("brew");
  });
});

describe("upgradeHint", () => {
  test("names the command for the channel", () => {
    expect(upgradeHint("brew")).toBe("upgrade: brew upgrade grove");
    expect(upgradeHint("npm")).toBe("upgrade: npm install -g @enginerd-kr/grove@latest");
  });
});
