import { type Reporter, withStep } from "../report/reporter.ts";
import { GroveError } from "./errors.ts";
import { gitOutput, gitSucceeds, runGit, runGitOrThrow } from "./git.ts";
import { toLines } from "./text.ts";

/** Questions about refs, asked of the bare repository — and the calls that maintain them. */

export const REMOTE = "origin";

/**
 * The refspec `git clone --bare` declines to write.
 *
 * Without it `git fetch` exits 0 having updated nothing: a bare clone copies the
 * remote's heads straight into `refs/heads/*` and configures no mapping into
 * `refs/remotes/*`. Every later command then fails in a way that points
 * somewhere else — `add` cannot find `origin/feat-x`, `sync` has no upstream to
 * rebase onto, `--prune` prunes nothing — so `clone` sets it before the first
 * fetch, and `doctor`'s advice prints the exact line `clone` would have run.
 */
export const FETCH_REFSPEC = `+refs/heads/*:refs/remotes/${REMOTE}/*`;

/**
 * Makes the bare repository keep reflogs, which `git clone --bare` does not.
 *
 * `core.logallrefupdates` defaults to off in a bare repository, on the
 * reasoning that nobody moves branches around in a repository with no working
 * tree. Here they do: every worktree hangs off this one, and its commits,
 * rebases and pushes all write their refs through it.
 *
 * Two things depend on the history that leaves. `rebase --fork-point` uses the
 * base's reflog to tell a withdrawn commit from one of the user's own, and
 * `push --force-if-includes` uses the branch's to prove the remote's tip was
 * already integrated locally — and without a reflog the latter does not degrade
 * to a weaker check, it simply refuses every force-push with "remote ref
 * updated since checkout".
 *
 * Idempotent, so it can be re-asserted on repositories cloned before grove set
 * it. Answers rather than throws: a repository that will not take the setting is
 * one where force-pushes get refused, not one where nothing else may happen.
 */
export function enableReflogs(bare: string): Promise<boolean> {
  return gitSucceeds(["config", "core.logallrefupdates", "true"], { cwd: bare });
}

/**
 * What a fetch left behind — which is not the same as how git said it went.
 *
 * `fetched` is the claim the callers act on: the remote-tracking branches are
 * as the remote has them. `staleTags` is the part of a nonzero exit that does
 * not touch that claim — see `fetchRemotes`.
 */
export type FetchOutcome = {
  /** The remote-tracking branches are as the remote has them. */
  readonly fetched: boolean;
  /** Tags whose local copy disagrees with the remote's, and so was kept. */
  readonly staleTags: readonly string[];
};

/** The one refusal a fetch can exit nonzero on with every branch delivered. */
const CLOBBERED_TAG = "would clobber existing tag";

/**
 * Brings every remote-tracking ref up to date.
 *
 * Here because everything else in this file reads what it produces: `origin/main`
 * is a local ref, so "2 behind" means two commits behind whatever this last saw,
 * not behind the remote as it is now.
 *
 * Answers rather than throws. Both callers want that — `sync` is about to do the
 * real work and would rather fail there with a better message, and the app polls
 * this in the background, where being offline is an ordinary state of affairs
 * and not something to interrupt anyone about.
 *
 * And the answer is read off the stderr, not the exit code alone, because git
 * exits nonzero for "one ref was refused" exactly as it does for "the remote
 * was unreachable" — and one of those refusals happens while every branch is
 * delivered. `--tags` does not force, so a tag that was moved on the remote
 * after being fetched — a release re-cut, most often — is refused with "would
 * clobber existing tag" on every fetch from then on, forever, with the trunk
 * arriving fine right next to it. Reading that exit code as "could not fetch"
 * told the user their sync ran against a stale trunk when it had not. So: a
 * failure whose every complaint is a clobbered tag is a fetch that happened,
 * with the tags reported for the caller to warn about; anything else — a dead
 * remote, a branch refused — is not.
 */
export async function fetchRemotes(bare: string): Promise<FetchOutcome> {
  const result = await runGit(["fetch", "--all", "--prune", "--tags"], { cwd: bare });
  if (result.code === 0) return { fetched: true, staleTags: [] };

  // ` ! [rejected]  v0.4.4  -> v0.4.4  (would clobber existing tag)` — the
  // parenthesised reason is git's, matched under the `LC_ALL=C` that `runGit`
  // pins, the same bargain `classifyGitError` already makes.
  const rejections = toLines(result.stderr)
    .map((line) => /!\s+\[rejected\]\s+(\S+)\s+->\s+\S+\s+\((.+)\)/.exec(line))
    .filter((match) => match !== null);

  const fetched =
    rejections.length > 0 &&
    rejections.every((match) => match[2] === CLOBBERED_TAG) &&
    // `--all` means one stderr for every remote: a clobbered tag on one does
    // not vouch for a remote that was unreachable underneath it.
    !/^fatal:/m.test(result.stderr);

  return {
    fetched,
    staleTags: fetched
      ? rejections.map((match) => match[1]).filter((tag) => tag !== undefined)
      : [],
  };
}

export type Drift = { readonly ahead: number; readonly behind: number };

/**
 * How far every local branch has drifted from `base`, in one call.
 *
 * One call rather than one per branch, because this is read on a timer: a
 * `rev-list` per worktree every couple of seconds is a cost that grows with the
 * repository, and `for-each-ref` walks the whole set once.
 *
 * `%(ahead-behind:)` arrived in git 2.41. On anything older the format is not a
 * field name and git refuses the whole command, which is reported here as "no
 * answer" rather than as a failure — the column it feeds simply stays empty,
 * and nothing else about the screen depends on it.
 */
export async function driftFrom(bare: string, base: string): Promise<Map<string, Drift>> {
  const result = await runGit(
    ["for-each-ref", `--format=%(refname:short) %(ahead-behind:${base})`, "refs/heads/"],
    { cwd: bare },
  );

  const drift = new Map<string, Drift>();
  if (result.code !== 0) return drift;

  for (const line of result.stdout.split("\n")) {
    // `<branch> <ahead> <behind>`, and a branch name may contain spaces in
    // nothing git allows — but the counts are the last two fields either way.
    const match = /^(.+) (\d+) (\d+)$/.exec(line.trim());
    if (!match) continue;

    const [, branch, ahead, behind] = match;
    if (branch === undefined) continue;

    drift.set(branch, { ahead: Number(ahead), behind: Number(behind) });
  }

  return drift;
}

/**
 * What the remote and the trunk say about a branch that may be finished with.
 *
 * Two questions, because a merge leaves two different traces and no workflow
 * leaves both. A pull request merged with the box ticked deletes the branch on
 * the remote, and what stays behind here is a local branch whose upstream has
 * been withdrawn — `gone`. A pull request squashed or rebased leaves the remote
 * branch alone but puts every one of its commits on the trunk — `merged`.
 * Looking for only one of them would leave half of everybody's worktrees piling
 * up.
 */
export type BranchState = {
  /** The branch it was configured to track, whether or not the remote still has it. */
  readonly upstream?: string;
  /** Configured to track something the remote no longer has. */
  readonly gone: boolean;
  /** Every commit on this branch is already on the base — as itself, or as an equivalent patch. */
  readonly merged: boolean;
};

const NO_STATE: BranchState = { gone: false, merged: false };

/**
 * What each local branch's upstream is, and whether it is still there.
 *
 * `%(upstream:track)` is git's own answer to the second question — it reports
 * `[gone]` for a branch configured to track a ref that no longer exists, which
 * is exactly the state `fetch --prune` leaves behind when somebody deletes a
 * merged branch on the forge. Reading it beats comparing two lists ourselves,
 * because git already knows the difference between "never had an upstream" and
 * "had one, and it went".
 *
 * Tab-separated because a ref name cannot contain a control character, so there
 * is no branch this splits wrongly — unlike a space, which `%(upstream:track)`
 * puts in the middle of its own answers.
 */
async function upstreamStates(bare: string): Promise<Map<string, BranchState>> {
  const states = new Map<string, BranchState>();
  const result = await runGit(
    [
      "for-each-ref",
      "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)",
      "refs/heads/",
    ],
    { cwd: bare },
  );
  if (result.code !== 0) return states;

  for (const line of result.stdout.split("\n")) {
    const [branch, upstream, track] = line.split("\t");
    if (branch === undefined || branch.length === 0) continue;

    states.set(branch, {
      ...NO_STATE,
      ...(upstream === undefined || upstream.length === 0 ? {} : { upstream }),
      gone: track === "gone",
    });
  }

  return states;
}

function refNames(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Whether every commit on `branch` already has an equivalent on `base`.
 *
 * `git cherry` compares patches rather than commits, which is the only way to
 * answer this after a rewrite: it prefixes with `-` each commit whose change is
 * already on `base` under a different sha, and with `+` each one that is not.
 * All `-` is exactly the trace a squash or a rebase leaves — the work landed,
 * and none of the commits carrying it survived to be reachable.
 *
 * An empty answer is *not* merged. A branch whose tip is unreachable from the
 * base always has commits of its own, so empty means git declined to compare
 * them rather than that there was nothing to compare: `git cherry` skips merge
 * commits, so a branch that only merged something in reads empty while still
 * holding a merge the trunk has not got. Reading "every line starts with `-`"
 * off no lines would badge such a branch finished — and `prune` would then
 * offer to delete its worktree — on the strength of no evidence at all.
 */
async function landedAsPatches(bare: string, base: string, branch: string): Promise<boolean> {
  const result = await runGit(["cherry", base, branch], { cwd: bare });
  if (result.code !== 0) return false;

  const commits = refNames(result.stdout);

  return commits.length > 0 && commits.every((line) => line.startsWith("-"));
}

/**
 * The branches with nothing of their own left to say — every change is on `base`.
 *
 * Two questions, and the cheap one first. `--merged` is a single walk over the
 * whole ref set and answers the ancestry half: the branch's tip is reachable
 * from `base`, which is what a merge commit leaves behind. It cannot see the
 * other half this module promises, because a squash or a rebase rewrites the
 * commits — nothing of the branch is reachable from the trunk even though every
 * change on it is there, which is the case the badge exists for.
 *
 * So the branches `--merged` rejects — asked for in the same walk, as
 * `--no-merged` — are put to `git cherry`, which compares patches. That one is
 * a process per branch and a patch-id for every commit on both sides since the
 * merge base, so it is deliberately never asked about a branch the ancestry
 * pass already accepted.
 */
async function mergedInto(bare: string, base: string): Promise<ReadonlySet<string>> {
  const [reachable, rewritten] = await Promise.all([
    runGit(["for-each-ref", "--format=%(refname:short)", "--merged", base, "refs/heads/"], {
      cwd: bare,
    }),
    runGit(["for-each-ref", "--format=%(refname:short)", "--no-merged", base, "refs/heads/"], {
      cwd: bare,
    }),
  ]);
  // A base that cannot be resolved — a repository with no remote-tracking trunk
  // yet — is "nothing is known to be merged", which leaves the badge off rather
  // than putting a wrong one on.
  if (reachable.code !== 0) return new Set();

  const merged = new Set(refNames(reachable.stdout));
  if (rewritten.code !== 0) return merged;

  // The trunk is never asked. Measured against its own remote-tracking ref it is
  // precisely the branch whose local commits somebody squashed upstream, and
  // "the trunk is finished with" is the one answer nothing here may give.
  const trunk = base.replace(new RegExp(`^${REMOTE}/`), "");
  const candidates = refNames(rewritten.stdout).filter((branch) => branch !== trunk);
  const landed = await Promise.all(candidates.map((branch) => landedAsPatches(bare, base, branch)));

  for (const [index, branch] of candidates.entries()) {
    if (landed[index]) merged.add(branch);
  }

  return merged;
}

/**
 * Both answers for every branch, in two calls rather than two per branch.
 *
 * `base` should be the *remote's* trunk, not the local one. The question being
 * asked is "has this work landed", and it lands on the remote — a local `main`
 * that has not been pulled since Tuesday would answer "not yet" for every
 * branch merged since, which is the week in which somebody most wants to know.
 */
export async function branchStates(
  bare: string,
  base: string,
): Promise<ReadonlyMap<string, BranchState>> {
  const [states, merged] = await Promise.all([upstreamStates(bare), mergedInto(bare, base)]);

  for (const [branch, state] of states) {
    if (merged.has(branch)) states.set(branch, { ...state, merged: true });
  }

  return states;
}

/**
 * When each of these commits was made, in one call, as epoch milliseconds.
 *
 * One call rather than one per worktree, for the same reason as `driftFrom`:
 * this feeds a screen that redraws on a timer, and `--no-walk` reads exactly
 * the commits it is handed without walking anything's history.
 *
 * Tolerant the same way too. A sha that cannot be shown — or a git that cannot
 * answer — leaves the map short rather than failing the read, and the column
 * this feeds simply stays empty for those rows.
 */
export async function commitTimes(
  bare: string,
  shas: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const times = new Map<string, number>();
  if (shas.length === 0) return times;

  const result = await runGit(["log", "--no-walk=unsorted", "--format=%H %ct", ...shas], {
    cwd: bare,
  });
  if (result.code !== 0) return times;

  for (const line of result.stdout.split("\n")) {
    const match = /^([0-9a-f]+) (\d+)$/.exec(line.trim());
    if (!match) continue;

    const [, sha, seconds] = match;
    if (sha === undefined) continue;

    times.set(sha, Number(seconds) * 1000);
  }

  return times;
}

/**
 * The branch everything else is measured against.
 *
 * Read from `refs/remotes/origin/HEAD` rather than from the bare repo's own
 * HEAD, because HEAD here tracks whichever branch got the first worktree —
 * which the user may have chosen with `--branch` and which says nothing about
 * what the remote considers its trunk.
 */
export async function defaultBranch(bare: string): Promise<string> {
  const result = await runGit(["symbolic-ref", "--short", `refs/remotes/${REMOTE}/HEAD`], {
    cwd: bare,
  });

  if (result.code !== 0) {
    throw new GroveError("git-failed", `cannot tell which branch ${REMOTE} considers default`, {
      hint: `run \`git -C ${bare} remote set-head ${REMOTE} --auto\``,
    });
  }

  // Comes back as `origin/main`; callers want the branch, not the remote-tracking ref.
  return result.stdout.trim().replace(new RegExp(`^${REMOTE}/`), "");
}

/**
 * Refuses to act on the default branch — the one everything else syncs onto.
 *
 * `remove` and `rename` both gate it behind `--force`, and both say the same
 * sentence about why; the hint is each command's own, since what `--force`
 * would let happen differs. One spelling of the sentence, so a test pinning it
 * pins them both.
 */
export async function refuseTrunk(
  bare: string,
  branch: string | undefined,
  hint: string,
): Promise<void> {
  if (branch === undefined || branch !== (await defaultBranch(bare))) return;

  throw new GroveError("refused", `${branch} is the branch everything else syncs onto`, { hint });
}

/**
 * Points `refs/remotes/origin/HEAD` at whatever the remote currently advertises.
 *
 * Tolerant of failure: a remote with no HEAD is unusual but not fatal, and the
 * caller has a fallback. Returns whether it worked so the caller can pick.
 */
export async function updateRemoteHead(bare: string): Promise<boolean> {
  return (await runGit(["remote", "set-head", REMOTE, "--auto"], { cwd: bare })).code === 0;
}

/**
 * Pushes a worktree's HEAD to `origin` and sets it as the branch's upstream.
 *
 * The push is always the tail of a larger operation that has already landed, so
 * the failure line belongs to the caller: what did happen is the part only the
 * caller knows, and an error that says nothing about it reads as though the
 * whole command came to nothing. The error is still rethrown — a branch that
 * was meant to be on the remote and is not is not a success to report quietly.
 */
export async function pushUpstream(
  path: string,
  branch: string,
  reporter: Reporter,
  failure: string,
): Promise<void> {
  await withStep(
    reporter,
    { start: `pushing ${branch}`, done: `pushed ${branch}`, failed: failure },
    () => runGitOrThrow(["push", "-u", REMOTE, "HEAD"], { cwd: path }),
  );
}

/** The remote-tracking ref for a branch — what `branchStates` measures against. */
export function remoteRef(branch: string): string {
  return `${REMOTE}/${branch}`;
}

export async function localBranchExists(bare: string, branch: string): Promise<boolean> {
  return gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: bare });
}

export async function remoteBranchExists(bare: string, branch: string): Promise<boolean> {
  return gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/remotes/${REMOTE}/${branch}`], {
    cwd: bare,
  });
}

export async function localBranches(bare: string): Promise<readonly string[]> {
  const output = await gitOutput(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
    cwd: bare,
  });

  return output.length === 0 ? [] : output.split("\n");
}
