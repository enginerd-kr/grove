import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { pathExists } from "../fs.ts";
import type { RepoPaths } from "../layout.ts";
import {
  managedRepo,
  probeGit,
  seedGit,
  seedWorktree,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";

/**
 * `grove prune` through the real binary.
 *
 * What `pruneWorktrees` decides is asserted in-process in `prune.test.ts`,
 * where the `PruneResult` can be read field by field. Two things are left that
 * a direct call cannot reach.
 *
 * The first is the `--json` document. It is not the result: `cli/run.ts`
 * serialises it, and the property this command has to keep — a row without a
 * branch is *absent* from the object rather than an empty string, the way
 * `list`, `remove` and `reset` spell it — only exists once the value has been
 * through `JSON.stringify` and come back. Asserting the key set of the parsed
 * object is the only way to say it.
 *
 * The second is which stream each half goes to. `prune` prints counts and rows
 * both, and the counts are on stderr on purpose so that `grove prune -n | wc
 * -l` counts worktrees. That split, and the `-n` spelling of `--dry-run`
 * reaching the same place `--dry-run` does, are facts about the binary.
 *
 * The fixtures are built in-process, because a `clone` and an `add` spent on
 * arranging a repository buy nothing that a function call does not.
 */

/** The half of `PruneResult` these tests read back out of `--json`. */
type PruneJson = {
  readonly entries: readonly {
    readonly path: string;
    readonly dir: string;
    readonly branch?: string;
    readonly reason: "gone" | "merged";
    readonly skipped?: string;
    readonly branchDeleted: boolean;
    readonly branchKept?: string;
  }[];
  readonly dryRun: boolean;
};

/** A branch with a commit of its own, pushed — the state a pull request starts in. */
async function proposed(repo: RepoPaths, branch: string, file: string): Promise<string> {
  const added = await seedWorktree(repo, branch, { push: true });
  await Bun.write(join(added.path, file), `${file}\n`);
  await seedGit(added.path, ["add", "-A"]);
  await seedGit(added.path, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
  await seedGit(added.path, ["push", "origin", `HEAD:${branch}`]);

  return added.path;
}

/** What a merged pull request with the delete box ticked leaves behind. */
async function deleteOnOrigin(temp: TempRepo, branch: string): Promise<void> {
  await seedGit(temp.originPath, ["branch", "-D", branch]);
}

/** Lands a branch on the origin's trunk, the way a forge would. */
async function landOnOrigin(temp: TempRepo, branch: string): Promise<void> {
  const scratch = join(temp.root, `elsewhere-e2e-${branch.replaceAll("/", "-")}`);
  await seedGit(temp.root, ["clone", "--branch", "main", temp.originPath, scratch]);
  await seedGit(scratch, [
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--no-ff",
    "-m",
    `Merge ${branch}`,
    `origin/${branch}`,
  ]);
  await seedGit(scratch, ["push", "origin", "HEAD:main"]);
  await rm(scratch, { recursive: true, force: true });
}

describe("grove prune, through the binary", () => {
  test("--json spells the branch the way every other payload does", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      const landed = await proposed(repo, "landed", "landed.txt");
      await landOnOrigin(temp, "landed");

      const dry = await runCli(["prune", "--dry-run", "--json"], { cwd: root });
      expect(dry.exitCode).toBe(ExitCode.ok);

      const planned = JSON.parse(dry.stdout) as PruneJson;
      expect(planned.dryRun).toBe(true);
      expect(planned.entries.map((entry) => entry.branch)).toEqual(["landed"]);
      expect(await pathExists(landed)).toBe(true);

      const pruned = await runCli(["prune", "--delete-branch", "--json"], { cwd: root });
      expect(pruned.exitCode).toBe(ExitCode.ok);

      const [entry] = (JSON.parse(pruned.stdout) as PruneJson).entries;
      expect(entry).toMatchObject({
        dir: "landed",
        branch: "landed",
        reason: "merged",
        branchDeleted: true,
      });
      // An optional field, the way `list`, `remove` and `reset` spell a branch:
      // a row without one is absent from the document rather than an empty
      // string, which a consumer checking `=== undefined` would read as a name.
      expect(Object.keys(entry ?? {}).toSorted()).toEqual([
        "branch",
        "branchDeleted",
        "dir",
        "path",
        "reason",
      ]);

      const branches = await probeGit(repo.gitDir, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
      ]);
      expect(branches.stdout.split("\n")).not.toContain("landed");
    });
  }, 60_000);

  test("the rows go to stdout and the counts to stderr, and -n is the same flag as --dry-run", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      const worktree = await proposed(repo, "shipped", "shipped.txt");
      await deleteOnOrigin(temp, "shipped");

      const dry = await runCli(["prune", "--dry-run"], { cwd: root });
      expect(dry.exitCode).toBe(ExitCode.ok);
      // `grove prune -n | wc -l` should count worktrees, not read a sentence
      // about them — so the row is on stdout and the tally is not.
      expect(dry.stdout).toContain("shipped");
      expect(dry.stdout).not.toContain("would remove");
      expect(dry.stderr).toContain("would remove 1");
      expect(await pathExists(worktree)).toBe(true);

      // And `-n` is the same flag: the same rows, in the same place.
      const short = await runCli(["prune", "-n"], { cwd: root });
      expect(short.stderr).toContain("would remove 1");
      expect(short.stdout).toBe(dry.stdout);
      expect(await pathExists(worktree)).toBe(true);

      const pruned = await runCli(["prune"], { cwd: root });
      expect(pruned.exitCode).toBe(ExitCode.ok);
      expect(pruned.stderr).toContain("removed 1");
      expect(await pathExists(worktree)).toBe(false);

      // Nothing left to do is still exit 0, and still says so on stderr — a
      // pipe reading stdout for rows gets an empty document, not a sentence.
      const again = await runCli(["prune"], { cwd: root });
      expect(again.exitCode).toBe(ExitCode.ok);
      expect(again.stderr).toContain("nothing is finished with");
      expect(again.stdout).toBe("");
    });
  });
});
