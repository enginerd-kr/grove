import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { entryExists } from "../core/fs.ts";
import { seedGit } from "../core/test-utils.ts";
import { HOOKS_FILE, platformKeyFor } from "./config.ts";
import { runSetup } from "./setup.ts";
import { runTeardown } from "./teardown.ts";
import { type Fixture, withRepo } from "./test-utils.ts";

describe("runTeardown", () => {
  const teardown = (fixture: Fixture) =>
    runTeardown(
      fixture.repo,
      { path: fixture.worktree, branch: fixture.branch },
      fixture.log.reporter,
    );

  test("a repository with no [teardown] has nothing to run", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\ncopy = [".env"]\n');

      expect(await teardown(fixture)).toMatchObject({ planned: 0, ran: [] });
      expect(fixture.log.warnings).toEqual([]);
    });
  });

  test("runs the commands inside the worktree, with [teardown]'s own env", async () => {
    await withRepo(async (fixture) => {
      const text = [
        "[setup]",
        'env = { TOKEN = "install" }',
        "",
        "[teardown]",
        'env = { TOKEN = "cleanup" }',
        `run = ['printf "%s|%s" "$TOKEN" "$(pwd)" > /dev/stderr; printf "%s|%s" "$TOKEN" "$(pwd)" > gone.txt']`,
      ].join("\n");
      await fixture.configure(`${text}\n`);

      const result = await teardown(fixture);

      expect(result.ran).toHaveLength(1);
      expect(result.failed).toBeUndefined();
      // `[setup]`'s value is not in reach: the credential that installs and the
      // one that tears down are rarely the same.
      expect(await Bun.file(join(fixture.worktree, "gone.txt")).text()).toBe(
        `cleanup|${fixture.worktree}`,
      );
    });
  });

  test("runs the platform's own [teardown.run] lines, with its own variables", async () => {
    await withRepo(async (fixture) => {
      const here = platformKeyFor(process.platform);
      const elsewhere = here === "macos" ? "linux" : "macos";
      const text = [
        "[teardown.env]",
        `${here} = { WHO = "${here}" }`,
        "",
        "[teardown.run]",
        `${here} = ['printf "%s" "$WHO" > here.txt']`,
        `${elsewhere} = ['touch elsewhere.txt']`,
      ].join("\n");
      await fixture.configure(`${text}\n`);

      const result = await teardown(fixture);

      expect(result.planned).toBe(1);
      expect(result.failed).toBeUndefined();
      expect(await Bun.file(join(fixture.worktree, "here.txt")).text()).toBe(here);
      // The other machine's line was read and checked, and not run.
      expect(await entryExists(join(fixture.worktree, "elsewhere.txt"))).toBe(false);
    });
  });

  test("a failing command is loud, but does not block the removal", async () => {
    await withRepo(async (fixture) => {
      const text = [
        "[teardown]",
        `run = ['echo docker is not running >&2; exit 7', 'touch never.txt']`,
      ].join("\n");
      await fixture.configure(`${text}\n`);

      // Resolves rather than throws — that is the whole rule.
      const result = await teardown(fixture);

      expect(result.failed).toMatchObject({ code: 7 });
      expect(result.failed?.details.join("\n")).toContain("docker is not running");
      expect(result.ran).toEqual([]);
      expect(await entryExists(join(fixture.worktree, "never.txt"))).toBe(false);
      expect(fixture.log.failed.join("\n")).toContain("exited 7");

      // And the worktree it was finished with really can go.
      await seedGit(fixture.repo.gitDir, ["worktree", "remove", "--force", fixture.worktree]);
      expect(await entryExists(fixture.worktree)).toBe(false);
    });
  });

  test("runs teardown commands without a prior setup", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[teardown]\nrun = ["touch cleanup.txt"]\n');

      const result = await teardown(fixture);

      expect(result).toMatchObject({ planned: 1, ran: ["touch cleanup.txt"] });
      expect(await entryExists(join(fixture.worktree, "cleanup.txt"))).toBe(true);
      expect(fixture.log.warnings).toEqual([]);
    });
  });

  test("setup edits do not prevent teardown from running", async () => {
    await withRepo(async (fixture) => {
      const text = [
        "[setup]",
        `run = ['touch setup-ran.txt']`,
        "",
        "[teardown]",
        `run = ['touch teardown-ran.txt']`,
      ].join("\n");
      await fixture.configure(`${text}\n`);

      await runSetup(fixture.repo, { path: fixture.worktree }, {}, fixture.log.reporter);

      expect(await entryExists(join(fixture.worktree, "setup-ran.txt"))).toBe(true);
      expect((await teardown(fixture)).ran).toEqual(["touch teardown-ran.txt"]);
      expect(await entryExists(join(fixture.worktree, "teardown-ran.txt"))).toBe(true);

      const edited = text.replace("setup-ran.txt", "setup-ran-again.txt");
      await fixture.configure(`${edited}\n`);
      await rm(join(fixture.worktree, "teardown-ran.txt"));

      const after = await teardown(fixture);

      expect(after.ran).toEqual(["touch teardown-ran.txt"]);
      expect(await entryExists(join(fixture.worktree, "teardown-ran.txt"))).toBe(true);
    });
  });

  test("reads [teardown] from the trunk, like everything else here", async () => {
    await withRepo(async (fixture) => {
      const text = "[teardown]\nrun = ['touch from-trunk.txt']\n";
      await fixture.configure(text);
      await Bun.write(
        join(fixture.worktree, HOOKS_FILE),
        "[teardown]\nrun = ['touch from-worktree.txt']\n",
      );

      await teardown(fixture);

      expect(await entryExists(join(fixture.worktree, "from-trunk.txt"))).toBe(true);
      expect(await entryExists(join(fixture.worktree, "from-worktree.txt"))).toBe(false);
    });
  });
});
