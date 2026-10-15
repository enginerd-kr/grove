import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Reporter } from "../../report/reporter.ts";
import { fetchOutcome } from "../branches.ts";
import { isGroveError } from "../errors.ts";
import type { RepoPaths } from "../layout.ts";
import { readStack, setParent } from "../stack.ts";
import {
  managedRepo,
  recorder,
  seedGit,
  seedWorktree,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";
import { operationInProgress, statusOf } from "../worktrees.ts";
import { rebaseWorktree } from "./rebase.ts";
import { failureFor, type SyncOptions, type SyncOutcome, syncWorktrees } from "./sync.ts";

const OPTIONS: SyncOptions = { all: false, abortOnConflict: true, push: true, publish: false };

function sync(repo: RepoPaths, options: Partial<SyncOptions> = {}, reporter = recorder().reporter) {
  return syncWorktrees(repo, repo.root, { ...OPTIONS, ...options }, reporter);
}

async function head(path: string, ref = "HEAD") {
  return (await seedGit(path, ["rev-parse", ref])).trim();
}

async function gitPath(path: string, name: string) {
  return (await seedGit(path, ["rev-parse", "--path-format=absolute", "--git-path", name])).trim();
}

async function commit(path: string, file: string, text: string) {
  await Bun.write(join(path, file), text);
  await seedGit(path, ["add", "--", file]);
  await seedGit(path, ["commit", "-m", `Change ${file}`]);
}

async function remoteCommit(
  temp: TempRepo,
  branch: string,
  file = "remote.txt",
  text = "remote\n",
) {
  const path = join(temp.root, "pusher");
  await seedGit(temp.root, ["clone", "-b", branch, temp.originUrl, path]);
  await commit(path, file, text);
  await seedGit(path, ["push", "origin", branch]);
  const sha = await head(path);
  await rm(path, { recursive: true });
  return sha;
}

function details(outcomes: readonly SyncOutcome[]) {
  const error = failureFor(outcomes);
  expect(error).toBeDefined();
  return `${error?.message}\n${error?.details.join("\n")}\n${error?.hint ?? ""}`;
}

describe("sync failures preserve the cause and the worktree", () => {
  test("a failed stack metadata repair stops that branch without claiming the repair succeeded", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "feat/login");
      const before = await head(path);
      await setParent(repo.gitDir, "feat/login", "deleted-parent");
      await remoteCommit(temp, "main");
      const lock = join(repo.gitDir, "config.lock");
      await Bun.write(lock, "busy\n");

      const outcomes = await sync(repo, { all: true });
      expect(outcomes.find((entry) => entry.branch === "feat/login")?.kind).toBe("failed");
      expect(outcomes.find((entry) => entry.branch === "main")?.kind).toBe("fast-forwarded");
      expect(details(outcomes)).toContain("could not lock config file");
      expect(await head(path)).toBe(before);
      expect((await readStack(repo.gitDir)).get("feat/login")).toBe("deleted-parent");
      expect(await Bun.file(lock).text()).toBe("busy\n");
    });
  });
  test("changes written by a successful rebase hook stop publishing", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "feat/login");
      const remoteBefore = await head(temp.originPath, "feat/login");
      await remoteCommit(temp, "main");
      const hook = await gitPath(path, "hooks/post-rewrite");
      await Bun.write(hook, "#!/bin/sh\nprintf 'hook changes\\n' > login.txt\n");
      await chmod(hook, 0o755);

      const outcomes = await sync(repo, { target: "feat/login" });
      expect(outcomes[0]).toMatchObject({ kind: "failed", errorCode: "state-conflict" });
      expect(details(outcomes)).toContain("publishing was stopped");
      expect(details(outcomes)).toContain("login.txt");
      expect(await head(temp.originPath, "feat/login")).toBe(remoteBefore);
      expect(await Bun.file(join(path, "login.txt")).text()).toBe("hook changes\n");
    });
  });

  test("a checkout changed during fetch is not mistaken for the original branch", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const main = join(repo.root, "main");
      const before = await head(main);
      await remoteCommit(temp, "main");
      const log = recorder();
      const reporter: Reporter = {
        ...log.reporter,
        step(label) {
          const step = log.reporter.step(label);
          return {
            ...step,
            succeed(message) {
              step.succeed(message);
              if (label === "fetching") {
                const checkout = Bun.spawnSync(["git", "checkout", "-b", "switched"], {
                  cwd: main,
                  env: process.env,
                });
                expect(checkout.exitCode).toBe(0);
              }
            },
          };
        },
      };

      const outcomes = await sync(repo, { target: "main" }, reporter);
      expect(outcomes[0]?.kind).toBe("skipped");
      expect(details(outcomes)).toContain("checked-out branch changed to switched");
      expect(await head(main)).toBe(before);
    });
  });
  test.each(["corrupt index", "missing checkout"])(
    "%s fails without stopping independent worktrees",
    async (problem) => {
      await withTempRepo(async (temp) => {
        const repo = await managedRepo(temp);
        const { path } = await seedWorktree(repo, "feat/login");
        const before = await head(path);
        const incoming = await remoteCommit(temp, "main");
        if (problem === "corrupt index")
          await Bun.write(await gitPath(path, "index"), "broken index");
        else await rm(path, { recursive: true });

        const outcomes = await sync(repo, { all: true });
        expect(outcomes.find((entry) => entry.branch === "feat/login")?.kind).toBe("failed");
        expect(outcomes.find((entry) => entry.branch === "main")?.kind).toBe("fast-forwarded");
        expect(await head(repo.gitDir, "feat/login")).toBe(before);
        expect(await head(repo.gitDir, "main")).toBe(incoming);
        expect(details(outcomes)).toContain(problem === "corrupt index" ? "index" : "No such file");
        expect(details(outcomes)).not.toContain("trunk has diverged");
      });
    },
  );

  test("a merge blocked by an index lock reports the lock, not divergence", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const main = join(repo.root, "main");
      const before = await head(main);
      await remoteCommit(temp, "main");
      const lock = await gitPath(main, "index.lock");
      await Bun.write(lock, "another process owns this\n");

      const outcomes = await sync(repo, { target: "main" });
      expect(outcomes[0]).toMatchObject({ kind: "failed", errorCode: "state-conflict" });
      expect(details(outcomes)).toContain("index.lock");
      expect(details(outcomes)).not.toContain("trunk has diverged");
      expect(await head(main)).toBe(before);
      expect(await Bun.file(lock).text()).toBe("another process owns this\n");
    });
  });

  test("a hook refusal is not a conflict even when the hook uses that word", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "feat/login");
      const before = await head(path);
      await remoteCommit(temp, "main");
      const hook = await gitPath(path, "hooks/pre-rebase");
      await Bun.write(
        hook,
        "#!/bin/sh\necho 'CONFLICT: policy rejected this operation' >&2\nexit 1\n",
      );
      await chmod(hook, 0o755);

      const outcomes = await sync(repo, { target: "feat/login" });
      expect(outcomes[0]).toMatchObject({ kind: "failed", errorCode: "git-failed" });
      expect(details(outcomes)).toContain("policy rejected");
      expect(details(outcomes)).not.toContain("was rolled back");
      expect(await head(path)).toBe(before);
      expect(await operationInProgress(path)).toBeUndefined();
    });
  });

  test("a missing trunk is caught before rebasing onto a changed upstream", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "feat/login");
      const before = await head(path);
      await remoteCommit(temp, "feat/login");
      await seedGit(repo.gitDir, ["config", "branch.main.merge", "refs/heads/missing"]);

      const outcomes = await sync(repo, { target: "feat/login" });
      expect(outcomes[0]?.kind).toBe("failed");
      expect(details(outcomes)).toContain("origin/missing");
      expect(await head(path)).toBe(before);
      expect(await Bun.file(join(path, "remote.txt")).exists()).toBe(false);
    });
  });

  test.each([true, false])(
    "a signing failure after rebase starts stays an operational error (abort=%s)",
    async (abortOnConflict) => {
      await withTempRepo(async (temp) => {
        const repo = await managedRepo(temp);
        const { path } = await seedWorktree(repo, "feat/login");
        const before = await head(path);
        await remoteCommit(temp, "main");
        await seedGit(repo.gitDir, ["config", "commit.gpgsign", "true"]);
        await seedGit(repo.gitDir, ["config", "gpg.program", "/usr/bin/false"]);

        const outcomes = await sync(repo, { target: "feat/login", abortOnConflict });
        expect(outcomes[0]).toMatchObject({ kind: "failed", errorCode: "git-failed" });
        expect(details(outcomes)).toContain("failed to sign");
        expect(outcomes[0]?.conflicts).toBeUndefined();
        expect(await operationInProgress(path)).toBe(abortOnConflict ? undefined : "rebase");
        if (abortOnConflict) expect(await head(path)).toBe(before);
        else expect(details(outcomes)).toContain("manually");
      });
    },
  );

  test.each([
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_START", "bisect"],
    ["sequencer", "cherry-pick or revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase or am"],
  ])("a clean checkout with %s is left alone", async (marker, operation) => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const main = join(repo.root, "main");
      const before = await head(main);
      await remoteCommit(temp, "main");
      const state = await gitPath(main, marker);
      if (marker === "sequencer" || marker.startsWith("rebase-")) await mkdir(state);
      else await Bun.write(state, `${before}\n`);

      expect((await statusOf(main)).dirty).toBe(false);
      const outcomes = await sync(repo, { target: "main" });
      expect(outcomes[0]).toMatchObject({
        kind: "skipped",
        reason: `a ${operation} is already in progress here`,
      });
      expect(await head(main)).toBe(before);
      expect(await operationInProgress(main)).toBe(operation);
    });
  });

  test("an abort failure is reported with recovery guidance and never called rolled back", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "spike");
      await commit(path, "app.txt", "mine\n");
      await remoteCommit(temp, "main", "app.txt", "theirs\n");
      const lock = await gitPath(path, "index.lock");
      const log = recorder();
      const reporter: Reporter = {
        ...log.reporter,
        step(label) {
          const step = log.reporter.step(label);
          return {
            ...step,
            fail(message) {
              step.fail(message);
              if (message?.includes("conflicts with")) writeFileSync(lock, "busy\n");
            },
          };
        },
      };

      const outcomes = await sync(repo, { target: "spike" }, reporter);
      expect(outcomes[0]?.kind).toBe("failed");
      expect(details(outcomes)).toContain("could not roll back");
      expect(details(outcomes)).toContain("index.lock");
      expect(details(outcomes)).toContain("manually");
      expect(details(outcomes)).not.toContain("was rolled back");
      expect(await operationInProgress(path)).toBe("rebase");
      expect(await Bun.file(lock).text()).toBe("busy\n");
    });
  });

  test("a push connection failure keeps the local commits and the original diagnostic", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "feat/login");
      const remoteBefore = await head(temp.originPath, "feat/login");
      await remoteCommit(temp, "main");
      await seedGit(repo.gitDir, [
        "remote",
        "set-url",
        "--push",
        "origin",
        join(temp.root, "unreachable.git"),
      ]);

      const outcomes = await sync(repo, { target: "feat/login" });
      expect(outcomes[0]).toMatchObject({ kind: "rebased", pushed: false });
      expect(details(outcomes)).toContain("unreachable.git");
      expect(details(outcomes)).toContain("does not appear to be a git repository");
      expect(await head(path)).not.toBe(remoteBefore);
      expect(await head(temp.originPath, "feat/login")).toBe(remoteBefore);
      expect(await operationInProgress(path)).toBeUndefined();
    });
  });

  test("a server hook rejection retains its policy explanation", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "feat/login");
      await commit(path, "local.txt", "mine\n");
      const hook = join(temp.originPath, "hooks", "pre-receive");
      await Bun.write(hook, "#!/bin/sh\necho 'protected branch: review required' >&2\nexit 1\n");
      await chmod(hook, 0o755);

      const outcomes = await sync(repo, { target: "feat/login" });
      expect(outcomes[0]?.pushed).toBe(false);
      expect(details(outcomes)).toContain("protected branch: review required");
      expect(details(outcomes)).toContain("pre-receive hook declined");
    });
  });

  test("a background fetch cannot weaken the push lease of a renamed branch", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const { path } = await seedWorktree(repo, "feat/login");
      await seedGit(path, ["branch", "-m", "review/topic"]);
      await remoteCommit(temp, "main");
      const scratch = join(temp.root, "colleague");
      await seedGit(temp.root, ["clone", "-b", "feat/login", temp.originUrl, scratch]);
      await commit(scratch, "colleague.txt", "must survive\n");
      await seedGit(scratch, ["push", "origin", "HEAD:refs/heads/incoming"]);
      const unseen = await head(scratch);
      const hook = await gitPath(path, "hooks/post-rewrite");
      const advanceRemote = [
        "git",
        `--git-dir=${temp.originPath}`,
        "update-ref",
        "refs/heads/feat/login",
        unseen,
      ];
      const advanceTracking = ["git", "update-ref", "refs/remotes/origin/feat/login", unseen];
      await Bun.write(
        hook,
        `#!${process.execPath}\nfor (const argv of ${JSON.stringify([advanceRemote, advanceTracking])}) { const result = Bun.spawnSync(argv); if (result.exitCode !== 0) process.exit(result.exitCode); }\n`,
      );
      await chmod(hook, 0o755);

      const outcomes = await sync(repo, { target: "review/topic" });
      expect(outcomes[0]?.pushed).toBe(false);
      expect(details(outcomes)).toContain("stale info");
      expect(await head(temp.originPath, "feat/login")).toBe(unseen);
      expect(await head(repo.gitDir, "origin/feat/login")).toBe(unseen);
      expect(await Bun.file(join(path, "colleague.txt")).exists()).toBe(false);
    });
  });
});

test("standalone rebase preserves its carried changes when abort fails", async () => {
  await withTempRepo(async (temp) => {
    const repo = await managedRepo(temp);
    const { path } = await seedWorktree(repo, "spike");
    await commit(path, "app.txt", "mine\n");
    await Bun.write(join(path, "README.md"), "unfinished note\n");
    await remoteCommit(temp, "main", "app.txt", "theirs\n");
    const lock = await gitPath(path, "index.lock");
    const log = recorder();
    const reporter: Reporter = {
      ...log.reporter,
      step(label) {
        const step = log.reporter.step(label);
        return {
          ...step,
          fail(message) {
            step.fail(message);
            if (message?.includes("conflicts with")) writeFileSync(lock, "busy\n");
          },
        };
      },
    };

    const error = await rebaseWorktree(
      repo,
      repo.root,
      {
        target: "spike",
        base: { kind: "trunk" },
        fetch: true,
        abortOnConflict: true,
        carry: true,
      },
      reporter,
    ).catch((error: unknown) => error);
    expect(isGroveError(error)).toBe(true);
    if (!isGroveError(error)) throw new Error("expected a recovery error");
    expect(error.message).toBe("could not roll back the rebase");
    const stash = /git stash apply ([0-9a-f]+)/.exec(error.hint ?? "")?.[1];
    expect(stash).toBeDefined();
    expect(await operationInProgress(path)).toBe("rebase");
    // Follow the recovery instructions and prove the uncommitted work survived.
    await rm(lock);
    await seedGit(path, ["rebase", "--abort"]);
    await seedGit(path, ["stash", "apply", stash ?? ""]);
    expect(await Bun.file(join(path, "README.md")).text()).toBe("unfinished note\n");
    expect(await Bun.file(join(path, "app.txt")).text()).toBe("mine\n");
  });
});

describe("failure aggregation", () => {
  test("retains every worktree's reason when failures have different severities", () => {
    const outcomes: SyncOutcome[] = [
      {
        path: "/a",
        dir: "a",
        kind: "conflicted",
        reason: "rebase conflict",
        conflicts: ["app.txt"],
      },
      { path: "/b", dir: "b", kind: "skipped", reason: "uncommitted changes" },
      {
        path: "/c",
        dir: "c",
        kind: "failed",
        errorCode: "state-conflict",
        reason: "rollback failed",
        details: ["index.lock"],
        hint: "recover manually",
      },
      {
        path: "/d",
        dir: "d",
        kind: "rebased",
        pushed: false,
        pushRefusal: "authentication failed",
      },
    ];
    const error = failureFor(outcomes);
    expect(error?.code).toBe("state-conflict");
    for (const reason of [
      "app.txt",
      "uncommitted changes",
      "index.lock",
      "authentication failed",
      "recover manually",
    ]) {
      expect(error?.details.join("\n")).toContain(reason);
    }
  });
});

describe("fetch failure classification", () => {
  const tag = " ! [rejected] v1 -> v1 (would clobber existing tag)\n";
  test.each([124, 130, 137, 128])(
    "exit %i is not a successful fetch even alongside a moved tag",
    (code) => {
      expect(fetchOutcome({ code, stdout: "", stderr: tag })).toMatchObject({
        fetched: false,
        staleTags: ["v1"],
      });
    },
  );
  test.each([
    "error: cannot lock ref 'refs/remotes/origin/main'\n",
    " ! [lock failure] main -> origin/main (unable to update local ref)\n",
    "fatal: Could not read from remote repository.\n",
  ])("a moved tag does not hide another fetch error: %s", (error) => {
    expect(fetchOutcome({ code: 1, stdout: "", stderr: `${tag}${error}` })).toMatchObject({
      fetched: false,
      staleTags: ["v1"],
    });
  });
});
