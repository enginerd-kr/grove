import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `add` decides three different things and then fills a directory in, so the
 * scenarios below are grouped by which decision they are about: where the
 * branch came from, what the flags change, and what `.grove.toml` is allowed
 * to do.
 */

type AddJson = {
  readonly path: string;
  readonly dir: string;
  readonly branch: string;
  readonly source: "existing" | "remote" | "new";
  readonly upstream?: string;
  readonly alreadyPresent: boolean;
  readonly setup?: {
    readonly planned: number;
    readonly copied: readonly string[];
    readonly linked: readonly string[];
    readonly ran: readonly string[];
    readonly untrusted: boolean;
  };
};

/** A managed repository at `<work>/app`, which is where every scenario starts. */
async function clone(repo: TempRepo): Promise<string> {
  const result = await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work });
  expect(result.exitCode).toBe(ExitCode.ok);

  return join(repo.work, "app");
}

async function add(cwd: string, args: readonly string[]): Promise<AddJson> {
  const result = await runCli(["add", ...args, "--json"], { cwd });
  expect([args, result.exitCode, result.stderr]).toEqual([args, ExitCode.ok, result.stderr]);

  return JSON.parse(result.stdout) as AddJson;
}

/** What git thinks the branch tracks, or nothing. */
async function upstreamOf(worktree: string): Promise<string | undefined> {
  const result = await probeGit(worktree, ["rev-parse", "--abbrev-ref", "@{upstream}"]);

  return result.code === 0 ? result.stdout.trim() : undefined;
}

describe("where the branch comes from", () => {
  test("a remote branch is tracked, a local one is used, and anything else is created", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const bare = join(root, ".bare");

      // On the remote: tracked, with the upstream set from the start.
      const remote = await add(root, ["feat/login"]);
      expect(remote.source).toBe("remote");
      expect(remote.upstream).toBe("origin/feat/login");
      // The directory follows the branch's own shape.
      expect(remote.path).toBe(join(root, "feat", "login"));
      expect(await Bun.file(join(root, "feat", "login", "login.txt")).text()).toBe("login\n");
      expect(await upstreamOf(remote.path)).toBe("origin/feat/login");

      // Already a local branch: used as it is.
      await seedGit(bare, ["branch", "existing", "refs/remotes/origin/main"]);
      const existing = await add(root, ["existing"]);
      expect(existing.source).toBe("existing");
      expect(existing.path).toBe(join(root, "existing"));

      // Nowhere yet: created from the default branch.
      const fresh = await add(root, ["fresh"]);
      expect(fresh.source).toBe("new");
      // No upstream, because nobody has pushed it — and `--no-track` is what
      // keeps it from quietly tracking origin/main and reporting main's drift.
      expect(fresh.upstream).toBeUndefined();
      expect(await upstreamOf(fresh.path)).toBeUndefined();
      expect((await probeGit(bare, ["config", "--get", "branch.fresh.remote"])).code).not.toBe(0);
      expect(await Bun.file(join(fresh.path, "app.txt")).text()).toBe("one\n");
    });
  }, 60_000);

  test("asking again for a worktree that is there is not an error", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      await add(root, ["feat/login"]);

      const again = await add(root, ["feat/login"]);

      // Idempotent, which is what makes it safe to put in a script.
      expect(again.alreadyPresent).toBe(true);
      expect(again.path).toBe(join(root, "feat", "login"));
    });
  }, 60_000);

  test("--json names the directory the way the list does", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      // Repo-root-relative and `/`-separated whatever the platform's separator
      // is — the spelling `path`, `reset` and `rename` already answer with, so
      // a `--json` reader can line this row up with `grove list` without
      // re-deriving it from the absolute path beside it.
      const nested = await add(root, ["feat/login"]);
      expect(nested.dir).toBe("feat/login");
      expect(nested.path).toBe(join(root, "feat", "login"));

      // The command's other way out: a worktree that was already there answers
      // with the same field rather than dropping it.
      const again = await add(root, ["feat/login"]);
      expect([again.alreadyPresent, again.dir]).toEqual([true, "feat/login"]);
    });
  }, 60_000);

  test("the fetch is what separates 'not on the remote' from 'not as far as we looked'", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      // Two branches that appeared on the remote after the clone.
      await seedGit(repo.originPath, ["branch", "late-a", "main"]);
      await seedGit(repo.originPath, ["branch", "late-b", "main"]);

      // --no-fetch works from the refs as they were last seen, so this one is
      // created locally and would collide on push.
      expect((await add(root, ["late-a", "--no-fetch"])).source).toBe("new");
      // The default fetch finds the other one and tracks it instead.
      expect((await add(root, ["late-b"])).source).toBe("remote");
    });
  }, 60_000);
});

describe("the flags", () => {
  test("--from bases a new branch somewhere else", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      const result = await add(root, ["spike", "--from", "origin/feat/login"]);

      expect(result.source).toBe("new");
      // Cut from feat/login rather than from the default branch.
      expect(await Bun.file(join(result.path, "login.txt")).text()).toBe("login\n");

      const bad = await runCli(["add", "other", "--from", "nowhere"], { cwd: root });
      expect(bad.exitCode).toBe(ExitCode.usage);
      expect(bad.stderr).toContain('cannot start a branch from "nowhere"');
      expect(await Bun.file(join(root, "other")).exists()).toBe(false);
    });
  }, 60_000);

  test("--push puts the branch on the remote and sets its upstream", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      const result = await add(root, ["shipped", "--push"]);

      expect(result.upstream).toBe("origin/shipped");
      expect(await upstreamOf(result.path)).toBe("origin/shipped");
      expect(
        (await probeGit(repo.originPath, ["rev-parse", "--verify", "refs/heads/shipped"])).code,
      ).toBe(0);
    });
  }, 60_000);

  test("--take carries the uncommitted work over and leaves the old worktree clean", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const main = join(root, "main");

      await Bun.write(join(main, "app.txt"), "two\n");
      await Bun.write(join(main, "untracked.txt"), "new\n");

      const result = await runCli(["add", "wip", "--take"], { cwd: main });
      expect(result.exitCode).toBe(ExitCode.ok);

      const wip = join(root, "wip");
      expect(await Bun.file(join(wip, "app.txt")).text()).toBe("two\n");
      expect(await Bun.file(join(wip, "untracked.txt")).text()).toBe("new\n");

      // And the worktree it came from is back to what it had committed.
      expect(await Bun.file(join(main, "app.txt")).text()).toBe("one\n");
      expect(await Bun.file(join(main, "untracked.txt")).exists()).toBe(false);
      expect((await probeGit(main, ["status", "--porcelain"])).stdout).toBe("");
      // The sha that undoes it is said out loud rather than left to be found.
      expect(result.stderr).toContain("git stash apply");
    });
  }, 60_000);

  test("--take from somewhere that is not a worktree is refused before anything is made", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      // The root is the one directory that is never a worktree.
      const result = await runCli(["add", "wip", "--take"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stderr).toContain("--take moves the changes of the worktree you are in");
      expect(await Bun.file(join(root, "wip")).exists()).toBe(false);
    });
  }, 60_000);
});

describe(".grove.toml", () => {
  /** A trunk carrying a setup file, plus the files it names. */
  async function seedSetupFile(root: string): Promise<void> {
    const main = join(root, "main");

    await Bun.write(
      join(main, ".grove.toml"),
      `[setup]
copy = [".env"]
link = ["node_modules"]
run = ["sh -c 'echo ok > ran.txt'"]
`,
    );
    await Bun.write(join(main, ".env"), "SECRET=1\n");
    await mkdir(join(main, "node_modules"), { recursive: true });
    await Bun.write(join(main, "node_modules", "marker"), "dep\n");

    await seedGit(main, ["add", "--", ".grove.toml"]);
    await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a setup file"]);
  }

  /**
   * The on-disk half of `checkedSetupPath`, from the outside.
   *
   * `setup.test.ts` proves the refusal itself; what only `add` can show is what
   * it costs — the worktree is created before `.grove.toml` is read, so a
   * repository that commits a symlink out of the tree leaves a directory behind
   * and a non-zero exit. Loud is the right answer to an attempt at somebody's
   * keys, but it is a different exit code than a merely failing `run` command,
   * which `setUpWorktree` downgrades to a warning — so it is pinned here.
   */
  test("a setup file that reaches outside the worktree fails the add", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const main = join(root, "main");
      const outside = join(repo.root, "outside");

      await mkdir(outside, { recursive: true });
      await Bun.write(join(outside, "id_rsa"), "a private key\n");

      // What a repository can commit: an innocent name pointing anywhere.
      await symlink(outside, join(main, "certs"));
      await Bun.write(join(main, ".grove.toml"), '[setup]\ncopy = ["certs/id_rsa"]\n');
      await seedGit(main, ["add", "--", ".grove.toml", "certs"]);
      await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a setup file"]);

      const result = await runCli(["add", "feat/login"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.usage);
      expect(result.stderr).toContain("leads out of the worktree");
      // The worktree is still there — it was made before the file was read —
      // but the thing the setup file was reaching for never arrived.
      expect(await Bun.file(join(root, "feat", "login", "app.txt")).exists()).toBe(true);
      expect(await Bun.file(join(root, "feat", "login", "certs", "id_rsa")).exists()).toBe(false);
    });
  }, 60_000);

  test("copy and link apply on sight, while run waits on --trust", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      await seedSetupFile(root);

      const untrusted = await add(root, ["feat/login"]);

      expect(untrusted.setup?.copied).toEqual([".env"]);
      expect(untrusted.setup?.linked).toEqual(["node_modules"]);
      expect(await Bun.file(join(untrusted.path, ".env")).text()).toBe("SECRET=1\n");
      expect(await Bun.file(join(untrusted.path, "node_modules", "marker")).text()).toBe("dep\n");
      // A `run` line is code that arrived with a pull, so it is reported and
      // skipped until somebody says they have read it.
      expect(untrusted.setup?.untrusted).toBe(true);
      expect(untrusted.setup?.ran).toEqual([]);
      expect(await Bun.file(join(untrusted.path, "ran.txt")).exists()).toBe(false);

      const trusted = await add(root, ["trusted", "--trust"]);

      expect(trusted.setup?.untrusted).toBe(false);
      expect(trusted.setup?.ran).toEqual(["sh -c 'echo ok > ran.txt'"]);
      expect(await Bun.file(join(trusted.path, "ran.txt")).text()).toBe("ok\n");
    });
  }, 60_000);

  test("the warning names the file to read, and --no-setup skips the lot", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      await seedSetupFile(root);

      const warned = await runCli(["add", "feat/login"], { cwd: root });
      expect(warned.stderr).toContain("main/.grove.toml");
      expect(warned.stderr).toContain("--trust");

      const skipped = await add(root, ["quiet", "--no-setup"]);

      expect(skipped.setup).toBeUndefined();
      expect(await Bun.file(join(skipped.path, ".env")).exists()).toBe(false);
      expect(await Bun.file(join(skipped.path, "node_modules")).exists()).toBe(false);
      expect(await Bun.file(join(skipped.path, "ran.txt")).exists()).toBe(false);
    });
  }, 60_000);
});

describe("what add refuses", () => {
  test("a branch already checked out somewhere else names the directory holding it", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const elsewhere = join(repo.root, "elsewhere");

      // A worktree made by hand, outside the layout `add` would have used.
      await seedGit(join(root, ".bare"), ["worktree", "add", elsewhere, "-b", "taken"]);

      const result = await runCli(["add", "taken"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.stateConflict);
      expect(result.stderr).toContain(`"taken" is already checked out at ${elsewhere}`);
      expect(await Bun.file(join(root, "taken")).exists()).toBe(false);
    });
  }, 60_000);

  test("a directory that is already there is left alone", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      await mkdir(join(root, "occupied"), { recursive: true });
      await Bun.write(join(root, "occupied", "mine.txt"), "keep\n");

      const result = await runCli(["add", "occupied"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.stateConflict);
      expect(result.stderr).toContain("occupied already exists");
      expect(await Bun.file(join(root, "occupied", "mine.txt")).text()).toBe("keep\n");
    });
  }, 60_000);

  test("a worktree that would nest inside another is refused", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      // `feat` as a worktree makes `feat/login` a directory inside it, which
      // git allows and which leaves each reporting the other's files.
      await seedGit(join(root, ".bare"), ["worktree", "add", join(root, "feat"), "-b", "feat-x"]);

      const result = await runCli(["add", "feat/login"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.stateConflict);
      expect(result.stderr).toContain("that would nest with the worktree at feat");
    });
  }, 60_000);
});
