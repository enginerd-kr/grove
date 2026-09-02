import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { version } from "../../../package.json";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import type { RepoPaths } from "../layout.ts";
import {
  managedRepo,
  probeGit,
  recorder,
  seedGit,
  seedWorktree,
  withTempRepo,
} from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { type Diagnosis, diagnose, failureFor, formatDiagnosis } from "./doctor.ts";

/**
 * Every check here exists because something breaks a *later* command in a place
 * that says nothing about the cause — so each one is tested by breaking exactly
 * that condition and asserting the report names it, at the severity that
 * decides whether a pipeline fails.
 *
 * These tests never called `diagnose` before, despite reading as though they
 * did: the local helper of that name spawned `grove doctor --json` and parsed
 * what came back, so what was under test was the round trip and not the
 * function. Calling it directly is the first time the `Diagnosis` itself is in
 * hand — including the two fields the JSON always carried and the old type
 * simply omitted, `grove` and `git`, which is a peculiar thing to have left
 * unasserted in a report whose stated purpose is to be pasted into an issue.
 *
 * `refused()` does not apply to this command, and that is the interesting part
 * of its shape: `diagnose` throws nothing. It returns findings, `failureFor`
 * decides afterwards whether any of them is bad enough to fail on, and
 * `cli/run.ts` prints the report *before* throwing what it hands back. So the
 * `Diagnosis` is taken with `succeeded`'s meaning — it always succeeds — and
 * the error is asserted by calling `failureFor` on it. The one thing that
 * leaves for `doctor.e2e.test.ts` is the exit code itself, because "an error
 * fails a pipeline and a warning does not" is a promise made to a pipeline.
 */

/** The findings as `[check, severity]`, which is what each case is really asserting. */
function reported(diagnosis: Diagnosis): readonly (readonly [string, string])[] {
  return diagnosis.findings.map((finding) => [finding.check, finding.severity] as const);
}

/**
 * The exit code this diagnosis would leave the shell with.
 *
 * The same two steps `cli/run.ts` takes — `failureFor`, then `errorToExitCode`
 * — so a test can say "this fails" and "this does not" in the units a caller
 * reads, without paying for a process to find out.
 */
function exitCodeFor(diagnosis: Diagnosis): number {
  const failure = failureFor(diagnosis);

  return failure === undefined ? ExitCode.ok : errorToExitCode(failure.code);
}

describe("a repository with nothing wrong", () => {
  test("reports no findings, exits 0, and says how much it checked", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "feat/login");

      const diagnosis = await diagnose(repo);

      expect(diagnosis.findings).toEqual([]);
      expect(exitCodeFor(diagnosis)).toBe(ExitCode.ok);
      expect(diagnosis.root).toBe(root);
      expect(diagnosis.gitDir).toBe(join(root, ".bare"));
      expect(diagnosis.kind).toBe("managed");
      // A clean report says how much it is claiming.
      expect(diagnosis.checked).toBe(10);
      // The two the report exists for: the header is what turns three messages
      // into one, and "what version?" is the first of the three.
      expect(diagnosis.grove).toBe(version);
      expect(diagnosis.git).toMatch(/^\d+\.\d+/);

      // The whole report, not a substring of it: the header, the blank line
      // under it, and the sentence that stands in for a list of findings.
      expect(formatDiagnosis(diagnosis)).toBe(
        [
          `${root}  (managed)`,
          `grove ${version} · git ${diagnosis.git}`,
          "",
          "nothing to report — 10 checks, all clean",
        ].join("\n"),
      );
    });
  });
});

describe("the remote checks", () => {
  test("a missing fetch refspec, an empty origin/*, and an origin/HEAD that does not resolve", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const bare = repo.gitDir;

      // The famous one: `git fetch` then exits 0 having updated nothing.
      await seedGit(bare, ["config", "--unset", "remote.origin.fetch"]);
      const noRefspec = await diagnose(repo);

      expect(reported(noRefspec)).toEqual([["fetch-refspec", "error"]]);
      expect(exitCodeFor(noRefspec)).toBe(ExitCode.stateConflict);
      expect(noRefspec.findings[0]?.fix.join("\n")).toContain(
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

      const noTracking = await diagnose(repo);
      expect(reported(noTracking)).toEqual([["remote-tracking", "error"]]);
      expect(exitCodeFor(noTracking)).toBe(ExitCode.stateConflict);

      await seedGit(bare, ["fetch", "origin", "--prune", "--tags"]);
      await seedGit(bare, ["remote", "set-head", "origin", "--auto"]);

      // The ref every command that picks a trunk goes through.
      await seedGit(bare, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
      const noHead = await diagnose(repo);

      expect(reported(noHead)).toEqual([["origin-head", "error"]]);
      expect(exitCodeFor(noHead)).toBe(ExitCode.stateConflict);
      expect(noHead.findings[0]?.details).toContain("it is not set");
      expect(noHead.findings[0]?.fix).toEqual([`git -C ${bare} remote set-head origin --auto`]);

      // Three consecutive breakages and each one is reported alone, which is
      // the claim the `reported` lists above make one at a time and this makes
      // once: nothing here accumulates findings from the previous state.
      await seedGit(bare, ["remote", "set-head", "origin", "--auto"]);
      expect((await diagnose(repo)).findings).toEqual([]);
    });
  });
});

describe("the .git file at the repo root", () => {
  test("missing, and pointing somewhere that is not there", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      const gitFile = join(root, ".git");

      await rm(gitFile);
      const absent = await diagnose(repo);

      expect(reported(absent)).toEqual([["git-file", "error"]]);
      expect(exitCodeFor(absent)).toBe(ExitCode.stateConflict);
      expect(absent.findings[0]?.summary).toContain("no .git file");
      expect(absent.findings[0]?.fix).toEqual([`echo 'gitdir: ./.bare' > ${gitFile}`]);

      await Bun.write(gitFile, "gitdir: ./elsewhere\n");
      const wrong = await diagnose(repo);

      expect(reported(wrong)).toEqual([["git-file", "error"]]);
      expect(wrong.findings[0]?.summary).toContain("points at a git directory that is not there");
      expect(wrong.findings[0]?.details).toEqual([`it names ${join(root, "elsewhere")}`]);

      // Not a pointer at all.
      await Bun.write(gitFile, "who knows\n");
      const garbled = await diagnose(repo);

      expect(reported(garbled)).toEqual([["git-file", "error"]]);
      expect(garbled.findings[0]?.summary).toContain("does not name a git directory");

      // A second repository beside .bare. The fix is deliberately not the
      // rewrite above: `>` cannot overwrite a directory, and this one has
      // history in it that nothing here should propose to flatten.
      await rm(gitFile);
      await mkdir(gitFile, { recursive: true });
      const directory = await diagnose(repo);

      expect(reported(directory)).toEqual([["git-file", "error"]]);
      expect(directory.findings[0]?.summary).toContain(".git at the repo root is a directory");
      expect(directory.findings[0]?.fix.join(" ")).toContain("move the loser aside");

      // Four states, one `check` name, and four different summaries — which is
      // what makes the summary and not the check name the thing worth reading.
      // A `toContain` on a rendered report proves only that one of the four
      // fired; holding the finding is what says which.
      const summaries = [absent, wrong, garbled, directory].map(
        (diagnosis) => diagnosis.findings[0]?.summary,
      );
      expect(new Set(summaries).size).toBe(4);
    });
  });
});

describe("directories and worktrees that disagree", () => {
  test("a worktree git still lists but that is gone from disk is a warning", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      await rm(join(repo.root, "feat", "login"), { recursive: true, force: true });
      const diagnosis = await diagnose(repo);

      expect(reported(diagnosis)).toEqual([["prunable-worktree", "warning"]]);
      // A warning does not fail a pipeline this is running in — which is a
      // decision `failureFor` makes about the severity, and the only place
      // outside the exit code where it is visible at all.
      expect(failureFor(diagnosis)).toBeUndefined();
      expect(diagnosis.findings[0]?.details[0]).toContain("feat/login");
      expect(diagnosis.findings[0]?.fix).toEqual([`git -C ${repo.gitDir} worktree prune`]);
      // The tally counts it, even though it does not fail: "1 warning, out of 10
      // checks" is the report saying it looked and found something untidy.
      expect(formatDiagnosis(diagnosis)).toContain("1 warning, out of 10 checks");
    });
  });

  test("a locked worktree that is gone from disk is a warning, with the unlock first", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const added = await seedWorktree(repo, "feat/login");

      // What a crashed agent session leaves: it locked the worktree it was
      // working in, and whatever cleaned up after it deleted the directory.
      // git lists this without `prunable`, and `git worktree prune` skips it.
      await seedGit(repo.gitDir, ["worktree", "lock", "--reason", "agent session", added.path]);
      await rm(added.path, { recursive: true, force: true });

      const diagnosis = await diagnose(repo);

      expect(reported(diagnosis)).toEqual([["locked-phantom-worktree", "warning"]]);
      expect(failureFor(diagnosis)).toBeUndefined();
      expect(diagnosis.findings[0]?.details).toEqual(["feat/login — agent session"]);
      // Unlock first: `prune` alone is what has already been declining.
      expect(diagnosis.findings[0]?.fix).toEqual([
        `git -C ${repo.gitDir} worktree unlock ${added.path}`,
        `git -C ${repo.gitDir} worktree prune`,
      ]);
    });
  });

  test("a directory left behind by a pruned worktree is a warning", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // What `git worktree prune` leaves: the checkout, holding a .git file
      // that names an admin directory which is no longer there.
      await mkdir(join(repo.root, "stray"), { recursive: true });
      await Bun.write(join(repo.root, "stray", ".git"), "gitdir: ../.bare/worktrees/stray\n");

      const diagnosis = await diagnose(repo);

      expect(reported(diagnosis)).toEqual([["orphan-worktree", "warning"]]);
      expect(failureFor(diagnosis)).toBeUndefined();
      expect(diagnosis.findings[0]?.details).toEqual(["stray"]);
    });
  });
});

describe("a fork set up by hand", () => {
  test("an upstream remote the trunk does not follow is a warning naming the command", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      // The state every forking guide leaves behind: the remote added, and
      // the line that makes it count not yet typed.
      await seedGit(repo.gitDir, ["remote", "add", "upstream", temp.originUrl]);

      const diagnosis = await diagnose(repo);

      expect(reported(diagnosis)).toEqual([["upstream-unfollowed", "warning"]]);
      expect(failureFor(diagnosis)).toBeUndefined();
      expect(diagnosis.findings[0]?.fix).toEqual([
        `grove -C ${repo.root} upstream ${temp.originUrl}`,
      ]);

      // And the fix is what clears it.
      await seedGit(repo.gitDir, ["fetch", "upstream"]);
      await seedGit(repo.gitDir, ["branch", "--set-upstream-to=upstream/main", "main"]);
      expect(reported(await diagnose(repo))).toEqual([]);
    });
  });

  test("a second remote by any other name says nothing about forks", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedGit(repo.gitDir, ["remote", "add", "deploy", temp.originUrl]);

      expect(reported(await diagnose(repo))).toEqual([]);
    });
  });
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
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedSetupFile(root, '[setup]\nlink = ["node_modules"]\n');
      await mkdir(join(root, "main", "node_modules"), { recursive: true });

      // `addWorktree` directly rather than `seedWorktree`, which pins
      // `setup: false`: the link this test is about is the one `add` makes, so
      // this is the one fixture in the file that needs setup turned on. `trust`
      // stays off — a `link` needs no permission, only a `run` does.
      await addWorktree(
        repo,
        root,
        {
          branch: "feat/login",
          from: undefined,
          fetch: true,
          push: false,
          setup: true,
          trust: false,
          take: false,
        },
        recorder().reporter,
      );

      // Deleting the trunk's copy breaks every worktree that links to it at
      // once, in a way that reads as the build's fault.
      await rm(join(root, "main", "node_modules"), { recursive: true, force: true });
      const diagnosis = await diagnose(repo);

      expect(reported(diagnosis)).toEqual([["broken-link", "warning"]]);
      expect(failureFor(diagnosis)).toBeUndefined();
      // Both ends, which is what makes it actionable: the link and what it was
      // supposed to point at.
      expect(diagnosis.findings[0]?.details[0]).toContain("feat/login/node_modules → ");
      expect(diagnosis.findings[0]?.details[0]).toContain(join("main", "node_modules"));
    });
  });

  test("a file that cannot be read is an error, because every later add fails on it", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedSetupFile(repo.root, "[setup]\ncopy = 3\n");

      const wrongShape = await diagnose(repo);

      expect(reported(wrongShape)).toEqual([["setup-file", "error"]]);
      expect(exitCodeFor(wrongShape)).toBe(ExitCode.stateConflict);
      expect(wrongShape.findings[0]?.details[0]).toContain("setup.copy must be a list of strings");

      await Bun.write(join(repo.root, "main", ".grove.toml"), "this is not = = toml\n");
      const unparseable = await diagnose(repo);

      expect(reported(unparseable)).toEqual([["setup-file", "error"]]);
      expect(unparseable.findings[0]?.details[0]).toContain("not valid TOML");
      // Two ways for one file to be unreadable, one check name, and two
      // different reasons on `details` — the same shape as the `.git` file
      // above, and the same reason to read the finding rather than the report.
      expect(unparseable.findings[0]?.details[0]).not.toBe(wrongShape.findings[0]?.details[0]);
    });
  });
});

describe("the printed report", () => {
  test("carries the fix for every finding, and the tally underneath", async () => {
    await withTempRepo(async (temp) => {
      const repo: RepoPaths = await managedRepo(temp);
      const root = repo.root;
      const bare = repo.gitDir;

      // One error and one warning, so the report has to say both.
      await seedGit(bare, ["config", "--unset", "remote.origin.fetch"]);
      await mkdir(join(root, "stray"), { recursive: true });
      await Bun.write(join(root, "stray", ".git"), "gitdir: ../.bare/worktrees/stray\n");

      const diagnosis = await diagnose(repo);
      const report = formatDiagnosis(diagnosis);

      expect(report).toContain("✗ origin has no fetch refspec");
      expect(report).toContain("! 1 directory left behind by a pruned worktree");
      // The fix is a line to paste, marked with the arrow that starts it.
      expect(report).toContain(`    → git -C ${bare} config remote.origin.fetch`);
      expect(report).toContain("1 problem and 1 warning, out of 10 checks");

      // The error is what decides the exit code, and the warning beside it does
      // not change the count: "1 problem" is one, not two.
      const failure = failureFor(diagnosis);
      expect(failure?.code).toBe("state-conflict");
      expect(failure?.message).toBe("the repository has 1 problem");
      // A refusal with no way past it would be a wall; the hint is the door,
      // and it points at the report that has just been printed above it.
      expect(failure?.hint).toBe("each is listed above, with the command that clears it");
    });
  });
});
