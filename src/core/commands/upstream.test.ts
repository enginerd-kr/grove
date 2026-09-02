import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { trunkOf } from "../branches.ts";
import type { RepoPaths } from "../layout.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  probeGit,
  refused,
  seedGit,
  seedWorktree,
  succeeded,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";
import { existingUpstream, followUpstream, type UpstreamResult } from "./upstream.ts";

/**
 * `grove upstream` against a real second repository.
 *
 * What it writes is three git settings, and each is asserted by reading it
 * back the way the rest of grove reads it — `trunkOf` for the tracking,
 * `git config` for the rest — because the whole claim is that `git push` and
 * `git pull` agree with grove afterwards, and that is a claim about config.
 */

/** A bare repository standing in for the one this was forked from. */
async function canonicalOf(temp: TempRepo, name = "canonical.git"): Promise<string> {
  const path = join(temp.root, name);
  await seedGit(temp.root, ["clone", "--bare", temp.originPath, path]);

  return path;
}

function attemptFollow(
  repo: RepoPaths,
  url: string,
  force = false,
): Promise<Attempt<UpstreamResult>> {
  return attempt((reporter) => followUpstream(repo, { url, force }, reporter));
}

async function config(bare: string, key: string): Promise<string> {
  return (await probeGit(bare, ["config", "--get", key])).stdout.trim();
}

describe("grove upstream", () => {
  test("adds the remote, points the trunk at it, and sends branches to origin", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const canonical = await canonicalOf(temp);
      const url = `file://${canonical}`;

      const outcome = await attemptFollow(repo, url);
      const result = succeeded(outcome);

      expect(result).toEqual({ remote: "upstream", url, trunk: "main", ref: "upstream/main" });
      expect(await existingUpstream(repo.gitDir)).toBe(url);
      // The three settings, read back the way they will be read.
      expect(await trunkOf(repo.gitDir)).toEqual({
        branch: "main",
        remote: "upstream",
        ref: "upstream/main",
      });
      expect(await config(repo.gitDir, "remote.pushDefault")).toBe("origin");
      // Fetched, so the ref it now follows is there to be followed.
      const ref = await probeGit(repo.gitDir, [
        "rev-parse",
        "--verify",
        "refs/remotes/upstream/main",
      ]);
      expect(ref.code).toBe(0);
      expect(outcome.log.err.join("")).toContain("main now follows upstream/main");

      // Again with the same URL: nothing to do, nothing refused.
      expect(succeeded(await attemptFollow(repo, url))).toEqual(result);
    });
  });

  test("a different URL is refused without --force, and replaced with it", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const first = `file://${await canonicalOf(temp, "first.git")}`;
      const second = `file://${await canonicalOf(temp, "second.git")}`;
      succeeded(await attemptFollow(repo, first));

      const error = refused(await attemptFollow(repo, second));
      expect(error.code).toBe("refused");
      expect(error.message).toContain(first);
      expect(await existingUpstream(repo.gitDir)).toBe(first);

      const replaced = succeeded(await attemptFollow(repo, second, true));
      expect(replaced.replaced).toBe(first);
      expect(await existingUpstream(repo.gitDir)).toBe(second);
    });
  });

  test("a URL that cannot be fetched leaves nothing behind", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const error = refused(await attemptFollow(repo, `file://${join(temp.root, "nowhere.git")}`));

      expect(error.code).toBe("remote");
      expect(error.hint).toContain("nothing was changed");
      expect(await existingUpstream(repo.gitDir)).toBeUndefined();
      expect((await trunkOf(repo.gitDir)).ref).toBe("origin/main");
      expect(await config(repo.gitDir, "remote.pushDefault")).toBe("");

      // And a remote that was there keeps the URL it had, when the new one fails.
      const good = `file://${await canonicalOf(temp)}`;
      succeeded(await attemptFollow(repo, good));
      refused(await attemptFollow(repo, `file://${join(temp.root, "nowhere.git")}`, true));
      expect(await existingUpstream(repo.gitDir)).toBe(good);
    });
  });

  test("follows the remote's own default when it has no branch by the trunk's name", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const canonical = await canonicalOf(temp);
      // The repository this was forked from calls its trunk something else.
      await seedGit(canonical, ["branch", "-m", "main", "trunk"]);
      await seedGit(canonical, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);

      const result = succeeded(await attemptFollow(repo, `file://${canonical}`));

      expect(result).toMatchObject({ trunk: "main", ref: "upstream/trunk" });
      expect((await trunkOf(repo.gitDir)).ref).toBe("upstream/trunk");
    });
  });

  test("what it wrote is what a new branch and a sync then read", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const canonical = await canonicalOf(temp);
      succeeded(await attemptFollow(repo, `file://${canonical}`));

      // The canonical trunk moves; the fork's copy does not.
      const scratch = join(temp.root, "scratch");
      await seedGit(temp.root, ["clone", "--branch", "main", canonical, scratch]);
      await Bun.write(join(scratch, "canon.txt"), "canon\n");
      await seedGit(scratch, ["add", "-A"]);
      await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", "Canon"]);
      await seedGit(scratch, ["push", "origin", "HEAD:main"]);

      // Cut from what the trunk now follows, not from the fork's stale copy.
      const added = await seedWorktree(repo, "feat/x");
      expect(await Bun.file(join(added.path, "canon.txt")).exists()).toBe(true);
    });
  });
});
