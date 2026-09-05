import type { SetupResult } from "../../hooks/index.ts";
import { type Reporter, withStep } from "../../report/reporter.ts";
import { localBranchExists, REMOTE, trunkOf } from "../branches.ts";
import { GroveError, stderrDetails } from "../errors.ts";
import { ghJson, record, text } from "../forge.ts";
import { gitOutput, runGit, runGitOrThrow } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
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
 * branch after that is git, run by us. How `gh` is run and read is
 * `core/forge.ts`, shared with the two other commands that ask it something. The worktree itself is not made here at
 * all: `pr/<n>` is created as a local branch and `addWorktree` takes it from
 * there, which is what buys the path rules, the collision and nesting
 * refusals, the setup run and the warn-rather-than-fail on a setup that broke.
 */

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
  readonly headRefName: string;
  readonly headOwner: string;
  readonly headRepo: string;
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
  /** Whether `[setup] open` may start the app it names. See `AddOptions.open`. */
  readonly open?: boolean;
};

export type PrResult = {
  readonly path: string;
  /**
   * Relative to the root, `/`-separated — the name the list uses.
   *
   * Taken from the `add` this command delegates to rather than recomputed, so
   * a `--json` reader can line this row up with `grove list` without
   * re-deriving it, the way `path`, `reset` and `rename` do.
   */
  readonly dir: string;
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

/**
 * The local branch a pull request gets, which is also its directory.
 *
 * Exported with `remoteFor` and `prNumberOf` because they are one convention,
 * not three: `remove` walks it backwards to take a pull request's remote with
 * its branch, and a second spelling of `pr/<n>` anywhere is the one that
 * drifts.
 */
export function branchFor(number: number): string {
  return `pr/${number}`;
}

/** `branchFor`, backwards: the number in `pr/<n>`, or nothing for any other branch. */
export function prNumberOf(branch: string): number | undefined {
  const match = /^pr\/(\d+)$/.exec(branch);

  return match?.[1] === undefined ? undefined : Number(match[1]);
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
export function remoteFor(number: number): string {
  return `pr-${number}`;
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
  const parsed: unknown = await ghJson(
    ["pr", "list", "--state", "open", "--limit", String(limit), "--json", LIST_FIELDS],
    repo.root,
  );
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

/**
 * The fields the badges are drawn from, and nothing a picker would pay for.
 *
 * `statusCheckRollup` is the expensive one — a row per check per pull request
 * — and it is the whole reason to ask: the number alone is what `propose`
 * already prints, and what the screen wants to know is whether the thing is
 * green.
 */
const BADGE_FIELDS = [
  "number",
  "url",
  "headRefName",
  "baseRefName",
  "isDraft",
  "reviewDecision",
  "mergeable",
  "statusCheckRollup",
].join(",");

/**
 * How many open pull requests the badges are read from.
 *
 * One call for every row on the screen, so the cost is the forge's, and the
 * newest hundred is where the pull request for a branch somebody is working in
 * this week is; one older than that has to be reached by its number, which
 * `grove pr <n>` takes.
 */
const BADGE_LIMIT = 100;

/** Every check passed, one of them failed, or some have not answered yet. */
export type ChecksState = "passing" | "failing" | "pending";

/**
 * What the reviewers said, when they have said something that stands.
 *
 * "Review required" is not a state here: it is what every fresh pull request
 * reads, and a badge that said it on every row would be saying nothing.
 */
export type ReviewState = "approved" | "changes-requested";

/**
 * A branch's open pull request as the forge sees it — what stands between the
 * branch and its merge.
 *
 * Read for the screen's `pr` column and for nothing else: `list` never asks
 * the forge, so `grove list` is the same command with and without `gh`, and
 * the column is the one part of the screen that is the forge's word rather
 * than git's.
 */
export type BranchPullRequest = {
  readonly number: number;
  readonly url: string;
  /** The branch it was proposed from, which is the branch a row is matched by. */
  readonly head: string;
  readonly base: string;
  readonly isDraft: boolean;
  /** Absent when the pull request has no checks at all. */
  readonly checks?: ChecksState;
  readonly review?: ReviewState;
  /** True when the forge cannot merge it as it stands. */
  readonly conflicts: boolean;
};

/**
 * The words the forge uses for a check that has come back red, and for one
 * that has come back green.
 *
 * Two shapes arrive in one list. A check run says `status` and, once
 * `COMPLETED`, a `conclusion`; a commit status says `state`. GitHub's own
 * "all checks have passed" counts a skipped or neutral run as passed, and so
 * does this. Anything not on either list is a check still on its way.
 */
const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function checksOf(rollup: unknown): ChecksState | undefined {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;

  let pending = false;
  for (const entry of rollup) {
    const row = record(entry);
    const state =
      text(row.state) || (text(row.status) === "COMPLETED" ? text(row.conclusion) : "PENDING");

    // One failure is the answer whatever the rest are doing: a red check is
    // what needs looking at, and a green one beside it changes nothing.
    if (FAILED.has(state)) return "failing";
    if (!PASSED.has(state)) pending = true;
  }

  return pending ? "pending" : "passing";
}

function reviewOf(decision: string): ReviewState | undefined {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes-requested";

  return undefined;
}

/**
 * The open pull requests with what stands between each and its merge — the
 * screen's `pr` column, in one round trip.
 *
 * The same refusals as `listPullRequests`, and the screen swallows every one of
 * them: this is read on the refresh tick, nobody pressed a key for it, and a
 * repository without `gh`, without GitHub, or without a network is a
 * repository with no column rather than one with a red line every minute.
 */
export async function branchPullRequests(
  repo: RepoPaths,
  limit = BADGE_LIMIT,
): Promise<readonly BranchPullRequest[]> {
  const parsed: unknown = await ghJson(
    ["pr", "list", "--state", "open", "--limit", String(limit), "--json", BADGE_FIELDS],
    repo.root,
    30_000,
  );
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    const row = record(entry);
    // A row with no number is a shape we do not recognise, and a badge with
    // nothing to draw. Dropped rather than drawn as `#0`.
    if (typeof row.number !== "number") return [];

    return [
      {
        number: row.number,
        url: text(row.url),
        head: text(row.headRefName),
        base: text(row.baseRefName),
        isDraft: row.isDraft === true,
        checks: checksOf(row.statusCheckRollup),
        review: reviewOf(text(row.reviewDecision)),
        conflicts: text(row.mergeable) === "CONFLICTING",
      },
    ];
  });
}

/**
 * The pull request a worktree's branch is on, out of what the forge listed.
 *
 * By the branch's name first, which is what the forge indexes on. A review
 * worktree is the other way round: `pr/42` is grove's name for somebody
 * else's `fix/crash`, and the number in it is the only thing the two share —
 * so it is matched by that, and the row reviewing a pull request shows
 * whether the pull request is green too.
 */
export function pullRequestFor(
  prs: readonly BranchPullRequest[],
  branch: string,
): BranchPullRequest | undefined {
  const byHead = prs.find((pr) => pr.head === branch);
  if (byHead !== undefined) return byHead;

  const number = prNumberOf(branch);

  return number === undefined ? undefined : prs.find((pr) => pr.number === number);
}

/**
 * How a word in the `pr` column is coloured, said as what it means rather
 * than as a colour — the row decides the colour, the way it does for the
 * state column's own words.
 */
export type BadgeTone = "plain" | "ok" | "warn" | "danger" | "dim";

export type BadgePart = { readonly text: string; readonly tone: BadgeTone };

/** One glyph per answer, so the column reads across the terminal without its colour. */
const CHECK_GLYPHS: Record<ChecksState, BadgePart> = {
  passing: { text: "✓", tone: "ok" },
  failing: { text: "✗", tone: "danger" },
  // The reporter's own mark for a step that has not settled, which is what a
  // check still running is.
  pending: { text: "·", tone: "dim" },
};

/**
 * The `pr` column, as the words it is made of.
 *
 * The number first, because it is what the row is recognised by; the checks
 * as one glyph, because they are the thing to glance at; and then only the
 * words that mean something is to be done or nothing is — `draft`, what the
 * reviewers said, and `conflicts`. A pull request waiting on its first review
 * with green checks reads `#42 ✓`, which is the whole of what is true of it.
 */
export function pullRequestParts(pr: BranchPullRequest): readonly BadgePart[] {
  const parts: BadgePart[] = [{ text: `#${pr.number}`, tone: "plain" }];

  if (pr.checks !== undefined) parts.push(CHECK_GLYPHS[pr.checks]);
  if (pr.isDraft) parts.push({ text: "draft", tone: "dim" });
  if (pr.review === "approved") parts.push({ text: "approved", tone: "ok" });
  if (pr.review === "changes-requested") parts.push({ text: "changes requested", tone: "warn" });
  if (pr.conflicts) parts.push({ text: "conflicts", tone: "warn" });

  return parts;
}

/** `pullRequestParts` as one string — what the column is sized by. */
export function describePullRequest(pr: BranchPullRequest): string {
  return pullRequestParts(pr)
    .map((part) => part.text)
    .join(" ");
}

/** A branch and the commit it is at — what a closed pull request is matched against. */
export type ForgeCandidate = {
  readonly branch: string;
  /** The branch's tip, in full. */
  readonly head: string;
};

/** The fields a closed-or-not question needs, and nothing a list would pay for. */
const STATE_FIELDS = ["number", "state", "headRefOid"].join(",");

/**
 * Whether the forge holds a pull request for this branch, closed without being
 * merged, at exactly this commit.
 *
 * Both halves of "closed without merging" are gh's own: `--state closed` lists
 * the merged ones too, and `MERGED` is what their `state` says, so only a row
 * still reading `CLOSED` is the case `prune` has no local answer for. The
 * commit is the guard: branch names get reused, and a `fix/crash` whose pull
 * request was declined in March is not the same `fix/crash` somebody cut this
 * morning — the head sha is what says which of the two the forge is talking
 * about.
 *
 * A `pr/<n>` branch is asked about by its number rather than by name, since
 * the name is ours and the forge has never heard it.
 */
async function closedAt(repo: RepoPaths, candidate: ForgeCandidate): Promise<number | undefined> {
  const number = prNumberOf(candidate.branch);
  const argv =
    number === undefined
      ? ["pr", "list", "--head", candidate.branch, "--state", "closed", "--json", STATE_FIELDS]
      : ["pr", "view", String(number), "--json", STATE_FIELDS];

  const parsed: unknown = await ghJson(argv, repo.root);
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  for (const entry of rows) {
    const row = record(entry);
    if (text(row.state) !== "CLOSED" || text(row.headRefOid) !== candidate.head) continue;
    if (typeof row.number === "number") return row.number;
  }

  return undefined;
}

/**
 * The branches among `candidates` whose pull request was closed without
 * merging, each with the pull request's number.
 *
 * One question per branch rather than one list for all of them: `gh pr list
 * --head` is exact, and a repository's closed pull requests are the one list
 * that only ever grows, so a single page of them would miss precisely the
 * oldest worktrees — the ones most worth clearing away. The questions are
 * asked together; they are independent, and each is a process and a round trip.
 */
export async function closedOnForge(
  repo: RepoPaths,
  candidates: readonly ForgeCandidate[],
): Promise<ReadonlyMap<string, number>> {
  const answers = await Promise.all(candidates.map((candidate) => closedAt(repo, candidate)));
  const closed = new Map<string, number>();

  for (const [index, candidate] of candidates.entries()) {
    const number = answers[index];
    if (number !== undefined) closed.set(candidate.branch, number);
  }

  return closed;
}

async function detailOf(repo: RepoPaths, pr: string): Promise<PrDetail> {
  const row = record(await ghJson(["pr", "view", pr, "--json", PR_FIELDS], repo.root));
  const state = text(row.state);

  const detail: PrDetail = {
    number: typeof row.number === "number" ? row.number : 0,
    title: text(row.title),
    url: text(row.url),
    state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
    isDraft: row.isDraft === true,
    headRefName: text(row.headRefName),
    headOwner: text(record(row.headRepositoryOwner).login),
    headRepo: text(record(row.headRepository).name),
  };

  // Refused here, before `configureRemote` writes anything. These four are the
  // ones spelled into config rather than merely printed — the remote's name and
  // URL and both of its refspecs — and a blank in any of them is written as a
  // refspec git will not parse, after which every `git remote` and `git fetch`
  // in the repository exits 128 and the sweep that would clean it up dies on
  // the same read. An answer we cannot use is gh's to explain, like any other.
  const missing = Object.entries({
    number: detail.number > 0,
    headRefName: detail.headRefName !== "",
    headRepositoryOwner: detail.headOwner !== "",
    headRepository: detail.headRepo !== "",
  })
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
    if (match?.[1] === undefined) continue;

    if (await localBranchExists(repo.gitDir, branchFor(Number(match[1])))) continue;

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
  // `refs/pull/<n>/head` lives on the repository the pull request was opened
  // against, which is the trunk's remote — in a fork that is `upstream`, and
  // origin's `refs/pull/42/head` is a different pull request or none.
  const base = (await trunkOf(repo.gitDir)).remote;
  await runGitOrThrow(["fetch", base, `refs/pull/${detail.number}/head`], { cwd: repo.gitDir });
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

  const detail = await withStep(
    reporter,
    {
      start: "asking the forge",
      done: (found: PrDetail) => `pull request ${found.number} — ${found.title}`,
      failed: "the forge had no answer",
    },
    () => detailOf(repo, options.pr),
  );

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
    // Pinned per branch, so a `remote.pushDefault` set for the fork workflow —
    // "everything I push goes to my fork" — does not catch this one: a pull
    // request's branch goes back to the pull request, whatever else is true
    // of the repository. `publishRemote` reads this before anything else.
    await runGitOrThrow(["config", `branch.${branch}.pushRemote`, head.remote], {
      cwd: repo.gitDir,
    });
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
      open: options.open,
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
    dir: result.dir,
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
