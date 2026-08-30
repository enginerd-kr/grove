import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `list` is the command everything else is read through, so what is asserted
 * here is the row: which worktrees are on it, what state each is reported in,
 * and that the machine-readable answer says the same thing on the stream a
 * pipeline reads.
 */

type Summary = {
  readonly dir: string;
  readonly branch?: string;
  readonly dirty: boolean;
  readonly changed: number;
  readonly untracked: number;
  readonly ahead: number;
  readonly behind: number;
  readonly upstream?: string;
  readonly trunk?: { readonly ahead: number; readonly behind: number };
  readonly finished?: "gone" | "merged";
  readonly isDefault: boolean;
  readonly current: boolean;
};

type Row = {
  readonly current: boolean;
  readonly branch: string;
  readonly dir: string;
  readonly state: string;
};

/** The padded table, read back as rows. `*` is in the first column, always. */
function rows(stdout: string): readonly Row[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [branch = "", dir = "", state = ""] = line.slice(2).split(/\s{2,}/);

      return { current: line.startsWith("*"), branch, dir, state };
    });
}

async function clone(repo: TempRepo): Promise<string> {
  const result = await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work });
  expect(result.exitCode).toBe(ExitCode.ok);

  return join(repo.work, "app");
}

async function summaries(cwd: string): Promise<readonly Summary[]> {
  const result = await runCli(["list", "--json"], { cwd });
  expect(result.exitCode).toBe(ExitCode.ok);

  return JSON.parse(result.stdout) as readonly Summary[];
}

/** Commits `message` in `worktree`, staging whatever is there. */
async function commit(worktree: string, message: string): Promise<void> {
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
}

describe("what the table says", () => {
  test("every worktree, its branch, and whether it is clean", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(ExitCode.ok);

      const clean = await runCli(["list"], { cwd: root });
      expect(clean.exitCode).toBe(ExitCode.ok);
      // The trunk first, then alphabetically — a stable order two runs can be
      // diffed against each other.
      expect(rows(clean.stdout)).toEqual([
        { current: false, branch: "main", dir: "main", state: "clean" },
        { current: false, branch: "feat/login", dir: "feat/login", state: "clean" },
      ]);

      const login = join(root, "feat", "login");
      await Bun.write(join(login, "scratch.txt"), "wip\n");

      const dirty = await runCli(["list"], { cwd: login });
      // `*` marks where you are standing, which is what people open this for.
      expect(rows(dirty.stdout)).toEqual([
        { current: false, branch: "main", dir: "main", state: "clean" },
        { current: true, branch: "feat/login", dir: "feat/login", state: "dirty" },
      ]);

      const [, summary] = await summaries(login);
      expect(summary).toMatchObject({
        dir: "feat/login",
        branch: "feat/login",
        dirty: true,
        changed: 1,
        untracked: 1,
        current: true,
        isDefault: false,
      });
    });
  }, 60_000);

  test("drift is counted after a local commit, and again after the origin moves", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(ExitCode.ok);
      const login = join(root, "feat", "login");

      await Bun.write(join(login, "mine.txt"), "mine\n");
      await commit(login, "Add mine");

      const ahead = await runCli(["list"], { cwd: root });
      expect(rows(ahead.stdout)[1]?.state).toBe("1 ahead");

      // The remote gains a commit of its own, from a clone standing in for
      // somebody else's laptop.
      const scratch = join(repo.root, "scratch");
      await seedGit(repo.root, ["clone", repo.originPath, scratch]);
      await seedGit(scratch, ["checkout", "feat/login"]);
      await Bun.write(join(scratch, "theirs.txt"), "theirs\n");
      await commit(scratch, "Add theirs");
      await seedGit(scratch, ["push", "origin", "feat/login"]);
      // `list` reports what the last fetch saw, and does not fetch itself.
      await seedGit(join(root, ".bare"), ["fetch", "origin", "--prune"]);

      const both = await runCli(["list"], { cwd: root });
      expect(rows(both.stdout)[1]?.state).toBe("1 ahead, 1 behind");

      const [, summary] = await summaries(root);
      expect(summary).toMatchObject({
        ahead: 1,
        behind: 1,
        upstream: "origin/feat/login",
        // A second question entirely: how far this branch has drifted from the
        // trunk, which is what `sync` closes. Two, because the fixture's own
        // `login` commit is on it as well as the one made here.
        trunk: { ahead: 2, behind: 0 },
      });
    });
  }, 60_000);

  test("the merged and gone badges are the two traces a finished branch leaves", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      // Pushed and still there, with nothing on it the trunk does not have.
      expect((await runCli(["add", "squashed", "--push"], { cwd: root })).exitCode).toBe(
        ExitCode.ok,
      );
      // Pushed, then deleted on the remote — a merged pull request.
      expect((await runCli(["add", "landed", "--push"], { cwd: root })).exitCode).toBe(ExitCode.ok);
      await seedGit(repo.originPath, ["branch", "-D", "landed"]);
      // A branch only reads as gone once a fetch has pruned the ref.
      await seedGit(join(root, ".bare"), ["fetch", "origin", "--prune"]);

      const table = rows((await runCli(["list"], { cwd: root })).stdout);

      expect(table).toEqual([
        // The trunk is never finished with, whatever is true of it.
        { current: false, branch: "main", dir: "main", state: "clean" },
        { current: false, branch: "landed", dir: "landed", state: "gone" },
        { current: false, branch: "squashed", dir: "squashed", state: "merged" },
      ]);

      const found = await summaries(root);
      expect(found.map((summary) => [summary.dir, summary.finished])).toEqual([
        ["main", undefined],
        ["landed", "gone"],
        ["squashed", "merged"],
      ]);
    });
  }, 60_000);
});

describe("--json", () => {
  test("goes to stdout while the progress goes to stderr", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      // `--verbose` is the loudest this gets: every git command, its exit code
      // and its timing. None of it may reach the stream `jq` is reading.
      const result = await runCli(["list", "--json", "--verbose"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stderr).toContain("git ");
      expect(result.stderr).toContain("rev-parse");
      expect(result.stdout).not.toContain("rev-parse");

      const parsed = JSON.parse(result.stdout) as readonly Summary[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        dir: "main",
        branch: "main",
        dirty: false,
        isDefault: true,
        upstream: "origin/main",
      });
    });
  }, 60_000);

  test("carries the changed paths, counted apart by whether git is tracking them", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const main = join(root, "main");

      await Bun.write(join(main, "app.txt"), "changed\n");
      await Bun.write(join(main, "extra.txt"), "new\n");

      const [summary] = await summaries(main);

      expect(summary).toMatchObject({ dirty: true, changed: 2, untracked: 1 });
      // Untracked ones are destroyed by a different command than tracked ones,
      // which is why they are counted separately rather than lumped together.
      expect((await runCli(["list"], { cwd: main })).stdout).toContain("dirty");
    });
  }, 60_000);
});
