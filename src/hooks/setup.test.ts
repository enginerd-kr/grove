import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ExitCode, errorToExitCode } from "../cli/exit-codes.ts";
import { entryExists } from "../core/fs.ts";
import { seedGit } from "../core/test-utils.ts";
import { failureFor, pendingCommands } from "./command.ts";
import { HOOKS_FILE, NO_HOOKS, repoHooks } from "./config.ts";
import { describeSetup, runSetup, type SetupResult, trustAndRun } from "./setup.ts";
import { recorder, refusalFromRun, setUp, withRepo } from "./test-utils.ts";
import { trust } from "./trust.ts";

/**
 * `[setup]` against a real repository, because almost everything here is about
 * what lands on disk: what a `copy` line reaches, where a `link` points, and
 * which commands a machine has agreed to run.
 */

describe("runSetup", () => {
  test("does nothing, and says so, when there is no file", async () => {
    await withRepo(async (fixture) => {
      const result = await setUp(fixture);

      expect(result).toMatchObject({
        planned: 0,
        copied: [],
        linked: [],
        ran: [],
        untrusted: false,
        dir: "feat/login",
      });
      expect(describeSetup(result)).toBe(`no ${HOOKS_FILE}`);
      expect(fixture.log.warnings).toEqual([]);
    });
  });

  test("copies files and whole directories out of the trunk", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await Bun.write(join(fixture.trunk, "certs", "dev.pem"), "pem\n");
      await Bun.write(join(fixture.trunk, "certs", "nested", "deep.txt"), "deep\n");
      await fixture.configure('[setup]\ncopy = [".env", "certs"]\n');

      const result = await setUp(fixture);

      expect(result.copied).toEqual([".env", "certs"]);
      expect(await Bun.file(join(fixture.worktree, ".env")).text()).toBe("SECRET=1\n");
      expect(await Bun.file(join(fixture.worktree, "certs", "dev.pem")).text()).toBe("pem\n");
      expect(await Bun.file(join(fixture.worktree, "certs", "nested", "deep.txt")).text()).toBe(
        "deep\n",
      );
      expect(describeSetup(result)).toBe("2 copied");
    });
  });

  test("links to the trunk's copy rather than duplicating it", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "node_modules", "left-pad", "index.js"), "//\n");
      await fixture.configure('[setup]\nlink = ["node_modules"]\n');

      const result = await setUp(fixture);
      const link = join(fixture.worktree, "node_modules");

      expect(result.linked).toEqual(["node_modules"]);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      // Relative, so moving the repository folder does not break it.
      expect(await readlink(link)).not.toStartWith("/");
      expect(await realpath(link)).toBe(await realpath(join(fixture.trunk, "node_modules")));
      expect(await Bun.file(join(link, "left-pad", "index.js")).text()).toBe("//\n");
    });
  });

  test("reports what the trunk did not have", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\ncopy = ["nothing-here.txt"]\nlink = ["also-absent"]\n');

      const result = await setUp(fixture);

      expect(result.missing).toEqual(["nothing-here.txt", "also-absent"]);
      expect(result.copied).toEqual([]);
      expect(describeSetup(result)).toBe("nothing to do");
      expect(fixture.log.infos.join("\n")).toContain("nothing-here.txt");
    });
  });

  test("takes the trunk's version of a file the worktree already had", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=fresh\n");
      await Bun.write(join(fixture.worktree, ".env"), "SECRET=stale\n");
      await fixture.configure('[setup]\ncopy = [".env"]\n');

      const result = await setUp(fixture);

      expect(await Bun.file(join(fixture.worktree, ".env")).text()).toBe("SECRET=fresh\n");
      expect(result.overwritten).toEqual([".env"]);
      expect(describeSetup(result)).toBe("1 copied, 1 overwritten");
    });
  });

  test("merges a directory entry by entry instead of replacing it", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "certs", "dev.pem"), "fresh\n");
      await Bun.write(join(fixture.trunk, "certs", "ca.pem"), "ca\n");
      await Bun.write(join(fixture.worktree, "certs", "dev.pem"), "stale\n");
      await Bun.write(join(fixture.worktree, "certs", "mine.pem"), "mine\n");
      await fixture.configure('[setup]\ncopy = ["certs"]\n');

      const result = await setUp(fixture);
      const at = (name: string) => Bun.file(join(fixture.worktree, "certs", name)).text();

      expect(await at("dev.pem")).toBe("fresh\n");
      expect(await at("ca.pem")).toBe("ca\n");
      // The worktree's own file survives — deleting the directory would have
      // taken it with it.
      expect(await at("mine.pem")).toBe("mine\n");
      expect(result.overwritten).toEqual(["certs/dev.pem"]);
    });
  });

  test("leaves a link alone when something is already there", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "node_modules", "a.js"), "trunk\n");
      await Bun.write(join(fixture.worktree, "node_modules", "b.js"), "mine\n");
      await fixture.configure('[setup]\nlink = ["node_modules"]\n');

      const result = await setUp(fixture);

      expect(result.kept).toEqual(["node_modules"]);
      expect(result.linked).toEqual([]);
      expect((await lstat(join(fixture.worktree, "node_modules"))).isSymbolicLink()).toBe(false);
      expect(await Bun.file(join(fixture.worktree, "node_modules", "b.js")).text()).toBe("mine\n");
      expect(describeSetup(result)).toBe("1 kept");
    });
  });

  test("warns about a copied file git would report as a change", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await Bun.write(join(fixture.trunk, "ignored.txt"), "x\n");
      await Bun.write(join(fixture.trunk, ".gitignore"), "ignored.txt\n");
      await seedGit(fixture.worktree, ["config", "core.excludesFile", "/dev/null"]);
      await Bun.write(join(fixture.worktree, ".gitignore"), "ignored.txt\n");
      await fixture.configure('[setup]\ncopy = [".env", "ignored.txt"]\n');

      await setUp(fixture);

      const warning = fixture.log.warnings.join("\n");

      expect(warning).toContain("not ignored here");
      expect(warning).toContain(".env");
      expect(warning).not.toContain("ignored.txt —");
    });
  });

  describe("commands", () => {
    const RUNS = [
      "[setup]",
      'env = { GREETING = "hello" }',
      `run = ['printf "%s|%s|%s|%s" "$GREETING" "$(pwd)" "$GROVE_WORKTREE" "$GROVE_BRANCH" > ran.txt']`,
    ].join("\n");

    test("waits for trust, and lets the files land anyway", async () => {
      await withRepo(async (fixture) => {
        await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
        await fixture.configure(`[setup]\ncopy = [".env"]\nrun = ["touch ran.txt"]\n`);

        const result = await setUp(fixture);

        expect(result.untrusted).toBe(true);
        expect(result.ran).toEqual([]);
        expect(await entryExists(join(fixture.worktree, "ran.txt"))).toBe(false);
        // The copy is the half that moves files already on this disk.
        expect(result.copied).toEqual([".env"]);
        expect(fixture.log.warnings.join("\n")).toContain("--trust");
        expect(describeSetup(result)).toBe("1 copied, commands not trusted");
      });
    });

    test("pendingCommands is what the screen offers, and empties once trusted", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["bun install", "bun run build"]\n');

        expect(await pendingCommands(fixture.repo)).toEqual(["bun install", "bun run build"]);

        const hooks = await repoHooks(fixture.repo);
        await trust(fixture.repo.gitDir, hooks.fingerprint ?? "");

        expect(await pendingCommands(fixture.repo)).toEqual([]);
      });
    });

    test("nothing pending for a repository that configures no commands", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\ncopy = [".env"]\n');

        expect(await pendingCommands(fixture.repo)).toEqual([]);
      });
    });

    test("trustAndRun records the file and then does what it says", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(`${RUNS}\n`);

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree, branch: fixture.branch },
          fixture.log.reporter,
        );

        expect(result.untrusted).toBe(false);
        expect(result.ran).toHaveLength(1);
        expect(await Bun.file(join(fixture.worktree, "ran.txt")).text()).toBe(
          // The environment, the cwd, and grove's own answer to "where am I".
          `hello|${fixture.worktree}|${fixture.worktree}|${fixture.branch}`,
        );
      });
    });

    test("a trusted file keeps running without asking again", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["touch ran.txt"]\n');
        await trustAndRun(fixture.repo, { path: fixture.worktree }, recorder().reporter);
        await rm(join(fixture.worktree, "ran.txt"));

        const again = await setUp(fixture);

        expect(again.untrusted).toBe(false);
        expect(again.ran).toEqual(["touch ran.txt"]);
      });
    });

    test("one edit to the file withdraws the trust it was given", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["touch ran.txt"]\n');
        await trustAndRun(fixture.repo, { path: fixture.worktree }, recorder().reporter);

        // What a `git pull` does: the commands change, so the answer no longer
        // covers them.
        await fixture.configure('[setup]\nrun = ["touch ran.txt", "touch surprise.txt"]\n');

        const again = await setUp(fixture);

        expect(again.untrusted).toBe(true);
        expect(again.ran).toEqual([]);
        expect(await entryExists(join(fixture.worktree, "surprise.txt"))).toBe(false);
      });
    });

    test("the file's env cannot lie to the command about where it is", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(
          [
            "[setup]",
            'env = { GROVE_WORKTREE = "/somewhere/else" }',
            `run = ['printf "%s" "$GROVE_WORKTREE" > where.txt']`,
          ].join("\n"),
        );

        await trustAndRun(fixture.repo, { path: fixture.worktree }, fixture.log.reporter);

        expect(await Bun.file(join(fixture.worktree, "where.txt")).text()).toBe(fixture.worktree);
      });
    });

    test("a failed command stops the ones after it and becomes an error", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure(
          [
            "[setup]",
            `run = ['touch first.txt', 'echo it broke >&2; exit 3', 'touch third.txt']`,
          ].join("\n"),
        );

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        expect(result.ran).toEqual(["touch first.txt"]);
        expect(result.failed).toMatchObject({ command: "echo it broke >&2; exit 3", code: 3 });
        expect(result.failed?.details.join("\n")).toContain("it broke");
        expect(await entryExists(join(fixture.worktree, "third.txt"))).toBe(false);

        const error = failureFor(result);

        expect(error?.code).toBe("setup-failed");
        expect(error?.message).toContain("exited 3");
        expect(error?.details.join("\n")).toContain("it broke");
        expect(errorToExitCode(error?.code ?? "usage")).toBe(ExitCode.setupFailed);
      });
    });

    test("no failure means no error to raise", async () => {
      await withRepo(async (fixture) => {
        await fixture.configure('[setup]\nrun = ["true"]\n');

        const result = await trustAndRun(
          fixture.repo,
          { path: fixture.worktree },
          fixture.log.reporter,
        );

        expect(failureFor(result)).toBeUndefined();
        expect(describeSetup(result)).toBe("1 run");
      });
    });
  });

  test("uses a file the caller already read", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await fixture.configure('[setup]\ncopy = ["never-read.txt"]\n');

      const result = await runSetup(
        fixture.repo,
        { path: fixture.worktree },
        { hooks: { ...NO_HOOKS, copy: [".env"] } },
        fixture.log.reporter,
      );

      expect(result.copied).toEqual([".env"]);
    });
  });
});

describe("describeSetup", () => {
  const base: SetupResult = {
    path: "/repo/feat/login",
    dir: "feat/login",
    planned: 0,
    copied: [],
    linked: [],
    ran: [],
    missing: [],
    kept: [],
    overwritten: [],
    untrusted: false,
  };

  test("nothing configured reads differently from nothing to do", () => {
    expect(describeSetup(base)).toBe(`no ${HOOKS_FILE}`);
    expect(describeSetup({ ...base, planned: 2 })).toBe("nothing to do");
  });

  test("counts what happened, in the order it happened", () => {
    expect(
      describeSetup({
        ...base,
        planned: 5,
        copied: [".env", "certs"],
        overwritten: [".env"],
        linked: ["node_modules"],
        ran: ["bun install"],
        kept: ["build"],
      }),
    ).toBe("2 copied, 1 overwritten, 1 linked, 1 run, 1 kept");
  });

  test("says when the commands are waiting on somebody", () => {
    expect(describeSetup({ ...base, planned: 1, untrusted: true })).toBe("commands not trusted");
  });
});

describe("the paths a configured line can reach", () => {
  /**
   * A committed symlink in the trunk is a path check `checkedPath` cannot
   * see: the value has no `..` in it, and the climb happens on disk instead.
   *
   * So the disk is what decides. `copy = ["certs/id_rsa"]` against a trunk
   * where `certs` is a symlink to `~/.ssh` is refused rather than run, and the
   * key never reaches a worktree somebody is about to commit from.
   */
  test("a copy cannot follow a symlink in the source out of the worktree", async () => {
    await withRepo(async (fixture) => {
      const outside = join(fixture.temp.root, "outside");
      await mkdir(outside, { recursive: true });
      await Bun.write(join(outside, "id_rsa"), "PRIVATE KEY\n");

      // What a repository can commit: a symlink under an innocent name.
      await symlink(outside, join(fixture.trunk, "certs"));

      await fixture.configure('[setup]\ncopy = ["certs/id_rsa"]\n');

      const error = await refusalFromRun(() => setUp(fixture));

      expect(error.code).toBe("usage");
      expect(error.message).toContain('"certs/id_rsa"');
      expect(error.details.join("\n")).toContain(join(outside, "id_rsa"));
      expect(await entryExists(join(fixture.worktree, "certs", "id_rsa"))).toBe(false);
    });
  });

  test("a link source out of the worktree is refused too", async () => {
    await withRepo(async (fixture) => {
      const outside = join(fixture.temp.root, "outside");
      await mkdir(join(outside, "node_modules"), { recursive: true });
      await symlink(join(outside, "node_modules"), join(fixture.trunk, "node_modules"));

      await fixture.configure('[setup]\nlink = ["node_modules"]\n');

      expect((await refusalFromRun(() => setUp(fixture))).code).toBe("usage");
      expect(await entryExists(join(fixture.worktree, "node_modules"))).toBe(false);
    });
  });

  test("a link inside the directory being copied is checked as well", async () => {
    await withRepo(async (fixture) => {
      const outside = join(fixture.temp.root, "outside");
      await mkdir(outside, { recursive: true });
      await Bun.write(join(outside, "id_rsa"), "PRIVATE KEY\n");

      await mkdir(join(fixture.trunk, "config", "keys"), { recursive: true });
      await symlink(join(outside, "id_rsa"), join(fixture.trunk, "config", "keys", "id_rsa"));

      await fixture.configure('[setup]\ncopy = ["config"]\n');

      const error = await refusalFromRun(() => setUp(fixture));

      expect(error.message).toContain('"config/keys/id_rsa"');
      expect(await entryExists(join(fixture.worktree, "config"))).toBe(false);
    });
  });

  test("a symlink that stays inside the worktree is still taken", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "config", "dev.json"), "{}\n");
      await symlink("dev.json", join(fixture.trunk, "config", "local.json"));
      // A link pointing at nothing yet is where it points, not whether it lands.
      await symlink("not-yet.json", join(fixture.trunk, "config", "pending.json"));

      await fixture.configure('[setup]\ncopy = ["config"]\n');

      expect((await setUp(fixture)).copied).toEqual(["config"]);
      expect(await readlink(join(fixture.worktree, "config", "local.json"))).toBe("dev.json");
    });
  });

  test("a link is created inside the worktree it was made for", async () => {
    await withRepo(async (fixture) => {
      await Bun.write(join(fixture.trunk, "node_modules", "a.js"), "//\n");
      await fixture.configure('[setup]\nlink = ["node_modules"]\n');

      await setUp(fixture);

      const link = join(fixture.worktree, "node_modules");
      const target = resolve(dirname(link), await readlink(link));

      expect(target).toBe(join(fixture.trunk, "node_modules"));
    });
  });
});
