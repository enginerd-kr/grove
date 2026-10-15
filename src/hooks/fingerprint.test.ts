import { describe, expect, test } from "bun:test";
import { fingerprintOf } from "./fingerprint.ts";

describe("fingerprintOf", () => {
  test("is stable for the same text", () => {
    const text = '[setup]\nrun = ["bun install"]\n';

    expect(fingerprintOf(text)).toBe(fingerprintOf(text));
    expect(fingerprintOf(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes for any edit at all, comments and whitespace included", () => {
    const text = '[setup]\nrun = ["bun install"]\n';

    expect(fingerprintOf(text)).not.toBe(fingerprintOf(`${text}# a comment\n`));
    expect(fingerprintOf(text)).not.toBe(fingerprintOf(`${text}\n`));
    expect(fingerprintOf(text)).not.toBe(
      fingerprintOf('[setup]\nrun = ["bun install --frozen-lockfile"]\n'),
    );
  });
});
