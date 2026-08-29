import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Reporter } from "../../report/reporter.ts";
import {
  defaultBranch,
  enableReflogs,
  localBranches,
  remoteBranchExists,
  updateRemoteHead,
} from "../branches.ts";
import { GroveError } from "../errors.ts";
import { isDirectory, isEmptyOrMissing, pathExists } from "../fs.ts";
import { gitOutput, parseGitProgress, runGit, runGitOrThrow } from "../git.ts";
import {
  GIT_FILE_CONTENTS,
  looksLikeRepoUrl,
  type RepoPaths,
  repoNameFromUrl,
  repoPaths,
  worktreeRelPath,
} from "../layout.ts";
import { pendingCommands } from "../setup.ts";
import { SETUP_FILE } from "../setup-file.ts";

/**
 * `grove clone` — turn a remote URL into a managed repository.
 *
 * The result is one directory holding `.bare`, a `.git` file pointing at it, and
 * a worktree for the first branch. Getting there is more than `git clone
 * --bare`, and the extra steps are the reason this command exists at all.
 */

export type CloneOptions = {
  readonly url: string;
  /** Directory name for the repo folder; defaults to the URL's last segment. */
  readonly dir?: string;
  /** Branch to check out first; defaults to whatever the remote calls default. */
  readonly branch?: string;
};

export type CloneResult = {
  readonly root: string;
  readonly gitDir: string;
  readonly defaultBranch: string;
  /** The branch that got the first worktree. */
  readonly branch: string;
  readonly worktree: string;
};

const REMOTE = "origin";

/**
 * The refspec `git clone --bare` declines to write.
 *
 * Without it `git fetch` exits 0 having updated nothing: a bare clone copies the
 * remote's heads straight into `refs/heads/*` and configures no mapping into
 * `refs/remotes/*`. Every later command then fails in a way that points
 * somewhere else — `add` cannot find `origin/feat-x`, `sync` has no upstream to
 * rebase onto, `--prune` prunes nothing — so it is set before the first fetch.
 */
const FETCH_REFSPEC = `+refs/heads/*:refs/remotes/${REMOTE}/*`;

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

    const trunk = await defaultBranch(paths.gitDir);
    const branch = options.branch ?? trunk;

    const worktree = join(root, worktreeRelPath(branch));
    await Bun.write(paths.gitFile, GIT_FILE_CONTENTS);
    await createFirstWorktree(paths.gitDir, branch, worktree);
    await pruneUnusedHeads(paths.gitDir, branch);

    reporter.info(`${relative(cwd, root) || root} is ready`);
    await sayWhatTheFileWants(paths, worktree, reporter);

    return { root, gitDir: paths.gitDir, defaultBranch: trunk, branch, worktree };
  } catch (error) {
    // A partial `.bare` is worse than nothing: discovery would find it, every
    // command would then fail obscurely, and re-running clone would refuse
    // because the directory is no longer empty. Removing it makes clone
    // idempotent — the second attempt behaves like the first.
    await rm(rootExisted ? paths.gitDir : root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Says what the repository's `.grove.toml` wants to run, and runs none of it.
 *
 * The first worktree is the one nothing sets up, and both halves of that are
 * deliberate. `copy` and `link` have nothing to say here — this worktree *is*
 * the one everything else is copied from. And `run` is a command that arrived
 * with a repository downloaded ten seconds ago, which is the worst moment there
 * has ever been to decide it may execute: nobody has read it yet.
 *
 * So it is said rather than done. Not saying it was the old behaviour and it
 * was wrong for a different reason than it looked: with the configuration in
 * git config, a fresh clone genuinely had none. A tracked file arrives with the
 * checkout, so from here on the file is there and staying quiet about it would
 * mean the only people who ever find out are the ones who go looking.
 */
async function sayWhatTheFileWants(
  paths: RepoPaths,
  worktree: string,
  reporter: Reporter,
): Promise<void> {
  const commands = await pendingCommands(paths, worktree);
  if (commands.length === 0) return;

  const where = relative(paths.root, join(worktree, SETUP_FILE));
  const what = commands.map((command) => JSON.stringify(command)).join(", ");

  reporter.warn(`${where} wants to run ${what} — nothing has; read it, then run it yourself`);
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
  const exists = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: bare,
  });

  if (exists.code !== 0) {
    throw new GroveError("usage", `the remote has no branch named ${JSON.stringify(branch)}`, {
      hint: "omit --branch to use the remote's default",
    });
  }

  await runGitOrThrow(["worktree", "add", path, branch], { cwd: bare });

  // `clone --bare` copies the heads without any branch.<name>.remote config, so
  // this branch would have no upstream: `git status` would not say "up to date
  // with origin/main", and a bare `git push` would have nothing to aim at.
  if (await remoteBranchExists(bare, branch)) {
    await runGitOrThrow(["branch", `--set-upstream-to=${REMOTE}/${branch}`, branch], { cwd: bare });
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
async function pruneUnusedHeads(bare: string, keep: string): Promise<void> {
  for (const branch of await localBranches(bare)) {
    if (branch === keep) continue;

    await runGitOrThrow(["update-ref", "-d", `refs/heads/${branch}`], { cwd: bare });
  }
}
