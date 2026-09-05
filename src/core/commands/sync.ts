import type { Reporter } from "../../report/reporter.ts";
import {
  enableReflogs,
  fetchRemotes,
  localBranchExists,
  publishRemote,
  type Trunk,
  trunkOf,
} from "../branches.ts";
import { GroveError, isGroveError } from "../errors.ts";
import { gitOutput, runGit } from "../git.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { reviewOf } from "../review.ts";
import { ancestry, clearParent, readStack, type Stack, setParent, stackOrder } from "../stack.ts";
import { toLines } from "../text.ts";
import {
  LISTED,
  listWorktrees,
  resolveTarget,
  statusOf,
  type WorktreeRecord,
  worktreeDir,
} from "../worktrees.ts";
import { checkoutPullRequest, pullRequestBase } from "./pr.ts";

/**
 * `grove sync` — fetch, then bring worktrees up to date with the default branch.
 *
 * Nothing here touches a worktree it has not first established is safe to touch.
 * A sync that half-finishes is worse than one that declines, because the user
 * finds out later and in the middle of something else.
 *
 * "The default branch" is the answer for most worktrees and the wrong one for a
 * stack. A branch cut from another branch — `grove add … --on`, recorded in
 * `core/stack.ts` — goes back onto that one, and the trunk reaches it through
 * its parent. Rebasing it onto the trunk directly would replay it over the
 * absence of the work it was written on top of, which is a conflict against a
 * change sitting in the next directory along. So the base is per worktree, and
 * the order is bottom-up: a parent is moved before anything standing on it.
 */

export type SyncOptions = {
  /** Explicitly rebase and push a review branch onto its PR base. */
  readonly contribute?: boolean;
  /** Which worktree. Omitted means the one you are standing in. */
  readonly target?: string;
  readonly all: boolean;
  /** Undo a conflicted rebase instead of leaving it to resolve by hand. */
  readonly abortOnConflict: boolean;
  /**
   * Publish the rebased commits back to the branch's own remote.
   *
   * On by default because without it the command only does two thirds of what
   * it says: a rebase rewrites the commits, so the branch is left diverged from
   * the remote it tracks and the next sync cannot fix it either.
   */
  readonly push: boolean;
  /**
   * Put a branch that is on no remote yet where `git push` would put it, and
   * track it.
   *
   * Off by default, and reported rather than done: `grove add` without
   * `--push` makes a branch nobody has published, and the first push is the
   * one that makes it somebody else's business too. The command line asks
   * for it explicitly with `--publish`.
   */
  readonly publish: boolean;
};

export type SyncOutcome = {
  readonly path: string;
  /** The worktree's directory relative to the repo root, for messages. */
  readonly dir: string;
  readonly branch?: string;
  readonly kind: "up-to-date" | "fast-forwarded" | "rebased" | "skipped" | "conflicted";
  /** Why it was skipped, or what conflicted. Absent when nothing went wrong. */
  readonly reason?: string;
  readonly conflicts?: readonly string[];
  /**
   * What this worktree was brought up to date against.
   *
   * `origin/main` for an ordinary branch, and the parent branch for one in a
   * stack. Reported because for a stack it is the whole of what the command
   * decided: two worktrees that both say `rebased` did two different things,
   * and this is the field that says which.
   */
  readonly onto?: string;
  /**
   * The branch this one was moved onto, when its recorded parent had gone.
   *
   * Set only when the record changed — a stack whose bottom branch was deleted
   * is one this command silently repaired, and a repair nobody was told about
   * is one they find out about from the rebase it caused.
   */
  readonly reparented?: string;
  /** Absent when there was nothing to publish; false when the remote refused. */
  readonly pushed?: boolean;
  /** Why the push did not happen, when it was meant to. */
  readonly pushRefusal?: string;
  /**
   * The branch is on no remote, and this run was not told to put it there.
   *
   * Carried apart from `pushed`, because it is neither of that field's two
   * answers: nothing was attempted and nothing was refused. The rebase stands,
   * and the branch stays local. This is informational: syncing from the
   * default branch does not require publishing the worktree's branch.
   */
  readonly unpublished?: true;
};

export async function syncWorktrees(
  repo: RepoPaths,
  cwd: string,
  options: SyncOptions,
  reporter: Reporter,
): Promise<readonly SyncOutcome[]> {
  const worktrees = await listWorktrees(repo.gitDir);
  const stack = await readStack(repo.gitDir);
  const targets = chooseTargets(worktrees, repo.root, cwd, options, stack);

  // Asserted here, before the fetch, and not only in `clone`: a repository
  // cloned before grove started setting it has no reflogs, and the push at the
  // end of this needs them. Idempotent, so every later sync is a no-op.
  await enableReflogs(repo.gitDir);

  // One fetch for the whole run: the remote does not change between worktrees,
  // and `--all` over ten of them should not mean ten round trips.
  const step = reporter.step("fetching");
  // Answered rather than thrown — see `fetchRemotes` — but never silently: the
  // trunk this rebases onto is a local ref, so a fetch that did not happen
  // means every worktree below is measured against whatever was last seen. A
  // `✓ fetched` over that is the stale-trunk sync this command exists to
  // prevent, reported as the success it was not.
  const fetch = await fetchRemotes(repo.gitDir);
  if (fetch.fetched) step.succeed("fetched");
  else step.fail("could not fetch — the trunk below is as it was last seen");
  // The one refusal that leaves `fetched` standing — the branches all arrived,
  // so the sync below is sound, but a tag the remote re-cut stays stale here
  // until somebody deletes the local copy, and it is warned about because
  // nothing else ever will: the same refusal comes back on every fetch.
  for (const tag of fetch.staleTags) {
    reporter.warn(
      `local tag ${tag} disagrees with the remote's and was kept — ` +
        `\`git tag -d ${tag}\` and sync again to take theirs`,
    );
  }

  const trunk = await trunkOf(repo.gitDir);
  const outcomes: SyncOutcome[] = [];

  for (const target of targets) {
    // Resolved inside the loop rather than up front, because the answer depends
    // on what the branches above this one have just become: a parent that was
    // rebased two iterations ago is where this one is going.
    const review =
      target.branch === undefined ? undefined : await reviewOf(repo.gitDir, target.branch);
    // Legacy review branches predate metadata but have an explicit PR remote.
    const legacy = /^pr\/(\d+)$/.exec(target.branch ?? "");
    const tracking = legacy ? (await statusOf(target.path)).upstream : undefined;
    const reviewNumber =
      review?.number ??
      (tracking?.startsWith(`pr-${legacy?.[1]}/`) ? Number(legacy?.[1]) : undefined);
    if (reviewNumber !== undefined && !options.contribute) {
      try {
        if (target.rebasing)
          throw new GroveError("refused", "a rebase is already in progress here");
        const result = await checkoutPullRequest(
          repo,
          cwd,
          {
            pr: review?.url ?? String(reviewNumber),
            setup: false,
            trust: false,
            open: false,
          },
          reporter,
        );
        outcomes.push({
          path: target.path,
          dir: worktreeDir(repo.root, target.path),
          branch: target.branch,
          kind: result.updated === "unchanged" ? "up-to-date" : "fast-forwarded",
          onto: result.upstream,
        });
      } catch (error) {
        if (!isGroveError(error)) throw error;
        outcomes.push({
          path: target.path,
          dir: worktreeDir(repo.root, target.path),
          branch: target.branch,
          kind: "skipped",
          reason: `${error.message}${error.hint ? `; ${error.hint}` : ""}`,
        });
      }
      continue;
    }
    const base =
      reviewNumber !== undefined && options.contribute
        ? {
            onto: `${trunk.remote}/${await pullRequestBase(repo, review?.url ?? String(reviewNumber))}`,
          }
        : await baseFor(repo, target.branch, trunk, stack, reporter);

    outcomes.push(await syncOne(target, repo.root, trunk, base, options, reporter));
  }

  return outcomes;
}

/** The base a worktree is rebased onto, and the record that had to be repaired to say so. */
type Base = { readonly onto: string; readonly reparented?: string };

/**
 * What this branch goes back onto — its parent, or the trunk.
 *
 * The chain is walked rather than only its first link, because the branch a
 * stack was standing on is the one most likely to be gone: it is the bottom of
 * the stack, so it merges first, and `prune --delete-branch` clears it away.
 * Walking up finds the nearest ancestor still here, which is where the rest of
 * the stack now belongs.
 *
 * And what it finds is **written back**. A record pointing at a branch that no
 * longer exists is repaired here rather than tolerated, because tolerating it
 * would mean every later command walking the same dead link — and because the
 * repair is the honest description of what this repository now is: two branches
 * where there were three.
 *
 * The trunk is where a chain ends, either by being named in it or by running
 * out of ancestors. It is the one base spelled as a remote-tracking ref, for
 * the reason `syncOne` gives: the trunk is measured against what the remote has
 * and every other branch against what is here.
 */
async function baseFor(
  repo: RepoPaths,
  branch: string | undefined,
  trunk: Trunk,
  stack: Stack,
  reporter: Reporter,
): Promise<Base> {
  const onto = trunk.ref;
  if (branch === undefined) return { onto };

  const chain = ancestry(stack, branch);
  if (chain.length === 0) return { onto };

  for (const [index, parent] of chain.entries()) {
    // The trunk named in a chain is still the trunk, and still measured against
    // the remote — somebody who wrote `--on main` said the ordinary thing in the
    // explicit way, and it must not read as a parent that has gone.
    const reached =
      parent === trunk.branch
        ? onto
        : (await localBranchExists(repo.gitDir, parent))
          ? parent
          : undefined;
    if (reached === undefined) continue;

    // The nearest one is still there, so nothing was repaired and nothing is
    // said: this is the ordinary shape of a stack that is being worked in.
    if (index === 0) return { onto: reached };

    if (reached === onto) await clearParent(repo.gitDir, branch);
    else await setParent(repo.gitDir, branch, reached);
    reporter.info(`${branch} now sits on ${parent} — ${chain[0]} has gone`);

    return { onto: reached, reparented: parent };
  }

  await clearParent(repo.gitDir, branch);
  reporter.info(`${branch} now sits on ${trunk.branch} — ${chain[0]} has gone`);

  return { onto, reparented: trunk.branch };
}

/**
 * Which worktrees this run touches, and in what order.
 *
 * The order is the part a stack adds: a parent is synced before its children,
 * so a child is replayed onto a parent that has already taken the trunk's new
 * commits rather than onto the position the parent is about to leave.
 *
 * Naming one worktree brings its parents with it, which is the one place this
 * command does more than it was literally asked to. The reason is that the
 * smaller reading is not useful: rebasing `feat/login-api` onto a `feat/login`
 * that is itself four commits behind the trunk leaves the branch exactly as
 * stale as it was, and the user would type the two commands in this order
 * anyway. Nothing is hidden by it — every worktree that was touched is in the
 * outcomes, and a parent that was dirty is reported as skipped there.
 */
function chooseTargets(
  worktrees: readonly WorktreeRecord[],
  root: string,
  cwd: string,
  options: SyncOptions,
  stack: Stack,
): readonly WorktreeRecord[] {
  if (options.all) return stackOrder(worktrees, stack, (record) => record.branch);

  const chosen =
    options.target === undefined
      ? worktrees.find((record) => contains(record.path, cwd))
      : resolveTarget(options.target, worktrees, { root, cwd });

  if (!chosen) {
    throw new GroveError("usage", "not inside a worktree, so there is nothing to sync", {
      hint: "name one (`grove sync <branch>`) or pass --all",
    });
  }

  return withAncestors(chosen, worktrees, stack);
}

/** The worktrees under this one in its stack, furthest first, and then it. */
function withAncestors(
  record: WorktreeRecord,
  worktrees: readonly WorktreeRecord[],
  stack: Stack,
): readonly WorktreeRecord[] {
  if (record.branch === undefined) return [record];

  const chain = ancestry(stack, record.branch);
  if (chain.length === 0) return [record];

  const byBranch = new Map(
    worktrees
      .filter((each) => each.branch !== undefined)
      .map((each) => [each.branch as string, each] as const),
  );

  // An ancestor with no worktree is skipped rather than refused: the branch is
  // still a base its children rebase onto, there is just no checkout to move it
  // in. `baseFor` handles the one that is gone altogether.
  const parents = chain
    .map((branch) => byBranch.get(branch))
    .filter((each): each is WorktreeRecord => each !== undefined)
    .toReversed();

  return [...parents, record];
}

async function syncOne(
  record: WorktreeRecord,
  root: string,
  trunk: Trunk,
  base: Base,
  options: SyncOptions,
  reporter: Reporter,
): Promise<SyncOutcome> {
  const name = worktreeDir(root, record.path);
  // Spread rather than assigned, so an outcome that repaired nothing does not
  // carry the key at all: `reparented: undefined` and no `reparented` read the
  // same to a person and differently to `--json` and to a test.
  const repaired = base.reparented === undefined ? {} : { reparented: base.reparented };
  // Every outcome this worktree can end in, built once: the identity of the
  // worktree, plus whatever the kind carries. `repaired` rides on all of them —
  // a repaired record is a change to the repository, and it happened whether or
  // not the worktree holding the branch turned out to be in a state to be moved.
  const outcome = (kind: SyncOutcome["kind"], extra: Partial<SyncOutcome> = {}): SyncOutcome => ({
    path: record.path,
    dir: name,
    branch: record.branch,
    kind,
    ...repaired,
    ...extra,
  });
  const skip = (reason: string, conflicts?: readonly string[]): SyncOutcome =>
    outcome("skipped", { reason, conflicts });
  /** The two facts about the base, put on an outcome `settle` built without them. */
  const stamp = (settled: SyncOutcome): SyncOutcome => ({
    ...settled,
    onto: base.onto,
    ...repaired,
  });

  // Checked before the detached test, because a worktree stopped mid-rebase is
  // detached: walking into someone's half-finished rebase would either fail
  // confusingly or discard the conflict resolution they were part-way through.
  if (record.rebasing) {
    return skip("a rebase is already in progress here");
  }

  if (record.detached || record.branch === undefined) {
    return skip("detached HEAD, so there is no branch to move");
  }

  const status = await statusOf(record.path);
  if (status.dirty) {
    // Checked before anything is run, not after: this is the difference between
    // declining and leaving the worktree half-updated.
    return skip("uncommitted changes", status.changed.slice(0, LISTED));
  }

  const before = await gitOutput(["rev-parse", "HEAD"], { cwd: record.path });
  // `origin/<trunk>` for a branch that hangs off the trunk, and the parent
  // branch — a local one — for a branch in a stack. See `baseFor`.
  const onto = base.onto;
  const step = reporter.step(`syncing ${name}`);

  /**
   * `--fork-point` is what makes this survive a force-push.
   *
   * Without it git replays every commit the branch has that `base` does not —
   * which, after somebody rewrote `base`, includes the pre-rewrite copies of
   * the very commits that replaced them. They land on top of their own
   * replacements and conflict with themselves, and the user is asked to
   * resolve a change against an edit of itself.
   *
   * The reflog of `base` is what tells the two apart. A commit that is only
   * reachable from a position `base` used to be at was published and then
   * withdrawn, so it is dropped; a commit that never was on `base` is the
   * user's own and is carried, exactly as before. When there is no reflog to
   * consult — a fresh clone — git falls back to plain `base`, so nothing is
   * worse than it was.
   */
  const rebaseOnto = async (ref: string): Promise<SyncOutcome | undefined> => {
    const result = await runGit(["rebase", "--fork-point", ref], { cwd: record.path });
    if (result.code === 0) return undefined;

    const conflicts = await conflictedPaths(record.path);
    if (options.abortOnConflict) {
      await runGit(["rebase", "--abort"], { cwd: record.path });
    }
    step.fail(`${name} conflicts with ${ref}`);

    return outcome("conflicted", {
      reason: options.abortOnConflict
        ? `rebase onto ${ref} conflicted and was rolled back`
        : `rebase onto ${ref} conflicted and was left in place to resolve`,
      conflicts,
      onto,
    });
  };

  // Keep the reference checkout fast-forward only; local commits stay in place.
  if (record.branch === trunk.branch) {
    const ff = await runGit(["merge", "--ff-only", onto], { cwd: record.path });
    if (ff.code === 0) return stamp(await settle(record, name, before, step, "fast-forwarded"));

    step.fail(`${name} cannot fast-forward`);
    return skip(
      "the trunk has diverged; move local commits to a feature branch or explicitly rebase it",
    );
  }

  /**
   * Its own remote first, then the trunk.
   *
   * The order is the whole of why this works. Rebasing onto the trunk rewrites
   * the branch's commits, so a colleague's commit sitting on `origin/<branch>`
   * would be left behind — and the force-push at the end would then be refused
   * by `--force-if-includes`, correctly, for trying to drop it. Taking their
   * work first means the rebase replays ours on top of theirs and the push has
   * nothing to destroy.
   */
  // A deleted remote branch can still be named in status after fetch prunes
  // its ref. Treat it like a new local branch for both rebase and publishing.
  const tracked =
    status.upstream === undefined
      ? undefined
      : await runGit(["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"], {
          cwd: record.path,
        });
  const upstream = tracked?.code === 0 ? status.upstream : undefined;
  for (const base of [upstream, onto]) {
    if (base === undefined) continue;

    const conflicted = await rebaseOnto(base);
    if (conflicted) return conflicted;
  }

  const published = await publish(record, name, upstream, options, reporter, {
    force: true,
  });

  return stamp({ ...(await settle(record, name, before, step, "rebased")), ...published });
}

/** The half of a rebase workflow that a rebase does not do. */
type Published = Pick<SyncOutcome, "pushed" | "pushRefusal" | "unpublished">;

/**
 * Puts the rewritten commits back where the branch came from.
 *
 * A rebase changes every commit it moves, so a branch that tracks a remote is
 * diverged from it the moment this command touches it. Leaving it there is what
 * the earlier version of this did, and the result was a screen reporting
 * "up-to-date" over a branch two commits adrift of its own remote with nothing
 * able to close the gap.
 *
 * `--force-with-lease` and `--force-if-includes` together are what make it safe
 * to do without asking: the first refuses if the remote moved since we last
 * looked, the second refuses if what is being overwritten is not already in our
 * history. A refusal says somebody else's work is in the way — but it is still
 * a failure of this command, because the branch is now rewritten locally and
 * published nowhere, and a user who believes otherwise finds out the next time
 * somebody asks them where their work is. So it is recorded on the outcome and
 * turned into the exit code at the end rather than thrown here: the rebase did
 * happen, and with `--all` one contended branch should not bury the news about
 * the other nine.
 */
async function publish(
  record: WorktreeRecord,
  name: string,
  upstream: string | undefined,
  options: SyncOptions,
  reporter: Reporter,
  /**
   * The lease-guarded force is for branches a rebase has just rewritten.
   * The trunk never gets it: after its rebase it is strictly ahead, a plain
   * push suffices, and a force spelling aimed at a trunk is a habit not worth
   * teaching a tool.
   */
  { force }: { readonly force: boolean },
): Promise<Published> {
  if (!options.push) return {};

  /**
   * No upstream is a branch `grove add` made without `--push`, and this is
   * the only command that ever comes back to it. Every sync used to return
   * here silently, so a branch could be rebased any number of times and never
   * reach the remote — and `remove --delete-branch` after that is the whole
   * of the work gone. Asked for, the first push is a plain `-u`: there is
   * nothing on the remote to lease against, and the upstream it sets is what
   * lets the next sync take the ordinary path above.
   */
  const branch = record.branch ?? "HEAD";

  if (upstream === undefined) {
    if (!options.publish) return { unpublished: true };

    const remote = await publishRemote(record.path, branch);
    const step = reporter.step(`publishing ${name}`);
    const result = await runGit(["push", "-u", remote, branch], { cwd: record.path });
    if (result.code !== 0) {
      step.fail(`${name} was not published`);

      return { pushed: false, pushRefusal: `${remote} refused it: ${stderrTail(result.stderr)}` };
    }
    step.succeed(`published ${name} to ${remote}/${branch}`);

    return { pushed: true };
  }

  const target = await pushTarget(record.path, branch, upstream);

  // Nothing to say if the remote already has exactly this.
  const [local, remote] = await Promise.all([
    runGit(["rev-parse", "HEAD"], { cwd: record.path }),
    runGit(["rev-parse", target.tracking], { cwd: record.path }),
  ]);
  if (local.code === 0 && remote.code === 0 && local.stdout.trim() === remote.stdout.trim()) {
    return {};
  }

  const step = reporter.step(`pushing ${name}`);
  const result = await runGit(
    [
      "push",
      ...(force ? forceArgs(target, remote.code === 0 ? remote.stdout.trim() : undefined) : []),
      target.remote,
      target.refspec,
    ],
    { cwd: record.path },
  );

  if (result.code !== 0) {
    step.fail(`${name} was not pushed`);

    // Said once, here, and carried on the outcome: `failureFor` prints it under
    // the error, so warning about it as well would put the same refusal on
    // stderr twice.
    return {
      pushed: false,
      pushRefusal: `${target.tracking} refused it: ${stderrTail(result.stderr)}`,
    };
  }

  step.succeed(`pushed ${name} to ${target.tracking}`);

  return { pushed: true };
}

/** Where a push goes, spelled out: the remote, the refspec, and the ref that mirrors it here. */
export type PushTarget = {
  readonly remote: string;
  /** `<branch>:<ref on the remote>`, always explicit — see `pushTarget`. */
  readonly refspec: string;
  /** The remote-tracking ref the push updates, for the lease and for "already there". */
  readonly tracking: string;
  /**
   * The destination's full name on the remote, when it is not the branch's
   * own — `refs/heads/feat-x` for `pr/42`. Set only then, because it is
   * only then that the lease has to be spelled out; see `forceArgs`.
   */
  readonly renamed?: string;
};

/**
 * The force spelling for a rewritten branch, and the one case it has to
 * change shape.
 *
 * `--force-with-lease --force-if-includes` is the pair everywhere the branch
 * lands on the remote under its own name: the lease refuses if the remote
 * moved since the last fetch, and if-includes refuses if it moved *before*
 * that fetch and the rebase never took the new commits in. The second check
 * is done by walking the reflog of the local branch the destination is named
 * after — and git finds that branch by the destination's name. So for
 * `pr/42` going to `fix/crash` it reads the reflog of a `fix/crash` that
 * does not exist here, and refuses every push with "remote ref updated
 * since checkout". Confirmed against git 2.54: the same push passes the
 * moment the local branch is renamed to match.
 *
 * What if-includes was standing in for is known here exactly. `syncOne`
 * rebased onto the upstream a moment ago, so the upstream's tip as it is
 * now is by construction integrated — and a lease spelled with that sha is
 * the same promise with no reflog to consult: the remote must still be
 * where the rebase took it from. Where the tracking ref cannot be read the
 * lease has nothing to lean on and falls back to the bare form.
 */
function forceArgs(target: PushTarget, integrated: string | undefined): readonly string[] {
  if (target.renamed === undefined) return ["--force-with-lease", "--force-if-includes"];
  if (integrated === undefined) return ["--force-with-lease"];

  return [`--force-with-lease=${target.renamed}:${integrated}`];
}

/**
 * What `git push` would do from this worktree, worked out rather than assumed.
 *
 * The remote is `publishRemote`'s answer. The refspec is the part that used to
 * be wrong: the push was `origin <branch>`, which for `pr/42` — a branch whose
 * upstream is `pr-42/feat-x`, on the fork the pull request came from — made a
 * new `pr/42` on origin and left the pull request exactly as it was. The same
 * `git push` with nothing after it did the right thing all along, because
 * `remote.pr-42.push` says where `pr/42` goes; an explicit refspec on the
 * command line is what stops git consulting it.
 *
 * So the refspec is explicit *and* right. Pushing to the remote the branch
 * tracks, the destination is the branch it tracks there, by the name it has
 * there — `feat-x`, not `pr/42`. Pushing anywhere else — a `pushRemote` or a
 * `pushDefault` that differs from the upstream's remote, git's triangular
 * workflow — the destination is the branch's own name, which is what git's
 * `push.default=simple` does in exactly that arrangement.
 */
export async function pushTarget(
  path: string,
  branch: string,
  upstream: string,
): Promise<PushTarget> {
  const remote = await publishRemote(path, branch);
  const [tracks, merge] = await Promise.all([
    runGit(["config", "--get", `branch.${branch}.remote`], { cwd: path }),
    runGit(["config", "--get", `branch.${branch}.merge`], { cwd: path }),
  ]);
  const upstreamRemote = tracks.code === 0 ? tracks.stdout.trim() : "";
  const mergeRef = merge.code === 0 ? merge.stdout.trim() : "";

  if (remote === upstreamRemote && mergeRef.length > 0) {
    const sameName = mergeRef === `refs/heads/${branch}`;

    return {
      remote,
      refspec: `${branch}:${mergeRef}`,
      tracking: upstream,
      ...(sameName ? {} : { renamed: mergeRef }),
    };
  }

  return { remote, refspec: `${branch}:refs/heads/${branch}`, tracking: `${remote}/${branch}` };
}

/**
 * git says a lot when it refuses a push; this is the line that says why.
 *
 * Not simply the last one. git ends with `error: failed to push some refs`,
 * which only repeats that the push failed — the reason is in the `! [rejected]`
 * line above it, and for a hook it is the only place the hook's own words
 * appear. Preferring that line is what turns "it did not work" into something
 * a person can act on.
 */
function stderrTail(stderr: string): string {
  const lines = toLines(stderr)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("To "));

  // Both spellings: `! [rejected]` for a non-fast-forward, `! [remote rejected]`
  // when the far end's own hook turned it down.
  const rejected = lines.filter((line) => /\[(?:remote )?rejected\]/.test(line));

  return rejected.at(-1) ?? lines.at(-1) ?? "no reason given";
}

/** Whether anything moved, which is the difference between the two good outcomes. */
async function settle(
  record: WorktreeRecord,
  name: string,
  before: string,
  step: { succeed: (text?: string) => void },
  moved: "fast-forwarded" | "rebased",
): Promise<SyncOutcome> {
  const after = await gitOutput(["rev-parse", "HEAD"], { cwd: record.path });

  if (before === after) {
    step.succeed(`${name} already up to date`);

    return { path: record.path, dir: name, branch: record.branch, kind: "up-to-date" };
  }

  step.succeed(`${name} updated`);

  return { path: record.path, dir: name, branch: record.branch, kind: moved };
}

/** The files git stopped on, captured before the rebase is rolled back. */
async function conflictedPaths(path: string): Promise<readonly string[]> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: path });
  if (result.code !== 0) return [];

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/**
 * Turns outcomes into the one exit code the shell sees.
 *
 * A conflict outranks a refused push, which outranks a skip: each is a result
 * that needs a decision, and with `--all` the sharper one would otherwise be
 * hidden behind a worktree that merely had uncommitted changes.
 *
 * A push that was refused is a failure even though the rebase it followed
 * worked. Exiting 0 there is what let `rebased` be printed over a branch the
 * remote never received — the one outcome of this command nobody would think to
 * check for.
 */
export function failureFor(outcomes: readonly SyncOutcome[]): GroveError | undefined {
  const conflicted = outcomes.filter((outcome) => outcome.kind === "conflicted");
  const skipped = outcomes.filter((outcome) => outcome.kind === "skipped");

  if (conflicted.length > 0) {
    return new GroveError("rebase-conflict", describe(conflicted, "conflicted"), {
      hint: "resolve them by hand, or sync after committing",
      details: reasons(conflicted),
    });
  }

  const refused = outcomes.filter((outcome) => outcome.pushed === false);
  if (refused.length > 0) {
    return new GroveError("refused", describe(refused, "not pushed"), {
      hint: "the rebase stands locally; look at what the remote gained, then sync again",
      details: refused.map((outcome) => `${outcome.dir}: ${outcome.pushRefusal ?? ""}`),
    });
  }

  if (skipped.length > 0) {
    return new GroveError("refused", describe(skipped, "skipped"), {
      details: reasons(skipped),
    });
  }

  return undefined;
}

/** Why each of these went the way it did, with any conflicting files indented under it. */
function reasons(outcomes: readonly SyncOutcome[]): string[] {
  return outcomes.flatMap((outcome) => [
    `${outcome.dir}: ${outcome.reason ?? ""}`,
    ...(outcome.conflicts ?? []).map((file) => `  ${file}`),
  ]);
}

function describe(outcomes: readonly SyncOutcome[], what: string): string {
  return outcomes.length === 1 && outcomes[0]
    ? `${outcomes[0].dir} ${what}`
    : `${outcomes.length} worktrees ${what}`;
}
