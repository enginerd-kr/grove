import { expect, test } from "bun:test";
import { version } from "../../package.json";
import type { CliCommand, WtCommand } from "./args.ts";
import { parseCliArgs } from "./args.ts";
import { BIN_NAME, SUBCOMMANDS } from "./help.ts";

/** Asserts the parse succeeded and hands back the command, so tests stay flat. */
function run(argv: readonly string[]): WtCommand {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "run") {
    throw new Error(`expected a run command, got ${parsed.kind}: ${describe(parsed)}`);
  }

  return parsed.command;
}

function describe(parsed: CliCommand): string {
  return parsed.kind === "run"
    ? parsed.command.name
    : ((parsed as { message?: string }).message ?? "");
}

test("clone takes a URL and an optional directory", () => {
  expect(run(["clone", "https://example.com/repo.git"])).toEqual({
    name: "clone",
    url: "https://example.com/repo.git",
    dir: undefined,
    branch: undefined,
  });
  expect(run(["clone", "https://example.com/repo.git", "work", "--branch", "trunk"])).toEqual({
    name: "clone",
    url: "https://example.com/repo.git",
    dir: "work",
    branch: "trunk",
  });
});

test("add defaults to fetching and not pushing", () => {
  expect(run(["add", "feat/login"])).toEqual({
    name: "add",
    branch: "feat/login",
    from: undefined,
    dir: undefined,
    fetch: true,
    push: false,
  });
});

// `--no-fetch` is a declared flag rather than a negation of `--fetch`, because
// parseArgs has no notion of negatable booleans to lean on.
test("--no-fetch and --no-abort invert the defaults they name", () => {
  expect(run(["add", "x", "--no-fetch"])).toHaveProperty("fetch", false);
  expect(run(["sync", "--no-abort"])).toHaveProperty("abortOnConflict", false);
  expect(run(["sync"])).toHaveProperty("abortOnConflict", true);
});

test("sync's target is optional and --all is separate", () => {
  expect(run(["sync"])).toEqual({
    name: "sync",
    target: undefined,
    all: false,
    abortOnConflict: true,
  });
  expect(run(["sync", "--all"])).toHaveProperty("all", true);
  expect(run(["sync", "feat/login"])).toHaveProperty("target", "feat/login");
});

test("remove exposes both destructive flags separately", () => {
  expect(run(["remove", "feat/login", "--force", "--delete-branch"])).toEqual({
    name: "remove",
    target: "feat/login",
    force: true,
    deleteBranch: true,
  });
});

test("aliases resolve to the canonical command", () => {
  expect(run(["ls"]).name).toBe("list");
  expect(run(["rm", "x"]).name).toBe("remove");
  expect(run(["init", "url"]).name).toBe("clone");
});

test("global options are read alongside a command's own", () => {
  const parsed = parseCliArgs(["list", "--json", "--verbose", "-C", "/work/repo"]);

  expect(parsed).toHaveProperty("global", { repo: "/work/repo", json: true, verbose: true });
});

test("global options default to off", () => {
  const parsed = parseCliArgs(["list"]);

  expect(parsed).toHaveProperty("global", { repo: undefined, json: false, verbose: false });
});

test("a missing required argument is a usage error carrying that command's help", () => {
  for (const argv of [["clone"], ["add"], ["remove"]]) {
    const parsed = parseCliArgs(argv);

    expect(parsed.kind).toBe("error");
    // The help attached must be the subcommand's, not the global one — the user
    // is already in the right command and needs its arguments, not a menu.
    expect(parsed).toHaveProperty("usage", expect.stringContaining(`${BIN_NAME} ${argv[0]}`));
  }
});

test("extra positionals are rejected rather than ignored", () => {
  expect(parseCliArgs(["list", "surplus"]).kind).toBe("error");
  expect(parseCliArgs(["add", "a", "b"]).kind).toBe("error");
  expect(parseCliArgs(["clone", "url", "dir", "extra"]).kind).toBe("error");
});

test("an unknown command names the ones that exist", () => {
  const parsed = parseCliArgs(["wroktree"]);

  expect(parsed.kind).toBe("error");
  for (const spec of SUBCOMMANDS) {
    expect(parsed).toHaveProperty("message", expect.stringContaining(spec.name));
  }
});

test("a misspelled flag is an error, never a positional", () => {
  // The failure mode this prevents: `--froom main` silently becoming a second
  // argument and the command doing something plausible but wrong.
  expect(parseCliArgs(["add", "x", "--froom", "main"]).kind).toBe("error");
  expect(parseCliArgs(["list", "--jsno"]).kind).toBe("error");
});

test("-- keeps a dash-leading branch name reachable", () => {
  expect(run(["add", "--", "-weird-branch"])).toHaveProperty("branch", "-weird-branch");
});

// `-C` is spelled after git's, and `git -C dir status` puts it first, so that is
// where people type it out of habit.
test("global flags work on either side of the command", () => {
  const before = parseCliArgs(["-C", "/work/repo", "--json", "list"]);
  const after = parseCliArgs(["list", "-C", "/work/repo", "--json"]);

  expect(before).toEqual(after);
  expect(before).toHaveProperty("global", { repo: "/work/repo", json: true, verbose: false });
});

test("a leading flag's value is not mistaken for the command", () => {
  // The failure this prevents: `repo` read as the subcommand, and `list` as a
  // stray positional.
  expect(parseCliArgs(["-C", "repo", "list"])).toHaveProperty("kind", "run");
  expect(parseCliArgs(["--repo", "repo", "list"])).toHaveProperty("kind", "run");
  // Attached forms carry their own value and consume nothing further.
  expect(parseCliArgs(["--repo=repo", "list"])).toHaveProperty("global", {
    repo: "repo",
    json: false,
    verbose: false,
  });
});

test("--help and --version answer before a command is required", () => {
  expect(parseCliArgs(["--json", "--help"]).kind).toBe("text");
  expect(parseCliArgs(["-C", "/work", "-v"])).toEqual({ kind: "text", output: version });
});

test("an unknown flag before the command is still rejected", () => {
  const parsed = parseCliArgs(["--jsno", "list"]);

  expect(parsed.kind).toBe("error");
  expect(parsed).toHaveProperty("usage", expect.stringContaining("Usage: wt <command>"));
});

test("--help answers at every level", () => {
  expect(parseCliArgs([]).kind).toBe("text");
  expect(parseCliArgs(["--help"]).kind).toBe("text");
  expect(parseCliArgs(["help"]).kind).toBe("text");

  const forAdd = parseCliArgs(["help", "add"]);
  expect(forAdd).toEqual({ kind: "text", output: expect.stringContaining("--no-fetch") });
  expect(parseCliArgs(["add", "--help"])).toEqual(forAdd);
});

// Someone who got the arguments wrong is exactly who needs the usage text.
test("--help wins over a missing argument", () => {
  expect(parseCliArgs(["clone", "--help"]).kind).toBe("text");
  expect(parseCliArgs(["remove", "-h"]).kind).toBe("text");
});

test("help for an unknown command is an error, not a blank page", () => {
  expect(parseCliArgs(["help", "nope"]).kind).toBe("error");
});

test("--version reports the package version", () => {
  expect(parseCliArgs(["--version"])).toEqual({ kind: "text", output: version });
  expect(parseCliArgs(["-v"])).toEqual({ kind: "text", output: version });
});

test("every command in the table parses without a special case", () => {
  // Guards the declarative table against gaining an entry that `buildCommand`
  // has no arm for, which would otherwise only show up at runtime.
  const sample: Record<string, readonly string[]> = {
    clone: ["clone", "url"],
    add: ["add", "branch"],
    list: ["list"],
    remove: ["remove", "target"],
    sync: ["sync"],
  };

  for (const spec of SUBCOMMANDS) {
    const argv = sample[spec.name];
    expect(argv, `no sample argv for "${spec.name}"`).toBeDefined();
    // Compared this way round so the wide `spec.name` is the expected value;
    // `run(...).name` is the narrow union and would reject it as an argument.
    expect(spec.name).toBe(run(argv ?? []).name);
  }
});
