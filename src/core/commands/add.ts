import {
  failureFor,
  type Hooks,
  repoHooks,
  runSetup,
  type SetupResult,
  trustAndRun,
} from "../../hooks/index.ts";
import { type Reporter, withStep } from "../../report/reporter.ts";
import {
  defaultBranch,
  localBranchExists,
  pushUpstream,
  REMOTE,
  remoteBranchExists,
  remoteRef,
} from "../branches.ts";
import { GroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { gitSucceeds, runGitOrThrow } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { contains, worktreePathFor } from "../layout.ts";
import { readStack, setParent, wouldCycle } from "../stack.ts";
import { type TakeResult, takeChanges } from "../take.ts";
import { listWorktrees, type WorktreeRecord, worktreeDir } from "../worktrees.ts";

/** `grove add` — give a branch a worktree, creating the branch if it does not exist. */

export type AddOptions = {
  readonly branch: string;
  /** Base for a branch that does not exist yet. Defaults to the remote's default. */
  readonly from?: string;
  /**
   * The branch this one sits on top of — a stack rather than a branch off the trunk.
   *
   * Does two things, and they are two because one of them outlives the command.
   * It is the base the new branch is cut from, which `--from` also does; and it
   * is written down, which is what makes every later `sync` rebase this branch
   * onto that one instead of onto the trunk. See `core/stack.ts`.
   */
  readonly on?: string;
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
  /**
   * Whether `[setup] open` may start the app it names. Defaults to allowed.
   *
   * The one place this tool does look at the terminal, and `cli/run.ts` is
   * where that is decided — see `openWhatItAsksFor` for why `open` gets the
   * exception the rule above denies everything else.
   */
  readonly open?: boolean;
  /**
   * Carry the uncommitted changes of the worktree you are standing in into the
   * new one, leaving that one clean.
   *
   * Off by default, and only ever explicit: this empties a directory somebody
   * is working in, and no amount of "you probably meant this" makes that a
   * thing to do unasked. See `take.ts` for why it is not a `git stash`.
   */
  readonly take: boolean;
};

export type AddResult = {
  readonly path: string;
  /**
   * Relative to the root, `/`-separated — the name the list uses.
   *
   * The directory this command already names in `added <dir>`; reported beside
   * the absolute path so a `--json` reader can line this row up with `grove
   * list` without re-deriving it, the way `path`, `reset` and `rename` do.
   */
  readonly dir: string;
  readonly branch: string;
  /** How the branch was obtained, which is the part worth reporting back. */
  readonly source: "existing" | "remote" | "new";
  readonly upstream?: string;
  /** True when the worktree was already there and nothing was done. */
  readonly alreadyPresent: boolean;
  /** The branch this one was recorded as sitting on, when `--on` said so. */
  readonly parent?: string;
  /** What `grove.copy`/`link`/`setup` did, when anything was configured. */
  readonly setup?: SetupResult;
  /** What `--take` carried across, when it was asked for. */
  readonly took?: TakeResult;
};

export async function addWorktree(
  repo: RepoPaths,
  cwd: string,
  options: AddOptions,
  reporter: Reporter,
): Promise<AddResult> {
  const path = worktreePathFor(repo, options.branch);
  const dir = worktreeDir(repo.root, path);
  const worktrees = await listWorktrees(repo.gitDir);

  // Resolved before anything is created, so `--take` from a directory that is
  // not a worktree fails while the request is still only a request — rather
  // than after a `git worktree add` that nobody would then want.
  const source = options.take ? takeSource(cwd, worktrees) : undefined;
  // And vetted here for the same reason: a `--on` naming a branch this
  // repository has not got is a mistake in the command line, and a refusal that
  // arrives after the directory does is a refusal with a directory behind it.
  const parent =
    options.on === undefined ? undefined : await checkedParent(repo, options.branch, options.on);

  const existing = await checkAlreadyThere(repo.root, options.branch, path, worktrees);
  if (existing) {
    // Asking for a worktree that is there is not an error, and neither is
    // asking for the changes to be moved into it: that half of the request has
    // not happened yet, and it is the half that was the point. The same is true
    // of `--on` — the branch was cut from wherever it was cut from, and where
    // it goes back to is a fact this command can still record.
    if (parent !== undefined) await setParent(repo.gitDir, options.branch, parent);
    if (source === undefined || source === path) return { ...existing, parent };

    return { ...existing, parent, took: await takeChanges(source, path, reporter) };
  }

  refuseNameCollision(repo.root, path, worktrees);
  refuseNesting(repo.root, path, worktrees);
  await refuseExistingDir(repo.root, path);

  // Read here rather than after the worktree exists: a path in `.grove.toml`
  // that nobody can resolve is a mistake in the file, and finding it out
  // afterwards would mean a directory on disk that the same command refused.
  // The file is the trunk's, which is why it can be read before this branch has
  // a worktree at all.
  const hooks = options.setup ? await repoHooks(repo) : undefined;

  // `origin` rather than `source`: where the *branch* comes from, which in a
  // command that can also be moving another worktree's changes across is not
  // the only thing something could be the source of.
  const origin = await resolveSource(repo.gitDir, options, reporter);

  await withStep(
    reporter,
    {
      start: `adding ${options.branch}`,
      done: `added ${dir}`,
      failed: `could not add ${options.branch}`,
    },
    // `git worktree add` creates intermediate directories itself, so a nested
    // path needs no mkdir of ours.
    () => runGitOrThrow(argsFor(origin, options, path), { cwd: repo.gitDir }),
  );

  // Written before the push rather than after it: a remote that refused the
  // branch says nothing about which branch it was cut from, and a stack whose
  // record depended on the network would be one that quietly is not a stack.
  if (parent !== undefined) await setParent(repo.gitDir, options.branch, parent);

  const pushFailure = `created the worktree, but pushing ${options.branch} failed`;
  if (options.push) await pushUpstream(path, options.branch, reporter, pushFailure);

  // Before setup, not after. Setup copies files in and runs commands over what
  // it finds, and `git stash apply` wants a tree it has not already been
  // written into — so the changes being carried are part of the checkout, and
  // the filling-in happens on top of them.
  const took = source === undefined ? undefined : await take(source, path, dir, reporter);

  const setup = hooks
    ? await setUpWorktree(
        repo,
        path,
        options.branch,
        options.trust ? undefined : hooks,
        reporter,
        options.open,
      )
    : undefined;

  return {
    path,
    dir,
    branch: options.branch,
    source: origin.kind,
    upstream: origin.kind === "new" && !options.push ? undefined : remoteRef(options.branch),
    alreadyPresent: false,
    parent,
    setup,
    took,
  };
}

/**
 * The branch `--on` names, once it is one this repository can stack on.
 *
 * Four refusals, and each is a different mistake.
 *
 * `--from` alongside it is refused a layer up, in `args.ts`, because both flags
 * name a base and only one of them is remembered: taking `--on` and ignoring
 * `--from` would start the branch somewhere other than where it was asked to
 * start, and taking `--from` while recording `--on` would record a parent the
 * branch was never cut from — the same lie, one `sync` later.
 *
 * A parent that is not a local branch is refused rather than fetched for. The
 * stack a branch belongs to is a local arrangement of local branches — see
 * `core/stack.ts` — and `origin/feat/login` as a parent would be the branch as
 * the remote last saw it, which is not the thing a child gets rebased onto.
 *
 * A cycle is refused at the one moment it can be: `wouldCycle` asks whether the
 * parent is already somewhere under this branch, which is the whole of what
 * would make the two of them unresolvable afterwards.
 *
 * And the trunk cannot be given a parent. It is the branch everything else is
 * measured against, so a record putting it on top of a feature branch would
 * have `sync` fast-forwarding the trunk onto that branch and pushing the result
 * — which is not a mistake to leave reachable by one flag. Stacking *on* the
 * trunk is fine and is what every unstacked branch already does; the refusal is
 * only about the trunk as the thing being stacked.
 */
async function checkedParent(repo: RepoPaths, branch: string, on: string): Promise<string> {
  if (branch === (await defaultBranch(repo.gitDir))) {
    throw new GroveError("usage", `${branch} is the branch everything else is measured against`, {
      hint: "the trunk is the bottom of every stack; --on goes on the branch above it",
    });
  }

  if (!(await localBranchExists(repo.gitDir, on))) {
    throw new GroveError("usage", `there is no branch named ${JSON.stringify(on)} here`, {
      hint: "a stack sits on a branch this repository has — make the parent first",
    });
  }

  if (wouldCycle(await readStack(repo.gitDir), branch, on)) {
    throw new GroveError("state-conflict", `${on} is already stacked under ${branch}`, {
      hint: "a stack is a line, and this would close it into a loop",
    });
  }

  return on;
}

/**
 * The move, with the one fact its own error cannot know added to it.
 *
 * A take that fails still leaves a worktree behind, because the worktree was
 * made first — and an error that says only "the changes did not apply" reads as
 * though the whole command came to nothing. The exit code stays a failure: what
 * was asked for was a branch *with the work in it*, and half of that is not a
 * success to report quietly.
 */
async function take(
  source: string,
  path: string,
  dir: string,
  reporter: Reporter,
): Promise<TakeResult> {
  try {
    return await takeChanges(source, path, reporter);
  } catch (error) {
    if (error instanceof GroveError) {
      throw new GroveError(error.code, error.message, {
        hint: error.hint,
        details: [...error.details, `the worktree ${dir} was made, and is empty of them`],
        cause: error,
      });
    }

    throw error;
  }
}

/**
 * The worktree `--take` empties, which is the one the shell is standing in.
 *
 * Never guessed at. "The worktree you were last in", or the trunk, or the only
 * dirty one would each be a rule somebody has to learn before they dare use
 * the flag — and the cost of learning it wrong is a directory emptied that
 * nobody meant. Standing somewhere is the one answer that needs no rule.
 */
function takeSource(cwd: string, worktrees: readonly WorktreeRecord[]): string {
  const here = worktrees.find((record) => contains(record.path, cwd));

  if (!here) {
    throw new GroveError("usage", "--take moves the changes of the worktree you are in", {
      hint: "cd into the worktree holding them first",
    });
  }

  return here.path;
}

/**
 * Fills the new worktree in, and warns rather than fails when that goes wrong.
 *
 * The line this draws: `add` was asked for a worktree and there is one, so a
 * `bun install` that failed on a train does not get to report that the worktree
 * is missing — a script reading the exit code would then do the wrong thing
 * with a directory that is sitting right there. It is said out loud instead,
 * along with what the failing command itself said.
 */
async function setUpWorktree(
  repo: RepoPaths,
  path: string,
  branch: string,
  /** Absent when `--trust` was passed: the file is re-read after it is recorded. */
  hooks: Hooks | undefined,
  reporter: Reporter,
  open?: boolean,
): Promise<SetupResult> {
  const target = { path, branch };
  const result =
    hooks === undefined
      ? await trustAndRun(repo, target, reporter, { open })
      : await runSetup(repo, target, { hooks, open }, reporter);
  warnSetupFailure(result, reporter);

  return result;
}

/**
 * The failed command, said as a warning under a worktree that exists.
 *
 * Exported for the one other place that runs `[setup]` on `add`'s behalf: the
 * command line, when it has asked about the commands `add` was denied and been
 * told yes. The worktree is just as much there, so the failure is just as much
 * a warning.
 */
export function warnSetupFailure(result: SetupResult, reporter: Reporter): void {
  const failure = failureFor(result);
  if (!failure) return;

  reporter.warn(`${failure.message}; the worktree is there`);
  // The reason is on `details` — the command's own stderr — and it is the
  // half worth having: `"open ..." exited 1` alone sends somebody off to run
  // the thing by hand to read what it already said. One line each, because a
  // warn takes a line and folding four of them into a sentence reads as one.
  for (const detail of failure.details) reporter.info(`  ${detail}`);
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
    return { path, dir: worktreeDir(root, path), branch, source: "existing", alreadyPresent: true };
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
 *
 * A worktree sitting exactly at `path` is not what this is for — the directory
 * check that follows it says so in plainer words — so only a *different*
 * directory folding onto the same name gets here.
 *
 * Exported for `rename`, which lands a worktree on a name derived by the same
 * `worktreePathFor` and so has to refuse by the same rule. Spelled twice, the
 * two would drift, and the drift would be a `rename` that produces the layout
 * `add` exists to refuse: on Linux both directories are made, and the
 * repository is then one no macOS or Windows checkout can reproduce.
 */
export function refuseNameCollision(
  root: string,
  path: string,
  worktrees: readonly { readonly path: string }[],
  /**
   * The worktree being moved onto `path`, when a command is moving one.
   *
   * `rename` passes it so a worktree may change nothing but its own case;
   * without it `feat/login` → `feat/Login` would be refused for colliding with
   * itself. `add` has none to pass — it is making a worktree, not moving one.
   */
  moving?: string,
): void {
  const wanted = worktreeDir(root, path).toLowerCase();
  const clash = worktrees.find(
    (record) =>
      record.path !== path &&
      record.path !== moving &&
      worktreeDir(root, record.path).toLowerCase() === wanted,
  );

  if (clash) {
    throw new GroveError("state-conflict", `${worktreeDir(root, clash.path)} already exists here`, {
      hint: "directories differing only by case collide on macOS and Windows; pick a name that differs by more",
    });
  }
}

/**
 * Refuses a worktree that would sit inside another, or swallow one.
 *
 * Possible because directories nest: `feat/test` lives under `feat/`. The refs
 * almost rule it out (git forbids `feat` and `feat/test` as a ref D/F
 * conflict), but slugging can close the gap — `feat!` lands on the directory
 * `feat` — and a worktree made by hand or by an older version can sit
 * anywhere. git allows the nesting, and the result is quietly broken: the
 * outer worktree reports the inner one's files as untracked, and `git clean`
 * there deletes someone's work.
 *
 * Exported for `rename`, for the reason `refuseNameCollision` above is: a
 * rename lands a worktree by the same rule `add` places one, and a second
 * spelling of this predicate would be the one that drifts.
 */
export function refuseNesting(
  root: string,
  path: string,
  worktrees: readonly { readonly path: string }[],
  /** The worktree being moved onto `path` — never a clash with itself. */
  moving?: string,
): void {
  const clash = worktrees.find(
    (record) =>
      record.path !== path &&
      record.path !== moving &&
      (contains(record.path, path) || contains(path, record.path)),
  );

  if (clash) {
    throw new GroveError(
      "state-conflict",
      `that would nest with the worktree at ${worktreeDir(root, clash.path)}`,
      {
        hint: "one worktree inside another makes each report the other's files; pick another branch name",
      },
    );
  }
}

/**
 * Refuses a directory already sitting where the worktree would go.
 *
 * Checked apart from the branch and the worktree list, because they can all
 * disagree: a branch name that slugs onto a directory somebody made by hand
 * collides on disk while git sees nothing wrong at all. Exported for `rename`,
 * whose destination is derived by the same rule and lands in the same place.
 */
export async function refuseExistingDir(root: string, path: string): Promise<void> {
  if (!(await pathExists(path))) return;

  throw new GroveError("state-conflict", `${worktreeDir(root, path)} already exists`, {
    hint: "move or delete that directory first",
  });
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

  // `--on` is a base as well as a record — a branch stacked on another one
  // starts at that one's tip, which is the whole of what "on top of" means. It
  // is checked before this point, so by here it is a branch that exists.
  const base = options.on ?? options.from ?? remoteRef(await defaultBranch(bare));
  if (
    !(await gitSucceeds(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { cwd: bare }))
  ) {
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
      return ["worktree", "add", "--track", "-b", options.branch, path, remoteRef(options.branch)];
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
