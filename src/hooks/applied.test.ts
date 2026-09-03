import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { listWorktreeSummaries } from "../core/commands/list.ts";
import { removeWorktree } from "../core/commands/remove.ts";
import { seedGit } from "../core/test-utils.ts";
import { appliedFingerprints, clearApplied, isStale, recordApplied } from "./applied.ts";
import { setUp, withRepo } from "./test-utils.ts";
import { fingerprintOf } from "./trust.ts";

/**
 * Which version of the file each worktree was filled in from, and the badge
 * that reads off it.
 *
 * The record is git config, so most of this runs against a real repository:
 * what `runSetup` writes, when it declines to, and what `list` makes of the
 * difference between the record and the file as it is now.
 */

describe("isStale", () => {
  test("only when both sides are known and differ", () => {
    expect(isStale("a", "b")).toBe(true);
    expect(isStale("a", "a")).toBe(false);
    // No record is a worktree nobody set up through grove since the record
    // existed; no current fingerprint is a project with no tracked file.
    // Neither is "probably stale".
    expect(isStale(undefined, "b")).toBe(false);
    expect(isStale("a", undefined)).toBe(false);
    expect(isStale(undefined, undefined)).toBe(false);
  });
});

describe("the record", () => {
  test("is written per branch, read in one call, and cleared on request", async () => {
    await withRepo(async (fixture) => {
      const bare = fixture.repo.gitDir;

      expect(await appliedFingerprints(bare)).toEqual(new Map());

      await recordApplied(bare, "feat/login", "abc");
      await recordApplied(bare, "feat/v1.2", "def");
      // Replaced, not accumulated: one worktree was filled in from one version.
      await recordApplied(bare, "feat/login", "abd");

      expect(await appliedFingerprints(bare)).toEqual(
        new Map([
          ["feat/login", "abd"],
          ["feat/v1.2", "def"],
        ]),
      );
      // Beside the rest of what git knows about the branch, so `branch -m`
      // carries it and `branch -d` takes it — the same section `stack.ts` uses.
      expect(
        (await seedGit(bare, ["config", "--get", "branch.feat/login.grovesetup"])).trim(),
      ).toBe("abd");

      await clearApplied(bare, "feat/login");
      // Clearing what is not there is the ordinary case, and not an error.
      await clearApplied(bare, "feat/login");

      expect(await appliedFingerprints(bare)).toEqual(new Map([["feat/v1.2", "def"]]));
    });
  });
});

describe("what setup records", () => {
  const FILE = '[setup]\ncopy = [".env"]\n';

  test("a completed setup records the file's fingerprint, and the badge follows the file", async () => {
    await withRepo(async (fixture) => {
      const { repo, branch } = fixture;
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await fixture.configure(FILE);

      await setUp(fixture);

      // The same fingerprint `trust` is keyed on: one edit withdraws the trust
      // and marks the worktree stale, and there is no second definition of
      // "the file changed".
      expect(await appliedFingerprints(repo.gitDir)).toEqual(
        new Map([[branch, fingerprintOf(FILE)]]),
      );

      const fresh = await listWorktreeSummaries(repo, repo.root);
      expect(fresh.map((summary) => [summary.dir, summary.setupStale])).toEqual([
        // The trunk was never filled in through grove, so nothing is known
        // about it — and nothing is claimed.
        ["main", false],
        ["feat/login", false],
      ]);

      // The file moves on: a line lands in it. The worktree is now filled in
      // from an older project, and the row says so.
      await fixture.configure('[setup]\ncopy = [".env", ".env.local"]\n');
      const moved = await listWorktreeSummaries(repo, repo.root);
      expect(moved.map((summary) => [summary.dir, summary.setupStale])).toEqual([
        ["main", false],
        ["feat/login", true],
      ]);

      // Filling it in again is what clears it — the badge is the invitation
      // to run exactly this.
      await setUp(fixture);
      const caught = await listWorktreeSummaries(repo, repo.root);
      expect(caught[1]?.setupStale).toBe(false);
    });
  });

  test("commands held back for trust leave the old record standing", async () => {
    await withRepo(async (fixture) => {
      const { repo, branch } = fixture;
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await fixture.configure(FILE);
      await fixture.commitTrunk();
      await setUp(fixture);
      const first = (await appliedFingerprints(repo.gitDir)).get(branch);
      expect(first).toBeDefined();

      // A `run` line arrives with a pull. Untrusted, it does not run — and
      // the worktree is not filled in from this version, so the record still
      // names the version it was filled in from, and the row stays stale
      // until somebody has read the file and the commands have run.
      const withRun = '[setup]\ncopy = [".env"]\nrun = ["sh -c \'echo ok > ran.txt\'"]\n';
      await fixture.configure(withRun);
      await fixture.commitTrunk();

      const untrusted = await setUp(fixture);
      expect(untrusted.untrusted).toBe(true);
      expect((await appliedFingerprints(repo.gitDir)).get(branch)).toBe(first);
      expect((await listWorktreeSummaries(repo, repo.root))[1]?.setupStale).toBe(true);
    });
  });

  test("a project with no tracked file has nothing to be stale against, and forgets", async () => {
    await withRepo(async (fixture) => {
      const { repo, branch } = fixture;
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await fixture.configure(FILE);
      await setUp(fixture);
      expect((await appliedFingerprints(repo.gitDir)).has(branch)).toBe(true);

      // Only your own layer left: nothing a pull could change, so no record.
      await rm(join(fixture.trunk, ".grove.toml"));
      await fixture.configureLocal(FILE);
      await setUp(fixture);

      expect((await appliedFingerprints(repo.gitDir)).has(branch)).toBe(false);
      expect((await listWorktreeSummaries(repo, repo.root))[1]?.setupStale).toBe(false);
    });
  });

  test("removing the worktree takes the record with it, and keeps the branch", async () => {
    await withRepo(async (fixture) => {
      const { repo, branch } = fixture;
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await fixture.configure(FILE);
      await setUp(fixture);

      // `discardDirty`, because the `.env` setup copied in is untracked here
      // and nothing in this fixture ignores it — the screen's `y` to the same
      // question.
      await removeWorktree(
        repo,
        repo.root,
        { target: branch, force: false, deleteBranch: false, teardown: false, discardDirty: true },
        fixture.log.reporter,
      );

      // The record was about the directory; the branch outlives it, and a
      // worktree `add` makes for it later records itself afresh.
      expect((await appliedFingerprints(repo.gitDir)).has(branch)).toBe(false);
      expect((await seedGit(repo.gitDir, ["branch", "--list", branch])).trim()).toContain(branch);
    });
  });
});
