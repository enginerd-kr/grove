import { expect, test } from "bun:test";
import { version } from "../../package.json";
import { BIN_NAME, formatHelp, parseCliArgs } from "./args.ts";

/**
 * Interim coverage. The subcommand rewrite replaces most of this, but the two
 * properties asserted here outlive it: parsing never prints or exits, and the
 * flags that answer without a terminal keep answering.
 */

test("--help and a bare invocation both yield the usage text", () => {
  expect(parseCliArgs(["--help"])).toEqual({ kind: "text", output: formatHelp() });
  expect(parseCliArgs(["-h"])).toEqual({ kind: "text", output: formatHelp() });
  // No subcommands to dispatch yet, so a bare run is a request for usage rather
  // than a mistake — which is how it will keep behaving once they exist.
  expect(parseCliArgs([])).toEqual({ kind: "text", output: formatHelp() });
});

test("--version reports the package version", () => {
  expect(parseCliArgs(["--version"])).toEqual({ kind: "text", output: version });
  expect(parseCliArgs(["-v"])).toEqual({ kind: "text", output: version });
});

test("--help wins over --version", () => {
  expect(parseCliArgs(["--help", "--version"])).toEqual({ kind: "text", output: formatHelp() });
});

test("rejects unknown flags and stray positionals", () => {
  // A typo must not be silently swallowed as an argument.
  expect(parseCliArgs(["--nope"]).kind).toBe("error");
  expect(parseCliArgs(["-x"]).kind).toBe("error");
  // Loosens once subcommands land; until then a positional has nowhere to go.
  expect(parseCliArgs(["extra"]).kind).toBe("error");
});

test("the help text names the binary and every flag it accepts", () => {
  const help = formatHelp();

  expect(help).toContain(BIN_NAME);
  expect(help).toContain("--version");
  expect(help).toContain("--help");
});

test("errors carry a message rather than throwing", () => {
  const command = parseCliArgs(["--nope"]);

  expect(command.kind).toBe("error");
  expect(command).toHaveProperty("message", expect.stringContaining("--nope"));
});
