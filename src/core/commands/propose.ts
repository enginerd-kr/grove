import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch, localBranchExists, publishRemote } from "../branches.ts";
import { GroveError, stderrDetails } from "../errors.ts";
import { ghJson, record, runGh, text } from "../forge.ts";
import { runGit } from "../git.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { ancestry, readStack } from "../stack.ts";
import { plural } from "../text.ts";
import {
  listWorktrees,
  refuseMidRebase,
  resolveTarget,
  statusOf,
  type WorktreeRecord,
  type WorktreeStatus,
  worktreeDir,
} from "../worktrees.ts";
import { pushTarget } from "./sync.ts";

/**
 * `grove propose` — open a pull request for a worktree's branch, onto the
 * branch it sits on.
 *
 * `gh pr create` already opens pull requests, and for a branch cut from the
 * trunk it needs no help. The case this exists for is the stack. `grove add
 * --on feat/login` wrote down that `feat/login-api` sits on `feat/login`, and
 * the one moment that record is worth the most is the moment a pull request is
 * opened: onto the trunk, the second pull request shows the first one's diff
 * all over again, and every reviewer reads both twice. The base has to be the
 * parent, and the parent is a fact only grove has — git forgot it the moment
 * the branch was cut, and the forge never knew it.
 *
 * So the base is read off the stack, `--base` says otherwise, and the trunk is
 * what an unstacked branch gets. Everything else is what `gh` would have done
 * asked by hand, in the order a person would do it: the branch is pushed where
 * `git push` sends it — a first push with `-u`, the same one `sync --publish`
 * makes — and then the forge is asked. A branch that already has an open pull
 * request is reported rather than proposed twice, and if that pull request's
 * base is not the one the stack says, that is said too, with the `gh pr edit`
 * that moves it. GitHub's own button for this is "Propose changes", which is
 * where the name comes from.
 *
 * `gh` is run in the worktree with no `--head`: the branch checked out there
 * is the branch, and `gh` reads where it is pushed from git's own config —
 * `pushRemote`, `pushDefault`, the remote it tracks — which is the same rule
 * `publishRemote` reads, so a fork proposes from the fork without being told.
 */

export type ProposeOptions = {
  /** Which worktree. Omitted means the one you are standing in. */
  readonly target?: string;
  /** `--base`: the branch the pull request goes onto, over the recorded parent. */
  readonly base?: string;
  readonly draft: boolean;
  /** `--title`; without it the title and body are filled in from the commits. */
  readonly title?: string;
  /** `--body`, beside `--title`. Empty when only the title was given. */
  readonly body?: string;
  /** `--web`: push, then open the browser to write it there instead. */
  readonly web: boolean;
};

/** An open pull request the forge already has for the branch. */
export type ExistingPullRequest = {
  readonly number: number;
  readonly url: string;
  /** The branch it goes onto, as the forge has it. */
  readonly base: string;
};

/**
 * Everything decided before anything is pushed or asked for.
 *
 * Read on its own by the screen, which asks before it acts: the base is the
 * one thing worth reading on the prompt, and a pull request that already exists
 * is not a question at all.
 */
export type Proposal = {
  readonly record: WorktreeRecord;
  readonly dir: string;
  readonly branch: string;
  /** Where the pull request goes: `--base`, else the recorded parent, else the trunk. */
  readonly base: string;
  /** The parent the stack recorded, when there is one — what `base` came from without `--base`. */
  readonly parent?: string;
  readonly status: WorktreeStatus;
  /** Where the branch is pushed, for the prompt that says so. */
  readonly remote: string;
  readonly existing?: ExistingPullRequest;
};

export type ProposeResult = {
  readonly path: string;
  readonly dir: string;
  readonly branch: string;
  /** The base the pull request has — the one just opened, or the one already there. */
  readonly base: string;
  readonly parent?: string;
  /**
   * How the branch reached the remote first: a first push that set the
   * upstream, a push of the commits it was ahead by, or nothing to send.
   */
  readonly pushed: "published" | "pushed" | "up-to-date";
  /** Absent with `--web`, where the browser has the form and no number exists yet. */
  readonly number?: number;
  readonly url?: string;
  /** False when a pull request already proposed the branch, and with `--web`. */
  readonly created: boolean;
  readonly web: boolean;
};

/**
 * The worktree named, or the one being stood in — `rebase`'s rule, and its
 * refusal for the empty case.
 */
function chooseTarget(
  worktrees: readonly WorktreeRecord[],
  root: string,
  cwd: string,
  target: string | undefined,
): WorktreeRecord {
  const chosen =
    target === undefined
      ? worktrees.find((record) => contains(record.path, cwd))
      : resolveTarget(target, worktrees, { root, cwd });

  if (!chosen) {
    throw new GroveError("usage", "not inside a worktree, so there is nothing to propose", {
      hint: "name one: grove propose <branch>",
    });
  }

  return chosen;
}

/** The fields the existence question needs, and nothing a picker would pay for. */
const EXISTING_FIELDS = ["number", "url", "baseRefName"].join(",");

/**
 * The open pull request for this branch, if the forge has one.
 *
 * Asked by branch name, which is what the forge indexes on; a `pr/<n>`
 * worktree is somebody else's proposal and is refused before this is reached.
 * An empty list is the ordinary answer and not an error.
 */
async function openPullRequestFor(
  path: string,
  branch: string,
): Promise<ExistingPullRequest | undefined> {
  const parsed: unknown = await ghJson(
    ["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", EXISTING_FIELDS],
    path,
  );
  const [first] = Array.isArray(parsed) ? parsed : [];
  if (first === undefined) return undefined;

  const row = record(first);
  if (typeof row.number !== "number") return undefined;

  return { number: row.number, url: text(row.url), base: text(row.baseRefName) };
}

export async function proposalFor(
  repo: RepoPaths,
  cwd: string,
  options: Pick<ProposeOptions, "target" | "base">,
): Promise<Proposal> {
  const worktrees = await listWorktrees(repo.gitDir);
  const record = chooseTarget(worktrees, repo.root, cwd, options.target);
  const dir = worktreeDir(repo.root, record.path);

  refuseMidRebase(record, dir);
  if (record.detached || record.branch === undefined) {
    throw new GroveError(
      "refused",
      `${dir} is on a detached HEAD, so there is no branch to propose`,
      {
        hint: "check a branch out there first",
      },
    );
  }
  const branch = record.branch;

  const trunk = await defaultBranch(repo.gitDir);
  if (branch === trunk) {
    throw new GroveError("refused", `${trunk} is the branch pull requests go onto`, {
      hint: "propose a branch: grove propose <branch>",
    });
  }

  // A review worktree is somebody else's proposal, already open. Pushing
  // there updates it; opening a second one under `pr/42` would be a pull
  // request for a pull request.
  if (/^pr\/\d+$/.test(branch)) {
    throw new GroveError("refused", `${branch} is a pull request already`, {
      hint: "push there to update it, or `grove sync` it",
    });
  }

  // The nearest parent, and only while it is still a branch here: a stack
  // whose bottom was deleted has had its children handed up already, and a
  // record pointing at nothing is not a base to offer the forge.
  const [nearest] = ancestry(await readStack(repo.gitDir), branch);
  const parent =
    nearest !== undefined && nearest !== trunk && (await localBranchExists(repo.gitDir, nearest))
      ? nearest
      : undefined;

  const [status, remote, existing] = await Promise.all([
    statusOf(record.path),
    publishRemote(record.path, branch),
    openPullRequestFor(record.path, branch),
  ]);

  return {
    record,
    dir,
    branch,
    base: options.base ?? parent ?? trunk,
    parent,
    status,
    remote,
    existing,
  };
}

/**
 * Puts the branch on the remote the way `git push` would, before the forge is
 * asked about it.
 *
 * A branch on no remote is pushed with `-u` — `sync --publish`'s first push,
 * because a pull request is the first thing anybody publishes a branch for.
 * One that is ahead is pushed plainly, to the same target `sync` pushes to.
 * One that is behind is refused: the pull request would propose commits the
 * branch here has not got, and `sync` is the command that sorts that out.
 */
async function bringToRemote(
  proposal: Proposal,
  reporter: Reporter,
): Promise<ProposeResult["pushed"]> {
  const { record, dir, branch, status, remote } = proposal;

  if (status.upstream === undefined) {
    const step = reporter.step(`publishing ${branch}`);
    const result = await runGit(["push", "-u", remote, branch], { cwd: record.path });
    if (result.code !== 0) {
      step.fail(`${branch} was not published`);
      throw new GroveError(
        "remote",
        `git push -u ${remote} ${branch} failed (exit ${result.code})`,
        {
          details: stderrDetails(result.stderr),
        },
      );
    }
    step.succeed(`published ${branch} to ${remote}/${branch}`);

    return "published";
  }

  if (status.behind > 0) {
    throw new GroveError(
      "refused",
      `${dir} is ${plural(status.behind, "commit")} behind ${status.upstream}`,
      { hint: `bring it up to date first: grove sync ${branch}` },
    );
  }

  if (status.ahead === 0) return "up-to-date";

  const target = await pushTarget(record.path, branch, status.upstream);
  const step = reporter.step(`pushing ${branch}`);
  const result = await runGit(["push", target.remote, target.refspec], { cwd: record.path });
  if (result.code !== 0) {
    step.fail(`${branch} was not pushed`);
    throw new GroveError("remote", `git push ${target.remote} failed (exit ${result.code})`, {
      details: stderrDetails(result.stderr),
    });
  }
  step.succeed(`pushed ${branch} to ${target.tracking}`);

  return "pushed";
}

/** The URL gh printed, and the number in it — the last line that looks like one. */
function pullRequestUrl(output: string): { readonly url?: string; readonly number?: number } {
  const url = output
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => /^https?:\/\//.test(line));
  if (url === undefined) return {};

  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);

  return { url, number: match?.[1] === undefined ? undefined : Number(match[1]) };
}

export async function proposePullRequest(
  repo: RepoPaths,
  cwd: string,
  options: ProposeOptions,
  reporter: Reporter,
): Promise<ProposeResult> {
  const proposal = await proposalFor(repo, cwd, options);
  const { record, dir, branch, base, parent, status, existing } = proposal;
  const identity = { path: record.path, dir, branch, parent };

  // Said rather than refused. The pull request is what was asked for and it
  // exists; a second one would be refused by the forge anyway. The base is
  // the one thing about it worth checking, because it is the one thing this
  // command knows better than the forge does.
  if (existing !== undefined) {
    reporter.info(
      `pull request ${existing.number} already proposes ${branch} onto ${existing.base}`,
    );
    if (existing.base !== base) {
      reporter.warn(
        `it goes onto ${existing.base}, and ${branch} sits on ${base}: ` +
          `gh pr edit ${existing.number} --base ${base} moves it`,
      );
    }

    return {
      ...identity,
      base: existing.base,
      pushed: "up-to-date",
      number: existing.number,
      url: existing.url,
      created: false,
      web: false,
    };
  }

  // Warned and not refused: what is uncommitted is not in any pull request,
  // and the branch as pushed is a perfectly good thing to propose. Said so the
  // edit somebody forgot to commit is not discovered from the review.
  if (status.dirty) {
    reporter.warn(
      `${dir} has ${plural(status.changed.length, "uncommitted change")}, which the pull request will not have`,
    );
  }

  const pushed = await bringToRemote(proposal, reporter);

  const argv = [
    "pr",
    "create",
    "--base",
    base,
    ...(options.draft ? ["--draft"] : []),
    ...(options.web
      ? ["--web"]
      : options.title !== undefined
        ? ["--title", options.title, "--body", options.body ?? ""]
        : ["--fill"]),
  ];

  const step = reporter.step(
    options.web
      ? `opening the browser to propose ${branch} onto ${base}`
      : `proposing ${branch} onto ${base}`,
  );
  let output: string;
  try {
    output = await runGh(argv, record.path);
  } catch (error) {
    step.fail(`could not propose ${branch}`);
    throw error;
  }

  if (options.web) {
    step.succeed(`browser opened for ${branch} onto ${base}`);

    return { ...identity, base, pushed, created: false, web: true };
  }

  const { url, number } = pullRequestUrl(output);
  step.succeed(
    number === undefined
      ? `proposed ${branch} onto ${base}`
      : `pull request ${number} — ${branch} onto ${base}`,
  );

  return { ...identity, base, pushed, number, url, created: true, web: false };
}
