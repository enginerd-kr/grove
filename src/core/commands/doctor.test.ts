import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * Every check here exists because something breaks a *later* command in a place
 * that says nothing about the cause — so each one is tested by breaking exactly
 * that condition and asserting the report names it, at the severity that
 * decides whether a pipeline fails.
 */

type Finding = {
  readonly check: string;
  readonly severity: "error" | "warning";
  readonly summary: string;
  readonly details: readonly string[];
  readonly fix: readonly string[];
};

type Diagnosis = {
  readonly root: string;
  readonly gitDir: string;
  readonly kind: string;
  readonly checked: number;
  readonly findings: readonly Finding[];
};

async function clone(repo: TempRepo): Promise<string> {
  const result = await runCli(["clone", repo.originUrl, "app"], { cwd: repo.work });
  expect(result.exitCode).toBe(ExitCode.ok);

  return join(repo.work, "app");
}

async function diagnose(cwd: string): Promise<{ diagnosis: Diagnosis; exitCode: number }> {
  const result = await runCli(["doctor", "--json"], { cwd });

  return { diagnosis: JSON.parse(result.stdout) as Diagnosis, exitCode: result.exitCode };
}

/** The findings as `[check, severity]`, which is what each case is really asserting. */
function reported(diagnosis: Diagnosis): readonly (readonly [string, string])[] {
  return diagnosis.findings.map((finding) => [finding.check, finding.severity] as const);
}

describe("a repository with nothing wrong", () => {
  test("reports no findings, exits 0, and says how much it checked", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(ExitCode.ok);

      const { diagnosis, exitCode } = await diagnose(root);

      expect(exitCode).toBe(ExitCode.ok);
      expect(diagnosis.findings).toEqual([]);
      expect(diagnosis.root).toBe(root);
      expect(diagnosis.gitDir).toBe(join(root, ".bare"));
      expect(diagnosis.kind).toBe("managed");
      // A clean report says how much it is claiming.
      expect(diagnosis.checked).toBe(7);

      const printed = await runCli(["doctor"], { cwd: root });
      expect(printed.stdout).toContain(`${root}  (managed)`);
      expect(printed.stdout).toContain("nothing to report — 7 checks, all clean");
    });
  }, 60_000);
});

describe("the remote checks", () => {
  test("a missing fetch refspec, an empty origin/*, and an origin/HEAD that does not resolve", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const bare = join(root, ".bare");

      // The famous one: `git fetch` then exits 0 having updated nothing.
      await seedGit(bare, ["config", "--unset", "remote.origin.fetch"]);
      const noRefspec = await diagnose(root);

      expect(reported(noRefspec.diagnosis)).toEqual([["fetch-refspec", "error"]]);
      expect(noRefspec.exitCode).toBe(ExitCode.stateConflict);
      expect(noRefspec.diagnosis.findings[0]?.fix.join("\n")).toContain(
        `git -C ${bare} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
      );

      await seedGit(bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);

      // The refspec is there and nothing has come through it yet. Only this is
      // reported: each check declines to speak while the one above it is wrong.
      const refs = (
        await probeGit(bare, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"])
      ).stdout
        .split("\n")
        .filter((line) => line.length > 0);
      await probeGit(bare, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
      for (const ref of refs) await probeGit(bare, ["update-ref", "-d", ref]);

      const noTracking = await diagnose(root);
      expect(reported(noTracking.diagnosis)).toEqual([["remote-tracking", "error"]]);
      expect(noTracking.exitCode).toBe(ExitCode.stateConflict);

      await seedGit(bare, ["fetch", "origin", "--prune", "--tags"]);
      await seedGit(bare, ["remote", "set-head", "origin", "--auto"]);

      // The ref every command that picks a trunk goes through.
      await seedGit(bare, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
      const noHead = await diagnose(root);

      expect(reported(noHead.diagnosis)).toEqual([["origin-head", "error"]]);
      expect(noHead.exitCode).toBe(ExitCode.stateConflict);
      expect(noHead.diagnosis.findings[0]?.details).toContain("it is not set");
      expect(noHead.diagnosis.findings[0]?.fix).toEqual([
        `git -C ${bare} remote set-head origin --auto`,
      ]);
    });
  }, 60_000);
});

describe("the .git file at the repo root", () => {
  test("missing, and pointing somewhere that is not there", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const gitFile = join(root, ".git");

      await rm(gitFile);
      const absent = await diagnose(root);

      expect(reported(absent.diagnosis)).toEqual([["git-file", "error"]]);
      expect(absent.exitCode).toBe(ExitCode.stateConflict);
      expect(absent.diagnosis.findings[0]?.summary).toContain("no .git file");
      expect(absent.diagnosis.findings[0]?.fix).toEqual([`echo 'gitdir: ./.bare' > ${gitFile}`]);

      await Bun.write(gitFile, "gitdir: ./elsewhere\n");
      const wrong = await diagnose(root);

      expect(reported(wrong.diagnosis)).toEqual([["git-file", "error"]]);
      expect(wrong.diagnosis.findings[0]?.summary).toContain(
        "points at a git directory that is not there",
      );
      expect(wrong.diagnosis.findings[0]?.details).toEqual([`it names ${join(root, "elsewhere")}`]);

      // Not a pointer at all.
      await Bun.write(gitFile, "who knows\n");
      const garbled = await diagnose(root);

      expect(reported(garbled.diagnosis)).toEqual([["git-file", "error"]]);
      expect(garbled.diagnosis.findings[0]?.summary).toContain("does not name a git directory");

      // A second repository beside .bare. The fix is deliberately not the
      // rewrite above: `>` cannot overwrite a directory, and this one has
      // history in it that nothing here should propose to flatten.
      await rm(gitFile);
      await mkdir(gitFile, { recursive: true });
      const directory = await diagnose(root);

      expect(reported(directory.diagnosis)).toEqual([["git-file", "error"]]);
      expect(directory.diagnosis.findings[0]?.summary).toContain(
        ".git at the repo root is a directory",
      );
      expect(directory.diagnosis.findings[0]?.fix.join(" ")).toContain("move the loser aside");
    });
  }, 60_000);
});

describe("directories and worktrees that disagree", () => {
  test("a worktree git still lists but that is gone from disk is a warning", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(ExitCode.ok);

      await rm(join(root, "feat", "login"), { recursive: true, force: true });
      const { diagnosis, exitCode } = await diagnose(root);

      expect(reported(diagnosis)).toEqual([["prunable-worktree", "warning"]]);
      // A warning does not fail a pipeline this is running in.
      expect(exitCode).toBe(ExitCode.ok);
      expect(diagnosis.findings[0]?.details[0]).toContain("feat/login");
      expect(diagnosis.findings[0]?.fix).toEqual([`git -C ${join(root, ".bare")} worktree prune`]);
    });
  }, 60_000);

  test("a directory left behind by a pruned worktree is a warning", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);

      // What `git worktree prune` leaves: the checkout, holding a .git file
      // that names an admin directory which is no longer there.
      await mkdir(join(root, "stray"), { recursive: true });
      await Bun.write(join(root, "stray", ".git"), "gitdir: ../.bare/worktrees/stray\n");

      const { diagnosis, exitCode } = await diagnose(root);

      expect(reported(diagnosis)).toEqual([["orphan-worktree", "warning"]]);
      expect(exitCode).toBe(ExitCode.ok);
      expect(diagnosis.findings[0]?.details).toEqual(["stray"]);
    });
  }, 60_000);
});

describe(".grove.toml", () => {
  /** Commits a setup file on the trunk, and gives `link` something to point at. */
  async function seedSetupFile(root: string, body: string): Promise<void> {
    const main = join(root, "main");

    await Bun.write(join(main, ".grove.toml"), body);
    await seedGit(main, ["add", "--", ".grove.toml"]);
    await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a setup file"]);
  }

  test("a link whose target has gone is a warning naming both ends", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      await seedSetupFile(root, '[setup]\nlink = ["node_modules"]\n');
      await mkdir(join(root, "main", "node_modules"), { recursive: true });

      expect((await runCli(["add", "feat/login"], { cwd: root })).exitCode).toBe(ExitCode.ok);

      // Deleting the trunk's copy breaks every worktree that links to it at
      // once, in a way that reads as the build's fault.
      await rm(join(root, "main", "node_modules"), { recursive: true, force: true });
      const { diagnosis, exitCode } = await diagnose(root);

      expect(reported(diagnosis)).toEqual([["broken-link", "warning"]]);
      expect(exitCode).toBe(ExitCode.ok);
      expect(diagnosis.findings[0]?.details[0]).toContain("feat/login/node_modules → ");
    });
  }, 60_000);

  test("a file that cannot be read is an error, because every later add fails on it", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      await seedSetupFile(root, "[setup]\ncopy = 3\n");

      const wrongShape = await diagnose(root);

      expect(reported(wrongShape.diagnosis)).toEqual([["setup-file", "error"]]);
      expect(wrongShape.exitCode).toBe(ExitCode.stateConflict);
      expect(wrongShape.diagnosis.findings[0]?.details[0]).toContain(
        "setup.copy must be a list of strings",
      );

      await Bun.write(join(root, "main", ".grove.toml"), "this is not = = toml\n");
      const unparseable = await diagnose(root);

      expect(reported(unparseable.diagnosis)).toEqual([["setup-file", "error"]]);
      expect(unparseable.diagnosis.findings[0]?.details[0]).toContain("not valid TOML");
    });
  }, 60_000);
});

describe("the printed report", () => {
  test("carries the fix for every finding, and the tally underneath", async () => {
    await withTempRepo(async (repo) => {
      const root = await clone(repo);
      const bare = join(root, ".bare");

      // One error and one warning, so the report has to say both.
      await seedGit(bare, ["config", "--unset", "remote.origin.fetch"]);
      await mkdir(join(root, "stray"), { recursive: true });
      await Bun.write(join(root, "stray", ".git"), "gitdir: ../.bare/worktrees/stray\n");

      const result = await runCli(["doctor"], { cwd: root });

      expect(result.exitCode).toBe(ExitCode.stateConflict);
      // Printed first, then thrown: the findings are what was asked for.
      expect(result.stdout).toContain("✗ origin has no fetch refspec");
      expect(result.stdout).toContain("! 1 directory left behind by a pruned worktree");
      // The fix is a line to paste, marked with the arrow that starts it.
      expect(result.stdout).toContain(`    → git -C ${bare} config remote.origin.fetch`);
      expect(result.stdout).toContain("1 problem and 1 warning, out of 7 checks");
      // And the exit code is for whatever is reading them.
      expect(result.stderr).toContain("the repository has 1 problem");
    });
  }, 60_000);
});
