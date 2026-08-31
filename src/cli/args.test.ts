import { describe, expect, test } from "bun:test";
import { version } from "../../package.json";
import { type CliCommand, parseCliArgs } from "./args.ts";
import { SUBCOMMANDS, type SubcommandSpec } from "./help.ts";

/**
 * The parser is generated from `SUBCOMMANDS`, so most of what is worth
 * asserting is a property of the whole table rather than of one command —
 * hence the loops. The hand-written cases below them are the ones where the
 * table says nothing: which flag lands on which field, and what a mistake reads
 * as.
 */

/** A `run` command, or a failure that says what came back instead. */
function run(argv: readonly string[]): Extract<CliCommand, { kind: "run" }> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "run") {
    throw new Error(`expected a run command from ${JSON.stringify(argv)}, got ${parsed.kind}`);
  }

  return parsed;
}

function error(argv: readonly string[]): Extract<CliCommand, { kind: "error" }> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "error") {
    throw new Error(`expected an error from ${JSON.stringify(argv)}, got ${parsed.kind}`);
  }

  return parsed;
}

/** The positionals `spec.args` promises, filled in with something acceptable. */
function requiredArgs(spec: SubcommandSpec): readonly string[] {
  return spec.args
    .split(/\s+/)
    .filter((token) => token.startsWith("<"))
    .map(() => "x");
}

describe("the subcommand table", () => {
  test("every name resolves to the command it describes", () => {
    for (const spec of SUBCOMMANDS) {
      const parsed = run([spec.name, ...requiredArgs(spec)]);

      // Paired with the name so a failure says which command disagreed.
      expect([spec.name, parsed.command.name]).toEqual([spec.name, spec.name]);
    }
  });

  test("every alias resolves to the same command as its name", () => {
    const aliases = SUBCOMMANDS.flatMap((spec) =>
      spec.aliases.map((alias) => [alias, spec] as const),
    );

    // The four the README promises, spelled out so a table that quietly lost one
    // fails here rather than passing an empty loop.
    expect(aliases.map(([alias, spec]) => `${alias}->${spec.name}`).toSorted()).toEqual([
      "init->clone",
      "ls->list",
      "mv->rename",
      "rm->remove",
    ]);

    for (const [alias, spec] of aliases) {
      const parsed = run([alias, ...requiredArgs(spec)]);

      expect([alias, parsed.command.name]).toEqual([alias, spec.name]);
    }
  });

  test("an unknown subcommand is a usage error naming the ones that exist", () => {
    const parsed = error(["nope"]);

    expect(parsed.message).toContain('unknown command "nope"');
    for (const spec of SUBCOMMANDS) expect(parsed.message).toContain(spec.name);
    expect(parsed.usage).toContain("Usage: grove <command>");
  });
});

describe("global flags", () => {
  test("-C and --repo are the same flag, before or after the subcommand", () => {
    for (const argv of [
      ["-C", "/tmp/repo", "list"],
      ["--repo", "/tmp/repo", "list"],
      ["-C/tmp/repo", "list"],
      ["--repo=/tmp/repo", "list"],
      ["list", "-C", "/tmp/repo"],
      ["list", "--repo=/tmp/repo"],
    ]) {
      expect(run(argv).global.repo).toBe("/tmp/repo");
    }
  });

  test("the later spelling wins when it is written on both sides", () => {
    expect(run(["-C", "a", "list", "-C", "b"]).global.repo).toBe("b");
  });

  test("the booleans parse either side of the subcommand", () => {
    expect(run(["--json", "--verbose", "--headless", "add", "x"]).global).toEqual({
      repo: undefined,
      json: true,
      verbose: true,
      headless: true,
    });
    expect(run(["add", "x", "--json", "--verbose", "--headless"]).global).toEqual({
      repo: undefined,
      json: true,
      verbose: true,
      headless: true,
    });
  });

  test("a global flag missing its value is a usage error", () => {
    expect(error(["-C"]).message).toContain("argument missing");
    expect(error(["list", "--repo"]).message).toContain("argument missing");
  });

  test("a flag where the subcommand should be says so", () => {
    // Distinct from "unknown command": `--nope` is not a name anybody meant as
    // one, and the global help is the relevant page.
    expect(error(["--", "list"]).message).toContain("expected a command before");
    expect(error(["--nope"]).message).toContain("Unknown option");
  });
});

describe("help and version", () => {
  test("--help and -h print the global help without needing a subcommand", () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const parsed = parseCliArgs(argv);

      expect(parsed.kind).toBe("text");
      expect(parsed.kind === "text" && parsed.output).toContain("Usage: grove <command>");
    }
  });

  test("`help <command>` takes an alias as readily as a name", () => {
    const byName = parseCliArgs(["help", "list"]);
    const byAlias = parseCliArgs(["help", "ls"]);

    expect(byName).toEqual(byAlias);
    expect(byName.kind === "text" && byName.output).toContain("Usage: grove list");
  });

  test("`help <not a command>` is a usage error", () => {
    expect(error(["help", "nope"]).message).toContain('unknown command "nope"');
  });

  test("--help on a subcommand beats its missing arguments", () => {
    const parsed = parseCliArgs(["add", "--help"]);

    expect(parsed.kind).toBe("text");
    expect(parsed.kind === "text" && parsed.output).toContain("Usage: grove add <branch>");
  });

  test("--version prints the version the package declares", () => {
    for (const argv of [["--version"], ["-v"], ["list", "-v"]]) {
      expect(parseCliArgs(argv)).toEqual({ kind: "text", output: version });
    }
  });

  test("a bare invocation asks for the screen, carrying the usage it may print instead", () => {
    const parsed = parseCliArgs([]);

    expect(parsed.kind).toBe("app");
    expect(parsed.kind === "app" && parsed.usage).toContain("Usage: grove <command>");
  });
});

describe("positional arity", () => {
  test("too few is a usage error naming what is missing", () => {
    expect(error(["clone"]).message).toContain("needs a repository URL");
    expect(error(["add"]).message).toContain("needs a branch name");
    expect(error(["rename", "a"]).message).toContain("needs a new branch name");
    expect(error(["remove"]).message).toContain("needs a worktree to remove");
    expect(error(["reset"]).message).toContain("needs a worktree to reset");
  });

  test("too many is a usage error naming the extras", () => {
    expect(error(["list", "extra"]).message).toBe('list takes 0 argument(s); unexpected "extra"');
    expect(error(["add", "a", "b"]).message).toBe('add takes 1 argument(s); unexpected "b"');
    expect(error(["rename", "a", "b", "c"]).message).toBe(
      'rename takes 2 argument(s); unexpected "c"',
    );
  });

  test("optional positionals may be left out", () => {
    expect(run(["path"]).command).toEqual({ name: "path", target: undefined });
    expect(run(["clone", "url"]).command).toMatchObject({ url: "url", dir: undefined });
    expect(run(["open"]).command).toEqual({ name: "open", target: undefined, trust: false });
  });

  test("every command's arity comes from the usage line, not from a second list", () => {
    for (const spec of SUBCOMMANDS) {
      // A usage line ending in `...` promises no limit rather than one more
      // argument, which is the next test rather than an exception to this one.
      if (spec.args.endsWith("...")) continue;

      const max = spec.args.split(/\s+/).filter((token) => token.length > 0).length;
      const argv = [spec.name, ...Array.from({ length: max + 1 }, () => "x")];

      expect(error(argv).message).toContain(`${spec.name} takes ${max} argument(s)`);
    }
  });

  test("a usage line ending in `...` takes as many arguments as it is handed", () => {
    // `exec` is the one, and what follows it is somebody else's command line:
    // an arity this parser enforced would be an opinion about how long
    // `bun run build --watch` is allowed to be.
    expect(run(["exec", "bun", "run", "build"]).command).toMatchObject({
      argv: ["bun", "run", "build"],
    });
    expect(run(["exec", "--", "git", "status", "--short"]).command).toMatchObject({
      argv: ["git", "status", "--short"],
    });
    expect(error(["exec"]).message).toContain("exec needs a command to run");
  });
});

describe("flags land where the command expects them", () => {
  test("clone", () => {
    expect(run(["clone", "url", "dir", "-b", "main"]).command).toEqual({
      name: "clone",
      url: "url",
      dir: "dir",
      branch: "main",
    });
    expect(run(["clone", "url", "--branch=main"]).command).toMatchObject({ branch: "main" });
  });

  test("add", () => {
    expect(run(["add", "x"]).command).toEqual({
      name: "add",
      branch: "x",
      from: undefined,
      fetch: true,
      push: false,
      setup: true,
      trust: false,
      take: false,
    });
    expect(
      run(["add", "x", "--from", "main", "--no-fetch", "--push", "--no-setup", "--trust", "--take"])
        .command,
    ).toEqual({
      name: "add",
      branch: "x",
      from: "main",
      // The `no-` flags are stored the way the command reads them: as the
      // positive thing that is now switched off.
      fetch: false,
      push: true,
      setup: false,
      trust: true,
      take: true,
    });
  });

  test("prune folds --gone and --merged into the one question they halve", () => {
    expect(run(["prune"]).command).toMatchObject({ only: undefined });
    expect(run(["prune", "--gone"]).command).toMatchObject({ only: "gone" });
    expect(run(["prune", "--merged"]).command).toMatchObject({ only: "merged" });
    // Both halves is the whole question, which is the default.
    expect(run(["prune", "--gone", "--merged"]).command).toMatchObject({ only: undefined });
    expect(run(["prune", "-n"]).command).toMatchObject({ dryRun: true });
  });

  test("the rest of the mutating commands", () => {
    expect(run(["remove", "x", "--force", "--delete-branch", "--no-teardown"]).command).toEqual({
      name: "remove",
      target: "x",
      force: true,
      deleteBranch: true,
      teardown: false,
    });
    expect(run(["rename", "a", "b", "--push", "--force"]).command).toEqual({
      name: "rename",
      target: "a",
      to: "b",
      push: true,
      force: true,
    });
    expect(run(["reset", "x", "--to", "HEAD~1", "--clean"]).command).toEqual({
      name: "reset",
      target: "x",
      to: "HEAD~1",
      clean: true,
    });
    expect(run(["sync", "--all", "--no-push", "--no-abort"]).command).toEqual({
      name: "sync",
      target: undefined,
      all: true,
      abortOnConflict: false,
      push: false,
    });
  });
});

describe("mistyped flags", () => {
  test("an unknown flag is refused rather than read as a positional", () => {
    // The whole point of `strict`: `grove add --brnach x` must not create a
    // branch called `x` and quietly drop the flag.
    const parsed = error(["add", "--brnach", "x"]);

    expect(parsed.message).toContain("Unknown option '--brnach'");
    expect(parsed.usage).toContain("Usage: grove add");
  });

  test("an unknown short flag is refused too", () => {
    expect(error(["add", "-x"]).message).toContain("Unknown option '-x'");
  });

  test("a string flag missing its value is refused", () => {
    expect(error(["add", "--from"]).message).toContain("argument missing");
  });

  test("another command's flag is not accepted here", () => {
    expect(error(["list", "--force"]).message).toContain("Unknown option '--force'");
  });

  test("-- makes a branch that looks like a flag reachable", () => {
    expect(run(["add", "--", "-x"]).command).toMatchObject({ branch: "-x" });
  });
});
