import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import { trunkOf } from "../branches.ts";
import { pathExists } from "../fs.ts";
import {
  type Attempt,
  attempt,
  probeGit,
  refused,
  seedGit,
  succeeded,
  withTempRepo,
} from "../test-utils.ts";
import { type CloneResult, cloneRepo } from "./clone.ts";

/**
 * `clone` is the command with the most to get wrong that nothing else would
 * notice: the refspec a bare clone declines to write, the `.git` pointer, the
 * upstream, the branches nobody asked for. Each one surfaces as a *later*
 * command failing, so each one is asserted here.
 *
 * `cloneRepo` is called directly, and this file is the one command test that
 * may not use `managedRepo` to build its fixture: that helper *is* a call to
 * `cloneRepo`, so leaning on it would make the arrangement and the subject the
 * same code and every assertion below vacuous. Everything here starts from
 * `temp.work`, an empty directory, and the origin the fixture seeded.
 *
 * The direct call buys back the `CloneResult` — five fields the binary reduced
 * to one tab-separated row — and the `GroveError`, which matters more here than
 * anywhere: this command has two refusals whose messages differ by three words
 * (`already exists and is not empty` / `and is not a directory`) and a rollback
 * with two branches that a `.bare/HEAD` check cannot tell apart.
 *
 * What stays in `clone.e2e.test.ts` is a larger share than elsewhere, because
 * more of this command is genuinely about the binary: `grove clone <url> [dir]`
 * is the one place argument order decides what happens, `-b` is a flag, and the
 * row and the `--json` document are composed in `cli/run.ts`.
 */

type CloneCall = {
  readonly dir?: string;
  readonly branch?: string;
  readonly upstream?: string;
};

/** Clones into the empty work directory, and hands back whichever outcome happened. */
function attemptClone(
  work: string,
  url: string,
  { dir, branch, upstream }: CloneCall = {},
): Promise<Attempt<CloneResult>> {
  return attempt((reporter) => cloneRepo(work, { url, dir, branch, upstream }, reporter));
}

/** The branch names that exist locally, which a fresh clone keeps to one. */
async function localBranches(gitDir: string): Promise<readonly string[]> {
  const result = await probeGit(gitDir, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

describe("grove clone --upstream", () => {
  test("is `grove upstream` on the clone the moment it exists", async () => {
    await withTempRepo(async (temp) => {
      const canonical = join(temp.root, "canonical.git");
      await seedGit(temp.root, ["clone", "--bare", temp.originPath, canonical]);

      const result = succeeded(
        await attemptClone(temp.work, temp.originUrl, {
          dir: "app",
          upstream: `file://${canonical}`,
        }),
      );

      expect(result.upstream).toEqual({
        remote: "upstream",
        url: `file://${canonical}`,
        trunk: "main",
        ref: "upstream/main",
      });
      expect(await trunkOf(result.gitDir)).toMatchObject({ remote: "upstream" });
    });
  });

  test("a bad upstream URL fails the command but keeps the clone", async () => {
    await withTempRepo(async (temp) => {
      const error = refused(
        await attemptClone(temp.work, temp.originUrl, {
          dir: "app",
          upstream: `file://${join(temp.root, "nowhere.git")}`,
        }),
      );

      expect(error.code).toBe("remote");
      expect(error.hint).toContain("grove upstream");
      // The clone is whole and usable, with no `upstream` remote left in it.
      const root = join(temp.work, "app");
      expect(await pathExists(join(root, "main", "README.md"))).toBe(true);
      expect((await trunkOf(join(root, ".bare"))).ref).toBe("origin/main");
      const remotes = await probeGit(join(root, ".bare"), ["remote"]);
      expect(remotes.stdout.trim()).toBe("origin");
    });
  });
});

describe("grove clone", () => {
  test("lays out .bare, a .git pointer, and a worktree for the default branch", async () => {
    await withTempRepo(async (temp) => {
      const outcome = await attemptClone(temp.work, temp.originUrl, { dir: "app" });

      const root = join(temp.work, "app");
      const bare = join(root, ".bare");

      // The whole result, field by field — what one tab-separated row was
      // standing in for. `defaultBranch` and `branch` are separate answers that
      // happen to agree here, and the `-b` test below is where they part.
      expect(succeeded(outcome)).toEqual({
        root,
        gitDir: bare,
        defaultBranch: "main",
        branch: "main",
        worktree: join(root, "main"),
      });

      expect(await Bun.file(join(bare, "HEAD")).exists()).toBe(true);
      // Relative, so the whole folder can be moved without breaking git.
      expect(await Bun.file(join(root, ".git")).text()).toBe("gitdir: ./.bare\n");

      // The worktree is a real checkout of main, not an empty directory.
      expect(await Bun.file(join(root, "main", "README.md")).text()).toBe("# fixture\n");
      expect(await Bun.file(join(root, "main", "app.txt")).text()).toBe("one\n");

      // The refspec `git clone --bare` will not write, without which
      // `origin/*` never appears and every later command fails elsewhere.
      expect((await probeGit(bare, ["config", "--get", "remote.origin.fetch"])).stdout.trim()).toBe(
        "+refs/heads/*:refs/remotes/origin/*",
      );
      expect(
        (await probeGit(bare, ["rev-parse", "--verify", "refs/remotes/origin/main"])).code,
      ).toBe(0);
      expect(
        (await probeGit(bare, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout,
      ).toBe("origin/main\n");

      // HEAD follows the branch that got the worktree.
      expect((await probeGit(bare, ["symbolic-ref", "HEAD"])).stdout).toBe("refs/heads/main\n");
      // With an upstream, so `git status` and a bare `git push` both work.
      expect(
        (await probeGit(join(root, "main"), ["rev-parse", "--abbrev-ref", "main@{upstream}"]))
          .stdout,
      ).toBe("origin/main\n");

      // A bare clone imports every remote branch; only the checked-out one stays.
      expect(await localBranches(bare)).toEqual(["main"]);

      // Two steps, both settled, and the line that says where it landed. A
      // result never goes through the reporter, so `out` stays empty however
      // much is narrated — the row on stdout is `cli/run.ts`'s doing, not this
      // function's, which is exactly why it is asserted next door instead.
      const narrated = outcome.log.err.join("");
      expect(narrated).toContain("✓ cloned");
      expect(narrated).toContain("✓ fetched refs");
      expect(narrated).toContain("· app is ready");
      // The fixture has no `.grove.toml`, so there is nothing this clone should
      // be offering to run — the warning that says otherwise is a real one.
      expect(narrated).not.toContain("wants to run");
      expect(outcome.log.out).toEqual([]);
    });
  }, 30_000);

  test("names the directory after the URL when no directory is given", async () => {
    await withTempRepo(async (temp) => {
      // `origin.git` minus the suffix nobody wants in a working directory.
      const result = succeeded(await attemptClone(temp.work, temp.originUrl));

      expect(result.root).toBe(join(temp.work, "origin"));
      expect(await Bun.file(join(temp.work, "origin", ".bare", "HEAD")).exists()).toBe(true);
      expect(await Bun.file(join(temp.work, "origin", "main", "app.txt")).exists()).toBe(true);
    });
  }, 30_000);

  test("a chosen branch is checked out first, and only that one", async () => {
    await withTempRepo(async (temp) => {
      const result = succeeded(
        await attemptClone(temp.work, temp.originUrl, { dir: "app", branch: "feat/login" }),
      );

      const root = join(temp.work, "app");

      // The two branch fields part company here, which is the whole point of
      // there being two: `defaultBranch` is still what the remote calls default
      // even though nothing checked it out, and `branch` is what was asked for.
      expect(result).toEqual({
        root,
        gitDir: join(root, ".bare"),
        defaultBranch: "main",
        branch: "feat/login",
        worktree: join(root, "feat", "login"),
      });

      // The branch's own shape on disk: `feat/login` is a directory inside `feat`.
      expect(await Bun.file(join(root, "feat", "login", "login.txt")).text()).toBe("login\n");
      expect(await Bun.file(join(root, "main", "app.txt")).exists()).toBe(false);
      expect(await localBranches(join(root, ".bare"))).toEqual(["feat/login"]);
      // HEAD follows the branch that has a worktree, not the remote's default —
      // it has to name a ref that survives the pruning above.
      expect((await probeGit(join(root, ".bare"), ["symbolic-ref", "HEAD"])).stdout).toBe(
        "refs/heads/feat/login\n",
      );
    });
  }, 30_000);
});

describe("grove clone, when it cannot", () => {
  test("a URL that is not one is a usage error, before anything is spawned", async () => {
    await withTempRepo(async (temp) => {
      const outcome = await attemptClone(temp.work, "not a url");
      const failure = refused(outcome);

      expect(failure.code).toBe("usage");
      expect(errorToExitCode(failure.code)).toBe(ExitCode.usage);
      expect(failure.message).toBe('"not a url" does not look like a repository URL');
      // "before anything is spawned" was an exit code, which cannot say when.
      // Not one step was opened, and no directory was made: the refusal happens
      // above `mkdir`, so there is nothing to roll back and nothing narrated.
      expect(outcome.log.err).toEqual([]);
      expect(await pathExists(join(temp.work, "not a url"))).toBe(false);
    });
  }, 30_000);

  test("a remote that is not there reports the remote, and leaves nothing behind", async () => {
    await withTempRepo(async (temp) => {
      const missing = `file://${join(temp.root, "nothing.git")}`;
      const outcome = await attemptClone(temp.work, missing, { dir: "app" });
      const failure = refused(outcome);

      // `remote` and not `git-failed`: a script retries the first and gives up
      // on the second, and the difference is a pattern match on git's stderr
      // that the exit code alone could never show had fired correctly.
      expect(failure.code).toBe("remote");
      expect(errorToExitCode(failure.code)).toBe(ExitCode.remote);
      // git's own words, carried under our sentence — proof the reason came
      // from git and was not invented.
      expect(failure.details.join("\n")).toContain("does not appear to be a git repository");
      expect(outcome.log.err.join("")).toContain("✗ clone failed");

      // A partial `.bare` would make discovery find it and every later command
      // fail obscurely, so a failed clone cleans up after itself. The whole
      // directory goes, not just `.bare` — this command made it, so this
      // command removes it, and the second attempt behaves like the first.
      expect(await pathExists(join(temp.work, "app"))).toBe(false);

      // The other half of that rollback, which no `.bare/HEAD` check could tell
      // apart from the above: a directory the *user* had already made is kept,
      // and only what this command put inside it is taken away.
      const mine = join(temp.work, "mine");
      await mkdir(mine, { recursive: true });
      refused(await attemptClone(temp.work, missing, { dir: "mine" }));

      expect(await pathExists(mine)).toBe(true);
      expect(await pathExists(join(mine, ".bare"))).toBe(false);
    });
  }, 30_000);

  test("a branch the remote does not have is a usage error, and rolls back", async () => {
    await withTempRepo(async (temp) => {
      const outcome = await attemptClone(temp.work, temp.originUrl, {
        dir: "app",
        branch: "nope",
      });
      const failure = refused(outcome);

      expect(failure.code).toBe("usage");
      expect(errorToExitCode(failure.code)).toBe(ExitCode.usage);
      expect(failure.message).toBe('the remote has no branch named "nope"');
      expect(failure.hint).toBe("omit --branch to use the remote's default");
      // Late, unlike the malformed URL above: the clone and the fetch both
      // succeeded and are in the transcript, and it is the checkout that could
      // not happen — which is what makes the rollback below load-bearing.
      expect(outcome.log.err.join("")).toContain("✓ fetched refs");
      expect(await pathExists(join(temp.work, "app"))).toBe(false);
    });
  }, 30_000);

  test("a directory with something in it is refused rather than clobbered", async () => {
    await withTempRepo(async (temp) => {
      const root = join(temp.work, "app");
      await mkdir(root, { recursive: true });
      await Bun.write(join(root, "mine.txt"), "keep me\n");

      const outcome = await attemptClone(temp.work, temp.originUrl, { dir: "app" });
      const occupied = refused(outcome);

      expect(occupied.code).toBe("state-conflict");
      expect(errorToExitCode(occupied.code)).toBe(ExitCode.stateConflict);
      expect(occupied.message).toBe(`${root} already exists and is not empty`);
      expect(occupied.hint).toBe("pass a different directory: grove clone <url> <dir>");
      // Refused before the first step opened, so nothing was fetched and there
      // was never a rollback that could have taken the file with it.
      expect(outcome.log.err).toEqual([]);
      expect(await Bun.file(join(root, "mine.txt")).text()).toBe("keep me\n");

      // The twin refusal, three words apart and never previously distinguished:
      // a file where the directory would go is not a place you might have meant
      // at all, and the sentence says so rather than calling it "not empty".
      const file = join(temp.work, "file");
      await Bun.write(file, "not a directory\n");

      const notADirectory = refused(await attemptClone(temp.work, temp.originUrl, { dir: "file" }));

      expect(notADirectory.code).toBe("state-conflict");
      expect(notADirectory.message).toBe(`${file} already exists and is not a directory`);
      expect(await Bun.file(file).text()).toBe("not a directory\n");
    });
  }, 30_000);
});
