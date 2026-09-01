import { fetchRemotes } from "../../core/branches.ts";
import { cdCommand, copyToClipboard } from "../../core/clipboard.ts";
import { addWorktree } from "../../core/commands/add.ts";
import { cloneRepo } from "../../core/commands/clone.ts";
import { listWorktreeSummaries, type WorktreeSummary } from "../../core/commands/list.ts";
import { openWorktree } from "../../core/commands/open.ts";
import { checkoutPullRequest, listPullRequests, type PullRequest } from "../../core/commands/pr.ts";
import { removeWorktree } from "../../core/commands/remove.ts";
import { describeDiscard, resetWorktree } from "../../core/commands/reset.ts";
import { setUpWorktrees, failureFor as setupFailureFor } from "../../core/commands/setup.ts";
import {
  type SyncOutcome,
  failureFor as syncFailureFor,
  syncWorktrees,
} from "../../core/commands/sync.ts";
import { GroveError } from "../../core/errors.ts";
import { type Commit, recentCommits } from "../../core/history.ts";
import { deepestFirst, type RepoPaths, repoPaths } from "../../core/layout.ts";
import { plural } from "../../core/text.ts";
import { listWorktrees, resolveTarget } from "../../core/worktrees.ts";
import {
  describeSetup,
  failureFor,
  type PendingOpen,
  pendingCommands,
  pendingOpen,
  trustAndRun,
} from "../../hooks/index.ts";
import type { Reporter } from "../../report/reporter.ts";

/**
 * Passed straight through, so the screen holds the answer without reaching past
 * this module for the shape of it — the same way it takes `WorktreeSummary`.
 */
export type { PendingOpen };

/**
 * What the screen is allowed to do: make a worktree, sync one, remove one, and
 * throw away what one has changed.
 *
 * The app talks to this rather than to `core/commands` directly, for the same
 * reason the components take props rather than reading state: a test can hand
 * over a stub and drive the whole interface without a git repository, and the
 * screen cannot quietly grow a capability the command line does not have.
 *
 * Deliberately narrow. Everything else git can do — a stash, a bisect, a
 * force-push — stays on the command line, where it has to be typed out on
 * purpose rather than reached with one finger.
 *
 * The two pull-request calls are the exception, and they are `grove pr` and
 * nothing more: the same function, the same refusals, the same worktree. What
 * the key buys is the *number*, which is the one part of that command you
 * cannot supply without leaving to go and look it up — and not leaving is the
 * whole argument for a key.
 */
export type WorktreeService = {
  readonly list: () => Promise<readonly WorktreeSummary[]>;
  /**
   * Refresh the remote-tracking refs, so `↑2 ↓1` means what it says.
   *
   * The one call here that reports nothing and refuses nothing: the app runs it
   * on a timer, and a laptop on a train would otherwise fill the screen with
   * network failures nobody asked for. `false` means the numbers are as stale as
   * they were, which is what the previous behaviour was anyway.
   */
  readonly fetch: () => Promise<boolean>;
  /**
   * Put a directory's absolute path on the clipboard, and say so.
   *
   * The one thing here that touches no worktree: `add` already ends by putting
   * the worktree it made on the clipboard, and this is that same handoff for
   * one that already exists — the path is wanted in a terminal this screen is
   * not in, so the clipboard is the only way to hand it over. The bare path
   * rather than `add`'s `cd` line, because a path that already exists is as
   * often headed for an editor's "open folder" box as for a shell. Unlike
   * `add`'s best-effort copy, a failure here is the whole outcome and is
   * thrown.
   */
  readonly copyPath: (path: string) => Promise<string>;
  /**
   * The newest `limit` commits in one worktree, for the panel under the list.
   *
   * The only read here that answers with data rather than with a line to show:
   * the panel draws its own columns, and handing it a formatted string would
   * put the colours and the widths in the wrong place — the screen is what
   * knows how wide the terminal is.
   *
   * Reads nothing else and refuses nothing. It runs whenever the cursor moves,
   * so a worktree whose history cannot be read — a branch with no commits on
   * it yet — is an empty list rather than a red line about a key nobody
   * deliberately pressed.
   */
  readonly log: (path: string, limit: number) => Promise<readonly Commit[]>;
  /**
   * Each action answers with the one line worth showing afterwards.
   *
   * `from` is where a *new* branch starts. It is ignored when the branch already
   * exists locally or on the remote, because those are checked out rather than
   * created — which is why the answer only mentions a base when there was one.
   */
  readonly add: (branch: string, from?: string) => Promise<string>;
  /**
   * `discardDirty` is the answer to a question the app has already asked: the
   * confirmation names the uncommitted changes before anyone presses `y`, so a
   * dirty worktree is removed rather than refused after the fact.
   */
  readonly remove: (target: string, discardDirty?: boolean) => Promise<string>;
  /**
   * Every worktree under one folder, removed one at a time.
   *
   * Not a new power — it is `remove` in a loop, and each one faces the same
   * refusals — which is what makes a folder safe to select at all. One that
   * refuses does not stop the rest; the answer says how many did what.
   */
  readonly removeMany: (targets: readonly string[], discardDirty?: boolean) => Promise<string>;
  /**
   * Everything one worktree has changed, thrown away: `git reset --hard` and
   * `git clean -fd`.
   *
   * Both halves, because "discard" that leaves files behind is a label that
   * lies — and a worktree still marked dirty after you discarded its changes is
   * exactly the confusion the dot was added to prevent. The confirmation is
   * where the care goes: it counts the two kinds separately, so what is about to
   * disappear is on screen before anyone answers.
   *
   * `.gitignore` still protects what it protects — `clean -fd` does not touch
   * ignored files, only ones git was never told about.
   *
   * `--to` is the spelling that stays on the command line. Discarding changes is
   * one thing; discarding commits is another, and only one of them belongs on a
   * key.
   */
  readonly reset: (target: string) => Promise<string>;
  /**
   * Opens a worktree with what `.grove.toml`'s `open` says opens it.
   *
   * `a` runs that line once, on the day the worktree is made. This is the same
   * line on every day after, which is when you actually want it — the worktree
   * is still there and the window is not.
   *
   * `trust` is the answer to the question `pendingOpen` opened, and it is the
   * only way a line out of a file nobody here has read gets to run from this
   * key: the screen put the command on the row, somebody read it and pressed
   * `y`, and that is the whole of what `--trust` means on the command line too.
   * Left off — which is every file already agreed to, and every one with
   * nothing gated — this opens what it is allowed to and says so when it is
   * not.
   */
  readonly open: (target: string, trust?: boolean) => Promise<string>;
  /**
   * The line that would open this worktree, when nobody here has read it yet.
   *
   * `pendingCommands`' counterpart for the one command aimed at a row, and it
   * is here for the reason that one is: the screen can ask about what it can
   * show. Nothing comes back for the ordinary repository — a file already
   * trusted, a line you wrote yourself, a platform this one says nothing about
   * — and `open` is simply run.
   */
  readonly pendingOpen: (target: string) => Promise<PendingOpen | undefined>;
  /**
   * `.grove.toml`'s `[setup]`, run again in a worktree that already has one.
   *
   * The other half of the same argument `open` makes: `a` fills a worktree in
   * on the day it makes one, and the file goes on changing afterwards. Reached
   * for on the row under the cursor rather than over the whole repository,
   * because that is the worktree you are about to work in and the one whose
   * failure you would read.
   *
   * Trusted by pressing it, which `open` is not — and for the reason `a` is:
   * the commands are what filling in *means*, the screen has already asked
   * about them once, and a key that copied files and then declined to install
   * anything would leave a worktree in the state this exists to get it out of.
   */
  readonly setup: (target: string) => Promise<string>;
  /**
   * The open pull requests, for the popup to pick one from.
   *
   * The one read here that leaves the machine for something other than git,
   * and the one that can answer "no such thing" honestly: `gh` missing is a
   * refusal with a URL in it rather than a crash. An empty list is a real
   * answer too, and the screen says so on its message line rather than opening
   * a popup there is nothing to pick from.
   */
  readonly pullRequests: () => Promise<readonly PullRequest[]>;
  /**
   * The same worktree `grove pr <n>` makes, from the row that was picked.
   *
   * Answers with what changed, because re-picking a pull request already open
   * is a normal thing to do: it may have made a worktree, caught an existing
   * one up, or found nothing to do at all.
   */
  readonly checkoutPr: (number: number) => Promise<string>;
  /**
   * `target` omitted means every worktree — the app's `S`.
   *
   * Refuses the same outcomes `grove sync` exits non-zero for. The screen
   * paints an answer in its accent colour and a refusal in its danger one, so
   * a rebase that stopped on a conflict has to arrive as the second: returned,
   * `feat/x conflicted` reads exactly like `feat/x rebased`, and the one thing
   * the outcome was carrying is the one thing that would not reach the eye.
   */
  readonly sync: (target?: string) => Promise<string>;
  /**
   * The commands a worktree was just denied, if any.
   *
   * Checked straight after `a`, because that is when it matters: the files are
   * in place and the commands are not. Empty for every repository that has no
   * `.grove.toml` and every one whose file is already trusted — `add` already
   * ran those.
   */
  readonly pendingCommands: () => Promise<readonly string[]>;
  /**
   * Records the file as read, then runs what it says.
   *
   * The same record `grove add --trust` writes, so running here trusts the
   * command line too — and a pull that changes the file runs it again from
   * here rather than skipping it silently.
   */
  readonly trustAndRun: (branch: string) => Promise<string>;
};

/**
 * What the setup screen is allowed to do, as one function.
 *
 * Separate from `WorktreeService` rather than folded into it, because it is the
 * one action that has no repository to act on — it is what produces one. The
 * paths it answers with are what the screen hands to the app it becomes.
 */
export type SetupService = {
  readonly clone: (url: string) => Promise<{ readonly paths: RepoPaths; readonly branch: string }>;
};

/**
 * `inPlace` decides whether the folder becomes the repository or gains one.
 *
 * Someone who made a directory, stepped into it, and typed `grove` means that
 * directory — nesting a second folder named after the URL inside it would be a
 * surprise. Somewhere with things already in it is the opposite: the repository
 * goes into a folder of its own, which is what `grove clone` does from a
 * command line and what `git clone` does before it.
 */
export function createSetupService(
  folder: string,
  inPlace: boolean,
  reporter: Reporter,
): SetupService {
  return {
    clone: async (url) => {
      const result = await cloneRepo(folder, { url, dir: inPlace ? "." : undefined }, reporter);

      return { paths: repoPaths(result.root), branch: result.branch };
    },
  };
}

/** How a finished sync reads: counts by outcome, worst first. */
function describeSync(outcomes: readonly SyncOutcome[]): string {
  const [only] = outcomes;
  if (only === undefined) return "nothing to sync";
  if (outcomes.length === 1) return `${only.dir} ${only.kind}`;

  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);

  return [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ");
}

export function createWorktreeService(
  repo: RepoPaths,
  cwd: string,
  reporter: Reporter,
): WorktreeService {
  return {
    list: () => listWorktreeSummaries(repo, cwd),

    fetch: () => fetchRemotes(repo.gitDir),

    log: (path, limit) => recentCommits(path, limit),

    copyPath: async (path) => {
      // Thrown rather than swallowed, unlike `add`'s copy: there the worktree
      // was the outcome and the copy a courtesy, here the copy *is* what the
      // key was pressed for, and pretending it happened would leave someone
      // pasting whatever the clipboard held before.
      if (!(await copyToClipboard(path))) {
        throw new GroveError("refused", "nothing was copied — no clipboard tool answered", {
          hint: "install wl-copy, xclip, or xsel",
        });
      }

      // The full path, because that is what the clipboard now holds — the one
      // line that lets the paste be trusted without being tried.
      return `copied ${path}`;
    },

    add: async (branch, from) => {
      // `setup: true` like the command line, because filling the worktree in is
      // part of making one rather than a second thing to ask for — the steps
      // draw themselves in the activity area, and a command that failed says so
      // there without ending the session.
      const result = await addWorktree(
        repo,
        cwd,
        // `take: false`, and not because the screen could not ask: emptying a
        // worktree somebody is working in is not something a single keystroke
        // should be able to do. `grove add <branch> --take` is where that is
        // typed out on purpose.
        // `open: true` needs no test: the screen only draws on a terminal, so
        // there is always one to open into.
        {
          branch,
          from,
          fetch: true,
          push: false,
          setup: true,
          trust: false,
          open: true,
          take: false,
        },
        reporter,
      );

      // The `cd` line rather than the path alone: what follows a new worktree
      // is stepping into it, and a clipboard that arrives ready to run saves
      // the two characters everyone types next. `Enter` still copies the bare
      // path, for the editor boxes that want one.
      //
      // Best-effort and silent on failure: the worktree exists either way, and
      // a screen with no clipboard tool installed has nothing useful to say
      // about it beyond what `add` already reported.
      const copied = await copyToClipboard(cdCommand(result.path));
      const suffix = copied ? ", cd copied" : "";

      if (result.alreadyPresent) return `${result.branch} already has a worktree${suffix}`;
      // Said back rather than assumed: `from` is only honoured for a branch that
      // did not already exist, and the difference is worth a word.
      if (result.source === "new" && from !== undefined) {
        return `added ${result.branch} from ${from}${suffix}`;
      }

      return `added ${result.branch} (${result.source})${suffix}`;
    },

    remove: async (target, discardDirty = false) => {
      // Never forced and never deleting the branch: those spellings stay on the
      // command line, where they have to be typed out on purpose. Discarding
      // dirty changes is the one exception, because the app asked about exactly
      // that — the confirmation counted them before `y` was pressed.
      const result = await removeWorktree(
        repo,
        cwd,
        { target, force: false, deleteBranch: false, discardDirty },
        reporter,
      );

      return result.unpushedWarning ?? `removed ${result.branch ?? result.path}`;
    },

    removeMany: async (targets, discardDirty = false) => {
      const ordered = targets.toSorted(deepestFirst);

      let removed = 0;
      const refusals: unknown[] = [];

      for (const target of ordered) {
        try {
          await removeWorktree(
            repo,
            cwd,
            { target, force: false, deleteBranch: false, discardDirty },
            reporter,
          );
          removed += 1;
        } catch (error) {
          refusals.push(error);
        }
      }

      // Nothing removed means the refusal *is* the outcome, and a red line
      // saying why beats a grey one counting to zero.
      const first = refusals[0];
      if (removed === 0 && first !== undefined) throw first;

      const took = `removed ${plural(removed, "worktree")}`;

      return refusals.length === 0 ? took : `${took}, ${refusals.length} refused`;
    },

    reset: async (target) => {
      // `clean: true` always, because the key says "discard": leaving untracked
      // files behind would answer with a worktree the list still draws a dirty
      // dot beside, which is the one outcome this key must not produce.
      const result = await resetWorktree(repo, cwd, { target, clean: true }, reporter);

      if (result.changed === 0) return `${result.dir} had nothing to discard`;

      const tracked = result.changed - result.untracked;

      return `discarded ${describeDiscard(tracked, result.untracked)} in ${result.dir}`;
    },

    setup: async (target) => {
      const results = await setUpWorktrees(
        repo,
        cwd,
        { target, all: false, trust: true },
        reporter,
      );
      const only = results[0];
      if (only === undefined) return "nothing to set up";

      // Raised rather than returned, the way `trustAndRun` above raises setup's
      // — and it is the same failure, reached by a different key.
      const failure = setupFailureFor(results);
      if (failure) throw failure;

      return `${describeSetup(only)} in ${only.dir}`;
    },

    open: async (target, trust = false) => {
      const result = await openWorktree(repo, cwd, { target, trust, open: true }, reporter);

      // The unanswered path, and the same sentence `grove open` prints: `trust`
      // records the file before the gate reads it back, so a run that carries
      // one never lands here. It is the screen's `/open` before the question.
      if (result.untrusted) return `${result.dir} has an open line nobody has read here`;
      if (result.opened === undefined) return `nothing opens ${result.dir} on this machine`;

      return `opened ${result.dir} with ${result.opened}`;
    },

    pendingOpen: async (target) => {
      // Resolved the way `trustAndRun` resolves its branch, and for the same
      // reason: which worktree a name means is `git worktree list`'s answer,
      // and this has to be asking about the worktree `open` is about to act on.
      const worktrees = await listWorktrees(repo.gitDir);
      const record = resolveTarget(target, worktrees, { root: repo.root, cwd });

      return pendingOpen(repo, { path: record.path, branch: record.branch });
    },

    pullRequests: () => listPullRequests(repo),

    checkoutPr: async (number) => {
      // `setup: true, trust: false` exactly like `add` above, and the app runs
      // the commands afterwards through `runPendingCommands`. Worth being
      // explicit about why that is safe here: a pull request can edit
      // `.grove.toml`, but `repoHooks` reads the *trunk's* copy, never the
      // new worktree's — so what runs is the maintainer's file in both cases,
      // and this key opens no door `a` did not already open.
      const result = await checkoutPullRequest(
        repo,
        cwd,
        { pr: String(number), setup: true, trust: false, open: true },
        reporter,
      );

      const copied = await copyToClipboard(cdCommand(result.path));
      const suffix = copied ? ", cd copied" : "";

      if (result.updated === "unchanged") return `pr/${number} is already up to date${suffix}`;
      if (result.updated === "fast-forwarded") {
        return `pr/${number} caught up with the pull request${suffix}`;
      }

      return `added pr/${number} — ${result.title}${suffix}`;
    },

    pendingCommands: () => pendingCommands(repo),

    trustAndRun: async (branch) => {
      // Resolved rather than assembled: the directory a branch lives in is
      // whatever `git worktree list` says, and slugging makes guessing it
      // from the name wrong.
      const worktrees = await listWorktrees(repo.gitDir);
      const record = resolveTarget(branch, worktrees, { root: repo.root, cwd });
      const result = await trustAndRun(
        repo,
        { path: record.path, branch: record.branch },
        reporter,
        { open: true },
      );

      const failure = failureFor(result);
      if (failure) throw failure;

      return `${describeSetup(result)} in ${result.dir}`;
    },

    sync: async (target) => {
      const outcomes = await syncWorktrees(
        repo,
        cwd,
        { target, all: target === undefined, abortOnConflict: true, push: true },
        reporter,
      );

      // Raised rather than returned, the way `trustAndRun` above raises
      // setup's. `abortOnConflict` has already put the worktree back, so
      // nothing here is half-done — but the screen draws what this returns in
      // the same accent colour it draws `rebased` in, and a sync that stopped
      // on a conflict is not a sync that worked. The command line has always
      // exited 5 for this; the screen was the one surface calling it success.
      //
      // A skip is the exception, and stays a line rather than a refusal: `S`
      // over a repository with one dirty worktree is an ordinary morning, and
      // the screen reports outcomes and stays open. Dropping those from the
      // input rather than reimplementing the test keeps `failureFor` the only
      // place that decides a conflict outranks a refused push.
      const failure = syncFailureFor(outcomes.filter((outcome) => outcome.kind !== "skipped"));
      if (failure) throw failure;

      return describeSync(outcomes);
    },
  };
}
