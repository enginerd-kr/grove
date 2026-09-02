import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import { pathExists } from "../fs.ts";
import type { RepoPaths } from "../layout.ts";
import {
  type Attempt,
  attempt,
  managedRepo,
  probeGit,
  refused,
  seedGit,
  succeeded,
  type TempRepo,
  withTempRepo,
} from "../test-utils.ts";
import { checkoutPullRequest, listPullRequests, type PrResult } from "./pr.ts";
import { removeWorktree } from "./remove.ts";
import { resetWorktree } from "./reset.ts";

/**
 * `grove pr` against a real repository and a fake forge.
 *
 * `gh` is the one tool grove runs that is not git, and it is reached by name
 * through `PATH` — so a script called `gh` in a directory only this test knows
 * about is enough to stand in for the whole of GitHub. The fake records the
 * argv it was called with, which is how the three documented spellings are
 * shown to be resolved by `gh` rather than parsed here.
 *
 * Everything after that answer is git, and git is real: the "fork" is a second
 * bare repository on disk, the fetch is a fetch, and the push refspec is proved
 * by pushing.
 *
 * `checkoutPullRequest` is called directly rather than through the binary, and
 * the fixture survives the change untouched: `runTool` spawns `gh` with
 * `process.env`, so installing the fake's `PATH` there is the same lookup the
 * child process was doing — the only difference is that a `GroveError` comes
 * back instead of an exit code. That difference is most of the point. `gh` can
 * disappoint in four different ways that all exit 10, and through stderr they
 * were told apart by substring; here the message, the `hint` and gh's own bytes
 * on `details` are each asserted, and the whole `PrResult` is checked field by
 * field instead of the seven of them a `--json` reader happened to look at.
 *
 * What only the binary can answer is in `pr.e2e.test.ts`: the `--json`
 * document, the exit codes, and the two sentences `cli/run.ts` composes about a
 * worktree that was already there.
 */

/** POSIX only — the fake is a shell script, and so is `clipboard.test.ts`'s. */
const POSIX = process.platform !== "win32";

/**
 * The stand-in for `gh`.
 *
 * `PATH` is reset inside so the fake can reach `cat` even when the test narrowed
 * the environment of the process under test down to nothing but git; what is
 * being exercised is grove's lookup, not the script's.
 */
const GH_FAKE = `#!/bin/sh
PATH=/usr/bin:/bin
printf '%s\\n' "$*" >> "$GROVE_GH_LOG"
[ -n "$GROVE_GH_STDERR" ] && printf '%s\\n' "$GROVE_GH_STDERR" >&2
[ -n "$GROVE_GH_OUT" ] && cat "$GROVE_GH_OUT"
exit "\${GROVE_GH_EXIT:-0}"
`;

/** What `gh pr view --json` answers, before a test says otherwise. */
const OPEN_PR: Readonly<Record<string, unknown>> = {
  number: 42,
  title: "Fix the crash",
  url: "https://github.example/acme/widget/pull/42",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "fix/crash",
  isCrossRepository: true,
  headRepository: { name: "widget" },
  headRepositoryOwner: { login: "octocat" },
  author: { login: "octocat" },
};

/** The fields `gh pr view` is asked for, in the order `pr.ts` asks for them. */
const PR_FIELDS =
  "number,title,url,state,isDraft,baseRefName,headRefName,isCrossRepository,headRepository,headRepositoryOwner,author";

type Forge = {
  readonly temp: TempRepo;
  /** The managed clone, whose origin is `acme/widget.git`. */
  readonly repo: RepoPaths;
  /** The bare repository origin points at. */
  readonly base: string;
  /** Somebody else's bare repository, one directory over — the fork. */
  readonly fork: string;
  /** Replaces what the next `gh pr view` answers, over `OPEN_PR`. */
  readonly answer: (over?: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Every argv the fake `gh` has been handed, in order. */
  readonly asked: () => Promise<readonly string[]>;
  /** Commits `text` on `branch` of the fork and pushes it, as its author would. */
  readonly propose: (branch: string, text: string, message: string) => Promise<void>;
  /** Makes `gh` answer the way it does when it is unhappy: a code and its own stderr. */
  readonly fails: (code: string, stderr: string) => void;
  /** Runs `body` with a `PATH` holding git and bun and nothing else. */
  readonly withoutGh: <T>(body: () => Promise<T>) => Promise<T>;
};

/**
 * A repository whose origin sits inside a forge-shaped directory tree.
 *
 * `pr.ts` works out where a head lives by rewriting the last two components of
 * origin's own URL, so the fixture has to have two components to rewrite:
 * `<forge>/acme/widget.git` is the base and `<forge>/octocat/widget.git` is the
 * fork, and grove reaches the second by deriving it rather than being told.
 *
 * The fake's environment goes onto `process.env` for the duration rather than
 * into a child's, because the code under test now runs in this process — the
 * same reason `withTempRepo` puts the pinned git identity there.
 */
async function withForge(body: (forge: Forge) => Promise<void>): Promise<void> {
  await withTempRepo(async (temp) => {
    const forge = join(temp.root, "forge");
    const base = join(forge, "acme", "widget.git");
    const fork = join(forge, "octocat", "widget.git");

    // Independent of each other, and two git processes is the single biggest
    // thing this fixture costs — so they are paid for at once.
    await Promise.all([
      seedGit(temp.root, ["clone", "--bare", temp.originPath, base]),
      seedGit(temp.root, ["clone", "--bare", temp.originPath, fork]),
    ]);

    /**
     * The fork owner's own checkout, made the first time a test proposes
     * something.
     *
     * Six of the tests below never do — they are about what the base
     * repository holds, or about gh refusing before any of this is reached —
     * and a clone they do not use is a clone they should not pay for.
     */
    let forkWork: string | undefined;
    const workingCopy = async (): Promise<string> => {
      if (forkWork === undefined) {
        const path = join(temp.root, "fork-work");
        await seedGit(temp.root, ["clone", fork, path]);
        forkWork = path;
      }

      return forkWork;
    };

    const bin = join(temp.root, "bin");
    await mkdir(bin, { recursive: true });
    await Bun.write(join(bin, "gh"), GH_FAKE);
    await chmod(join(bin, "gh"), 0o755);

    // git and bun alone, so "gh is not installed" is a fact about the
    // environment rather than a fact about one directory being first.
    const barePath = join(temp.root, "no-gh");
    await mkdir(barePath, { recursive: true });
    await symlink(Bun.which("git") ?? "/usr/bin/git", join(barePath, "git"));
    await symlink(process.execPath, join(barePath, "bun"));

    const log = join(temp.root, "gh.log");
    const out = join(temp.root, "gh.json");
    await Bun.write(log, "");

    const repo = await managedRepo(temp, `file://${base}`);

    // Every key is set, including the two a test only sometimes wants, so that
    // all of them are on the restore list below — an exit code left behind
    // would make the next file's tests fail in a way that points nowhere near
    // here.
    const env: Readonly<Record<string, string>> = {
      PATH: `${bin}:${process.env.PATH}`,
      GROVE_GH_LOG: log,
      GROVE_GH_OUT: out,
      GROVE_GH_EXIT: "",
      GROVE_GH_STDERR: "",
    };
    const restore = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(env)) {
      restore.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      await body({
        temp,
        repo,
        base,
        fork,
        answer: async (over = {}) => {
          await Bun.write(out, JSON.stringify({ ...OPEN_PR, ...over }));
        },
        asked: async () =>
          (await Bun.file(log).text()).split("\n").filter((line) => line.length > 0),
        propose: async (branch, text, message) => {
          const work = await workingCopy();
          const known = await probeGit(work, ["rev-parse", "--verify", "--quiet", branch]);
          await seedGit(work, known.code === 0 ? ["checkout", branch] : ["checkout", "-b", branch]);

          await Bun.write(join(work, "crash.txt"), text);
          await seedGit(work, ["add", "-A"]);
          await seedGit(work, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
          await seedGit(work, ["push", "origin", branch]);
        },
        fails: (code, stderr) => {
          process.env.GROVE_GH_EXIT = code;
          process.env.GROVE_GH_STDERR = stderr;
        },
        withoutGh: async (inner) => {
          const path = process.env.PATH;
          process.env.PATH = barePath;

          try {
            return await inner();
          } finally {
            process.env.PATH = path;
          }
        },
      });
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

type PrCall = {
  /**
   * Off, though the flag is on.
   *
   * None of these fixtures has a `.grove.toml` until the block that writes one
   * says so, and an empty plan still comes back as a `SetupResult` full of
   * empty lists — noise in every `toEqual` below. The `.grove.toml` block
   * passes it explicitly.
   */
  readonly setup?: boolean;
  readonly trust?: boolean;
};

/** Checks a pull request out, and hands back whichever of the two outcomes happened. */
function attemptPr(
  forge: Forge,
  pr: string,
  { setup = false, trust = false }: PrCall = {},
): Promise<Attempt<PrResult>> {
  return attempt((reporter) =>
    checkoutPullRequest(forge.repo, forge.repo.root, { pr, setup, trust }, reporter),
  );
}

/** The same, insisting it worked — the shape most of these tests want. */
async function pr(forge: Forge, spelling: string, options?: PrCall): Promise<PrResult> {
  return succeeded(await attemptPr(forge, spelling, options));
}

async function config(bare: string, key: string): Promise<string> {
  return (await probeGit(bare, ["config", "--get-all", key])).stdout.trim();
}

async function headOf(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

/** The remotes the repository has, which is what a leak would show up in. */
async function remotes(bare: string): Promise<readonly string[]> {
  return (await probeGit(bare, ["remote"])).stdout.trim().split("\n").filter(Boolean);
}

describe.skipIf(!POSIX)("how a pull request is named", () => {
  test("a number, its browser URL, and its source branch all reach the same worktree", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      const byNumber = await pr(forge, "42");
      const byUrl = await pr(forge, "https://github.example/acme/widget/pull/42");
      const byBranch = await pr(forge, "octocat:fix/crash");

      // One directory, whichever spelling asked for it — the number comes back
      // out of gh's answer rather than out of the argument.
      expect([byUrl.path, byBranch.path]).toEqual([byNumber.path, byNumber.path]);
      expect(byNumber.path).toBe(join(forge.repo.root, "pr", "42"));
      expect([byUrl.alreadyPresent, byBranch.alreadyPresent]).toEqual([true, true]);

      // And each spelling was handed to `gh` untouched: grove parses none of
      // them, which is what makes all three free.
      expect(await forge.asked()).toEqual([
        `pr view 42 --json ${PR_FIELDS}`,
        `pr view https://github.example/acme/widget/pull/42 --json ${PR_FIELDS}`,
        `pr view octocat:fix/crash --json ${PR_FIELDS}`,
      ]);
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("the worktree a pull request gets", () => {
  test("a fork's proposal lands on a real local branch called pr/42", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      const outcome = await attemptPr(forge, "42");
      const result = succeeded(outcome);

      // The whole result, field by field — what "exit 0 and seven fields off
      // stdout" was standing in for.
      expect(result).toEqual({
        path: join(forge.repo.root, "pr", "42"),
        // Taken from the `add` underneath rather than recomputed — the same
        // field `path`, `reset` and `rename` answer with, so this row lines up
        // with `grove list`.
        dir: "pr/42",
        branch: "pr/42",
        number: 42,
        title: "Fix the crash",
        url: "https://github.example/acme/widget/pull/42",
        state: "OPEN",
        head: "octocat:fix/crash",
        remote: "pr-42",
        upstream: "pr-42/fix/crash",
        pushable: true,
        updated: "created",
        alreadyPresent: false,
        setup: undefined,
      });

      // A branch, not a detached head — `git branch` is where a reviewer looks.
      expect((await probeGit(forge.repo.gitDir, ["branch", "--list", "pr/42"])).stdout).toContain(
        "pr/42",
      );
      expect(
        (await probeGit(result.path, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim(),
      ).toBe("pr/42");

      // Checked out from what the fake gh reported, which lives on somebody
      // else's remote and was never on origin at all.
      expect(await Bun.file(join(result.path, "crash.txt")).text()).toBe("one\n");
      expect(
        (await probeGit(forge.base, ["rev-parse", "--verify", "--quiet", "fix/crash"])).code,
      ).not.toBe(0);
      expect(await headOf(result.path)).toBe(
        (await probeGit(forge.fork, ["rev-parse", "fix/crash"])).stdout.trim(),
      );

      // The title and the link, kept where `git branch --edit-description` put
      // them, so a directory called `pr/42` is still readable in a month.
      expect(await config(forge.repo.gitDir, "branch.pr/42.description")).toContain(
        "Fix the crash",
      );
      expect(await config(forge.repo.gitDir, "branch.pr/42.description")).toContain(
        "https://github.example/acme/widget/pull/42",
      );

      // The transcript, which a process only ever showed as a blob: what was
      // asked, what was fetched, and — on a branch that was just created — the
      // one line that says the push refspec below is there at all.
      const narrated = outcome.log.err.join("");
      expect(narrated).toContain("✓ pull request 42 — Fix the crash");
      expect(narrated).toContain("✓ fetched octocat:fix/crash");
      expect(narrated).toContain("git push there sends it back to octocat:fix/crash");
      // Nothing about the pull request went to stdout: the result is the result.
      expect(outcome.log.out).toEqual([]);
    });
  }, 90_000);

  test("a plain `git push` in that worktree goes back to the pull request's own branch", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      const result = await pr(forge, "42");
      const bare = forge.repo.gitDir;

      // The refspec is the payoff, and it is asserted rather than inferred:
      // `pr/42` and `fix/crash` are different names, so under `push.default`
      // alone a bare `git push` would be refused.
      expect(await config(bare, "remote.pr-42.push")).toBe("refs/heads/pr/42:refs/heads/fix/crash");
      expect(result.upstream).toBe("pr-42/fix/crash");
      expect(await config(bare, "branch.pr/42.remote")).toBe("pr-42");
      expect(result.pushable).toBe(true);

      await Bun.write(join(result.path, "review.txt"), "reviewed\n");
      await seedGit(result.path, ["add", "-A"]);
      await seedGit(result.path, ["-c", "commit.gpgsign=false", "commit", "-m", "Review note"]);

      const pushed = await probeGit(result.path, ["push"]);
      expect([pushed.code, pushed.stderr]).toEqual([0, pushed.stderr]);

      // It arrived on the fork under the pull request's name, not under `pr/42`.
      expect((await probeGit(forge.fork, ["rev-parse", "fix/crash"])).stdout.trim()).toBe(
        await headOf(result.path),
      );
      expect(
        (await probeGit(forge.fork, ["rev-parse", "--verify", "--quiet", "pr/42"])).code,
      ).not.toBe(0);
    });
  }, 90_000);

  test("the pr-42 remote fetches one branch, not the fork's whole collection", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");
      // Two more branches the fork's owner happens to have, and which this
      // review has no business paying for.
      await forge.propose("wip/other", "other\n", "Something else");

      await pr(forge, "42");
      const bare = forge.repo.gitDir;

      expect(await config(bare, "remote.pr-42.fetch")).toBe(
        "+refs/heads/fix/crash:refs/remotes/pr-42/fix/crash",
      );
      expect(await config(bare, "remote.pr-42.tagOpt")).toBe("--no-tags");

      const refs = await probeGit(bare, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/pr-42/",
      ]);
      // One ref, though the fork carries main, feat/login and wip/other too.
      expect(refs.stdout.trim().split("\n")).toEqual(["refs/remotes/pr-42/fix/crash"]);

      // Named after the pull request rather than its author, so a second
      // proposal from the same fork cannot fight over one push refspec.
      expect(await remotes(bare)).toEqual(["origin", "pr-42"]);
    });
  }, 90_000);

  test("a proposal from the base repository points its remote back at origin", async () => {
    await withForge(async (forge) => {
      await forge.answer({
        number: 7,
        headRefName: "feat/login",
        isCrossRepository: false,
        headRepositoryOwner: { login: "acme" },
      });

      const result = await pr(forge, "7");

      expect(result.head).toBe("acme:feat/login");
      // Derived from origin's own URL, which is what keeps the transport and
      // the host that already work here.
      expect(await config(forge.repo.gitDir, "remote.pr-7.url")).toBe(`file://${forge.base}`);
      expect(await Bun.file(join(result.path, "login.txt")).text()).toBe("login\n");
      expect(result.upstream).toBe("pr-7/feat/login");
    });
  }, 90_000);

  test("a merged pull request whose branch is gone is a copy with nothing to push to", async () => {
    await withForge(async (forge) => {
      // GitHub keeps `refs/pull/<n>/head` on the base repository forever, which
      // is the only thing left once a merge has deleted the head branch.
      const sha = (await probeGit(forge.base, ["rev-parse", "feat/login"])).stdout.trim();
      await seedGit(forge.base, ["update-ref", "refs/pull/8/head", sha]);
      await forge.answer({
        number: 8,
        state: "MERGED",
        isDraft: true,
        headRefName: "gone-branch",
      });

      const outcome = await attemptPr(forge, "8");
      const result = succeeded(outcome);

      expect(result.state).toBe("MERGED");
      expect(result.dir).toBe("pr/8");
      // Three facts rather than one sentence: there is no remote that can serve
      // it, so there is no upstream and nothing to push.
      expect(result.pushable).toBe(false);
      expect(result.remote).toBeUndefined();
      expect(result.upstream).toBeUndefined();
      expect(await headOf(result.path)).toBe(sha);

      // Said, not refused: "what did this change" is as good a question about a
      // merged pull request as an open one. Two of the three are warnings and
      // the draft is an aside, which the prefixes are the record of.
      const narrated = outcome.log.err;
      expect(narrated).toContain(
        "! pull request 8 is merged; this is the branch as it was proposed\n",
      );
      expect(narrated).toContain("· pull request 8 is still a draft\n");
      expect(narrated).toContain(
        "! the branch behind pull request 8 is gone; this is a copy with nothing to push back to\n",
      );
      // And nothing promised a push refspec that is not there.
      expect(narrated.join("")).not.toContain("git push there sends it back");

      // The remote that could not serve it is gone rather than left behind.
      expect(await remotes(forge.repo.gitDir)).toEqual(["origin"]);
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("running it again", () => {
  test("catches the worktree up when the pull request moves on", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");
      const first = await pr(forge, "42");

      const unchanged = await pr(forge, "42");
      expect([unchanged.updated, unchanged.alreadyPresent]).toEqual(["unchanged", true]);

      await forge.propose("fix/crash", "two\n", "More fixing");
      const caught = await pr(forge, "42");

      expect(caught.updated).toBe("fast-forwarded");
      expect(caught.alreadyPresent).toBe(true);
      // Still named, on the path where the worktree was already there.
      expect([caught.dir, caught.path]).toEqual(["pr/42", first.path]);
      // The move went through the worktree, so the files match the branch.
      expect(await Bun.file(join(first.path, "crash.txt")).text()).toBe("two\n");
      expect(await headOf(first.path)).toBe(
        (await probeGit(forge.fork, ["rev-parse", "fix/crash"])).stdout.trim(),
      );
    });
  }, 90_000);

  test("refuses rather than choosing when the pull request moved and you have commits there", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");
      const first = await pr(forge, "42");

      await Bun.write(join(first.path, "mine.txt"), "mine\n");
      await seedGit(first.path, ["add", "-A"]);
      await seedGit(first.path, ["-c", "commit.gpgsign=false", "commit", "-m", "My own work"]);
      const mine = await headOf(first.path);

      // Meanwhile the author pushes another commit, so the branch here is
      // neither equal to the head nor an ancestor of it.
      await forge.propose("fix/crash", "two\n", "More fixing");

      const outcome = await attemptPr(forge, "42");
      const error = refused(outcome);

      expect(error.code).toBe("refused");
      expect(errorToExitCode(error.code)).toBe(ExitCode.refused);
      expect(error.message).toBe("pr/42 has 1 commit pull request 42 does not");
      // Which of the two refusals `reconcileBranch` composes this was: the
      // commits are yours. The other one — a `pr/42` somebody else made — reads
      // almost the same and is told apart by the hint, below.
      expect(error.hint).toBe(
        "they are yours — push them, or throw them away: grove reset pr/42 --to pr-42/fix/crash",
      );

      // Nothing was lost: the branch is where it was, and so is the file.
      expect(await headOf(first.path)).toBe(mine);
      expect(await Bun.file(join(first.path, "mine.txt")).text()).toBe("mine\n");
      expect(await Bun.file(join(first.path, "crash.txt")).text()).toBe("one\n");

      // And the hint works, which is what makes it a hint rather than an excuse.
      succeeded(
        await attempt((reporter) =>
          resetWorktree(
            forge.repo,
            forge.repo.root,
            { target: "pr/42", to: "pr-42/fix/crash", clean: false },
            reporter,
          ),
        ),
      );

      expect((await pr(forge, "42")).updated).toBe("unchanged");
      expect(await Bun.file(join(first.path, "crash.txt")).text()).toBe("two\n");
    });
  }, 90_000);

  test("refuses a moved pull request over uncommitted changes, and an unrelated pr/9", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");
      const first = await pr(forge, "42");

      await Bun.write(join(first.path, "crash.txt"), "half-edited\n");
      await forge.propose("fix/crash", "two\n", "More fixing");

      const dirty = refused(await attemptPr(forge, "42"));

      expect(dirty.code).toBe("refused");
      expect(dirty.message).toBe("pr/42 has uncommitted changes, and pull request 42 has moved on");
      expect(dirty.hint).toBe("commit them, or discard them: grove reset pr/42");
      expect(await Bun.file(join(first.path, "crash.txt")).text()).toBe("half-edited\n");

      // Somebody's own branch that happens to be called `pr/9`: not an
      // ancestor of the head, so it is refused rather than quietly checked out
      // as though it were the pull request.
      await seedGit(forge.repo.gitDir, ["branch", "pr/9", "refs/remotes/origin/feat/login"]);
      await forge.answer({
        number: 9,
        headRefName: "main",
        headRepositoryOwner: { login: "acme" },
      });

      const outcome = await attemptPr(forge, "9");
      const clash = refused(outcome);

      expect(clash.code).toBe("refused");
      expect(clash.message).toBe("pr/9 is already a branch here, and it is not pull request 9");
      // The other half of the same check, and the half stderr could not show:
      // this one is not yours, so the way out is a rename and not a reset.
      expect(clash.hint).toBe(
        `rename it: git -C ${forge.repo.gitDir} branch -m pr/9 <another name>`,
      );
      expect(await pathExists(join(forge.repo.root, "pr", "9"))).toBe(false);
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("the remotes a review leaves behind", () => {
  test("removing pr/42 with its branch takes the pr-42 remote too", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");
      await pr(forge, "42");

      /** `grove remove`, without the teardown no fixture here has a file for. */
      const remove = (deleteBranch: boolean) =>
        attempt((reporter) =>
          removeWorktree(
            forge.repo,
            forge.repo.root,
            { target: "pr/42", force: false, deleteBranch, teardown: false },
            reporter,
          ),
        );

      // The worktree alone is not enough: the branch is what the remote serves.
      const kept = succeeded(await remove(false));
      expect(kept.branchDeleted).toBe(false);
      expect(await remotes(forge.repo.gitDir)).toContain("pr-42");

      await pr(forge, "42");
      const outcome = await remove(true);

      expect(succeeded(outcome).branchDeleted).toBe(true);
      expect(outcome.log.err.join("")).toContain("dropped remote pr-42");
      expect(await remotes(forge.repo.gitDir)).toEqual(["origin"]);
    });
  }, 90_000);

  test("a remote left by a review that went another way is swept up on the next run", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      // `pr-99` with no `pr/99` branch: what a branch deleted by hand, or a
      // merge, leaves for the refresh tick to fetch forever.
      await seedGit(forge.repo.gitDir, ["remote", "add", "pr-99", `file://${forge.fork}`]);
      // A remote that merely looks similar is not grove's to remove.
      await seedGit(forge.repo.gitDir, ["remote", "add", "upstream", `file://${forge.base}`]);

      await pr(forge, "42");

      expect(await remotes(forge.repo.gitDir)).toEqual(["origin", "pr-42", "upstream"]);
    });
  }, 90_000);
});

describe.skipIf(!POSIX)(".grove.toml", () => {
  /** A trunk carrying a setup file, the same fixture `add` is measured against. */
  async function seedSetupFile(root: string): Promise<void> {
    const main = join(root, "main");

    await Bun.write(
      join(main, ".grove.toml"),
      `[setup]
copy = [".env"]
link = ["node_modules"]
run = ["sh -c 'echo ok > ran.txt'"]
`,
    );
    await Bun.write(join(main, ".env"), "SECRET=1\n");
    await mkdir(join(main, "node_modules"), { recursive: true });
    await Bun.write(join(main, "node_modules", "marker"), "dep\n");

    await seedGit(main, ["add", "--", ".grove.toml"]);
    await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a setup file"]);
  }

  test("fills the worktree in like add does — run waits on --trust, --no-setup skips the lot", async () => {
    await withForge(async (forge) => {
      await seedSetupFile(forge.repo.root);
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      const untrusted = await pr(forge, "42", { setup: true });

      expect(untrusted.setup?.copied).toEqual([".env"]);
      expect(untrusted.setup?.linked).toEqual(["node_modules"]);
      expect(untrusted.setup?.planned).toBe(3);
      expect(await Bun.file(join(untrusted.path, ".env")).text()).toBe("SECRET=1\n");
      // A `run` line in somebody else's pull request is code that arrived with
      // a fetch, which is exactly the case the trust gate is there for.
      expect(untrusted.setup?.untrusted).toBe(true);
      expect(untrusted.setup?.ran).toEqual([]);
      expect(await pathExists(join(untrusted.path, "ran.txt"))).toBe(false);

      await forge.answer({ number: 43, headRefName: "fix/other" });
      await forge.propose("fix/other", "other\n", "Something else");
      const trusted = await pr(forge, "43", { setup: true, trust: true });

      expect(trusted.setup?.untrusted).toBe(false);
      expect(trusted.setup?.ran).toEqual(["sh -c 'echo ok > ran.txt'"]);
      expect(trusted.setup?.failed).toBeUndefined();
      expect(await Bun.file(join(trusted.path, "ran.txt")).text()).toBe("ok\n");

      await forge.answer({ number: 44, headRefName: "fix/third" });
      await forge.propose("fix/third", "third\n", "A third thing");
      const skipped = await pr(forge, "44", { setup: false });

      // Not an empty record: `--no-setup` means the file was never read, and an
      // absent field is the honest way to say that.
      expect(skipped.setup).toBeUndefined();
      expect(await pathExists(join(skipped.path, ".env"))).toBe(false);
      expect(await pathExists(join(skipped.path, "node_modules"))).toBe(false);
      expect(await pathExists(join(skipped.path, "ran.txt"))).toBe(false);
    });
  }, 120_000);
});

describe.skipIf(!POSIX)("when gh cannot answer", () => {
  test("gh missing is its own answer, with somewhere to get it", async () => {
    await withForge(async (forge) => {
      await forge.answer();

      // Nothing on `PATH` but git and bun, so this is "gh is not installed"
      // rather than "the fake was shadowed".
      const outcome = await forge.withoutGh(() => attemptPr(forge, "42"));
      const error = refused(outcome);

      expect(error.code).toBe("gh");
      // The one exit code nothing else in grove reports, because `gh` is the
      // one tool nothing else in grove needs.
      expect(errorToExitCode(error.code)).toBe(ExitCode.gh);
      expect(error.message).toBe("this needs `gh`, which is not installed");
      expect(error.hint).toBe(
        "https://cli.github.com — only `grove pr` and `grove prune --closed` use it",
      );
      // Missing is not the same as failing: there is no exit code to quote and
      // no stderr to carry, so `details` is empty rather than a guess.
      expect(error.details).toEqual([]);

      // Not a crash: the step that was open says it failed, and nothing was
      // written.
      expect(outcome.log.err.join("")).toContain("✗ the forge had no answer");
      expect(await pathExists(join(forge.repo.root, "pr"))).toBe(false);
      expect(await remotes(forge.repo.gitDir)).toEqual(["origin"]);
    });
  }, 90_000);

  test("gh failing surfaces gh's own stderr, and names the fix when it is the repository", async () => {
    await withForge(async (forge) => {
      forge.fails("1", "no pull requests found for branch 999");

      const failing = refused(await attemptPr(forge, "999"));

      expect(failing.code).toBe("gh");
      expect(failing.message).toBe("gh pr view failed (exit 1)");
      // gh's own words are the useful half; grove adds none of its own.
      expect(failing.details.join("\n")).toContain("no pull requests found for branch 999");
      // No hint at all, rather than a hint that happens not to mention
      // `set-default`: this is gh answering a question, not gh being lost.
      expect(failing.hint).toBeUndefined();

      forge.fails("1", "none of the git remotes correspond to a known GitHub host");

      const hostless = refused(await attemptPr(forge, "42"));

      expect(hostless.code).toBe("gh");
      expect(hostless.hint).toBe(
        "gh could not tell which GitHub repository this is; try `gh repo set-default`",
      );
      expect(await remotes(forge.repo.gitDir)).toEqual(["origin"]);
    });
  }, 90_000);

  // The fields the remote's name, URL and refspecs are spelled out of are
  // checked before the first write, so an answer with no head ref costs the run
  // and not the repository — nothing invalid reaches `.bare/config`.
  test("an answer grove does not recognise is refused before the config is touched", async () => {
    await withForge(async (forge) => {
      await Bun.write(join(forge.temp.root, "gh.json"), JSON.stringify({ title: "who knows" }));

      const error = refused(await attemptPr(forge, "42"));

      expect(error.code).toBe("gh");
      // Every field that was missing, named — the sentence a `toContain("gh")`
      // could not tell from any other gh failure, and the one that says which
      // half of the answer to go and look at.
      expect(error.message).toBe(
        "gh pr view answered without number, headRefName, headRepositoryOwner, headRepository",
      );
      expect(error.hint).toBe(`see what it answers: gh pr view 42 --json ${PR_FIELDS}`);

      // The repository still works afterwards, which is the point of refusing.
      const listed = await probeGit(forge.repo.gitDir, ["remote"]);
      expect([listed.code, listed.stdout.trim()]).toEqual([0, "origin"]);
    });
  }, 90_000);

  // gh's stdout is as much external input as its exit code, so output grove
  // cannot read is one more way gh disappoints — a `gh` error with gh's own
  // words, not a `SyntaxError` and "a bug in this tool".
  test("gh answering with something that is not JSON is a gh failure, not a crash", async () => {
    await withForge(async (forge) => {
      await Bun.write(join(forge.temp.root, "gh.json"), "not json at all\n");

      const error = refused(await attemptPr(forge, "42"));

      expect(error.code).toBe("gh");
      expect(error.message).toBe("gh pr view answered with something that is not JSON");
      // gh's own bytes, carried rather than paraphrased.
      expect(error.details.join("\n")).toContain("not json at all");
    });
  }, 90_000);

  // The same answer for the other question grove asks gh. The picker is its
  // only caller — no command line lists pull requests — and `PATH` is what
  // grove looks `gh` up on either way.
  test("the picker's own gh call answers the same way when the list is not JSON", async () => {
    await withForge(async (forge) => {
      await Bun.write(join(forge.temp.root, "gh.json"), "not json at all\n");

      const error = refused(await attempt(() => listPullRequests(forge.repo)));

      expect(error.code).toBe("gh");
      expect(error.message).toBe("gh pr list answered with something that is not JSON");
      // gh's own bytes, so the panel can say what it was handed.
      expect(error.details.join("\n")).toContain("not json at all");
    });
  }, 90_000);
});
