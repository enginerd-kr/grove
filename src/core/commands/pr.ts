import type { Reporter } from "../../report/reporter.ts";
import { GroveError, stderrDetails } from "../errors.ts";
import { gitOutput, runGit, runGitOrThrow, runTool } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import type { SetupResult } from "../setup.ts";
import { listWorktrees, statusOf } from "../worktrees.ts";
import { addWorktree } from "./add.ts";

/**
 * `grove pr` — give a pull request a worktree you can build in.
 *
 * The problem this exists for is the one worktrees were always the answer to,
 * and the one place the answer was still out of reach: `gh pr checkout` moves
 * the checkout you are standing in, so reviewing somebody's change means
 * putting your own down first. Here it is a directory instead, filled in from
 * `.grove.toml` like any other, and reviewing becomes running rather than
 * reading.
 *
 * The division of labour is deliberate. `gh` answers only what git cannot —
 * which repository the head lives in, what the ref is called there, whether it
 * is a fork, what state the pull request is in — and every ref, remote and
 * branch after that is git, run by us. The worktree itself is not made here at
 * all: `pr/<n>` is created as a local branch and `addWorktree` takes it from
 * there, which is what buys the path rules, the collision and nesting
 * refusals, the setup run and the warn-rather-than-fail on a setup that broke.
 */

const REMOTE = "origin";

/** Everything `checkoutPullRequest` needs off the forge, in one round trip. */
const PR_FIELDS = [
  "number",
  "title",
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "isCrossRepository",
  "headRepository",
  "headRepositoryOwner",
  "author",
].join(",");

/** Everything the picker draws. Narrower than `PR_FIELDS`: a list pays per row. */
const LIST_FIELDS = ["number", "title", "author", "isDraft", "headRefName", "updatedAt"].join(",");

export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** One row of the picker. Everything here is drawn; nothing here is acted on. */
export type PullRequest = {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  /** Epoch ms, so the screen can hand it straight to `describeAge`. */
  readonly updatedAt: number;
};

/** What the forge said, flattened out of gh's nested JSON. */
type PrDetail = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: PrState;
  readonly isDraft: boolean;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
  readonly headOwner: string;
  readonly headRepo: string;
  readonly author: string;
};

export type PrOptions = {
  /**
   * As typed: a number, a URL, or the branch it was proposed from.
   *
   * Never parsed here. `gh` already resolves all three, and the number comes
   * back out of its answer — so the spellings people actually use cost nothing.
   */
  readonly pr: string;
  /** Copy, link and run whatever `.grove.toml` asks for. On by default. */
  readonly setup: boolean;
  /** Record the trunk's `.grove.toml` commands as read, and run them. */
  readonly trust: boolean;
};

export type PrResult = {
  readonly path: string;
  /** Always `pr/<number>`: the directory is the branch, the same as everywhere else. */
  readonly branch: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: PrState;
  /** `owner:branch` — how a pull request's head reads on the forge. */
  readonly head: string;
  /** `pr-<number>`, or absent when the head branch was gone and this came off `refs/pull`. */
  readonly remote?: string;
  readonly upstream?: string;
  /** False when there is nothing on the far end to push back to. */
  readonly pushable: boolean;
  readonly updated: "created" | "fast-forwarded" | "unchanged";
  readonly alreadyPresent: boolean;
  readonly setup?: SetupResult;
};

/** The local branch a pull request gets, which is also its directory. */
function branchFor(number: number): string {
  return `pr/${number}`;
}

/**
 * The remote a pull request gets, named after the pull request and not its author.
 *
 * `pr-42` rather than `<owner>` because the remote carries a *push refspec*
 * (see `configureRemote`), and that refspec is only true for one pull request:
 * two proposals from the same fork would otherwise fight over one
 * `remote.<owner>.push`. A hyphen rather than `pr/42`, because a remote with a
 * slash in it produces `refs/remotes/pr/42/<head>`, which conflicts with any
 * remote called `pr` and reads as a typo in `git remote -v`.
 */
function remoteFor(number: number): string {
  return `pr-${number}`;
}

/**
 * The one place a `gh` failure becomes a `GroveError`.
 *
 * `gh` missing is its own answer rather than a crash: everything else in grove
 * works without it, so this is the one feature that gets to say "install gh"
 * and point at where. Anything else is gh's own stderr, which is the useful
 * half — "no pull requests found", "not a GitHub repository".
 */
async function runGh(argv: readonly string[], cwd: string): Promise<string> {
  const [head = "", second = ""] = argv;
  const result = await runTool(["gh", ...argv] as [string, ...string[]], { cwd });

  if (result === null) {
    throw new GroveError("gh", "reviewing a pull request needs `gh`, which is not installed", {
      hint: "https://cli.github.com — nothing else in grove uses it",
    });
  }

  if (result.code !== 0) {
    throw new GroveError("gh", `gh ${head} ${second} failed (exit ${result.code})`.trim(), {
      details: stderrDetails(result.stderr),
      hint: /GitHub host|default remote|not a git repository/i.test(result.stderr)
        ? "gh could not tell which GitHub repository this is; try `gh repo set-default`"
        : undefined,
    });
  }

  return result.stdout;
}

/**
 * gh's stdout, parsed — the same reasoning as `runGh`, one step further out.
 *
 * What gh prints is as much somebody else's output as the exit code it prints
 * it with: a broken extension, a paginator, an auth notice on stdout. So an
 * answer we cannot read is gh disappointing us rather than a bug in this tool,
 * and it exits 10 with gh's own words instead of 1 with a `SyntaxError`.
 */
function parseGh(output: string, what: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new GroveError("gh", `${what} answered with something that is not JSON`, {
      details: stderrDetails(output),
    });
  }
}

/** gh's JSON, read defensively: a missing field is a shape we do not recognise. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The open pull requests, newest first — the picker's rows.
 *
 * An empty list is a real answer, not an error: a repository with nothing open
 * is a normal repository, and the screen says so on its message line.
 */
export async function listPullRequests(
  repo: RepoPaths,
  limit = 30,
): Promise<readonly PullRequest[]> {
  const output = await runGh(
    ["pr", "list", "--state", "open", "--limit", String(limit), "--json", LIST_FIELDS],
    repo.root,
  );

  const parsed: unknown = parseGh(output, "gh pr list");
  if (!Array.isArray(parsed)) return [];

  return parsed.map((entry) => {
    const row = record(entry);
    const updatedAt = Date.parse(text(row.updatedAt));

    return {
      number: typeof row.number === "number" ? row.number : 0,
      title: text(row.title),
      author: text(record(row.author).login),
      isDraft: row.isDraft === true,
      headRefName: text(row.headRefName),
      // `0` rather than `NaN`: `describeAge` does arithmetic on this, and one
      // unparseable timestamp should cost that row its age, not the panel.
      updatedAt: Number.isNaN(updatedAt) ? 0 : updatedAt,
    };
  });
}

async function detailOf(repo: RepoPaths, pr: string): Promise<PrDetail> {
  const row = record(
    parseGh(await runGh(["pr", "view", pr, "--json", PR_FIELDS], repo.root), "gh pr view"),
  );
  const state = text(row.state);

  const detail: PrDetail = {
    number: typeof row.number === "number" ? row.number : 0,
    title: text(row.title),
    url: text(row.url),
    state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
    isDraft: row.isDraft === true,
    baseRefName: text(row.baseRefName),
    headRefName: text(row.headRefName),
    isCrossRepository: row.isCrossRepository === true,
    headOwner: text(record(row.headRepositoryOwner).login),
    headRepo: text(record(row.headRepository).name),
    author: text(record(row.author).login),
  };

  // Refused here, before `configureRemote` writes anything. These four are the
  // ones spelled into config rather than merely printed — the remote's name and
  // URL and both of its refspecs — and a blank in any of them is written as a
  // refspec git will not parse, after which every `git remote` and `git fetch`
  // in the repository exits 128 and the sweep that would clean it up dies on
  // the same read. An answer we cannot use is gh's to explain, like any other.
  const missing = (
    [
      ["number", detail.number > 0],
      ["headRefName", detail.headRefName !== ""],
      ["headRepositoryOwner", detail.headOwner !== ""],
      ["headRepository", detail.headRepo !== ""],
    ] as const
  )
    .filter(([, present]) => !present)
    .map(([field]) => field);

  if (missing.length > 0) {
    throw new GroveError("gh", `gh pr view answered without ${missing.join(", ")}`, {
      hint: `see what it answers: gh pr view ${pr} --json ${PR_FIELDS}`,
    });
  }

  return detail;
}

/**
 * Where the head lives, worked out from origin's URL rather than asked for.
 *
 * `gh` would hand over a `clone_url`, and it would be the wrong one: somebody
 * who cloned over ssh would get an https fork remote their key does not open,
 * and a GitHub Enterprise host would be answered with github.com. Rewriting the
 * last two components of origin's own URL keeps the transport and the host that
 * are already known to work here.
 */
async function headUrl(repo: RepoPaths, detail: PrDetail): Promise<string> {
  const origin = await gitOutput(["remote", "get-url", REMOTE], { cwd: repo.gitDir });
  // `https://host/owner/repo.git` and `git@host:owner/repo` alike: everything
  // up to the separator before the owner is kept exactly as it was written.
  const match = /^(.*[/:])[^/:]+\/[^/]+?(\.git)?$/.exec(origin.trim());

  if (match === null) {
    throw new GroveError(
      "gh",
      `cannot work out the URL of ${detail.headOwner}/${detail.headRepo} from origin's`,
      { hint: `add it yourself: git remote add ${remoteFor(detail.number)} <url>` },
    );
  }

  return `${match[1]}${detail.headOwner}/${detail.headRepo}${match[2] ?? ""}`;
}

/**
 * Points `pr-<n>` at the head repository, with the two refspecs that matter.
 *
 * The fetch refspec is one branch, not `*`: a fork carries whatever its owner
 * has ever pushed, and none of it is this pull request.
 *
 * The push refspec is the whole reason the remote exists. `pr/42` tracking
 * `pr-42/feat-x` would be refused by a bare `git push` under the default
 * `push.default=simple`, because the two names differ — but git consults
 * `remote.*.push` *before* it consults `push.default`, so this makes `git push`
 * from the worktree mean "send it back to the pull request", which is the only
 * thing it could sensibly mean there. Nothing global is touched to achieve it.
 */
async function configureRemote(repo: RepoPaths, detail: PrDetail, url: string): Promise<void> {
  const remote = remoteFor(detail.number);
  const head = detail.headRefName;
  const known = await runGit(["remote", "get-url", remote], { cwd: repo.gitDir });

  await runGitOrThrow(
    known.code === 0 ? ["remote", "set-url", remote, url] : ["remote", "add", remote, url],
    { cwd: repo.gitDir },
  );

  for (const [key, value] of [
    [`remote.${remote}.fetch`, `+refs/heads/${head}:refs/remotes/${remote}/${head}`],
    [`remote.${remote}.push`, `refs/heads/${branchFor(detail.number)}:refs/heads/${head}`],
    // A pull request is a branch, and a fork's tags are nobody's business here.
    [`remote.${remote}.tagOpt`, "--no-tags"],
  ] as const) {
    await runGitOrThrow(["config", "--replace-all", key, value], { cwd: repo.gitDir });
  }
}

/**
 * Drops the `pr-*` remotes whose branch is gone.
 *
 * These remotes are fetched by the refresh tick's `fetch --all`, so a remote
 * left behind by a review finished months ago is a network round trip paid
 * forever for a branch that no longer exists. `remove --delete-branch` takes
 * one with its branch; this is the sweep for every other way a branch goes,
 * and it costs one `git remote` read.
 */
async function pruneOrphanRemotes(repo: RepoPaths): Promise<void> {
  const listed = await runGit(["remote"], { cwd: repo.gitDir });
  if (listed.code !== 0) return;

  for (const remote of listed.stdout.split("\n").map((line) => line.trim())) {
    const match = /^pr-(\d+)$/.exec(remote);
    if (match === null) continue;

    const branch = `pr/${match[1]}`;
    const exists = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repo.gitDir,
    });
    if (exists.code === 0) continue;

    await runGit(["remote", "remove", remote], { cwd: repo.gitDir });
  }
}

/** The head's sha, and the remote that can still serve it — if any can. */
type Head = { readonly sha: string; readonly remote?: string };

/**
 * Fetches the head, falling back to `refs/pull/<n>/head` when the branch is gone.
 *
 * Deleting the head branch is what a merge does by default, so the common case
 * for a pull request worth looking back at is that its branch no longer exists.
 * GitHub keeps `refs/pull/<n>/head` on the base repository forever, which is
 * enough to check the work out — just not to push anything back, so the remote
 * is removed rather than left pointing at a fork that cannot serve it.
 *
 * Only "the ref is not there" falls back. A network failure is still a network
 * failure, and answering it with a second request to a different host would
 * report the wrong problem.
 */
async function fetchHead(repo: RepoPaths, detail: PrDetail, reporter: Reporter): Promise<Head> {
  const remote = remoteFor(detail.number);
  const label = `${detail.headOwner}:${detail.headRefName}`;
  const step = reporter.step(`fetching ${label}`);
  const fetched = await runGit(["fetch", remote], { cwd: repo.gitDir });

  if (fetched.code === 0) {
    const sha = await gitOutput(["rev-parse", `refs/remotes/${remote}/${detail.headRefName}`], {
      cwd: repo.gitDir,
    });
    step.succeed(`fetched ${label}`);

    return { sha: sha.trim(), remote };
  }

  if (!/couldn't find remote ref|Repository not found|not found/i.test(fetched.stderr)) {
    step.fail(`could not fetch ${label}`);
    throw new GroveError("remote", `git fetch ${remote} failed (exit ${fetched.code})`, {
      details: stderrDetails(fetched.stderr),
    });
  }

  await runGit(["remote", "remove", remote], { cwd: repo.gitDir });
  await runGitOrThrow(["fetch", REMOTE, `refs/pull/${detail.number}/head`], { cwd: repo.gitDir });
  const sha = await gitOutput(["rev-parse", "FETCH_HEAD"], { cwd: repo.gitDir });
  step.succeed(`fetched pull request ${detail.number}`);

  return { sha: sha.trim() };
}

/**
 * Brings `pr/<n>` to the head, or refuses — and never resets.
 *
 * One rule covers three situations, which is why it is one rule: equal is
 * nothing to do, an ancestor fast-forwards, and anything else necessarily
 * carries commits the head does not have. Those commits are either the
 * reviewer's own or the ones a force-push withdrew, and grove does not throw
 * away either on your behalf — `grove reset --to` is the spelling for that, and
 * it has to be typed.
 *
 * The same rule is what answers "somebody already has a branch called `pr/42`":
 * an unrelated branch is not an ancestor, so it is refused here rather than
 * being quietly checked out as if it were the pull request.
 */
async function reconcileBranch(
  repo: RepoPaths,
  detail: PrDetail,
  head: Head,
): Promise<"created" | "fast-forwarded" | "unchanged"> {
  const branch = branchFor(detail.number);
  const remote = remoteFor(detail.number);
  const ref = `refs/heads/${branch}`;
  const current = await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd: repo.gitDir });

  if (current.code !== 0) {
    // `--no-track` because the upstream is set by name below; letting
    // `branch.autoSetupMerge` guess from a remote-tracking ref would set it to
    // whatever the sha happened to be reachable from.
    await runGitOrThrow(["branch", "--no-track", branch, head.sha], { cwd: repo.gitDir });

    return "created";
  }

  if (current.stdout.trim() === head.sha) return "unchanged";

  const ancestor = await runGit(["merge-base", "--is-ancestor", ref, head.sha], {
    cwd: repo.gitDir,
  });

  if (ancestor.code !== 0) {
    const tracking = await runGit(["config", "--get", `branch.${branch}.remote`], {
      cwd: repo.gitDir,
    });
    const mine = tracking.stdout.trim() === remote;
    const ahead = (
      await gitOutput(["rev-list", "--count", `${head.sha}..${ref}`], { cwd: repo.gitDir })
    ).trim();
    const commits = `${ahead} commit${ahead === "1" ? "" : "s"}`;

    throw new GroveError(
      "refused",
      mine
        ? `${branch} has ${commits} pull request ${detail.number} does not`
        : `${branch} is already a branch here, and it is not pull request ${detail.number}`,
      {
        hint: mine
          ? `they are yours — push them, or throw them away: grove reset ${branch} --to ${remote}/${detail.headRefName}`
          : `rename it: git -C ${repo.gitDir} branch -m ${branch} <another name>`,
      },
    );
  }

  // Behind, and safely so. Where it is checked out the move has to go through
  // the worktree, or the index and the working tree would be left describing
  // the commit the branch no longer points at.
  const worktrees = await listWorktrees(repo.gitDir);
  const holder = worktrees.find((wt) => wt.branch === branch);

  if (holder === undefined) {
    await runGitOrThrow(["branch", "-f", branch, head.sha], { cwd: repo.gitDir });

    return "fast-forwarded";
  }

  const status = await statusOf(holder.path);
  if (status.dirty) {
    throw new GroveError(
      "refused",
      `${branch} has uncommitted changes, and pull request ${detail.number} has moved on`,
      { hint: `commit them, or discard them: grove reset ${branch}` },
    );
  }

  await runGitOrThrow(["merge", "--ff-only", head.sha], { cwd: holder.path });

  return "fast-forwarded";
}

export async function checkoutPullRequest(
  repo: RepoPaths,
  cwd: string,
  options: PrOptions,
  reporter: Reporter,
): Promise<PrResult> {
  await pruneOrphanRemotes(repo);

  const asking = reporter.step("asking the forge");
  let detail: PrDetail;
  try {
    detail = await detailOf(repo, options.pr);
  } catch (error) {
    asking.fail("the forge had no answer");
    throw error;
  }
  asking.succeed(`pull request ${detail.number} — ${detail.title}`);

  // Said rather than refused. "What did this actually change, in a directory I
  // can build in" is as good a question about a merged pull request as an open
  // one; the same call `add` makes about a setup that failed and `remove` makes
  // about unpushed commits.
  if (detail.state !== "OPEN") {
    reporter.warn(
      `pull request ${detail.number} is ${detail.state.toLowerCase()}; this is the branch as it was proposed`,
    );
  }
  if (detail.isDraft) reporter.info(`pull request ${detail.number} is still a draft`);

  await configureRemote(repo, detail, await headUrl(repo, detail));
  const head = await fetchHead(repo, detail, reporter);

  if (head.remote === undefined) {
    reporter.warn(
      `the branch behind pull request ${detail.number} is gone; this is a copy with nothing to push back to`,
    );
  }

  const branch = branchFor(detail.number);
  const updated = await reconcileBranch(repo, detail, head);

  if (head.remote !== undefined) {
    // Re-asserted every run rather than only on creation: both are idempotent,
    // and a branch somebody re-pointed by hand should come back to the truth.
    await runGitOrThrow(
      ["branch", `--set-upstream-to=${head.remote}/${detail.headRefName}`, branch],
      { cwd: repo.gitDir },
    );
  }
  await runGitOrThrow(
    ["config", "--replace-all", `branch.${branch}.description`, `${detail.title}\n\n${detail.url}`],
    { cwd: repo.gitDir },
  );

  const result = await addWorktree(
    repo,
    cwd,
    // `fetch: false` because the fetch above brought exactly the right ref, and
    // `push: false` because publishing somebody else's proposal under your own
    // name on arrival is never what was meant. `take: false` for a reason of
    // its own: carrying your uncommitted changes into somebody else's proposal
    // is not a thing anybody means, and `grove add --take` is where that lives.
    {
      branch,
      fetch: false,
      push: false,
      setup: options.setup,
      trust: options.trust,
      take: false,
    },
    reporter,
  );

  if (updated === "created" && head.remote !== undefined) {
    // The push refspec is invisible otherwise, and it is the whole payoff:
    // without this line the branch merely looks like a copy of somebody's work.
    reporter.info(`git push there sends it back to ${detail.headOwner}:${detail.headRefName}`);
  }

  return {
    path: result.path,
    branch,
    number: detail.number,
    title: detail.title,
    url: detail.url,
    state: detail.state,
    head: `${detail.headOwner}:${detail.headRefName}`,
    remote: head.remote,
    // Built here rather than taken from `AddResult`, which reports
    // `origin/<branch>` for an existing branch whatever it actually tracks.
    upstream: head.remote === undefined ? undefined : `${head.remote}/${detail.headRefName}`,
    pushable: head.remote !== undefined,
    updated,
    alreadyPresent: result.alreadyPresent,
    setup: result.setup,
  };
}
