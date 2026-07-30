import { expect, test } from "bun:test";
import { version } from "../../package.json";
import { TAB_LABELS } from "../ui/index.ts";
import { formatHelp, parseCliArgs } from "./args.ts";

test("defaults to the first tab", () => {
  expect(parseCliArgs([])).toEqual({ kind: "run", initialTab: 0 });
});

test("converts --tab to a 0-based index for App", () => {
  expect(parseCliArgs(["--tab", "2"])).toEqual({ kind: "run", initialTab: 1 });
  expect(parseCliArgs(["-t", "3"])).toEqual({ kind: "run", initialTab: 2 });
  expect(parseCliArgs(["--tab=3"])).toEqual({ kind: "run", initialTab: 2 });
});

test("accepts every tab the app actually has", () => {
  for (const [index] of TAB_LABELS.entries()) {
    expect(parseCliArgs(["--tab", String(index + 1)])).toEqual({ kind: "run", initialTab: index });
  }
});

test("rejects a tab outside the range", () => {
  // `--tab=-1` rather than `--tab -1`: parseArgs rejects a dash-leading value
  // as ambiguous before the range check ever sees it.
  for (const argv of [["--tab", "0"], ["--tab=-1"], ["--tab", String(TAB_LABELS.length + 1)]]) {
    const command = parseCliArgs(argv);

    expect(command.kind).toBe("error");
    // The message has to name the bound, or the user is left guessing.
    expect(command).toHaveProperty("message", expect.stringContaining(String(TAB_LABELS.length)));
  }
});

test("rejects a dash-leading tab value outright", () => {
  expect(parseCliArgs(["--tab", "-1"]).kind).toBe("error");
});

test("rejects a tab that is not a whole number", () => {
  for (const value of ["two", "1.5", "", " "]) {
    expect(parseCliArgs(["--tab", value]).kind).toBe("error");
  }
});

test("rejects unknown flags and stray positionals", () => {
  // A typo must not be silently swallowed as an argument.
  expect(parseCliArgs(["--tba", "2"]).kind).toBe("error");
  expect(parseCliArgs(["--tab"]).kind).toBe("error");
  expect(parseCliArgs(["extra"]).kind).toBe("error");
});

test("--help lists every tab and both other flags", () => {
  const command = parseCliArgs(["--help"]);

  expect(command).toEqual({ kind: "text", output: formatHelp() });

  const help = formatHelp();
  for (const label of TAB_LABELS) {
    expect(help).toContain(label.toLowerCase());
  }
  expect(help).toContain("--version");
  expect(help).toContain("--tab");
});

test("--version reports the package version", () => {
  expect(parseCliArgs(["--version"])).toEqual({ kind: "text", output: version });
  expect(parseCliArgs(["-v"])).toEqual({ kind: "text", output: version });
});

test("--help wins over an invalid --tab", () => {
  // Someone who got the flag wrong is exactly who needs the usage text.
  expect(parseCliArgs(["--help", "--tab", "bogus"]).kind).toBe("text");
});
