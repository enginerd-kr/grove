import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch } from "../branches.ts";
import { GroveError, stderrDetails } from "../errors.ts";
import { gitOutput, runGit, runGitOrThrow, runTool } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { listWorktrees, resolveTarget, type WorktreeRecord, worktreeDir } from "../worktrees.ts";

/**
 * Opening a pull request for a worktree's branch, from the screen.
 *
 * The work is three things this tool already knows how to reason about — is
 * there anything to propose, is the branch published, what should the PR say —
 * and one it does not: talking to the forge. That last part is `gh`'s job, and
 * `gh` is the only tool beyond git that grove ever runs. Missing, it fails
 * with the one-line answer rather than a stack trace, and nothing else in the
 * tool cares.
 *
 * No `grove pr` on the command line, deliberately: `gh pr create` already
 * exists there, with a real editor behind it. The key exists because from the
 * app the alternative was leaving.
 */

const REMOTE = "origin";

export type PrPreview = {
  readonly path: string;
  readonly dir: string;
  readonly branch: string;
  /** What the PR would merge into — whatever the remote calls its trunk. */
  readonly base: string;
  /** The subjects being proposed, oldest first — the popup's context block. */
  readonly subjects: readonly string[];
  /** What `gh` will be handed as the body; the title is typed, never guessed. */
  readonly body: string;
  readonly commits: number;
};

export type PrResult = {
  readonly path: string;
  readonly dir: string;
  readonly branch: string;
  readonly url: string;
  /** True when the branch had to be published first. */
  readonly published: boolean;
};

async function resolveProposable(
  repo: RepoPaths,
  cwd: string,
  target: string,
  base: string,
): Promise<WorktreeRecord & { readonly branch: string }> {
  const worktrees = await listWorktrees(repo.gitDir);
  const record = resolveTarget(target, worktrees, { root: repo.root, cwd });
  const dir = worktreeDir(repo.root, record.path);

  if (record.detached || record.branch === undefined) {
    throw new GroveError(
      "refused",
      `${dir} is on a detached HEAD, so there is no branch to propose`,
    );
  }

  if (record.branch === base) {
    throw new GroveError("refused", `${base} is what pull requests merge into`, {
      hint: "start a branch first: `a` in the app, or `grove add <branch>`",
    });
  }

  if (record.rebasing === true) {
    throw new GroveError("refused", `${dir} is in the middle of a rebase`);
  }

  return record as WorktreeRecord & { branch: string };
}

/**
 * What the PR would carry, before anybody has typed anything.
 *
 * The body is guessed the way `gh --fill` guesses it — one commit is described
 * by its own body, several by the list of subjects, oldest first, which is the
 * order the review reads them in. The title is not guessed at all: it is the
 * one thing the popup exists to ask for, and a prefilled answer to a question
 * is how questions stop being read.
 */
export async function prPreview(repo: RepoPaths, cwd: string, target: string): Promise<PrPreview> {
  const base = await defaultBranch(repo.gitDir);
  const record = await resolveProposable(repo, cwd, target, base);
  const dir = worktreeDir(repo.root, record.path);

  const subjects = (
    await gitOutput(["log", "--reverse", "--format=%s", `${REMOTE}/${base}..HEAD`], {
      cwd: record.path,
    })
  )
    .split("\n")
    .filter((line) => line.length > 0);

  if (subjects.length === 0) {
    throw new GroveError("refused", `${dir} has nothing ${base} does not`, {
      hint: "commit something there first",
    });
  }

  const body =
    subjects.length === 1
      ? (await gitOutput(["log", "-1", "--format=%b"], { cwd: record.path })).trim()
      : subjects.map((subject) => `- ${subject}`).join("\n");

  return {
    path: record.path,
    dir,
    branch: record.branch,
    base,
    subjects,
    body,
    commits: subjects.length,
  };
}

export type PrOptions = {
  readonly target: string;
  readonly title: string;
  readonly body: string;
};

export async function createPr(
  repo: RepoPaths,
  cwd: string,
  options: PrOptions,
  reporter: Reporter,
): Promise<PrResult> {
  const title = options.title.trim();
  if (title.length === 0) {
    throw new GroveError("usage", "a pull request needs a title");
  }

  const base = await defaultBranch(repo.gitDir);
  const record = await resolveProposable(repo, cwd, options.target, base);
  const dir = worktreeDir(repo.root, record.path);

  // Published first, because `gh` requires it and cannot ask us anything. A
  // branch that never met the remote gets `-u`, the same spelling `add --push`
  // uses; one that has diverged fails here with git's own reason, which is
  // better than `gh`'s.
  const upstream = await runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], {
    cwd: record.path,
  });
  const published = upstream.code !== 0;

  const step = reporter.step(
    published ? `publishing ${record.branch}` : `pushing ${record.branch}`,
  );
  try {
    await runGitOrThrow(published ? ["push", "-u", REMOTE, "HEAD"] : ["push"], {
      cwd: record.path,
    });
    step.succeed(published ? `published ${record.branch}` : `pushed ${record.branch}`);
  } catch (error) {
    step.fail(`could not push ${record.branch}`);
    throw error;
  }

  const asking = reporter.step("asking the forge");
  const result = await runTool(["gh", "pr", "create", "--title", title, "--body", options.body], {
    cwd: record.path,
  });

  if (result === null) {
    asking.fail("gh is not installed");
    throw new GroveError("gh", "opening a pull request needs `gh`, which is not installed", {
      hint: "https://cli.github.com — nothing else in grove uses it",
    });
  }

  if (result.code !== 0) {
    asking.fail("gh refused");
    // gh's stderr is the useful half — "already exists", "no default remote" —
    // and when a PR already exists it names the URL, which is the answer.
    throw new GroveError("gh", `gh pr create failed (exit ${result.code})`, {
      details: stderrDetails(result.stderr),
    });
  }

  // gh prints the new PR's URL on stdout, alone.
  const url = result.stdout.trim().split("\n").at(-1) ?? "";
  asking.succeed(`opened ${url}`);

  return { path: record.path, dir, branch: record.branch, url, published };
}
