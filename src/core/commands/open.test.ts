import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoHooks } from "../../hooks/source.ts";
import { waitForEntry } from "../../hooks/test-utils.ts";
import { trust } from "../../hooks/trust.ts";
import {
  attempt,
  managedRepo,
  recorder,
  refused,
  seedWorktree,
  withTempRepo,
} from "../test-utils.ts";
import { openWorktree } from "./open.ts";

/**
 * `grove open` — the `[setup] open` line, asked for on its own.
 *
 * Two halves, and they are tested apart. Which worktree it lands on is this
 * command's own work: a named one, the one the shell is standing in, or a
 * refusal that says so. What happens then belongs to the hook, and is asserted
 * here only where `open` differs from the `add` that used to be its only
 * caller — a file with no `open` line is a mistake when it is the whole of what
 * you asked for, and merely quiet when it is the tail of something else.
 *
 * Nothing here starts an editor. `open` runs a shell line and lets go of it, so
 * the line is `touch`, and what proves it ran is the file turning up.
 */

/** A repository whose trunk asks to open something, and a second worktree. */
async function withOpener(
  line: string,
  body: (fixture: {
    readonly root: string;
    readonly repo: Awaited<ReturnType<typeof managedRepo>>;
    readonly worktree: string;
  }) => Promise<void>,
): Promise<void> {
  await withTempRepo(async (temp) => {
    const repo = await managedRepo(temp);
    await Bun.write(join(repo.root, "main", ".grove.toml"), `[setup]\nopen = ${line}\n`);
    const added = await seedWorktree(repo, "feat/login");

    await body({ root: repo.root, repo, worktree: added.path });
  });
}

describe("openWorktree", () => {
  test("opens the named worktree with what the file says", async () => {
    await withOpener('"touch opened.txt"', async ({ repo, worktree }) => {
      const log = recorder();
      const result = await openWorktree(
        repo,
        repo.root,
        { target: "feat/login", trust: true, open: true },
        log.reporter,
      );

      expect(result.dir).toBe("feat/login");
      expect(result.opened).toBe("touch opened.txt");
      expect(result.untrusted).toBe(false);
      // The line runs in the worktree, so `.` there is the worktree.
      expect(await waitForEntry(join(worktree, "opened.txt"))).toBe(true);
    });
  });

  test("no target is the worktree the shell is standing in, wherever in it", async () => {
    await withOpener('"touch opened.txt"', async ({ repo, worktree }) => {
      const inside = join(worktree, "src", "deep");
      await Bun.write(join(inside, "keep.txt"), "");

      const log = recorder();
      const result = await openWorktree(repo, inside, { trust: true, open: true }, log.reporter);

      expect(result.dir).toBe("feat/login");
      expect(await waitForEntry(join(worktree, "opened.txt"))).toBe(true);
    });
  });

  test("the repository root is in no worktree, and the refusal lists the ones there are", async () => {
    await withOpener('"touch opened.txt"', async ({ repo }) => {
      const error = refused(
        await attempt((reporter) =>
          openWorktree(repo, repo.root, { trust: true, open: true }, reporter),
        ),
      );

      expect(error.code).toBe("usage");
      expect(error.message).toContain("not inside a worktree");
      expect(error.details).toEqual(["feat/login", "main"]);
    });
  });

  test("a file with no open line is a refusal, because it is what was asked for", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await Bun.write(join(repo.root, "main", ".grove.toml"), '[setup]\nrun = ["true"]\n');

      const error = refused(
        await attempt((reporter) =>
          openWorktree(repo, repo.root, { target: "main", trust: true, open: true }, reporter),
        ),
      );

      expect(error.code).toBe("usage");
      expect(error.message).toContain("opens");
      expect(error.hint).toContain('open = "code ."');
    });
  });

  test("an untrusted line is not run, and the warning says where to read it", async () => {
    await withOpener('"touch opened.txt"', async ({ repo, worktree }) => {
      const log = recorder();
      const result = await openWorktree(
        repo,
        repo.root,
        { target: "feat/login", trust: false, open: true },
        log.reporter,
      );

      expect(result.untrusted).toBe(true);
      expect(result.opened).toBeUndefined();
      expect(log.err.join("")).toContain("main/.grove.toml");
      // Long enough to catch a launch that should not have happened.
      await Bun.sleep(200);
      expect(await Bun.file(join(worktree, "opened.txt")).exists()).toBe(false);
    });
  });

  test("the trust it records is the one the commands answer to", async () => {
    await withOpener('"touch opened.txt"', async ({ repo }) => {
      const log = recorder();
      await openWorktree(
        repo,
        repo.root,
        { target: "feat/login", trust: true, open: true },
        log.reporter,
      );

      // One record for the whole file, so agreeing here is agreeing for `add`.
      const hooks = await repoHooks(repo);
      expect(
        await openWorktree(
          repo,
          repo.root,
          { target: "feat/login", trust: false, open: true },
          recorder().reporter,
        ),
      ).toMatchObject({ untrusted: false });
      expect(hooks.fingerprint).toBeDefined();
    });
  });

  test("nowhere to open into is not a failure, and it says so", async () => {
    await withOpener('"touch opened.txt"', async ({ repo, worktree }) => {
      const hooks = await repoHooks(repo);
      await trust(repo.gitDir, hooks.fingerprint ?? "");

      const log = recorder();
      const result = await openWorktree(
        repo,
        repo.root,
        { target: "feat/login", trust: false, open: false },
        log.reporter,
      );

      expect(result.opened).toBeUndefined();
      expect(result.untrusted).toBe(false);
      expect(log.err.join("")).toContain("not a terminal");
      await Bun.sleep(200);
      expect(await Bun.file(join(worktree, "opened.txt")).exists()).toBe(false);
    });
  });
});
