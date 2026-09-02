import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { seedGit, withTempRepo } from "../core/test-utils.ts";
import {
  checkedPath,
  HOOKS_FILE,
  NO_HOOKS,
  NO_TEARDOWN,
  parseHooks,
  plannedCount,
  platformKeyFor,
  readHooks,
} from "./config.ts";
import { repoHooks } from "./source.ts";
import { refusalFrom, withRepo } from "./test-utils.ts";

/**
 * `.grove.toml` is the one file a repository writes for grove to read, so what
 * it accepts and what it refuses is a contract with the people who write it.
 * Everything below is about the file: what each key means, which spellings are
 * refused, and where the copy that governs is read from.
 */

describe("parseHooks", () => {
  test("an empty file asks for nothing", () => {
    expect(parseHooks("")).toEqual(NO_HOOKS);
    expect(parseHooks("# only a comment\n")).toEqual(NO_HOOKS);
  });

  test("reads every [setup] key", () => {
    const hooks = parseHooks(`
[setup]
copy = [".env", "certs"]
link = ["node_modules"]
env = { UV_INDEX_USERNAME = "PLACE_HOLDER" }
run = ["bun install", "bun run build"]
open = "code ."
`);

    expect(hooks.copy).toEqual([".env", "certs"]);
    expect(hooks.link).toEqual(["node_modules"]);
    expect(hooks.env).toEqual([{ name: "UV_INDEX_USERNAME", value: "PLACE_HOLDER" }]);
    expect(hooks.commands).toEqual(["bun install", "bun run build"]);
    expect(hooks.open).toEqual({ macos: "code .", linux: "code .", windows: "code ." });
    expect(hooks.teardown).toEqual(NO_TEARDOWN);
  });

  test("open is one line, and a list points at the table instead", () => {
    const error = refusalFrom(() => parseHooks('[setup]\nopen = ["code .", "idea ."]\n'));

    // A list is what somebody reaches for when what they wanted was to say it
    // differently per platform, so the refusal says where that lives. Two apps
    // on one platform is what the shell already spells `&&`.
    expect(error.message).toContain("setup.open must be one command line");
    expect(error.hint).toContain("[setup.open]");
  });

  test("[setup.open] writes the line once per platform", () => {
    const hooks = parseHooks(`
[setup]
run = ["bun install"]

[setup.open]
macos = 'open -a "Visual Studio Code" .'
linux = "code . --new-window"
`);

    // The reason the table exists: one line cannot be right on both. `open -a`
    // is macOS only, and `code` is not on a macOS PATH until somebody installs
    // the shim.
    expect(hooks.open.macos).toBe('open -a "Visual Studio Code" .');
    expect(hooks.open.linux).toBe("code . --new-window");
    // A platform the file did not mention opens nothing, rather than being
    // guessed at with an application that may not be installed.
    expect(hooks.open.windows).toBe("");
    expect(hooks.commands).toEqual(["bun install"]);
  });

  test("[setup.open] refuses a platform it does not have", () => {
    // `ubuntu` is the tempting one to write and the one that cannot work:
    // `process.platform` says `linux` and never which distribution.
    const error = refusalFrom(() => parseHooks('[setup.open]\nubuntu = "code ."\n'));

    expect(error.message).toContain('[setup.open] has no key named "ubuntu"');
    expect(error.hint).toBe("the keys are macos, linux, windows");
  });

  test("open is a line or a table, and says so when it is neither", () => {
    const error = refusalFrom(() => parseHooks("[setup]\nopen = 42\n"));

    expect(error.code).toBe("usage");
    expect(error.message).toContain("setup.open must be one command line");
  });

  test("an empty line is refused where it can still be read", () => {
    const error = refusalFrom(() => parseHooks('[setup]\nopen = ""\n'));

    // It would otherwise start a shell that exits at once, which grove would
    // read as having opened something.
    expect(error.code).toBe("usage");
    expect(error.message).toContain("setup.open has nothing to open");

    // The same check reaches inside the table, and names the key it was about.
    const inTable = refusalFrom(() => parseHooks('[setup.open]\nmacos = "  "\n'));
    expect(inTable.message).toContain("setup.open.macos has nothing to open");
    expect(inTable.hint).toContain("open -a");
  });

  describe("per platform", () => {
    test("a list key can be written once per platform, like open", () => {
      const text = `
[setup]
link = ["node_modules"]

[setup.copy]
macos   = [".env"]
windows = [".env", "local.bat"]

[setup.run]
linux   = "bun install"
windows = ["bun install", "npm run win-post"]

[teardown.run]
macos = ["docker compose down", "colima stop"]
`;
      const mac = parseHooks(text, HOOKS_FILE, "darwin");
      const win = parseHooks(text, HOOKS_FILE, "win32");
      const linux = parseHooks(text, HOOKS_FILE, "linux");

      // A bare list is the file that is the same everywhere, and still is.
      expect(mac.link).toEqual(["node_modules"]);
      expect(win.link).toEqual(["node_modules"]);

      expect(mac.copy).toEqual([".env"]);
      expect(win.copy).toEqual([".env", "local.bat"]);
      // A platform the table leaves out gets nothing, rather than a guess.
      expect(linux.copy).toEqual([]);

      // A bare string inside the table reads as it does outside it.
      expect(linux.commands).toEqual(["bun install"]);
      expect(win.commands).toEqual(["bun install", "npm run win-post"]);
      expect(mac.commands).toEqual([]);

      expect(mac.teardown.commands).toEqual(["docker compose down", "colima stop"]);
      expect(linux.teardown.commands).toEqual([]);
    });

    test("an inline table is the same table", () => {
      const hooks = parseHooks('[setup]\ncopy = { macos = [".env"] }\n', HOOKS_FILE, "darwin");

      expect(hooks.copy).toEqual([".env"]);
    });

    test("refuses a platform it does not have, the way [setup.open] does", () => {
      const error = refusalFrom(() => parseHooks('[setup.copy]\nubuntu = [".env"]\n'));

      expect(error.message).toContain('[setup.copy] has no key named "ubuntu"');
      expect(error.hint).toBe("the keys are macos, linux, windows");
    });

    test("a wrong value inside the table names the key, with the key's own example", () => {
      const error = refusalFrom(() =>
        parseHooks("[setup.copy]\nmacos = 5\n", HOOKS_FILE, "darwin"),
      );

      expect(error.message).toContain("setup.copy.macos must be a list of strings");
      // A path, and not the `open -a` line the `macos` key would otherwise
      // reach for: the advice is about `copy`.
      expect(error.hint).toBe('for example: macos = [".env"]');

      expect(refusalFrom(() => parseHooks("[teardown.run]\nlinux = [1]\n")).hint).toContain(
        '"bun install"',
      );
    });

    test("the other platforms' lines are checked too, so a bad file is refused everywhere", () => {
      // Read for a Mac, and what was written for Windows is still wrong.
      expect(
        refusalFrom(() => parseHooks("[setup.copy]\nwindows = 5\n", HOOKS_FILE, "darwin")).message,
      ).toContain("setup.copy.windows");

      // The path check too, which is the one that matters: a `..` aimed at the
      // machine that will pull this next week is refused on the one writing it.
      const climbing = refusalFrom(() =>
        parseHooks('[setup.copy]\nwindows = ["../.ssh"]\n', HOOKS_FILE, "darwin"),
      );
      expect(climbing.message).toContain('"../.ssh"');
      expect(climbing.hint).toContain("inside the worktree");
      expect(
        refusalFrom(() => parseHooks('[setup.link]\nlinux = ["/etc"]\n', HOOKS_FILE, "win32")).code,
      ).toBe("usage");
    });

    test("counts what was written for other platforms, so the file still asked for something", () => {
      const text = `
[setup.copy]
windows = [".env", "local.bat"]

[setup.run]
linux = "bun install"

[teardown.run]
linux = ["docker compose down"]
`;
      const mac = parseHooks(text, HOOKS_FILE, "darwin");

      expect(mac.copy).toEqual([]);
      expect(mac.commands).toEqual([]);
      // Three [setup] lines for machines this is not. [teardown]'s is not
      // counted, as `plannedCount` never counted it.
      expect(mac.elsewhere).toBe(3);
      expect(plannedCount(mac)).toBe(3);
      expect(parseHooks(text, HOOKS_FILE, "win32").elsewhere).toBe(1);
      expect(parseHooks(text, HOOKS_FILE, "linux").elsewhere).toBe(2);
    });

    describe("env", () => {
      test("a platform's variables sit inside the table, over the shared ones", () => {
        const text = `
[setup.env]
PORT = "3000"
SHELL = "sh"
macos = { SHELL = "zsh", DOCKER_HOST = "unix:///tmp/colima.sock" }

[setup.env.windows]
SHELL = "pwsh"
`;
        expect(parseHooks(text, HOOKS_FILE, "darwin").env).toEqual([
          { name: "PORT", value: "3000" },
          { name: "SHELL", value: "zsh" },
          { name: "DOCKER_HOST", value: "unix:///tmp/colima.sock" },
        ]);
        // `[setup.env.windows]` is the same TOML as `windows = { … }`.
        expect(parseHooks(text, HOOKS_FILE, "win32").env).toEqual([
          { name: "PORT", value: "3000" },
          { name: "SHELL", value: "pwsh" },
        ]);
        // A platform the table says nothing about keeps the shared ones only.
        expect(parseHooks(text, HOOKS_FILE, "linux").env).toEqual([
          { name: "PORT", value: "3000" },
          { name: "SHELL", value: "sh" },
        ]);
      });

      test("a platform name is not a variable, so a string there is refused", () => {
        const error = refusalFrom(() => parseHooks('[setup.env]\nmacos = ""\n'));

        expect(error.code).toBe("usage");
        expect(error.message).toContain(
          "setup.env.macos must be a table of variables for that platform",
        );
        expect(error.hint).toContain("macos = {");
      });

      test("every platform's names are checked, and [teardown] keeps its own", () => {
        const error = refusalFrom(() =>
          parseHooks('[setup.env]\nwindows = { "A B" = "x" }\n', HOOKS_FILE, "darwin"),
        );
        expect(error.message).toContain("setup.env.windows has no name");

        const hooks = parseHooks(
          `
[setup.env]
linux = { TOKEN = "install" }

[teardown.env]
linux = { TOKEN = "cleanup" }
`,
          HOOKS_FILE,
          "linux",
        );

        expect(hooks.env).toEqual([{ name: "TOKEN", value: "install" }]);
        expect(hooks.teardown.env).toEqual([{ name: "TOKEN", value: "cleanup" }]);
      });
    });
  });

  test("[teardown] has no open — there is nothing to open in a worktree that is going", () => {
    const error = refusalFrom(() => parseHooks('[teardown]\nopen = "code ."\n'));

    expect(error.message).toContain('[teardown] has no key named "open"');
    expect(error.hint).toBe("the keys are env, run");
  });

  test("takes a bare string where a list would do", () => {
    const hooks = parseHooks(`
[setup]
copy = ".env"
link = "node_modules"
run = "bun install"
`);

    expect(hooks.copy).toEqual([".env"]);
    expect(hooks.link).toEqual(["node_modules"]);
    expect(hooks.commands).toEqual(["bun install"]);
  });

  test("reads [teardown] on its own, with no [setup] to gate it", () => {
    const hooks = parseHooks(`
[teardown]
env = { STACK = "test" }
run = ["docker compose down"]
`);

    expect(hooks).toMatchObject({ copy: [], link: [], env: [], commands: [] });
    expect(hooks.teardown.commands).toEqual(["docker compose down"]);
    expect(hooks.teardown.env).toEqual([{ name: "STACK", value: "test" }]);
  });

  test("keeps the two sections' environments apart", () => {
    const hooks = parseHooks(`
[setup]
env = { TOKEN = "install" }
run = ["true"]

[teardown]
env = { TOKEN = "teardown" }
run = ["false"]
`);

    expect(hooks.env).toEqual([{ name: "TOKEN", value: "install" }]);
    expect(hooks.teardown.env).toEqual([{ name: "TOKEN", value: "teardown" }]);
  });

  describe("env", () => {
    test("accepts a list of NAME=value", () => {
      const hooks = parseHooks(`
[setup]
env = ["A=1", "B=2"]
`);

      expect(hooks.env).toEqual([
        { name: "A", value: "1" },
        { name: "B", value: "2" },
      ]);
    });

    test("splits a list entry at the first = only", () => {
      const hooks = parseHooks(`
[setup]
env = ["URL=https://example.invalid/?a=1&b=2"]
`);

      expect(hooks.env).toEqual([{ name: "URL", value: "https://example.invalid/?a=1&b=2" }]);
    });

    test("accepts an empty value", () => {
      expect(parseHooks('[setup]\nenv = ["A="]\n').env).toEqual([{ name: "A", value: "" }]);
    });

    test("accepts a [setup.env] section as well as an inline table", () => {
      const section = parseHooks(`
[setup]

[setup.env]
A = "1"
`);

      expect(section.env).toEqual([{ name: "A", value: "1" }]);
      expect(parseHooks('[setup]\nenv = { A = "1" }\n').env).toEqual(section.env);
    });

    test("turns a number or a boolean into the string a process receives", () => {
      const hooks = parseHooks(`
[setup]
env = { PORT = 3000, DEBUG = true }
`);

      expect(hooks.env).toEqual([
        { name: "PORT", value: "3000" },
        { name: "DEBUG", value: "true" },
      ]);
    });

    test("refuses a value with no string reading", () => {
      const error = refusalFrom(() => parseHooks('[setup]\nenv = { A = ["x"] }\n'));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("setup.env.A must be a string");
    });

    test("refuses a list entry with no name", () => {
      const error = refusalFrom(() => parseHooks('[setup]\nenv = ["NOEQUALS"]\n'));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("setup.env has no name");
      expect(error.hint).toContain("UV_INDEX_USERNAME");
    });

    test("refuses a name a shell would not accept", () => {
      expect(refusalFrom(() => parseHooks('[setup]\nenv = ["1BAD=x"]\n')).message).toContain(
        "has no name",
      );
      expect(refusalFrom(() => parseHooks('[setup]\nenv = { "A B" = "x" }\n')).message).toContain(
        "has no name",
      );
      expect(refusalFrom(() => parseHooks('[setup]\nenv = ["=x"]\n')).message).toContain(
        "has no name",
      );
    });

    test("names the section it refused, so [teardown] is not reported as [setup]", () => {
      expect(refusalFrom(() => parseHooks('[teardown]\nenv = ["NOEQUALS"]\n')).message).toContain(
        "teardown.env",
      );
    });
  });

  describe("what it refuses", () => {
    test("an unknown key, rather than quietly doing nothing", () => {
      const error = refusalFrom(() => parseHooks('[setup]\ncpoy = [".env"]\n'));

      expect(error.code).toBe("usage");
      expect(error.message).toContain('[setup] has no key named "cpoy"');
      expect(error.hint).toBe("the keys are copy, link, env, run, open");
    });

    test("a [setup]-only key written under [teardown]", () => {
      const error = refusalFrom(() => parseHooks('[teardown]\ncopy = [".env"]\n'));

      expect(error.message).toContain('[teardown] has no key named "copy"');
      expect(error.hint).toBe("the keys are env, run");
    });

    test("a section that is not a table", () => {
      expect(refusalFrom(() => parseHooks("setup = 1\n")).message).toContain(
        "[setup] must be a table",
      );
      expect(refusalFrom(() => parseHooks('[[setup]]\ncopy = [".env"]\n')).message).toContain(
        "[setup] must be a table",
      );
      expect(refusalFrom(() => parseHooks("teardown = true\n")).message).toContain(
        "[teardown] must be a table",
      );
    });

    test("a value of the wrong type, with an example of the right one", () => {
      const error = refusalFrom(() => parseHooks("[setup]\ncopy = 5\n"));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("setup.copy must be a list of strings");
      expect(error.hint).toContain('copy = [".env"]');

      expect(refusalFrom(() => parseHooks('[setup]\nrun = ["ok", 5]\n')).hint).toContain(
        '"bun install"',
      );

      const inTable = refusalFrom(() => parseHooks("[setup.open]\nlinux = 5\n"));
      expect(inTable.message).toContain("setup.open.linux must be one command line");
      expect(inTable.hint).toContain('"code ."');
    });

    test("TOML it cannot parse, quoting what the parser said", () => {
      const error = refusalFrom(() => parseHooks('[setup]\ncopy = [".env"\n'));

      expect(error.code).toBe("usage");
      expect(error.message).toBe(`${HOOKS_FILE} is not valid TOML`);
      expect(error.details.length).toBeGreaterThan(0);
      expect(error.cause).toBeDefined();
    });
  });
});

describe("platformKeyFor", () => {
  test("names platforms the way a config line does, not the way Node does", () => {
    expect(platformKeyFor("darwin")).toBe("macos");
    expect(platformKeyFor("win32")).toBe("windows");
    // Everything else is "the name is the command", which is as true on
    // FreeBSD as on Ubuntu — and `process.platform` could not tell the
    // distributions apart to do better.
    expect(platformKeyFor("linux")).toBe("linux");
    expect(platformKeyFor("freebsd")).toBe("linux");
  });
});

describe("plannedCount", () => {
  test("counts the work, and a file that asks for nothing has none", () => {
    expect(plannedCount(NO_HOOKS)).toBe(0);
    expect(NO_HOOKS.teardown).toBe(NO_TEARDOWN);
    expect(NO_TEARDOWN).toEqual({ env: [], commands: [] });
  });

  test("adds copy, link, run and open together", () => {
    const hooks = parseHooks(`
[setup]
copy = [".env", "certs"]
link = ["node_modules"]
run = ["bun install"]
open = "code ."
`);

    expect(plannedCount(hooks)).toBe(5);
  });

  test("a file that only opens something has still asked for something", () => {
    // Zero here would reach `describeSetup` as "no .grove.toml", about a file
    // that is sitting right there and that just opened an editor.
    expect(plannedCount(parseHooks('[setup]\nopen = "code ."\n'))).toBe(1);
    // Platforms are not more work either: still one thing, said for three
    // machines because it cannot be said once.
    expect(
      plannedCount(parseHooks('[setup.open]\nmacos = "a"\nlinux = "b"\nwindows = "c"\n')),
    ).toBe(1);
  });

  test("counts neither env nor teardown — neither is work in this worktree", () => {
    const hooks = parseHooks(`
[setup]
env = { A = "1" }

[teardown]
run = ["docker compose down"]
`);

    expect(plannedCount(hooks)).toBe(0);
  });
});

describe("checkedPath", () => {
  test("accepts a relative path inside the worktree", () => {
    expect(checkedPath("copy", ".env")).toBe(".env");
    expect(checkedPath("copy", "config/local.json")).toBe("config/local.json");
    expect(checkedPath("link", "node_modules")).toBe("node_modules");
  });

  test("normalises the spellings of the same path", () => {
    expect(checkedPath("copy", "./.env")).toBe(".env");
    expect(checkedPath("copy", "a//b")).toBe("a/b");
    expect(checkedPath("copy", "a/./b/")).toBe("a/b");
    // Windows separators, so one file reads the same on either kind of machine.
    expect(checkedPath("copy", "config\\local.json")).toBe("config/local.json");
  });

  test("refuses a path that climbs out of the worktree", () => {
    for (const value of [
      "..",
      "../.env",
      "../../etc/passwd",
      "a/../../b",
      "a/..",
      "..\\.env",
      "a\\..\\..\\b",
      "./../x",
    ]) {
      const error = refusalFrom(() => checkedPath("copy", value));

      expect(error.code).toBe("usage");
      expect(error.message).toContain(JSON.stringify(value));
      expect(error.hint).toContain("inside the worktree");
    }
  });

  test("refuses an absolute path, on either kind of machine", () => {
    for (const value of [
      "/etc/passwd",
      "/",
      "\\\\server\\share",
      "\\etc\\passwd",
      "C:\\Windows\\system32",
      "c:/Windows",
    ]) {
      expect(refusalFrom(() => checkedPath("copy", value)).code).toBe("usage");
    }
  });

  test("refuses the repository's own plumbing", () => {
    for (const value of [
      ".git",
      ".git/config",
      "a/.git/hooks",
      ".bare",
      ".bare/config",
      "a/.bare",
    ]) {
      expect(refusalFrom(() => checkedPath("copy", value)).code).toBe("usage");
    }
  });

  test("refuses a path that names nothing", () => {
    for (const value of ["", ".", "./", "/", "//", "\\"]) {
      expect(refusalFrom(() => checkedPath("copy", value)).code).toBe("usage");
    }
  });

  test("says which key it was reading", () => {
    expect(refusalFrom(() => checkedPath("link", "../x")).message).toStartWith("link: ");
    expect(refusalFrom(() => checkedPath("copy", "../x")).message).toStartWith("copy: ");
  });

  test("keeps a name that merely looks alarming", () => {
    // Only a segment that *is* `..` climbs; `...` and `..env` are ordinary names.
    expect(checkedPath("copy", "...")).toBe("...");
    expect(checkedPath("copy", "..env")).toBe("..env");
    expect(checkedPath("copy", ".gitignore")).toBe(".gitignore");
    expect(checkedPath("copy", ".github/workflows")).toBe(".github/workflows");
  });
});

describe("readHooks", () => {
  test("checks every path, so a bad line refuses the file as a whole", async () => {
    await withTempRepo(async (temp) => {
      await Bun.write(
        join(temp.work, HOOKS_FILE),
        '[setup]\ncopy = [".env", "../../.ssh/id_rsa"]\n',
      );

      await expect(readHooks(temp.work)).rejects.toThrow("is not a usable path");
    });
  });

  test("a worktree with no file plans nothing", async () => {
    await withTempRepo(async (temp) => {
      expect(await readHooks(temp.work)).toEqual(NO_HOOKS);
    });
  });

  test("reads for the platform it is asked about", async () => {
    await withTempRepo(async (temp) => {
      await Bun.write(join(temp.work, HOOKS_FILE), '[setup.copy]\nwindows = ["local.bat"]\n');

      expect((await readHooks(temp.work, { platform: "win32" })).copy).toEqual(["local.bat"]);
      expect((await readHooks(temp.work, { platform: "linux" })).copy).toEqual([]);
    });
  });
});

describe("repoHooks", () => {
  test("reads the trunk's file, not the worktree being set up", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\ncopy = [".env"]\n');
      await Bun.write(join(fixture.worktree, HOOKS_FILE), '[setup]\nrun = ["exit 1"]\n');

      const hooks = await repoHooks(fixture.repo);

      expect(hooks.copy).toEqual([".env"]);
      expect(hooks.commands).toEqual([]);
      expect(hooks.layers.map((layer) => layer.path)).toEqual([join(fixture.trunk, HOOKS_FILE)]);
    });
  });

  test("falls back to the worktree it was given when the trunk has none", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.worktree, HOOKS_FILE), '[setup]\nrun = ["true"]\n');
      await seedGit(fixture.repo.gitDir, ["worktree", "remove", "--force", fixture.trunk]);

      expect((await repoHooks(fixture.repo, fixture.worktree)).commands).toEqual(["true"]);
      // Without a fallback there is nothing to read, and that is not an error.
      expect(await repoHooks(fixture.repo)).toEqual(NO_HOOKS);
    });
  });

  test("a repository with no file plans nothing", async () => {
    await withRepo(async (fixture) => {
      expect(await repoHooks(fixture.repo)).toEqual(NO_HOOKS);
    });
  });
});
