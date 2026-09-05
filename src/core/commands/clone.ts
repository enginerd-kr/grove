import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  HOOKS_FILE,
  pendingCommands,
  runSetup,
  type SetupResult,
  trustAndRun,
} from "../../hooks/index.ts";
import { recordSetupState } from "../../hooks/state.ts";
import type { Reporter } from "../../report/reporter.ts";
import {
  defaultBranch,
  enableReflogs,
  FETCH_REFSPEC,
  localBranchExists,
  localBranches,
  REMOTE,
  remoteBranchExists,
  remoteRef,
  updateRemoteHead,
} from "../branches.ts";
import { GroveError, isGroveError } from "../errors.ts";
import { isDirectory, isEmptyOrMissing, pathExists } from "../fs.ts";
import { gitOutput, parseGitProgress, runGitOrThrow } from "../git.ts";
import {
  GIT_FILE_CONTENTS,
  looksLikeRepoUrl,
  type RepoPaths,
  repoNameFromUrl,
  repoPaths,
  worktreeRelPath,
} from "../layout.ts";
import { followUpstream, type UpstreamResult } from "./upstream.ts";

/**
 * `grove clone` — turn a remote URL into a managed repository.
 *
 * The result is one directory holding `.bare`, a `.git` file pointing at it, and
 * a worktree for the first branch. Getting there is more than `git clone
 * --bare`, and the extra steps are the reason this command exists at all.
 */

export type CloneOptions = {
  readonly setup?: boolean;
  readonly trust?: boolean;
  readonly url: string;
  /** Directory name for the repo folder; defaults to the URL's last segment. */
  readonly dir?: string;
  /** Branch to check out first; defaults to whatever the remote calls default. */
  readonly branch?: string;
  /**
   * The repository this one was forked from — `grove upstream <url>`, run
   * on the clone the moment it exists. See `upstream.ts` for what it sets.
   */
  readonly upstream?: string;
};

export type CloneResult = {
  readonly setup?: readonly SetupResult[];
  readonly root: string;
  readonly gitDir: string;
  readonly defaultBranch: string;
  /** The requested checkout; the trunk is always created first. */
  readonly branch: string;
  readonly worktree: string;
  /** What `--upstream` set, when it was given. */
  readonly upstream?: UpstreamResult;
};

export async function cloneRepo(
  cwd: string,
  options: CloneOptions,
  reporter: Reporter,
): Promise<CloneResult> {
  if (!looksLikeRepoUrl(options.url)) {
    throw new GroveError(
      "usage",
      `${JSON.stringify(options.url)} does not look like a repository URL`,
    );
  }

  const root = resolve(cwd, options.dir ?? repoNameFromUrl(options.url));
  const paths = repoPaths(root);

  if (!(await isEmptyOrMissing(root))) {
    // Two different things are in the way here and they read nothing alike:
    // a directory with files in it is a place you might have meant, a file is
    // not a place at all.
    const obstacle = (await isDirectory(root)) ? "is not empty" : "is not a directory";

    throw new GroveError("state-conflict", `${root} already exists and ${obstacle}`, {
      hint: "pass a different directory: grove clone <url> <dir>",
    });
  }

  // Remember whether we are the ones creating it, so a failure cleans up after
  // itself without deleting a directory the user had already made.
  const rootExisted = await pathExists(root);
  const createdPaths: string[] = [];
  let wroteGitFile = false;
  let trunk = "";
  let branch = "";

  try {
    await mkdir(root, { recursive: true });

    // Deliberately not the URL: a long one wraps across several terminal lines
    // and shoves the progress bar around while it draws. The user just typed it.
    const step = reporter.step("cloning");
    try {
      await runGitOrThrow(["clone", "--bare", "--progress", options.url, paths.gitDir], {
        cwd,
        onStderrLine: (line) => {
          const percent = parseGitProgress(line);
          if (percent !== undefined) step.progress(percent);
        },
      });
      step.succeed("cloned");
    } catch (error) {
      step.fail("clone failed");
      throw error;
    }

    // Before the first fetch, so the refs it writes are recorded: a bare clone
    // keeps no reflogs, and grove's worktrees need them — see `enableReflogs`.
    await enableReflogs(paths.gitDir);
    await configureRemote(paths.gitDir, reporter);

    trunk = await defaultBranch(paths.gitDir);
    branch = options.branch ?? trunk;

    const worktree = join(root, worktreeRelPath(branch));
    wroteGitFile = true;
    await Bun.write(paths.gitFile, GIT_FILE_CONTENTS);
    createdPaths.push(join(root, worktreeRelPath(trunk)));
    await createFirstWorktree(paths.gitDir, trunk, join(root, worktreeRelPath(trunk)));
    if (branch !== trunk) {
      createdPaths.push(worktree);
      await createFirstWorktree(paths.gitDir, branch, worktree);
    }
    await pruneUnusedHeads(paths.gitDir, new Set([trunk, branch]));

    reporter.info(`${relative(cwd, root) || root} created`);
  } catch (error) {
    // A partial `.bare` is worse than nothing: discovery would find it, every
    // command would then fail obscurely, and re-running clone would refuse
    // because the directory is no longer empty. Removing it makes clone
    // idempotent — the second attempt behaves like the first.
    if (rootExisted) {
      for (const path of createdPaths.toReversed()) {
        await rm(path, { recursive: true, force: true });
        for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
          try {
            await rmdir(parent);
          } catch {
            break;
          }
        }
      }
      if (wroteGitFile) await rm(paths.gitFile, { force: true });
      await rm(paths.gitDir, { recursive: true, force: true });
    } else await rm(root, { recursive: true, force: true });
    throw error;
  }

  const worktree = join(root, worktreeRelPath(branch));
  const result = { root, gitDir: paths.gitDir, defaultBranch: trunk, branch, worktree };
  const bootstrap = async (completed: CloneResult): Promise<CloneResult> => {
    if (options.setup === false) return completed;
    const setup: SetupResult[] = [];
    for (const name of new Set([trunk, branch])) {
      const target = { path: join(root, worktreeRelPath(name)), branch: name };
      setup.push(
        options.trust
          ? await trustAndRun(paths, target, reporter, { opens: false })
          : await runSetup(paths, target, { opens: false }, reporter),
      );
    }
    if (setup[0]?.untrusted)
      await sayWhatTheFileWants(paths, join(root, worktreeRelPath(trunk)), reporter);
    return setup.some((item) => item.planned > 0) ? { ...completed, setup } : completed;
  };
  if (options.upstream === undefined) return bootstrap(result);

  // Outside the cleanup above on purpose: the clone is done and correct, and
  // a mistyped `--upstream` is not a reason to delete it. The failure carries
  // the command that finishes the job once the URL is right.
  try {
    const upstream = await followUpstream(paths, { url: options.upstream, force: false }, reporter);

    return bootstrap({ ...result, upstream });
  } catch (error) {
    if (isGroveError(error)) {
      throw new GroveError(error.code, error.message, {
        ...(error.details === undefined ? {} : { details: error.details }),
        hint: `the clone is ready without it; grove upstream <url> from inside it finishes this`,
        cause: error,
      });
    }
    throw error;
  }
}

/** Show the unapproved bootstrap recipe after the checkout has been preserved. */
async function sayWhatTheFileWants(
  paths: RepoPaths,
  worktree: string,
  reporter: Reporter,
): Promise<void> {
  const commands = await pendingCommands(paths, worktree);
  if (commands.length === 0) return;

  const where = relative(paths.root, join(worktree, HOOKS_FILE));
  const what = commands.map((command) => JSON.stringify(command)).join(", ");

  reporter.warn(`${where} wants to run ${what} — review it; grove setup applies it after approval`);
}

async function configureRemote(bare: string, reporter: Reporter): Promise<void> {
  const step = reporter.step("fetching refs");

  await runGitOrThrow(["config", `remote.${REMOTE}.fetch`, FETCH_REFSPEC], { cwd: bare });
  await runGitOrThrow(["fetch", REMOTE, "--prune", "--tags"], { cwd: bare });

  if (!(await updateRemoteHead(bare))) {
    // A remote that advertises no HEAD is unusual but survivable: the branch the
    // clone checked out is the same one git would have picked.
    const head = await gitOutput(["symbolic-ref", "--short", "HEAD"], { cwd: bare });
    await runGitOrThrow(
      ["symbolic-ref", `refs/remotes/${REMOTE}/HEAD`, `refs/remotes/${REMOTE}/${head}`],
      { cwd: bare },
    );
  }

  step.succeed("fetched refs");
}

async function createFirstWorktree(bare: string, branch: string, path: string): Promise<void> {
  if (!(await localBranchExists(bare, branch))) {
    throw new GroveError("usage", `the remote has no branch named ${JSON.stringify(branch)}`, {
      hint: "omit --branch to use the remote's default",
    });
  }

  await runGitOrThrow(["worktree", "add", path, branch], { cwd: bare });
  await recordSetupState(bare, branch, "pending");

  // `clone --bare` copies the heads without any branch.<name>.remote config, so
  // this branch would have no upstream: `git status` would not say "up to date
  // with origin/main", and a bare `git push` would have nothing to aim at.
  if (await remoteBranchExists(bare, branch)) {
    await runGitOrThrow(["branch", `--set-upstream-to=${remoteRef(branch)}`, branch], {
      cwd: bare,
    });
  }

  // HEAD follows the branch that has a worktree, not the remote's default. It
  // has to point at a ref that survives the pruning below, and this is the one
  // that does.
  await runGitOrThrow(["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: bare });
}

/**
 * Deletes the local branches `clone --bare` copied in but nothing checked out.
 *
 * A bare clone imports every remote branch as a local one, which is a set nobody
 * asked for: fifty branches on the remote means fifty local refs with no
 * worktrees, no upstreams, and no way to tell which you actually work on.
 * Pruning starts the repository at "local branches are the ones you checked
 * out", so `add` can create-and-track in one step and every local branch has a
 * correct upstream. The remote-tracking refs configured above still remember the
 * rest.
 *
 * `remove` may leave a branch behind deliberately — that is where unpushed
 * commits live — so this is the starting state, not a permanent invariant.
 */
async function pruneUnusedHeads(bare: string, keep: ReadonlySet<string>): Promise<void> {
  for (const branch of await localBranches(bare)) {
    if (keep.has(branch)) continue;

    await runGitOrThrow(["update-ref", "-d", `refs/heads/${branch}`], { cwd: bare });
  }
}
