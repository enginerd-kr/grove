import { basename, dirname, join } from "node:path";
import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch, localBranchExists, remoteBranchExists } from "../branches.ts";
import { GroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { contains, worktreeRelPath } from "../layout.ts";
import {
  failureFor,
  repoSetupPlan,
  runSetup,
  type SetupPlan,
  type SetupResult,
  trustAndRun,
} from "../setup.ts";
import { listWorktrees, type WorktreeRecord, worktreeDir } from "../worktrees.ts";

/** `grove add` — give a branch a worktree, creating the branch if it does not exist. */

export type AddOptions = {
  readonly branch: string;
  /** Base for a branch that does not exist yet. Defaults to the remote's default. */
  readonly from?: string;
  readonly dir?: string;
  /** Fetch before deciding the branch is missing. On by default. */
  readonly fetch: boolean;
  readonly push: boolean;
  /**
   * Copy, link, and run whatever `.grove.toml` asks for.
   *
   * On by default, and free where there is no file. A worktree that cannot
   * build is not finished, and the alternative — remembering the `cp` every
   * time — is the bookkeeping this tool is for.
   */
  readonly setup: boolean;
  /**
   * Record the file's commands as read, and run them.
   *
   * Off by default, and it has to be: `copy` and `link` move files already on
   * your disk, while a `run` command is code that arrived with a pull. Without
   * this the commands are printed and skipped, which is the honest thing for a
   * command line to do — there is nothing to prompt on in a pipe, and a tool
   * that behaved differently under a terminal would be two tools.
   */
  readonly trust: boolean;
};

export type AddResult = {
  readonly path: string;
  readonly branch: string;
  /** How the branch was obtained, which is the part worth reporting back. */
  readonly source: "existing" | "remote" | "new";
  readonly upstream?: string;
  /** True when the worktree was already there and nothing was done. */
  readonly alreadyPresent: boolean;
  /** What `grove.copy`/`link`/`setup` did, when anything was configured. */
  readonly setup?: SetupResult;
};

const REMOTE = "origin";

export async function addWorktree(
  repo: RepoPaths,
  options: AddOptions,
  reporter: Reporter,
): Promise<AddResult> {
  const path = join(worktreeBase(repo), worktreeRelSegment(repo, options));
  const dir = worktreeDir(repo.root, path);
  const worktrees = await listWorktrees(repo.gitDir);

  const existing = await checkAlreadyThere(repo.root, options.branch, path, worktrees);
  if (existing) return existing;

  refuseNameCollision(repo.root, path, worktrees);
  refuseNesting(repo.root, path, worktrees);

  if (await pathExists(path)) {
    throw new GroveError("state-conflict", `${dir} already exists`, {
      hint: "pass --dir <path> to use a different directory",
    });
  }

  // Read here rather than after the worktree exists: a path in `.grove.toml`
  // that nobody can resolve is a mistake in the file, and finding it out
  // afterwards would mean a directory on disk that the same command refused.
  // The file is the trunk's, which is why it can be read before this branch has
  // a worktree at all.
  const plan = options.setup ? await repoSetupPlan(repo) : undefined;

  const source = await resolveSource(repo.gitDir, options, reporter);

  const step = reporter.step(`adding ${options.branch}`);
  try {
    // `git worktree add` creates intermediate directories itself, so a nested
    // path needs no mkdir of ours.
    await runGitOrThrow(argsFor(source, options, path), { cwd: repo.gitDir });
    step.succeed(`added ${dir}`);
  } catch (error) {
    step.fail(`could not add ${options.branch}`);
    throw error;
  }

  if (options.push) await pushBranch(path, options.branch, reporter);

  const setup = plan
    ? await setUpWorktree(repo, path, options.branch, options.trust ? undefined : plan, reporter)
    : undefined;

  return {
    path,
    branch: options.branch,
    source: source.kind,
    upstream: source.kind === "new" && !options.push ? undefined : `${REMOTE}/${options.branch}`,
    alreadyPresent: false,
    setup,
  };
}

/**
 * Where new worktrees go: inside the root for a managed repository, beside it
 * for a plain one.
 *
 * A plain repository's root is itself the main checkout, so there is no
 * spare folder to nest a worktree inside — `git worktree add ../thing` is the
 * convention its users already have, and this follows it.
 */
function worktreeBase(repo: RepoPaths): string {
  return repo.kind === "plain" ? dirname(repo.root) : repo.root;
}

/**
 * The new worktree's path, relative to `worktreeBase`.
 *
 * `--dir` is honoured exactly as it is for a managed repository — a path
 * checked rather than rewritten, now resolved against the parent instead of
 * the root. Without one, a plain repository gets a name prefixed with the
 * repository's own — `myapp-feat-login` beside `myapp` — so a shared parent
 * directory does not fill with bare branch names that collide with whatever
 * else lives there.
 */
function worktreeRelSegment(repo: RepoPaths, options: AddOptions): string {
  if (repo.kind === "plain" && options.dir === undefined) {
    return `${basename(repo.root)}-${worktreeRelPath(options.branch).replaceAll("/", "-")}`;
  }

  return worktreeRelPath(options.branch, options.dir);
}

/**
 * Fills the new worktree in, and warns rather than fails when that goes wrong.
 *
 * The line this draws: `add` was asked for a worktree and there is one, so a
 * `bun install` that failed on a train does not get to report that the worktree
 * is missing — a script reading the exit code would then do the wrong thing
 * with a directory that is sitting right there. It is said out loud instead,
 * along with the command that repeats it once the network is back.
 */
async function setUpWorktree(
  repo: RepoPaths,
  path: string,
  branch: string,
  /** Absent when `--trust` was passed: the plan is re-read after it is recorded. */
  plan: SetupPlan | undefined,
  reporter: Reporter,
): Promise<SetupResult> {
  const target = { path, branch };
  const result =
    plan === undefined
      ? await trustAndRun(repo, target, reporter)
      : await runSetup(repo, target, { plan }, reporter);
  const failure = failureFor(result);

  if (failure) reporter.warn(`${failure.message}; the worktree is there — ${failure.hint}`);

  return result;
}

/**
 * Asking for a worktree that is already there is not an error.
 *
 * Someone re-running `grove add feat/login` wants to end up with that worktree, and
 * they have. Reporting success keeps the command idempotent, which is what makes
 * it safe to put in a script.
 */
async function checkAlreadyThere(
  root: string,
  branch: string,
  path: string,
  worktrees: readonly WorktreeRecord[],
): Promise<AddResult | undefined> {
  const holder = worktrees.find((record) => record.branch === branch);
  if (!holder) return undefined;

  if (holder.path === path) {
    return { path, branch, source: "existing", alreadyPresent: true };
  }

  // Same branch, different directory. git would refuse this anyway, but its
  // message does not say which of your directories is the one holding it.
  throw new GroveError(
    "state-conflict",
    `${JSON.stringify(branch)} is already checked out at ${holder.path}`,
    { hint: `use that worktree, or remove it first: grove rm ${worktreeDir(root, holder.path)}` },
  );
}

/**
 * Refuses a directory that differs from an existing one only by case.
 *
 * macOS and Windows filesystems fold case, so `Feat/Login` and `feat/login`
 * would be the same directory there and a different one on Linux. Refusing is
 * better than a repository that only works on the machine it was made on.
 */
function refuseNameCollision(
  root: string,
  path: string,
  worktrees: readonly WorktreeRecord[],
): void {
  const wanted = worktreeDir(root, path).toLowerCase();
  const clash = worktrees.find(
    (record) => record.path !== path && worktreeDir(root, record.path).toLowerCase() === wanted,
  );

  if (clash) {
    throw new GroveError("state-conflict", `${worktreeDir(root, clash.path)} already exists here`, {
      hint: "directories differing only by case collide on macOS and Windows; pass --dir",
    });
  }
}

/**
 * Refuses a worktree that would sit inside another, or swallow one.
 *
 * Newly possible now that directories nest: `feat/test` lives under `feat/`, so
 * a `--dir feat` would put one worktree inside the other. git allows it, and the
 * result is quietly broken — the outer worktree reports the inner one's files as
 * untracked, and `git clean` there deletes someone's work.
 *
 * Branches alone cannot reach this (git forbids `feat` and `feat/test` as a ref
 * D/F conflict); `--dir` can.
 */
function refuseNesting(root: string, path: string, worktrees: readonly WorktreeRecord[]): void {
  const clash = worktrees.find(
    (record) =>
      record.path !== path && (contains(record.path, path) || contains(path, record.path)),
  );

  if (clash) {
    throw new GroveError(
      "state-conflict",
      `that would nest with the worktree at ${worktreeDir(root, clash.path)}`,
      { hint: "one worktree inside another makes each report the other's files; pass --dir" },
    );
  }
}

type Source =
  | { readonly kind: "existing" }
  | { readonly kind: "remote" }
  | { readonly kind: "new"; readonly base: string };

/**
 * Decides where the branch comes from: already local, on the remote, or new.
 *
 * The fetch sits between "not on the remote yet" and "not on the remote as far
 * as we last looked", which are very different answers — the second creates a
 * branch that then collides on push.
 */
async function resolveSource(
  bare: string,
  options: AddOptions,
  reporter: Reporter,
): Promise<Source> {
  if (await localBranchExists(bare, options.branch)) return { kind: "existing" };
  if (await remoteBranchExists(bare, options.branch)) return { kind: "remote" };

  if (options.fetch) {
    const step = reporter.step("fetching");
    await runGitOrThrow(["fetch", REMOTE, "--prune"], { cwd: bare });
    step.succeed("fetched");

    if (await remoteBranchExists(bare, options.branch)) return { kind: "remote" };
  }

  const base = options.from ?? `${REMOTE}/${await defaultBranch(bare)}`;
  const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
    cwd: bare,
  });

  if (resolved.code !== 0) {
    throw new GroveError("usage", `cannot start a branch from ${JSON.stringify(base)}`, {
      hint: options.from ? "--from takes a branch, tag, or commit that exists" : undefined,
    });
  }

  return { kind: "new", base };
}

function argsFor(source: Source, options: AddOptions, path: string): readonly string[] {
  switch (source.kind) {
    case "existing":
      return ["worktree", "add", path, options.branch];
    // `--track -b` in one step is reachable only when no local ref exists for
    // this branch — the check above proved that — so there is nothing to collide
    // with and the upstream is set correctly from the start.
    case "remote":
      return [
        "worktree",
        "add",
        "--track",
        "-b",
        options.branch,
        path,
        `${REMOTE}/${options.branch}`,
      ];
    // `--no-track` is load-bearing. The default base is `origin/<default>`, and
    // git's `branch.autoSetupMerge` — on unless someone turned it off — sets a
    // branch cut from a remote-tracking ref to track that ref. So a brand new
    // `feat/x` would quietly come out tracking `origin/main`: the remote column
    // would report its drift from *main* under the heading of its own remote,
    // `push` would refuse it for having an upstream by another name, and the
    // unpushed-commit warning on `remove` would count against the wrong branch.
    // A branch nobody has pushed has no remote to be measured against, and
    // saying so is the honest answer.
    case "new":
      return ["worktree", "add", "--no-track", "-b", options.branch, path, source.base];
  }
}

async function pushBranch(path: string, branch: string, reporter: Reporter): Promise<void> {
  const step = reporter.step(`pushing ${branch}`);
  try {
    await runGitOrThrow(["push", "-u", REMOTE, "HEAD"], { cwd: path });
    step.succeed(`pushed ${branch}`);
  } catch (error) {
    // The worktree exists and is usable; only the push failed. Say so rather
    // than letting the error imply nothing happened.
    step.fail(`created the worktree, but pushing ${branch} failed`);
    throw error;
  }
}
