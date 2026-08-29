import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  branchStates,
  commitTimes,
  defaultBranch,
  driftFrom,
  fetchRemotes,
  localBranchExists,
  localBranches,
  remoteBranchExists,
  remoteRef,
  updateRemoteHead,
} from "./branches.ts";
import { type GroveError, isGroveError } from "./errors.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "./test-utils.ts";

/**
 * Everything here runs against a real bare clone of the `file://` fixture,
 * because the whole file is questions about refs that only git can answer —
 * a fake would only prove that the fake agrees with itself.
 */

/** The layout `grove clone` leaves behind: a bare clone with remote-tracking refs. */
async function bareClone(repo: TempRepo, name = "app"): Promise<string> {
  const bare = join(repo.work, name, ".bare");

  await seedGit(repo.work, ["clone", "--bare", repo.originUrl, bare]);
  await seedGit(bare, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await seedGit(bare, ["fetch", "origin", "--prune", "--tags"]);
  await seedGit(bare, ["remote", "set-head", "origin", "--auto"]);

  return bare;
}

/** A worktree on the bare clone, for the fixtures that need real commits made. */
async function worktreeOn(bare: string, path: string, branch: string): Promise<string> {
  await seedGit(bare, ["worktree", "add", path, branch]);

  return path;
}

async function commitIn(worktree: string, file: string, body: string, message: string) {
  await Bun.write(join(worktree, file), body);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
}

/** Puts another commit on a branch of the origin fixture, via a throwaway clone. */
async function pushToOrigin(repo: TempRepo, branch: string, message: string): Promise<string> {
  const scratch = join(repo.root, "pusher");

  await seedGit(repo.root, ["clone", "--branch", branch, repo.originUrl, scratch]);
  await commitIn(scratch, "app.txt", "one\ntwo\n", message);
  await seedGit(scratch, ["push", "origin", branch]);
  const sha = (await seedGit(scratch, ["rev-parse", "HEAD"])).trim();
  await rm(scratch, { recursive: true, force: true });

  return sha;
}

async function failure(promise: Promise<unknown>): Promise<GroveError> {
  try {
    await promise;
  } catch (error) {
    if (isGroveError(error)) return error;
    throw error;
  }

  throw new Error("expected the call to fail");
}

describe("defaultBranch", () => {
  test("reads the trunk from origin/HEAD, and says how to fix a repo without one", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareClone(repo);

      expect(await defaultBranch(bare)).toBe("main");

      // Recent git recreates origin/HEAD on fetch, so the missing-HEAD case has
      // to be arranged by deleting the symref rather than by not making it.
      await seedGit(bare, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);

      const error = await failure(defaultBranch(bare));
      expect(error.code).toBe("git-failed");
      expect(error.message).toContain("default");
      expect(error.hint).toContain("remote set-head");

      // And putting it back is exactly what the hint says to do.
      expect(await updateRemoteHead(bare)).toBe(true);
      expect(await defaultBranch(bare)).toBe("main");
    });
  });

  test("strips the remote, not just the first slash", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareClone(repo);
      await seedGit(bare, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/feat/login",
      ]);

      expect(await defaultBranch(bare)).toBe("feat/login");
    });
  });
});

test("updateRemoteHead answers false rather than throwing when there is nothing to ask", async () => {
  await withTempRepo(async (repo) => {
    const lonely = join(repo.work, "lonely.git");
    await seedGit(repo.work, ["init", "--bare", "--initial-branch=main", lonely]);

    expect(await updateRemoteHead(lonely)).toBe(false);
  });
});

test("which branches exist, locally and on the remote", async () => {
  await withTempRepo(async (repo) => {
    const bare = await bareClone(repo);

    // `clone --bare` copies every remote head in as a local branch, which is the
    // state `grove clone` prunes afterwards — both are visible here.
    expect(await localBranches(bare)).toEqual(["feat/login", "main"]);

    expect(await localBranchExists(bare, "main")).toBe(true);
    expect(await localBranchExists(bare, "feat/login")).toBe(true);
    expect(await localBranchExists(bare, "nope")).toBe(false);
    // A remote-tracking ref is not a local branch, however it is spelled.
    expect(await localBranchExists(bare, "origin/main")).toBe(false);

    expect(await remoteBranchExists(bare, "main")).toBe(true);
    expect(await remoteBranchExists(bare, "feat/login")).toBe(true);
    expect(await remoteBranchExists(bare, "nope")).toBe(false);

    expect(remoteRef("feat/login")).toBe("origin/feat/login");

    await seedGit(bare, ["update-ref", "-d", "refs/heads/feat/login"]);
    expect(await localBranches(bare)).toEqual(["main"]);
    // Deleting the local branch leaves the remote's copy alone.
    expect(await remoteBranchExists(bare, "feat/login")).toBe(true);
  });
});

describe("fetchRemotes", () => {
  test("brings a commit pushed after the clone into origin/main", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareClone(repo);
      const before = (await seedGit(bare, ["rev-parse", "origin/main"])).trim();

      const pushed = await pushToOrigin(repo, "main", "Add a line to app.txt");
      // Nothing has looked at the remote yet, so the tracking ref is stale.
      expect((await seedGit(bare, ["rev-parse", "origin/main"])).trim()).toBe(before);

      expect(await fetchRemotes(bare)).toBe(true);
      expect((await seedGit(bare, ["rev-parse", "origin/main"])).trim()).toBe(pushed);
    });
  });

  test("answers false rather than throwing when the remote is unreachable", async () => {
    await withTempRepo(async (repo) => {
      const orphan = join(repo.work, "orphan.git");
      await seedGit(repo.work, ["init", "--bare", "--initial-branch=main", orphan]);
      await seedGit(orphan, ["remote", "add", "origin", `file://${join(repo.root, "gone.git")}`]);

      expect(await fetchRemotes(orphan)).toBe(false);
    });
  });
});

test("driftFrom counts both directions for every local branch", async () => {
  await withTempRepo(async (repo) => {
    const bare = await bareClone(repo);
    const wt = await worktreeOn(bare, join(repo.work, "wt"), "main");

    // One branch of each shape, measured against local `main`.
    await seedGit(bare, ["branch", "same", "main"]);
    await seedGit(bare, ["branch", "behind", "main~1"]);

    await seedGit(wt, ["checkout", "-b", "ahead"]);
    await commitIn(wt, "ahead.txt", "ahead\n", "Add ahead.txt");

    await seedGit(wt, ["checkout", "-b", "diverged", "main~1"]);
    await commitIn(wt, "diverged.txt", "diverged\n", "Add diverged.txt");

    const drift = await driftFrom(bare, "main");

    expect(drift.get("same")).toEqual({ ahead: 0, behind: 0 });
    expect(drift.get("main")).toEqual({ ahead: 0, behind: 0 });
    expect(drift.get("behind")).toEqual({ ahead: 0, behind: 1 });
    expect(drift.get("ahead")).toEqual({ ahead: 1, behind: 0 });
    expect(drift.get("diverged")).toEqual({ ahead: 1, behind: 1 });

    // A branch with a slash in it is one line like any other.
    expect(drift.get("feat/login")).toEqual({ ahead: 1, behind: 0 });
    // Remote-tracking refs are not local branches and get no row.
    expect(drift.has("origin/main")).toBe(false);
  });
});

test("driftFrom answers an empty map rather than failing on a base git cannot resolve", async () => {
  await withTempRepo(async (repo) => {
    const bare = await bareClone(repo);

    expect((await driftFrom(bare, "origin/no-such-trunk")).size).toBe(0);
  });
});

describe("branchStates", () => {
  test("marks a branch whose every commit is already on the trunk", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareClone(repo);
      const wt = await worktreeOn(bare, join(repo.work, "wt"), "main");

      await seedGit(wt, ["checkout", "-b", "topic"]);
      await commitIn(wt, "topic.txt", "topic\n", "Add topic.txt");
      await seedGit(wt, ["checkout", "main"]);
      await seedGit(wt, [
        "-c",
        "commit.gpgsign=false",
        "merge",
        "--no-ff",
        "topic",
        "-m",
        "Merge topic",
      ]);

      const states = await branchStates(bare, "main");

      expect(states.get("topic")?.merged).toBe(true);
      // Its own tip is trivially reachable from itself.
      expect(states.get("main")?.merged).toBe(true);
      expect(states.get("feat/login")?.merged).toBe(false);
      // Nothing here was configured to track anything, so nothing reads as gone.
      expect(states.get("topic")?.gone).toBe(false);
      expect(states.get("topic")?.upstream).toBeUndefined();
    });
  });

  // A squash rewrites the commits, so nothing of the branch is reachable from
  // the trunk — ancestry cannot see it. The patch comparison can, which is what
  // makes the documented promise ("a squash or a rebase") true.
  test("marks a branch whose changes were squashed onto the trunk", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareClone(repo);
      const wt = await worktreeOn(bare, join(repo.work, "wt"), "main");

      await seedGit(wt, ["checkout", "-b", "squashed"]);
      await commitIn(wt, "squashed.txt", "squashed\n", "Add squashed.txt");
      await seedGit(wt, ["checkout", "main"]);
      await seedGit(wt, ["merge", "--squash", "squashed"]);
      await seedGit(wt, ["-c", "commit.gpgsign=false", "commit", "-m", "Squash squashed"]);

      const states = await branchStates(bare, "main");

      expect(states.get("squashed")?.merged).toBe(true);
    });
  });

  test("reports gone only once a fetch has pruned the tracking ref", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareClone(repo);
      await seedGit(bare, ["branch", "--set-upstream-to=origin/feat/login", "feat/login"]);

      const tracked = await branchStates(bare, "origin/main");
      expect(tracked.get("feat/login")?.upstream).toBe("origin/feat/login");
      expect(tracked.get("feat/login")?.gone).toBe(false);

      // The branch goes on the remote — the state a merged pull request leaves.
      await seedGit(repo.originPath, ["update-ref", "-d", "refs/heads/feat/login"]);

      // This is the subtlety worth pinning: `gone` is read off the local
      // tracking ref, so until a prune removes it the branch still looks fine.
      const stale = await branchStates(bare, "origin/main");
      expect(stale.get("feat/login")?.gone).toBe(false);

      expect(await fetchRemotes(bare)).toBe(true);

      const pruned = await branchStates(bare, "origin/main");
      expect(pruned.get("feat/login")?.gone).toBe(true);
      // The upstream it was configured to track is still reported, which is what
      // tells "its remote went" apart from "it never had one".
      expect(pruned.get("feat/login")?.upstream).toBe("origin/feat/login");
      expect(pruned.get("main")?.gone).toBe(false);
    });
  });
});

describe("commitTimes", () => {
  test("answers in epoch milliseconds, for the shas it was handed", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareClone(repo);
      const head = (await seedGit(bare, ["rev-parse", "main"])).trim();
      const parent = (await seedGit(bare, ["rev-parse", "main~1"])).trim();

      const times = await commitTimes(bare, [head, parent]);

      expect(times.size).toBe(2);
      // The fixture pins the committer date, so this is exact rather than a range.
      expect(times.get(head)).toBe(Date.parse("2026-01-01T00:00:00Z"));
      expect(times.get(parent)).toBe(Date.parse("2026-01-01T00:00:00Z"));
    });
  });

  test("is tolerant: no shas, and a sha that resolves to nothing", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareClone(repo);

      expect((await commitTimes(bare, [])).size).toBe(0);

      const missing = "0".repeat(40);
      expect((await probeGit(bare, ["cat-file", "-e", missing])).code).not.toBe(0);
      expect((await commitTimes(bare, [missing])).size).toBe(0);
    });
  });
});
