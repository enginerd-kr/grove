import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
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
  seedWorktree,
  succeeded,
  withTempRepo,
} from "../test-utils.ts";
import { type AddResult, addWorktree } from "./add.ts";

/**
 * `add` decides three different things and then fills a directory in, so the
 * scenarios below are grouped by which decision they are about: where the
 * branch came from, what the flags change, and what `.grove.toml` is allowed
 * to do.
 *
 * `addWorktree` is called directly, against a real repository and a recording
 * reporter, for the reason `rename.test.ts` gives at length: the repository is
 * the part that has to be real, and a process around it buys latency and costs
 * coverage. It costs it sharply here, because `add` refuses in four places and
 * two of them compose almost the same sentence — `refuseNameCollision` says
 * "<dir> already exists here" and the directory check says "<dir> already
 * exists", so a `toContain` on stderr matched either one and never said which.
 * Holding the `GroveError` distinguishes them by `hint`, and holding the
 * `AddResult` turns "exit 0" into an assertion about every field: `source`,
 * `upstream`, `dir`, and the `took`/`setup` records underneath.
 *
 * What still goes through the binary is in `add.e2e.test.ts`.
 */

type AddCall = {
  readonly from?: string;
  /** Fetch before deciding the branch is missing. On, as the flag is. */
  readonly fetch?: boolean;
  readonly push?: boolean;
  /**
   * Off, though the flag is on.
   *
   * None of these fixtures has a `.grove.toml` until the block that writes one
   * says so, and an empty plan still comes back as a `SetupResult` full of
   * empty lists — noise in every `toEqual` below, for a slower way of doing
   * nothing. The `.grove.toml` block passes it explicitly.
   */
  readonly setup?: boolean;
  readonly trust?: boolean;
  readonly take?: boolean;
  /** Where the add is asked from. Defaults to the repository root. */
  readonly cwd?: string;
};

/** Adds, and hands back whichever of the two outcomes happened. */
function attemptAdd(
  repo: RepoPaths,
  branch: string,
  {
    from,
    fetch = true,
    push = false,
    setup = false,
    trust = false,
    take = false,
    cwd = repo.root,
  }: AddCall = {},
): Promise<Attempt<AddResult>> {
  return attempt((reporter) =>
    addWorktree(repo, cwd, { branch, from, fetch, push, setup, trust, take }, reporter),
  );
}

/** What git thinks the branch tracks, or nothing. */
async function upstreamOf(worktree: string): Promise<string | undefined> {
  const result = await probeGit(worktree, ["rev-parse", "--abbrev-ref", "@{upstream}"]);

  return result.code === 0 ? result.stdout.trim() : undefined;
}

describe("where the branch comes from", () => {
  test("a remote branch is tracked, a local one is used, and anything else is created", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      // On the remote: tracked, with the upstream set from the start.
      const outcome = await attemptAdd(repo, "feat/login");

      // The whole result, field by field — what "exit 0" was standing in for.
      expect(succeeded(outcome)).toEqual({
        path: join(root, "feat", "login"),
        // The directory follows the branch's own shape, and is named twice: the
        // absolute path, and the `/`-separated row `grove list` prints.
        dir: "feat/login",
        branch: "feat/login",
        source: "remote",
        upstream: "origin/feat/login",
        alreadyPresent: false,
        setup: undefined,
        took: undefined,
      });
      expect(await Bun.file(join(root, "feat", "login", "login.txt")).text()).toBe("login\n");
      expect(await upstreamOf(join(root, "feat", "login"))).toBe("origin/feat/login");
      // The branch was already on the remote, so nothing had to go and look for
      // it — the fetch is a step, and its absence is visible here.
      expect(outcome.log.err.join("")).toContain("✓ added feat/login");
      expect(outcome.log.err.join("")).not.toContain("fetching");
      // A result never goes through the reporter, so stdout stays empty however
      // much is narrated.
      expect(outcome.log.out).toEqual([]);

      // Already a local branch: used as it is.
      await seedGit(repo.gitDir, ["branch", "existing", "refs/remotes/origin/main"]);
      const existing = succeeded(await attemptAdd(repo, "existing"));
      expect([existing.source, existing.path]).toEqual(["existing", join(root, "existing")]);
      // Reported as `origin/existing` because that is where a branch of this
      // name would be pushed — not because anything checked that it is there.
      expect(existing.upstream).toBe("origin/existing");

      // Nowhere yet: created from the default branch.
      const fresh = succeeded(await attemptAdd(repo, "fresh"));
      expect(fresh.source).toBe("new");
      // No upstream, because nobody has pushed it — and `--no-track` is what
      // keeps it from quietly tracking origin/main and reporting main's drift.
      expect(fresh.upstream).toBeUndefined();
      expect(await upstreamOf(fresh.path)).toBeUndefined();
      expect(
        (await probeGit(repo.gitDir, ["config", "--get", "branch.fresh.remote"])).code,
      ).not.toBe(0);
      expect(await Bun.file(join(fresh.path, "app.txt")).text()).toBe("one\n");
    });
  }, 60_000);

  test("asking again for a worktree that is there is not an error", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/login");

      const outcome = await attemptAdd(repo, "feat/login");

      // Idempotent, which is what makes it safe to put in a script — and the
      // whole answer is the one the first call gave, not a shortened version.
      expect(succeeded(outcome)).toEqual({
        path: join(repo.root, "feat", "login"),
        dir: "feat/login",
        branch: "feat/login",
        source: "existing",
        upstream: undefined,
        alreadyPresent: true,
        setup: undefined,
        took: undefined,
      });
      // Nothing was even begun: no fetch, no `git worktree add`, no step. That
      // is the same fact as "nothing happened", and cheaper to be sure of than
      // a directory listing.
      expect(outcome.log.err).toEqual([]);
    });
  }, 60_000);

  test("the fetch is what separates 'not on the remote' from 'not as far as we looked'", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // Two branches that appeared on the remote after the clone.
      await seedGit(temp.originPath, ["branch", "late-a", "main"]);
      await seedGit(temp.originPath, ["branch", "late-b", "main"]);

      // --no-fetch works from the refs as they were last seen, so this one is
      // created locally and would collide on push.
      const blind = await attemptAdd(repo, "late-a", { fetch: false });
      const local = succeeded(blind);

      expect(local.source).toBe("new");
      // Created, so it tracks nothing — while the remote has had a branch of
      // that name all along, which is the collision this is the story of.
      expect(local.upstream).toBeUndefined();
      expect(blind.log.err.join("")).not.toContain("fetching");
      expect(
        (await probeGit(temp.originPath, ["rev-parse", "--verify", "--quiet", "late-a"])).code,
      ).toBe(0);

      // The default fetch finds the other one and tracks it instead.
      const looked = await attemptAdd(repo, "late-b");
      const remote = succeeded(looked);

      expect([remote.source, remote.upstream]).toEqual(["remote", "origin/late-b"]);
      expect(await upstreamOf(remote.path)).toBe("origin/late-b");
      // And the looking is narrated, because it is the slow part.
      expect(looked.log.err.join("")).toContain("✓ fetched");
    });
  }, 60_000);
});

describe("the flags", () => {
  test("--from bases a new branch somewhere else", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const result = succeeded(await attemptAdd(repo, "spike", { from: "origin/feat/login" }));

      expect(result.source).toBe("new");
      // Cut from feat/login rather than from the default branch.
      expect(await Bun.file(join(result.path, "login.txt")).text()).toBe("login\n");

      const outcome = await attemptAdd(repo, "other", { from: "nowhere" });
      const bad = refused(outcome);

      expect(bad.code).toBe("usage");
      expect(errorToExitCode(bad.code)).toBe(ExitCode.usage);
      expect(bad.message).toBe('cannot start a branch from "nowhere"');
      // The hint is the only thing separating this from the same sentence about
      // `origin/main` in a repository whose default branch has gone: that one
      // is nobody's typo and carries no hint, and stderr showed neither apart.
      expect(bad.hint).toBe("--from takes a branch, tag, or commit that exists");
      // The base is checked after the fetch and before the worktree, so the
      // looking happened and the making did not.
      expect(outcome.log.err.join("")).toContain("✓ fetched");
      expect(outcome.log.err.join("")).not.toContain("adding other");
      expect(await pathExists(join(repo.root, "other"))).toBe(false);
    });
  }, 60_000);

  test("--push puts the branch on the remote and sets its upstream", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const outcome = await attemptAdd(repo, "shipped", { push: true });
      const result = succeeded(outcome);

      expect([result.source, result.upstream]).toEqual(["new", "origin/shipped"]);
      expect(await upstreamOf(result.path)).toBe("origin/shipped");
      expect(
        (await probeGit(temp.originPath, ["rev-parse", "--verify", "refs/heads/shipped"])).code,
      ).toBe(0);
      // Two writes, and the transcript says both happened — the push is a step
      // of its own, because it is the one that can fail on its own.
      expect(outcome.log.err.join("")).toContain("✓ added shipped");
      expect(outcome.log.err.join("")).toContain("✓ pushed shipped");
    });
  }, 60_000);

  test("--take carries the uncommitted work over and leaves the old worktree clean", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      const main = join(root, "main");

      await Bun.write(join(main, "app.txt"), "two\n");
      await Bun.write(join(main, "untracked.txt"), "new\n");

      const result = succeeded(await attemptAdd(repo, "wip", { take: true, cwd: main }));

      const wip = join(root, "wip");
      expect(await Bun.file(join(wip, "app.txt")).text()).toBe("two\n");
      expect(await Bun.file(join(wip, "untracked.txt")).text()).toBe("new\n");

      // The two kinds of change are counted apart, because they move apart: the
      // tracked one rides the snapshot and the untracked one is carried by hand.
      expect(result.took?.tracked).toBe(1);
      expect(result.took?.untracked).toEqual(["untracked.txt"]);
      expect(result.took?.empty).toBe(false);
      // The sha that undoes it, held as a fact rather than as a sentence — the
      // sentence is `cli/run.ts`'s, and is pinned in `add.e2e.test.ts`.
      expect(result.took?.stash).toMatch(/^[0-9a-f]{40}$/);

      // And the worktree it came from is back to what it had committed.
      expect(await Bun.file(join(main, "app.txt")).text()).toBe("one\n");
      expect(await pathExists(join(main, "untracked.txt"))).toBe(false);
      expect((await probeGit(main, ["status", "--porcelain"])).stdout).toBe("");
    });
  }, 60_000);

  test("--take from somewhere that is not a worktree is refused before anything is made", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // The root is the one directory that is never a worktree.
      const outcome = await attemptAdd(repo, "wip", { take: true });
      const error = refused(outcome);

      expect(error.code).toBe("usage");
      expect(errorToExitCode(error.code)).toBe(ExitCode.usage);
      expect(error.message).toBe("--take moves the changes of the worktree you are in");
      // A refusal with no way past it would be a wall; the hint is the door.
      expect(error.hint).toBe("cd into the worktree holding them first");
      // Resolved before anything is created, which is the whole point of where
      // the check sits: not one step was opened, so there is nothing to undo.
      expect(outcome.log.err).toEqual([]);
      expect(await pathExists(join(repo.root, "wip"))).toBe(false);
    });
  }, 60_000);
});

describe(".grove.toml", () => {
  /** A trunk carrying a setup file, plus the files it names. */
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

  /**
   * The on-disk half of `checkedPath`, from the outside.
   *
   * `setup.test.ts` proves the refusal itself; what only `add` can show is what
   * it costs — the worktree is created before `.grove.toml` is read, so a
   * repository that commits a symlink out of the tree leaves a directory behind
   * and a failed add. Loud is the right answer to an attempt at somebody's
   * keys, but it is a different error than a merely failing `run` command,
   * which `setUpWorktree` downgrades to a warning — so it is pinned here.
   */
  test("a setup file that reaches outside the worktree fails the add", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      const main = join(root, "main");
      const outside = join(temp.root, "outside");

      await mkdir(outside, { recursive: true });
      await Bun.write(join(outside, "id_rsa"), "a private key\n");

      // What a repository can commit: an innocent name pointing anywhere.
      await symlink(outside, join(main, "certs"));
      await Bun.write(join(main, ".grove.toml"), '[setup]\ncopy = ["certs/id_rsa"]\n');
      await seedGit(main, ["add", "--", ".grove.toml", "certs"]);
      await seedGit(main, ["-c", "commit.gpgsign=false", "commit", "-m", "Add a setup file"]);

      const outcome = await attemptAdd(repo, "feat/login", { setup: true });
      const error = refused(outcome);

      expect(error.code).toBe("usage");
      // A mistake in the file, not a state conflict and not a setup failure:
      // exit 2 is what a script reads, and 9 — "the worktree is there, the
      // install on it is not" — would send it to retry the install instead.
      expect(errorToExitCode(error.code)).toBe(ExitCode.usage);
      expect(error.message).toBe('copy: "certs/id_rsa" leads out of the worktree');
      expect(error.hint).toBe(
        "a path that stays inside the worktree once the links on it are followed",
      );
      // Where it led, which is the half that makes the refusal checkable by the
      // person who did not write the file.
      expect(error.details).toEqual([`certs/id_rsa → ${join(outside, "id_rsa")}`]);

      // The worktree is still there — it was made before the file was read, and
      // the transcript says so — but the thing the setup file was reaching for
      // never arrived.
      expect(outcome.log.err.join("")).toContain("✓ added feat/login");
      expect(await pathExists(join(root, "feat", "login", "app.txt"))).toBe(true);
      expect(await pathExists(join(root, "feat", "login", "certs", "id_rsa"))).toBe(false);
    });
  }, 60_000);

  test("copy and link apply on sight, while run waits on --trust", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedSetupFile(repo.root);

      const untrusted = succeeded(await attemptAdd(repo, "feat/login", { setup: true }));

      // The whole record, not the two fields a `--json` reader happened to look
      // at: what was planned, what landed, and the lists that stayed empty.
      expect(untrusted.setup).toEqual({
        path: join(repo.root, "feat", "login"),
        dir: "feat/login",
        planned: 3,
        copied: [".env"],
        linked: ["node_modules"],
        ran: [],
        missing: [],
        kept: [],
        overwritten: [],
        failed: undefined,
        // A `run` line is code that arrived with a pull, so it is reported and
        // skipped until somebody says they have read it.
        untrusted: true,
      });
      expect(await Bun.file(join(untrusted.path, ".env")).text()).toBe("SECRET=1\n");
      expect(await Bun.file(join(untrusted.path, "node_modules", "marker")).text()).toBe("dep\n");
      expect(await pathExists(join(untrusted.path, "ran.txt"))).toBe(false);

      const trusted = succeeded(await attemptAdd(repo, "trusted", { setup: true, trust: true }));

      expect(trusted.setup?.untrusted).toBe(false);
      expect(trusted.setup?.ran).toEqual(["sh -c 'echo ok > ran.txt'"]);
      expect(trusted.setup?.failed).toBeUndefined();
      expect(await Bun.file(join(trusted.path, "ran.txt")).text()).toBe("ok\n");
    });
  }, 60_000);

  test("the warning names the file to read, and --no-setup skips the lot", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedSetupFile(repo.root);

      const warned = await attemptAdd(repo, "feat/login", { setup: true });
      succeeded(warned);

      // The trunk's file, by the path somebody can open — not the copy in the
      // worktree that was just filled in, which nothing consults.
      expect(warned.log.err.join("")).toContain("main/.grove.toml");
      expect(warned.log.err.join("")).toContain("--trust");
      // Said as a warning rather than narrated as a step: nothing went wrong,
      // and something is waiting on a person.
      expect(warned.log.err.some((line) => line.startsWith("! ") && line.includes("--trust"))).toBe(
        true,
      );

      const skipped = succeeded(await attemptAdd(repo, "quiet", { setup: false }));

      // Not an empty record: `--no-setup` means the file was never read, and an
      // absent field is the honest way to say that.
      expect(skipped.setup).toBeUndefined();
      expect(await pathExists(join(skipped.path, ".env"))).toBe(false);
      expect(await pathExists(join(skipped.path, "node_modules"))).toBe(false);
      expect(await pathExists(join(skipped.path, "ran.txt"))).toBe(false);
    });
  }, 60_000);
});

describe("what add refuses", () => {
  test("a branch already checked out somewhere else names the directory holding it", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const elsewhere = join(temp.root, "elsewhere");

      // A worktree made by hand, outside the layout `add` would have used.
      await seedGit(repo.gitDir, ["worktree", "add", elsewhere, "-b", "taken"]);

      const outcome = await attemptAdd(repo, "taken");
      const error = refused(outcome);

      expect(error.code).toBe("state-conflict");
      expect(errorToExitCode(error.code)).toBe(ExitCode.stateConflict);
      // git would refuse this anyway; what it would not say is which of your
      // directories is the one holding the branch.
      expect(error.message).toBe(`"taken" is already checked out at ${elsewhere}`);
      // Named the way `grove list` would name it: relative to the root, which
      // for a worktree nobody put inside the root climbs out of it.
      expect(error.hint).toBe(
        `use that worktree, or remove it first: grove rm ${relative(repo.root, elsewhere)}`,
      );
      expect(outcome.log.err).toEqual([]);
      expect(await pathExists(join(repo.root, "taken"))).toBe(false);
    });
  }, 60_000);

  test("a directory that is already there is left alone", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await mkdir(join(root, "occupied"), { recursive: true });
      await Bun.write(join(root, "occupied", "mine.txt"), "keep\n");

      const outcome = await attemptAdd(repo, "occupied");
      const error = refused(outcome);

      expect(error.code).toBe("state-conflict");
      expect(errorToExitCode(error.code)).toBe(ExitCode.stateConflict);
      // Exactly this sentence, and not the one the case-collision check below
      // composes: the two differ by a trailing word, so a substring on stderr
      // matched either, and the hint is what tells them apart.
      expect(error.message).toBe("occupied already exists");
      expect(error.hint).toBe("move or delete that directory first");
      expect(outcome.log.err).toEqual([]);
      expect(await Bun.file(join(root, "occupied", "mine.txt")).text()).toBe("keep\n");
    });
  }, 60_000);

  test("a name that differs from a worktree only by case is refused, and says why", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      // A branch that is nowhere near the remote, so the fetch `add` would do
      // before giving up on finding one is a git process this fixture can skip.
      await seedWorktree(repo, "solo", { fetch: false });

      // Nothing is on disk at `SOLO`, and on Linux nothing would be: this is
      // refused because of where the directory *would* be on the machine next
      // to this one.
      const outcome = await attemptAdd(repo, "SOLO");
      const error = refused(outcome);

      expect(error.code).toBe("state-conflict");
      // "already exists here" — the other check's sentence with a word on the
      // end, which is why the hint is what a test has to read.
      expect(error.message).toBe("solo already exists here");
      expect(error.hint).toBe(
        "directories differing only by case collide on macOS and Windows; pick a name that differs by more",
      );
      expect(outcome.log.err).toEqual([]);
    });
  }, 60_000);

  test("a worktree that would nest inside another is refused", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // `feat` as a worktree makes `feat/login` a directory inside it, which
      // git allows and which leaves each reporting the other's files.
      await seedGit(repo.gitDir, ["worktree", "add", join(repo.root, "feat"), "-b", "feat-x"]);

      const outcome = await attemptAdd(repo, "feat/login");
      const error = refused(outcome);

      expect(error.code).toBe("state-conflict");
      expect(errorToExitCode(error.code)).toBe(ExitCode.stateConflict);
      expect(error.message).toBe("that would nest with the worktree at feat");
      expect(error.hint).toContain("one worktree inside another");
      expect(outcome.log.err).toEqual([]);
      expect(await pathExists(join(repo.root, "feat", "login"))).toBe(false);
    });
  }, 60_000);
});
