import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../ui/e2e-utils.ts";
import { isGroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { repoPaths } from "../layout.ts";
import { probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";
import { listPullRequests } from "./pr.ts";

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

type PrJson = {
  readonly path: string;
  readonly branch: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly head: string;
  readonly remote?: string;
  readonly upstream?: string;
  readonly pushable: boolean;
  readonly updated: "created" | "fast-forwarded" | "unchanged";
  readonly alreadyPresent: boolean;
  readonly setup?: {
    readonly planned: number;
    readonly copied: readonly string[];
    readonly linked: readonly string[];
    readonly ran: readonly string[];
    readonly untrusted: boolean;
  };
};

type Forge = {
  readonly repo: TempRepo;
  /** The managed clone, whose origin is `acme/widget.git`. */
  readonly root: string;
  readonly bare: string;
  /** The bare repository origin points at. */
  readonly base: string;
  /** Somebody else's bare repository, one directory over — the fork. */
  readonly fork: string;
  /** `PATH` plus the files the fake `gh` reads its answer out of. */
  readonly env: Record<string, string>;
  /** A `PATH` holding git and bun and nothing else, for proving `gh` absent. */
  readonly barePath: string;
  /** Replaces what the next `gh pr view` answers, over `OPEN_PR`. */
  readonly answer: (over?: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Every argv the fake `gh` has been handed, in order. */
  readonly asked: () => Promise<readonly string[]>;
  /** Commits `text` on `branch` of the fork and pushes it, as its author would. */
  readonly propose: (branch: string, text: string, message: string) => Promise<void>;
};

/**
 * A repository whose origin sits inside a forge-shaped directory tree.
 *
 * `pr.ts` works out where a head lives by rewriting the last two components of
 * origin's own URL, so the fixture has to have two components to rewrite:
 * `<forge>/acme/widget.git` is the base and `<forge>/octocat/widget.git` is the
 * fork, and grove reaches the second by deriving it rather than being told.
 */
async function withForge(body: (forge: Forge) => Promise<void>): Promise<void> {
  await withTempRepo(async (repo) => {
    const forge = join(repo.root, "forge");
    const base = join(forge, "acme", "widget.git");
    const fork = join(forge, "octocat", "widget.git");

    await seedGit(repo.root, ["clone", "--bare", repo.originPath, base]);
    await seedGit(repo.root, ["clone", "--bare", repo.originPath, fork]);

    const forkWork = join(repo.root, "fork-work");
    await seedGit(repo.root, ["clone", fork, forkWork]);

    const bin = join(repo.root, "bin");
    await mkdir(bin, { recursive: true });
    await Bun.write(join(bin, "gh"), GH_FAKE);
    await chmod(join(bin, "gh"), 0o755);

    // git and bun alone, so "gh is not installed" is a fact about the
    // environment rather than a fact about one directory being first.
    const barePath = join(repo.root, "no-gh");
    await mkdir(barePath, { recursive: true });
    await symlink(Bun.which("git") ?? "/usr/bin/git", join(barePath, "git"));
    await symlink(process.execPath, join(barePath, "bun"));

    const log = join(repo.root, "gh.log");
    const out = join(repo.root, "gh.json");
    await Bun.write(log, "");

    const cloned = await runCli(["clone", `file://${base}`, "app"], { cwd: repo.work });
    expect([cloned.exitCode, cloned.stderr]).toEqual([ExitCode.ok, cloned.stderr]);
    const root = join(repo.work, "app");

    async function commitOnFork(branch: string, text: string, message: string): Promise<void> {
      const known = await probeGit(forkWork, ["rev-parse", "--verify", "--quiet", branch]);
      await seedGit(forkWork, known.code === 0 ? ["checkout", branch] : ["checkout", "-b", branch]);

      await Bun.write(join(forkWork, "crash.txt"), text);
      await seedGit(forkWork, ["add", "-A"]);
      await seedGit(forkWork, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
      await seedGit(forkWork, ["push", "origin", branch]);
    }

    await body({
      repo,
      root,
      bare: join(root, ".bare"),
      base,
      fork,
      barePath,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GROVE_GH_LOG: log,
        GROVE_GH_OUT: out,
      },
      answer: async (over = {}) => {
        await Bun.write(out, JSON.stringify({ ...OPEN_PR, ...over }));
      },
      asked: async () => (await Bun.file(log).text()).split("\n").filter((line) => line.length > 0),
      propose: commitOnFork,
    });
  });
}

/** `grove pr`, expected to succeed, read back as JSON. */
async function pr(forge: Forge, args: readonly string[]): Promise<PrJson> {
  const result = await runCli(["pr", ...args, "--json"], { cwd: forge.root, env: forge.env });
  expect([args, result.exitCode, result.stderr]).toEqual([args, ExitCode.ok, result.stderr]);

  return JSON.parse(result.stdout) as PrJson;
}

async function config(bare: string, key: string): Promise<string> {
  return (await probeGit(bare, ["config", "--get-all", key])).stdout.trim();
}

async function headOf(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

describe.skipIf(!POSIX)("how a pull request is named", () => {
  test("a number, its browser URL, and its source branch all reach the same worktree", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      const byNumber = await pr(forge, ["42"]);
      const byUrl = await pr(forge, ["https://github.example/acme/widget/pull/42"]);
      const byBranch = await pr(forge, ["octocat:fix/crash"]);

      // One directory, whichever spelling asked for it — the number comes back
      // out of gh's answer rather than out of the argument.
      expect([byUrl.path, byBranch.path]).toEqual([byNumber.path, byNumber.path]);
      expect(byNumber.path).toBe(join(forge.root, "pr", "42"));
      expect([byUrl.alreadyPresent, byBranch.alreadyPresent]).toEqual([true, true]);

      // And each spelling was handed to `gh` untouched: grove parses none of
      // them, which is what makes all three free.
      expect(await forge.asked()).toEqual([
        "pr view 42 --json number,title,url,state,isDraft,baseRefName,headRefName,isCrossRepository,headRepository,headRepositoryOwner,author",
        "pr view https://github.example/acme/widget/pull/42 --json number,title,url,state,isDraft,baseRefName,headRefName,isCrossRepository,headRepository,headRepositoryOwner,author",
        "pr view octocat:fix/crash --json number,title,url,state,isDraft,baseRefName,headRefName,isCrossRepository,headRepository,headRepositoryOwner,author",
      ]);
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("the worktree a pull request gets", () => {
  test("a fork's proposal lands on a real local branch called pr/42", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      const result = await pr(forge, ["42"]);

      expect(result.branch).toBe("pr/42");
      expect(result.head).toBe("octocat:fix/crash");
      expect(result.updated).toBe("created");

      // A branch, not a detached head — `git branch` is where a reviewer looks.
      expect((await probeGit(forge.bare, ["branch", "--list", "pr/42"])).stdout).toContain("pr/42");
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
      expect(await config(forge.bare, "branch.pr/42.description")).toContain("Fix the crash");
      expect(await config(forge.bare, "branch.pr/42.description")).toContain(
        "https://github.example/acme/widget/pull/42",
      );
    });
  }, 90_000);

  test("a plain `git push` in that worktree goes back to the pull request's own branch", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      const result = await pr(forge, ["42"]);

      // The refspec is the payoff, and it is asserted rather than inferred:
      // `pr/42` and `fix/crash` are different names, so under `push.default`
      // alone a bare `git push` would be refused.
      expect(await config(forge.bare, "remote.pr-42.push")).toBe(
        "refs/heads/pr/42:refs/heads/fix/crash",
      );
      expect(result.upstream).toBe("pr-42/fix/crash");
      expect(await config(forge.bare, "branch.pr/42.remote")).toBe("pr-42");
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

      await pr(forge, ["42"]);

      expect(await config(forge.bare, "remote.pr-42.fetch")).toBe(
        "+refs/heads/fix/crash:refs/remotes/pr-42/fix/crash",
      );
      expect(await config(forge.bare, "remote.pr-42.tagOpt")).toBe("--no-tags");

      const refs = await probeGit(forge.bare, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/pr-42/",
      ]);
      // One ref, though the fork carries main, feat/login and wip/other too.
      expect(refs.stdout.trim().split("\n")).toEqual(["refs/remotes/pr-42/fix/crash"]);

      // Named after the pull request rather than its author, so a second
      // proposal from the same fork cannot fight over one push refspec.
      expect((await probeGit(forge.bare, ["remote"])).stdout.trim().split("\n")).toEqual([
        "origin",
        "pr-42",
      ]);
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

      const result = await pr(forge, ["7"]);

      expect(result.head).toBe("acme:feat/login");
      // Derived from origin's own URL, which is what keeps the transport and
      // the host that already work here.
      expect(await config(forge.bare, "remote.pr-7.url")).toBe(`file://${forge.base}`);
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

      const result = await runCli(["pr", "8", "--json"], { cwd: forge.root, env: forge.env });
      expect(result.exitCode).toBe(ExitCode.ok);
      const parsed = JSON.parse(result.stdout) as PrJson;

      expect(parsed.state).toBe("MERGED");
      expect(parsed.pushable).toBe(false);
      expect(parsed.remote).toBeUndefined();
      expect(parsed.upstream).toBeUndefined();
      expect(await headOf(parsed.path)).toBe(sha);

      // Said, not refused: "what did this change" is as good a question about a
      // merged pull request as an open one.
      expect(result.stderr).toContain("pull request 8 is merged");
      expect(result.stderr).toContain("still a draft");
      expect(result.stderr).toContain("nothing to push");

      // And the remote that could not serve it is gone rather than left behind.
      expect((await probeGit(forge.bare, ["remote"])).stdout.trim().split("\n")).toEqual([
        "origin",
      ]);
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("running it again", () => {
  test("catches the worktree up when the pull request moves on", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");
      const first = await pr(forge, ["42"]);

      const unchanged = await pr(forge, ["42"]);
      expect(unchanged.updated).toBe("unchanged");

      await forge.propose("fix/crash", "two\n", "More fixing");
      const caught = await runCli(["pr", "42", "--json"], { cwd: forge.root, env: forge.env });
      expect(caught.exitCode).toBe(ExitCode.ok);

      const parsed = JSON.parse(caught.stdout) as PrJson;
      expect(parsed.updated).toBe("fast-forwarded");
      expect(parsed.alreadyPresent).toBe(true);
      expect(caught.stderr).toContain("caught up with pull request 42");
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
      const first = await pr(forge, ["42"]);

      await Bun.write(join(first.path, "mine.txt"), "mine\n");
      await seedGit(first.path, ["add", "-A"]);
      await seedGit(first.path, ["-c", "commit.gpgsign=false", "commit", "-m", "My own work"]);
      const mine = await headOf(first.path);

      // Meanwhile the author pushes another commit, so the branch here is
      // neither equal to the head nor an ancestor of it.
      await forge.propose("fix/crash", "two\n", "More fixing");

      const refused = await runCli(["pr", "42"], { cwd: forge.root, env: forge.env });

      expect(refused.exitCode).toBe(ExitCode.refused);
      expect(refused.stderr).toContain("pr/42 has 1 commit pull request 42 does not");
      // The one line that resolves it, spelled out rather than described.
      expect(refused.stderr).toContain("grove reset pr/42 --to pr-42/fix/crash");

      // Nothing was lost: the branch is where it was, and so is the file.
      expect(await headOf(first.path)).toBe(mine);
      expect(await Bun.file(join(first.path, "mine.txt")).text()).toBe("mine\n");
      expect(await Bun.file(join(first.path, "crash.txt")).text()).toBe("one\n");

      // And the hint works, which is what makes it a hint rather than an excuse.
      const reset = await runCli(["reset", "pr/42", "--to", "pr-42/fix/crash"], {
        cwd: forge.root,
      });
      expect(reset.exitCode).toBe(ExitCode.ok);
      expect((await pr(forge, ["42"])).updated).toBe("unchanged");
      expect(await Bun.file(join(first.path, "crash.txt")).text()).toBe("two\n");
    });
  }, 90_000);

  test("refuses a moved pull request over uncommitted changes, and an unrelated pr/9", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");
      const first = await pr(forge, ["42"]);

      await Bun.write(join(first.path, "crash.txt"), "half-edited\n");
      await forge.propose("fix/crash", "two\n", "More fixing");

      const dirty = await runCli(["pr", "42"], { cwd: forge.root, env: forge.env });
      expect(dirty.exitCode).toBe(ExitCode.refused);
      expect(dirty.stderr).toContain("has uncommitted changes");
      expect(await Bun.file(join(first.path, "crash.txt")).text()).toBe("half-edited\n");

      // Somebody's own branch that happens to be called `pr/9`: not an
      // ancestor of the head, so it is refused rather than quietly checked out
      // as though it were the pull request.
      await seedGit(forge.bare, ["branch", "pr/9", "refs/remotes/origin/feat/login"]);
      await forge.answer({
        number: 9,
        headRefName: "main",
        headRepositoryOwner: { login: "acme" },
      });

      const clash = await runCli(["pr", "9"], { cwd: forge.root, env: forge.env });
      expect(clash.exitCode).toBe(ExitCode.refused);
      expect(clash.stderr).toContain("pr/9 is already a branch here, and it is not pull request 9");
      expect(clash.stderr).toContain("branch -m pr/9");
      expect(await pathExists(join(forge.root, "pr", "9"))).toBe(false);
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("the remotes a review leaves behind", () => {
  test("removing pr/42 with its branch takes the pr-42 remote too", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");
      await pr(forge, ["42"]);

      // The worktree alone is not enough: the branch is what the remote serves.
      const kept = await runCli(["remove", "pr/42"], { cwd: forge.root });
      expect(kept.exitCode).toBe(ExitCode.ok);
      expect((await probeGit(forge.bare, ["remote"])).stdout).toContain("pr-42");

      await pr(forge, ["42"]);
      const removed = await runCli(["remove", "pr/42", "--delete-branch"], { cwd: forge.root });

      expect(removed.exitCode).toBe(ExitCode.ok);
      expect(removed.stderr).toContain("dropped remote pr-42");
      expect((await probeGit(forge.bare, ["remote"])).stdout.trim().split("\n")).toEqual([
        "origin",
      ]);
    });
  }, 90_000);

  test("a remote left by a review that went another way is swept up on the next run", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      // `pr-99` with no `pr/99` branch: what a branch deleted by hand, or a
      // merge, leaves for the refresh tick to fetch forever.
      await seedGit(forge.bare, ["remote", "add", "pr-99", `file://${forge.fork}`]);
      // A remote that merely looks similar is not grove's to remove.
      await seedGit(forge.bare, ["remote", "add", "upstream", `file://${forge.base}`]);

      await pr(forge, ["42"]);

      expect((await probeGit(forge.bare, ["remote"])).stdout.trim().split("\n")).toEqual([
        "origin",
        "pr-42",
        "upstream",
      ]);
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
      await seedSetupFile(forge.root);
      await forge.answer();
      await forge.propose("fix/crash", "one\n", "Fix the crash");

      const untrusted = await pr(forge, ["42"]);

      expect(untrusted.setup?.copied).toEqual([".env"]);
      expect(untrusted.setup?.linked).toEqual(["node_modules"]);
      expect(await Bun.file(join(untrusted.path, ".env")).text()).toBe("SECRET=1\n");
      // A `run` line in somebody else's pull request is code that arrived with
      // a fetch, which is exactly the case the trust gate is there for.
      expect(untrusted.setup?.untrusted).toBe(true);
      expect(untrusted.setup?.ran).toEqual([]);
      expect(await pathExists(join(untrusted.path, "ran.txt"))).toBe(false);

      await forge.answer({ number: 43, headRefName: "fix/other" });
      await forge.propose("fix/other", "other\n", "Something else");
      const trusted = await pr(forge, ["43", "--trust"]);

      expect(trusted.setup?.untrusted).toBe(false);
      expect(trusted.setup?.ran).toEqual(["sh -c 'echo ok > ran.txt'"]);
      expect(await Bun.file(join(trusted.path, "ran.txt")).text()).toBe("ok\n");

      await forge.answer({ number: 44, headRefName: "fix/third" });
      await forge.propose("fix/third", "third\n", "A third thing");
      const skipped = await pr(forge, ["44", "--no-setup"]);

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
      const result = await runCli(["pr", "42"], {
        cwd: forge.root,
        env: { PATH: forge.barePath },
      });

      expect(result.exitCode).toBe(ExitCode.gh);
      expect(result.stderr).toContain("needs `gh`, which is not installed");
      expect(result.stderr).toContain("https://cli.github.com");
      // Not a crash: no stack trace, and nothing was written.
      expect(result.stderr).not.toContain("at <parse>");
      expect(await pathExists(join(forge.root, "pr"))).toBe(false);
      expect((await probeGit(forge.bare, ["remote"])).stdout.trim()).toBe("origin");
    });
  }, 90_000);

  test("gh failing surfaces gh's own stderr, and names the fix when it is the repository", async () => {
    await withForge(async (forge) => {
      const failing = await runCli(["pr", "999"], {
        cwd: forge.root,
        env: {
          ...forge.env,
          GROVE_GH_EXIT: "1",
          GROVE_GH_STDERR: "no pull requests found for branch 999",
        },
      });

      expect(failing.exitCode).toBe(ExitCode.gh);
      expect(failing.stderr).toContain("gh pr view failed (exit 1)");
      // gh's own words are the useful half; grove adds none of its own.
      expect(failing.stderr).toContain("no pull requests found for branch 999");
      expect(failing.stderr).not.toContain("gh repo set-default");

      const hostless = await runCli(["pr", "42"], {
        cwd: forge.root,
        env: {
          ...forge.env,
          GROVE_GH_EXIT: "1",
          GROVE_GH_STDERR: "none of the git remotes correspond to a known GitHub host",
        },
      });

      expect(hostless.exitCode).toBe(ExitCode.gh);
      expect(hostless.stderr).toContain("gh repo set-default");
      expect((await probeGit(forge.bare, ["remote"])).stdout.trim()).toBe("origin");
    });
  }, 90_000);

  // The fields the remote's name, URL and refspecs are spelled out of are
  // checked before the first write, so an answer with no head ref costs the run
  // and not the repository — nothing invalid reaches `.bare/config`.
  test("an answer grove does not recognise is refused before the config is touched", async () => {
    await withForge(async (forge) => {
      await Bun.write(join(forge.repo.root, "gh.json"), JSON.stringify({ title: "who knows" }));

      const result = await runCli(["pr", "42"], { cwd: forge.root, env: forge.env });

      expect(result.exitCode).toBe(ExitCode.gh);
      expect(result.stderr).toContain("gh");
      // The repository still works afterwards, which is the point of refusing.
      const remotes = await probeGit(forge.bare, ["remote"]);
      expect([remotes.code, remotes.stdout.trim()]).toEqual([0, "origin"]);
    });
  }, 90_000);

  // gh's stdout is as much external input as its exit code, so output grove
  // cannot read is one more way gh disappoints — exit 10 with gh's own words,
  // not exit 1 and "a bug in this tool".
  test("gh answering with something that is not JSON is a gh failure, not a crash", async () => {
    await withForge(async (forge) => {
      await Bun.write(join(forge.repo.root, "gh.json"), "not json at all\n");

      const result = await runCli(["pr", "42"], { cwd: forge.root, env: forge.env });

      expect(result.exitCode).toBe(ExitCode.gh);
      expect(result.stderr).not.toContain("SyntaxError");
    });
  }, 90_000);

  // The same answer for the other question grove asks gh. In process because
  // that is how it is reached: no command line lists pull requests, the app's
  // picker is the only caller, and `PATH` is what grove looks `gh` up on either
  // way — the swap `service.test.ts` makes to prove `gh` missing.
  test("the picker's own gh call answers the same way when the list is not JSON", async () => {
    await withForge(async (forge) => {
      await Bun.write(join(forge.repo.root, "gh.json"), "not json at all\n");

      const path = process.env.PATH;
      Object.assign(process.env, forge.env);

      try {
        const failed: unknown = await listPullRequests(repoPaths(forge.root)).catch(
          (error: unknown) => error,
        );

        if (!isGroveError(failed)) throw new Error(`expected a GroveError, got ${String(failed)}`);
        expect(failed.code).toBe("gh");
        // gh's own bytes, so the panel can say what it was handed.
        expect(failed.details.join("\n")).toContain("not json at all");
      } finally {
        process.env.PATH = path;
        delete process.env.GROVE_GH_LOG;
        delete process.env.GROVE_GH_OUT;
      }
    });
  }, 90_000);
});
