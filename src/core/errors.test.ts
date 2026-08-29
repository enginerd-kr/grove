import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyGitError,
  GroveError,
  type GroveErrorCode,
  isGroveError,
  stderrDetails,
} from "./errors.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "./test-utils.ts";

/**
 * `classifyGitError` is a bet about the exact English sentences git prints, so
 * every string fed to it below was captured from a real failing command rather
 * than written from memory — most of them live, from the fixture repo, in the
 * "against real git" block at the bottom.
 *
 * The handful of literals in `CAPTURED` are the ones no offline fixture can
 * produce: they need a remote that refuses us, a DNS lookup, or a git old
 * enough to phrase the worktree message differently.
 */
const CAPTURED = {
  /** `git ls-remote https://no-such-host.invalid/x.git` — needs a resolver to say no. */
  unresolvedHost:
    "fatal: unable to access 'https://no-such-host.invalid/x.git/': Could not resolve host: no-such-host.invalid\n",
  /** SSH giving up on an unreachable host. */
  timedOut:
    "ssh: connect to host github.com port 22: Connection timed out\r\nfatal: Could not read from remote repository.\n",
  /** SSH with no key the remote accepts. */
  publickey:
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n",
  /** GitHub's answer for both a missing repo and one we may not see. */
  repositoryNotFound:
    "ERROR: Repository not found.\nfatal: Could not read from remote repository.\n",
  /** A remote that accepted the connection and then dropped it mid-transfer. */
  hungUp:
    "fatal: the remote end hung up unexpectedly\nfatal: early EOF\nfatal: index-pack failed\n",
  /** git < 2.36 phrased the busy-branch refusal this way; newer git says "already used by worktree". */
  checkedOutAt:
    "fatal: 'main' is already checked out at '/repos/app/main'\nUse 'git worktree add --force' to override\n",
  /** An index left unmerged: git writes this one to stdout, so only a caller passing combined output reaches it. */
  needsMerge: "app.txt: needs merge\nerror: you need to resolve your current index first\n",
  /** Likewise `git merge`'s own conflict report — stdout, not stderr. */
  conflictLine:
    "Auto-merging app.txt\nCONFLICT (content): Merge conflict in app.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n",
} as const;

/** The non-fast-forward push from the block below, kept for the `stderrDetails` tests. */
const REJECTED_PUSH = [
  "To file:///tmp/grove-WQeDHa/origin.git",
  " ! [rejected]        main -> main (fetch first)",
  "error: failed to push some refs to 'file:///tmp/grove-WQeDHa/origin.git'",
  "hint: Updates were rejected because the remote contains work that you do not",
  "hint: have locally. This is usually caused by another repository pushing to",
  "hint: the same ref. If you want to integrate the remote changes, use",
  "hint: 'git pull' before pushing again.",
  "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
  "",
].join("\n");

/** A clone of the fixture with a second commit on `main`, ready to be made to fail. */
async function clone(repo: TempRepo, name = "app"): Promise<string> {
  const path = join(repo.work, name);

  await seedGit(repo.work, ["clone", repo.originUrl, path]);

  return path;
}

async function commitIn(worktree: string, file: string, body: string, message: string) {
  await writeFile(join(worktree, file), body);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
}

describe("GroveError", () => {
  test("code, message and both optional fields survive construction", () => {
    const error = new GroveError("refused", "worktree has uncommitted changes", {
      hint: "commit or stash them first",
      details: ["app.txt", "README.md"],
    });

    expect(error.code).toBe("refused");
    expect(error.message).toBe("worktree has uncommitted changes");
    expect(error.hint).toBe("commit or stash them first");
    expect(error.details).toEqual(["app.txt", "README.md"]);
  });

  test("the optional fields have usable absences, not undefined holes", () => {
    const error = new GroveError("usage", "expected one argument");

    expect(error.hint).toBeUndefined();
    // An empty array rather than undefined, so a printer can loop unconditionally.
    expect(error.details).toEqual([]);
  });

  test("it is a real Error: instanceof, name, stack, and a throwable", () => {
    const error = new GroveError("git-failed", "git rev-parse failed (exit 128)");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GroveError);
    expect(error.name).toBe("GroveError");
    expect(typeof error.stack).toBe("string");
    // The stack has to name this file, or a crash report points at nothing useful.
    expect(error.stack).toContain("errors.test.ts");
    expect(() => {
      throw error;
    }).toThrow("git rev-parse failed (exit 128)");
  });

  test("a cause is kept, so the original failure is still reachable", () => {
    const cause = new Error("EACCES: permission denied");
    const error = new GroveError("setup-failed", "grove.setup failed", { cause });

    expect(error.cause).toBe(cause);
  });

  test("every code is accepted and stored verbatim", () => {
    const codes: readonly GroveErrorCode[] = [
      "usage",
      "not-a-repo",
      "refused",
      "rebase-conflict",
      "state-conflict",
      "setup-failed",
      "git-failed",
      "remote",
      "gh",
    ];

    expect(codes.map((code) => new GroveError(code, "x").code)).toEqual([...codes]);
  });
});

describe("isGroveError", () => {
  test("true for one we made", () => {
    expect(isGroveError(new GroveError("usage", "bad flag"))).toBe(true);
  });

  test("false for other errors, however similar", () => {
    expect(isGroveError(new Error("bad flag"))).toBe(false);
    expect(isGroveError(new TypeError("bad flag"))).toBe(false);

    // The whole point of the guard: a shape that duck-types the same is still
    // not ours, because `code` would not be one of `GroveErrorCode`.
    const lookalike = Object.assign(new Error("bad flag"), {
      name: "GroveError",
      code: "usage",
      details: [],
      hint: undefined,
    });

    expect(isGroveError(lookalike)).toBe(false);
    expect(
      isGroveError({ name: "GroveError", code: "usage", message: "bad flag", details: [] }),
    ).toBe(false);
  });

  test("false for the non-errors a catch block can actually receive", () => {
    expect(isGroveError(undefined)).toBe(false);
    expect(isGroveError(null)).toBe(false);
    expect(isGroveError("GroveError: bad flag")).toBe(false);
    expect(isGroveError(0)).toBe(false);
    expect(isGroveError([])).toBe(false);
  });

  test("narrows to the fields callers read", () => {
    const thrown: unknown = new GroveError("remote", "fetch failed", { details: ["timeout"] });

    if (!isGroveError(thrown)) throw new Error("expected isGroveError to narrow");

    expect(thrown.code).toBe("remote");
    expect(thrown.details).toEqual(["timeout"]);
  });
});

describe("classifyGitError", () => {
  test("remote failures no local fixture can produce", () => {
    expect(classifyGitError(CAPTURED.unresolvedHost)).toBe("remote");
    expect(classifyGitError(CAPTURED.timedOut)).toBe("remote");
    expect(classifyGitError(CAPTURED.publickey)).toBe("remote");
    expect(classifyGitError(CAPTURED.repositoryNotFound)).toBe("remote");
    expect(classifyGitError(CAPTURED.hungUp)).toBe("remote");
  });

  test("an older git's phrasing of a busy branch is still a state conflict", () => {
    expect(classifyGitError(CAPTURED.checkedOutAt)).toBe("state-conflict");
  });

  test("an unmerged index and a conflict banner are rebase conflicts", () => {
    expect(classifyGitError(CAPTURED.needsMerge)).toBe("rebase-conflict");
    expect(classifyGitError(CAPTURED.conflictLine)).toBe("rebase-conflict");
  });

  test("CONFLICT must start a line, so a mention of the word is not one", () => {
    expect(classifyGitError("fatal: nothing to do about the conflict marker style\n")).toBe(
      "git-failed",
    );
    expect(classifyGitError("Auto-merging a\nCONFLICT (add/add): Merge conflict in a\n")).toBe(
      "rebase-conflict",
    );
  });

  test("the remote's complaint wins over the local one it contains", () => {
    // Both sentences arrive together when a clone fails; matching "not a git
    // repository" first would report an unreachable remote as a bad local path.
    const both = [
      "fatal: '/definitely/not/here.git' does not appear to be a git repository",
      "fatal: not a git repository (or any of the parent directories): .git",
      "",
    ].join("\n");

    expect(classifyGitError(both)).toBe("remote");
  });

  test("a state conflict wins over a refusal mentioned in the same output", () => {
    // Ordering again: "already exists" is checked before the refusal patterns,
    // so the actionable half (the directory) is what the user is told about.
    const both = [
      "fatal: '/repos/app/feat/login' already exists",
      "Please commit your changes or stash them before you merge.",
      "",
    ].join("\n");

    expect(classifyGitError(both)).toBe("state-conflict");
  });

  test("matching is case-insensitive, since git varies its own capitalisation", () => {
    expect(classifyGitError("FATAL: NOT A GIT REPOSITORY (OR ANY PARENT)")).toBe("not-a-repo");
    expect(classifyGitError("Authentication Failed for 'https://example.test/x.git/'")).toBe(
      "remote",
    );
  });

  test("nothing recognisable, including nothing at all, is the honest default", () => {
    expect(classifyGitError("")).toBe("git-failed");
    expect(classifyGitError("\n\n")).toBe("git-failed");
    expect(classifyGitError("fatal: unrecognized argument: --not-an-option\n")).toBe("git-failed");
    expect(classifyGitError("git: 'nope' is not a git command. See 'git --help'.\n")).toBe(
      "git-failed",
    );
  });
});

describe("stderrDetails", () => {
  test("keeps the tail, because git's last sentence is the useful one", () => {
    const lines = stderrDetails(REJECTED_PUSH);

    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe(
      "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
    );
    expect(lines.at(0)).toBe(
      "hint: Updates were rejected because the remote contains work that you do not",
    );
  });

  test("an explicit max replaces the default of five", () => {
    expect(stderrDetails(REJECTED_PUSH, 1)).toEqual([
      "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
    ]);
    expect(stderrDetails(REJECTED_PUSH, 100)).toHaveLength(8);
  });

  test("input already shorter than the cap comes back whole", () => {
    const stderr = "fatal: not a git repository (or any of the parent directories): .git\n";

    expect(stderrDetails(stderr)).toEqual([
      "fatal: not a git repository (or any of the parent directories): .git",
    ]);
  });

  test("blank and whitespace-only lines are dropped, and the rest are trimmed", () => {
    const stderr = "  fatal: one  \n\n\t\n   \nfatal: two\n";

    expect(stderrDetails(stderr)).toEqual(["fatal: one", "fatal: two"]);
  });

  test("splits on the three line endings git actually emits", () => {
    // A lone `\r` matters: that is how git rewrites a progress line in place.
    expect(stderrDetails("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
  });

  test("progress narration is dropped once the command has already failed", () => {
    const stderr = [
      "remote: Enumerating objects: 12, done.",
      "remote: Counting objects: 100% (12/12), done.",
      "remote: Compressing objects:  85% (6/7)",
      "Receiving objects:  42% (5/12)",
      "fatal: the remote end hung up unexpectedly",
      "",
    ].join("\n");

    expect(stderrDetails(stderr)).toEqual([
      // No percentage, so it is a fact rather than a bar and survives.
      "remote: Enumerating objects: 12, done.",
      "fatal: the remote end hung up unexpectedly",
    ]);
  });

  // git's fourth phase narrates "Resolving deltas:" rather than objects, and
  // every clone emits it — which is exactly when this function is asked for
  // details, so it is dropped with the rest of the narration.
  test("the deltas phase is progress too", () => {
    const stderr = [
      "Resolving deltas:  33% (1/3)",
      "Resolving deltas: 100% (3/3), done.",
      "fatal: the remote end hung up unexpectedly",
      "",
    ].join("\n");

    expect(stderrDetails(stderr)).toEqual(["fatal: the remote end hung up unexpectedly"]);
  });

  test("empty input yields no lines at all", () => {
    expect(stderrDetails("")).toEqual([]);
    expect(stderrDetails("\n\n \n")).toEqual([]);
  });

  test("a single long line is trimmed, never wrapped or cut", () => {
    const long = `fatal: ${"x".repeat(500)}`;

    expect(stderrDetails(`  ${long}  \n`)).toEqual([long]);
  });

  // A cap of zero means no room for details, not unlimited room: `slice(-0)`
  // would hand back every line, so the cap is answered before the tail is
  // taken. No caller passes 0 today; the next one to compute a cap will.
  test("a max of zero yields no lines", () => {
    expect(stderrDetails(REJECTED_PUSH, 0)).toEqual([]);
  });
});

describe("against real git", () => {
  test("a path outside any repository is not-a-repo", async () => {
    await withTempRepo(async ({ root }) => {
      const plain = join(root, "plain");
      await mkdir(plain, { recursive: true });

      const status = await probeGit(plain, ["status"]);
      const revParse = await probeGit(plain, ["rev-parse", "--git-dir"]);

      expect(status.stderr).toContain("not a git repository");
      expect(classifyGitError(status.stderr)).toBe("not-a-repo");
      expect(classifyGitError(revParse.stderr)).toBe("not-a-repo");
    });
  });

  test("a busy branch, an occupied directory and an existing branch are state conflicts", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const bare = join(repo.work, "bare.git");

      await seedGit(repo.work, ["clone", "--bare", repo.originUrl, bare]);
      await seedGit(bare, ["worktree", "add", join(repo.work, "wt-main"), "main"]);

      const busy = await probeGit(bare, ["worktree", "add", join(repo.work, "other"), "main"]);
      const occupied = await probeGit(bare, [
        "worktree",
        "add",
        join(repo.work, "wt-main"),
        "feat/login",
      ]);
      const existing = await probeGit(app, ["checkout", "-b", "main"]);

      expect(classifyGitError(busy.stderr)).toBe("state-conflict");
      expect(classifyGitError(occupied.stderr)).toBe("state-conflict");
      expect(classifyGitError(existing.stderr)).toBe("state-conflict");
    });
  });

  test("a dirty tree and a worktree holding untracked files are refusals", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const bare = join(repo.work, "bare.git");

      // A change on the remote to pull over, and a local edit to the same file.
      const pusher = await clone(repo, "pusher");
      await commitIn(pusher, "app.txt", "two\n", "Move app.txt on");
      await seedGit(pusher, ["push", "origin", "main"]);
      await rm(pusher, { recursive: true, force: true });

      await writeFile(join(app, "app.txt"), "mine\n");
      const pulled = await probeGit(app, ["pull", "origin", "main"]);

      await seedGit(repo.work, ["clone", "--bare", repo.originUrl, bare]);
      const wt = join(repo.work, "wt");
      await seedGit(bare, ["worktree", "add", wt, "feat/login"]);
      await writeFile(join(wt, "scratch.txt"), "unsaved\n");
      const removed = await probeGit(bare, ["worktree", "remove", wt]);

      expect(pulled.stderr).toContain("would be overwritten by merge");
      expect(classifyGitError(pulled.stderr)).toBe("refused");
      expect(removed.stderr).toContain("contains modified or untracked files");
      expect(classifyGitError(removed.stderr)).toBe("refused");
    });
  });

  test("a rebase that stops on conflicting content is a rebase conflict", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);

      await seedGit(app, ["checkout", "-b", "feat/conflict"]);
      await commitIn(app, "app.txt", "feat\n", "Feat edit");
      await seedGit(app, ["checkout", "main"]);
      await commitIn(app, "app.txt", "main\n", "Main edit");
      await seedGit(app, ["checkout", "feat/conflict"]);

      const rebase = await probeGit(app, ["rebase", "main"]);

      expect(rebase.code).not.toBe(0);
      expect(rebase.stderr).toContain("could not apply");
      expect(classifyGitError(rebase.stderr)).toBe("rebase-conflict");
    });
  });

  test("a remote that is missing, refuses us, or drops us is remote", async () => {
    await withTempRepo(async ({ work }) => {
      const missing = await probeGit(work, [
        "clone",
        "file:///definitely/not/here.git",
        join(work, "nope"),
      ]);

      expect(missing.stderr).toContain("does not appear to be a git repository");
      expect(classifyGitError(missing.stderr)).toBe("remote");

      // A loopback server standing in for a remote: enough to make git meet a
      // 401 and a dropped connection without leaving the machine.
      const unauthorized = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () =>
          new Response("no", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="git"' },
          }),
      });

      try {
        const base = `127.0.0.1:${unauthorized.port}/x.git`;
        const noCredentials = await probeGit(work, ["ls-remote", `http://${base}`]);
        const badCredentials = await probeGit(work, ["ls-remote", `http://u:p@${base}`]);

        // The first one only reads this way because `runGit` pins
        // GIT_TERMINAL_PROMPT=0; otherwise it would still be waiting for a username.
        expect(noCredentials.stderr).toContain("terminal prompts disabled");
        expect(classifyGitError(noCredentials.stderr)).toBe("remote");
        expect(badCredentials.stderr).toContain("Authentication failed");
        expect(classifyGitError(badCredentials.stderr)).toBe("remote");
      } finally {
        unauthorized.stop(true);
      }

      const rude = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open: (socket) => {
            socket.end();
          },
          data: () => {},
        },
      });

      try {
        const dropped = await probeGit(work, ["ls-remote", `git://127.0.0.1:${rude.port}/x.git`]);

        expect(classifyGitError(dropped.stderr)).toBe("remote");
      } finally {
        rude.stop(true);
      }
    });
  });

  test("a lock is not a category of its own and falls through to git-failed", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const bare = join(repo.work, "bare.git");

      await writeFile(join(app, ".git", "index.lock"), "");
      await writeFile(join(app, "scratch.txt"), "x\n");
      const locked = await probeGit(app, ["add", "scratch.txt"]);
      await rm(join(app, ".git", "index.lock"));

      await seedGit(repo.work, ["clone", "--bare", repo.originUrl, bare]);
      const wt = join(repo.work, "wt");
      await seedGit(bare, ["worktree", "add", wt, "feat/login"]);
      await seedGit(bare, ["worktree", "lock", wt]);
      const lockedWorktree = await probeGit(bare, ["worktree", "remove", wt]);
      await seedGit(bare, ["worktree", "unlock", wt]);

      expect(locked.stderr).toContain("index.lock");
      expect(lockedWorktree.stderr).toContain("locked working tree");
      // No pattern claims either message, and inventing one would be guesswork
      // about a message that means "wait", not "this will never work".
      expect(classifyGitError(locked.stderr)).toBe("git-failed");
      expect(classifyGitError(lockedWorktree.stderr)).toBe("git-failed");
    });
  });

  test("a rejected push has no pattern, but its details survive for printing", async () => {
    await withTempRepo(async (repo) => {
      const app = await clone(repo);
      const other = await clone(repo, "other");

      await commitIn(other, "app.txt", "theirs\n", "Their edit");
      await seedGit(other, ["push", "origin", "main"]);
      await commitIn(app, "app.txt", "mine\n", "My edit");

      const push = await probeGit(app, ["push", "origin", "main"]);

      expect(push.code).not.toBe(0);
      expect(classifyGitError(push.stderr)).toBe("git-failed");

      // The classification is generic, so the details are the only thing that
      // tells the user what to do — they must not be swallowed.
      const details = stderrDetails(push.stderr);

      expect(details).toHaveLength(5);
      expect(details.join("\n")).toContain("fast-forward");
    });
  });
});
