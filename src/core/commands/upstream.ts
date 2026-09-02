import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch, REMOTE } from "../branches.ts";
import { GroveError, stderrDetails } from "../errors.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import { looksLikeRepoUrl, type RepoPaths } from "../layout.ts";

/**
 * `grove upstream` — make this repository a fork of that one, in git's terms.
 *
 * The three git lines a fork needs, as one command. Each of them is a thing
 * git already understands, which is what keeps this from being a grove
 * setting: a remote called `upstream` pointing at the repository this was
 * forked from, the trunk told to follow that remote's copy — `git branch -u`,
 * which is what `trunkOf` reads — and `remote.pushDefault` set to `origin`,
 * so a branch cut from the trunk it now follows still goes to the fork when it
 * is pushed. `git pull` and `git push` from the trunk worktree do the same
 * thing afterwards that grove does, because they read the same three lines.
 *
 * Nothing here detects anything. Which repository a fork came from is a fact
 * only the forge holds, and asking it would make the first command anybody
 * runs depend on `gh`; the URL is typed instead, once, by somebody who knows
 * it. The name `upstream` is not chosen here either — it is the name every
 * forking guide has used for fifteen years, so it is the one `git remote -v`
 * will make sense of next year.
 *
 * Idempotent when the URL is the same, so `doctor`'s advice can be pasted
 * over a remote that is already there. A different URL is a replacement, and
 * a replacement is refused without `--force`: the remote somebody added by
 * hand last month is a decision, and overwriting it because a URL was
 * mistyped today is not.
 */

/** The remote's name, which every forking guide agrees on. */
export const UPSTREAM = "upstream";

export type UpstreamOptions = {
  readonly url: string;
  /** Replace an `upstream` remote that already points somewhere else. */
  readonly force: boolean;
};

export type UpstreamResult = {
  readonly remote: string;
  readonly url: string;
  /** The trunk's local name, which now follows the remote's copy. */
  readonly trunk: string;
  /** What it follows: `upstream/main`, or whatever the remote calls its default. */
  readonly ref: string;
  /** The URL the remote pointed at before, when `--force` replaced one. */
  readonly replaced?: string;
};

/** Where `upstream` points now, or nothing when there is no such remote. */
export async function existingUpstream(bare: string): Promise<string | undefined> {
  const result = await runGit(["remote", "get-url", UPSTREAM], { cwd: bare });

  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * The remote's copy of the trunk: by the trunk's own name where the remote
 * has one, else whatever the remote advertises as its default.
 *
 * The second case is a fork whose owner renamed the trunk — `master` here,
 * `main` there — and `trunkOf` keeps the two names apart for exactly this.
 * A remote with neither is not one this can follow, and says so.
 */
async function trunkOn(bare: string, trunk: string): Promise<string> {
  const named = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${UPSTREAM}/${trunk}`],
    { cwd: bare },
  );
  if (named.code === 0) return `${UPSTREAM}/${trunk}`;

  await runGit(["remote", "set-head", UPSTREAM, "--auto"], { cwd: bare });
  const head = await runGit(["symbolic-ref", "--short", `refs/remotes/${UPSTREAM}/HEAD`], {
    cwd: bare,
  });
  const advertised = head.stdout.trim();
  if (head.code === 0 && advertised.length > 0) return advertised;

  throw new GroveError(
    "refused",
    `${UPSTREAM} has no branch named ${trunk}, and advertises no default branch to follow instead`,
    {
      hint: `check the URL, or that the repository has a branch to follow: git ls-remote ${UPSTREAM}`,
    },
  );
}

export async function followUpstream(
  repo: RepoPaths,
  options: UpstreamOptions,
  reporter: Reporter,
): Promise<UpstreamResult> {
  if (!looksLikeRepoUrl(options.url)) {
    throw new GroveError(
      "usage",
      `${JSON.stringify(options.url)} does not look like a repository URL`,
    );
  }

  const bare = repo.gitDir;
  const existing = await existingUpstream(bare);
  const replacing = existing !== undefined && existing !== options.url;

  if (replacing && !options.force) {
    throw new GroveError("refused", `${UPSTREAM} already points at ${existing}`, {
      hint: `--force replaces it with ${options.url}`,
    });
  }

  if (existing === undefined) {
    await runGitOrThrow(["remote", "add", UPSTREAM, options.url], { cwd: bare });
  } else if (replacing) {
    await runGitOrThrow(["remote", "set-url", UPSTREAM, options.url], { cwd: bare });
  }

  const step = reporter.step(`fetching ${UPSTREAM}`);
  const fetched = await runGit(["fetch", UPSTREAM, "--prune", "--tags"], { cwd: bare });
  if (fetched.code !== 0) {
    step.fail(`could not fetch ${UPSTREAM}`);
    // A remote this just added, and that cannot be reached, is a typo and not
    // a state to leave behind: `git remote -v` a week later would show an
    // `upstream` nobody can explain. One somebody else added is theirs, and
    // stays as it was — including the URL this was about to replace.
    if (existing === undefined) {
      await runGit(["remote", "remove", UPSTREAM], { cwd: bare });
    } else if (replacing) {
      await runGit(["remote", "set-url", UPSTREAM, existing], { cwd: bare });
    }
    throw new GroveError("remote", `git fetch ${UPSTREAM} failed (exit ${fetched.code})`, {
      details: stderrDetails(fetched.stderr),
      hint: "nothing was changed; check the URL and try again",
    });
  }
  step.succeed(`fetched ${UPSTREAM}`);

  const trunk = await defaultBranch(bare);
  const ref = await trunkOn(bare, trunk);

  await runGitOrThrow(["branch", `--set-upstream-to=${ref}`, trunk], { cwd: bare });
  await runGitOrThrow(["config", "remote.pushDefault", REMOTE], { cwd: bare });

  reporter.info(`${trunk} now follows ${ref}; branches are pushed to ${REMOTE}`);

  return {
    remote: UPSTREAM,
    url: options.url,
    trunk,
    ref,
    ...(replacing && existing !== undefined ? { replaced: existing } : {}),
  };
}
