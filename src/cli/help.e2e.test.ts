import { describe, expect, test } from "bun:test";
import { findSubcommand, formatGlobalHelp, formatSubcommandHelp } from "./help.ts";
import { runCli } from "./test-cli.ts";

/**
 * `--help`, through the binary.
 *
 * Everything about the *text* — that the parser takes what the page offers,
 * that a section shows a command's own flags and nothing else, that no line
 * runs past a narrow terminal — is a property of two pure functions, and is
 * asserted directly in `help.test.ts` for the price of a function call.
 *
 * What cannot move in-process is the delivery: that `--help` is answered at
 * all rather than being taken for a missing argument, that the page reaches
 * *stdout* so `grove --help | less` works, that stderr stays empty so it is
 * not mistaken for a complaint, and that the run exits 0 so `grove --help` in
 * a script is not a failure. A function that returns a string can say none of
 * those things.
 */

describe("--help through the binary", () => {
  test("`grove --help` prints the global page on stdout and exits 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${formatGlobalHelp()}\n`);
    expect(result.stderr).toBe("");
  });

  test("`grove add --help` prints add's own page on stdout and exits 0", async () => {
    const spec = findSubcommand("add");
    const result = await runCli(["add", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(spec).toBeDefined();
    expect(result.stdout).toBe(`${spec ? formatSubcommandHelp(spec) : ""}\n`);
    expect(result.stderr).toBe("");
  });
});
