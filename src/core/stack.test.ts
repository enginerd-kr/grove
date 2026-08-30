import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { addWorktree } from "./commands/add.ts";
import { removeWorktree } from "./commands/remove.ts";
import { renameWorktree } from "./commands/rename.ts";
import type { RepoPaths } from "./layout.ts";
import {
  ancestry,
  childrenOf,
  clearParent,
  forgetBranch,
  readStack,
  renameInStack,
  type Stack,
  setParent,
  stackOrder,
  wouldCycle,
} from "./stack.ts";
import {
  attempt,
  managedRepo,
  probeGit,
  recorder,
  refused,
  seedWorktree,
  succeeded,
  withTempRepo,
} from "./test-utils.ts";

/**
 * Which branch a branch was cut from, and what stays true about it afterwards.
 *
 * Two halves, and the second is the reason the first exists. The walks —
 * `ancestry`, `stackOrder`, `wouldCycle` — are pure and are asserted as such.
 * Everything else is about a record surviving the commands that move branches
 * around: a rename, a deletion, the branch that turns out to be gone. Those are
 * run against a real repository, because what is being asserted is what git
 * does to grove's own config keys — that `branch -m` carries them and `branch
 * -d` takes them away — and a stub of git would be a stub of the claim.
 */

function stackOf(entries: readonly (readonly [string, string])[]): Stack {
  return new Map(entries);
}

/** `grove add --on`, at the level `cli/args.ts` calls it. */
function addOn(repo: RepoPaths, branch: string, on: string | undefined) {
  return attempt((reporter) =>
    addWorktree(
      repo,
      repo.root,
      { branch, on, fetch: false, push: false, setup: false, trust: false, take: false },
      reporter,
    ),
  );
}

describe("the walks over a recorded stack", () => {
  const three = stackOf([
    ["feat/c", "feat/b"],
    ["feat/b", "feat/a"],
  ]);

  test("ancestry answers nearest first, and stops at the bottom", () => {
    expect(ancestry(three, "feat/c")).toEqual(["feat/b", "feat/a"]);
    expect(ancestry(three, "feat/a")).toEqual([]);
    expect(ancestry(three, "nothing-recorded")).toEqual([]);
  });

  test("a loop that arrived from somewhere is walked once, not forever", () => {
    // Not reachable through `add`, which refuses it — but the records are in a
    // config file two commands can each write a sensible half of.
    const loop = stackOf([
      ["a", "b"],
      ["b", "a"],
    ]);

    expect(ancestry(loop, "a")).toEqual(["b"]);
  });

  test("childrenOf is the same question asked downwards", () => {
    expect(childrenOf(three, "feat/a")).toEqual(["feat/b"]);
    expect(childrenOf(three, "feat/c")).toEqual([]);
  });

  test("wouldCycle refuses the parent that is already below the branch", () => {
    expect(wouldCycle(three, "feat/a", "feat/c")).toBe(true);
    expect(wouldCycle(three, "feat/a", "feat/a")).toBe(true);
    expect(wouldCycle(three, "feat/d", "feat/c")).toBe(false);
  });

  test("stackOrder puts a parent before its children and leaves the rest alone", () => {
    const rows = ["feat/c", "main", "feat/b", "fix/crash", "feat/a"];

    expect(stackOrder(rows, three, (row) => row)).toEqual([
      // Depth zero, in the order they arrived — which for `sync` is git's own.
      "main",
      "fix/crash",
      "feat/a",
      "feat/b",
      "feat/c",
    ]);
    // A repository with nothing stacked is handed straight back.
    expect(stackOrder(rows, new Map(), (row) => row)).toEqual(rows);
  });
});

describe("the record itself", () => {
  test("survives a branch name with a dot in it, which git subsections allow", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      await setParent(repo.gitDir, "release/v1.2", "main");
      await setParent(repo.gitDir, "feat/login", "release/v1.2");

      expect([...(await readStack(repo.gitDir))]).toEqual([
        ["release/v1.2", "main"],
        ["feat/login", "release/v1.2"],
      ]);

      await clearParent(repo.gitDir, "release/v1.2");
      expect((await readStack(repo.gitDir)).get("release/v1.2")).toBeUndefined();
      // Clearing one leaves the others; and clearing one twice is not an error,
      // because every caller here clears records it is not certain exist.
      await clearParent(repo.gitDir, "release/v1.2");
      expect((await readStack(repo.gitDir)).get("feat/login")).toBe("release/v1.2");
    });
  });

  test("a repository that has never stacked anything reads as empty", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      expect((await readStack(repo.gitDir)).size).toBe(0);
    });
  });
});

describe("grove add --on", () => {
  test("cuts the branch from its parent and writes down where it sits", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/a");
      await Bun.write(join(repo.root, "feat", "a", "a.txt"), "a\n");
      await probeGit(join(repo.root, "feat", "a"), ["add", "-A"]);
      await probeGit(join(repo.root, "feat", "a"), [
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Add a.txt",
      ]);

      const added = succeeded(await addOn(repo, "feat/b", "feat/a"));

      expect(added.parent).toBe("feat/a");
      expect((await readStack(repo.gitDir)).get("feat/b")).toBe("feat/a");
      // Cut from the parent's tip, which is what "on top of" means — the file
      // the parent committed is in the child's checkout.
      expect(await Bun.file(join(repo.root, "feat", "b", "a.txt")).text()).toBe("a\n");
    });
  });

  test("refuses a parent this repository has not got", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const error = refused(await addOn(repo, "feat/b", "feat/nowhere"));

      expect(error.code).toBe("usage");
      expect(error.message).toContain("feat/nowhere");
      // And nothing was made: the refusal has no directory behind it.
      expect(await Bun.file(join(repo.root, "feat", "b", ".git")).exists()).toBe(false);
    });
  });

  test("refuses a parent that is already under the branch", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/a");
      succeeded(await addOn(repo, "feat/b", "feat/a"));

      const error = refused(await addOn(repo, "feat/a", "feat/b"));

      expect(error.code).toBe("state-conflict");
      expect(error.message).toBe("feat/b is already stacked under feat/a");
      expect(error.hint).toContain("loop");
    });
  });

  test("refuses to stack the trunk, which is what everything else is measured against", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/a");

      const error = refused(await addOn(repo, "main", "feat/a"));

      expect(error.code).toBe("usage");
      // Recording it would have `sync` fast-forwarding the trunk onto a feature
      // branch and pushing the result, which is no mistake to leave one flag away.
      expect((await readStack(repo.gitDir)).get("main")).toBeUndefined();
    });
  });

  test("records the parent even when the worktree was already there", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/a");
      await seedWorktree(repo, "feat/b");

      // Half the request has already happened; the half that has not is the
      // one this flag was typed for.
      const added = succeeded(await addOn(repo, "feat/b", "feat/a"));

      expect(added.alreadyPresent).toBe(true);
      expect((await readStack(repo.gitDir)).get("feat/b")).toBe("feat/a");
    });
  });
});

describe("the record follows the branches around", () => {
  test("a rename moves the branch's own parent and repoints its children", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/a");
      succeeded(await addOn(repo, "feat/b", "feat/a"));
      succeeded(await addOn(repo, "feat/c", "feat/b"));

      await renameWorktree(
        repo,
        repo.root,
        { target: "feat/b", to: "feat/renamed", push: false, force: false },
        recorder().reporter,
      );

      const stack = await readStack(repo.gitDir);
      // git carried `branch.feat/b`'s whole section, this key with it.
      expect(stack.get("feat/renamed")).toBe("feat/a");
      expect(stack.get("feat/b")).toBeUndefined();
      // And what git could not know: the branch above named the old spelling.
      expect(stack.get("feat/c")).toBe("feat/renamed");
    });
  });

  test("deleting a branch hands its children to what it was standing on", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/a");
      succeeded(await addOn(repo, "feat/b", "feat/a"));
      succeeded(await addOn(repo, "feat/c", "feat/b"));

      await removeWorktree(
        repo,
        repo.root,
        { target: "feat/b", force: true, deleteBranch: true, teardown: false },
        recorder().reporter,
      );

      const stack = await readStack(repo.gitDir);
      expect(stack.get("feat/c")).toBe("feat/a");
      expect(stack.get("feat/b")).toBeUndefined();
    });
  });

  test("deleting the bottom branch leaves the rest a stack of what is left", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/a");
      succeeded(await addOn(repo, "feat/b", "feat/a"));

      const moved = await forgetBranch(repo.gitDir, "feat/a");

      // Nothing to hand them to, so the record goes rather than pointing at a
      // branch that is not there.
      expect(moved).toEqual([{ child: "feat/b", parent: undefined }]);
      expect((await readStack(repo.gitDir)).size).toBe(0);
    });
  });

  test("renameInStack is a no-op for a branch nothing stands on", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await setParent(repo.gitDir, "feat/b", "feat/a");

      await renameInStack(repo.gitDir, "feat/z", "feat/y");

      expect((await readStack(repo.gitDir)).get("feat/b")).toBe("feat/a");
    });
  });
});
