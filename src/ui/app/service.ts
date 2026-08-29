import { fetchRemotes } from "../../core/branches.ts";
import { cdCommand, copyToClipboard } from "../../core/clipboard.ts";
import { addWorktree } from "../../core/commands/add.ts";
import { cloneRepo } from "../../core/commands/clone.ts";
import { listWorktreeSummaries, type WorktreeSummary } from "../../core/commands/list.ts";
import { removeWorktree } from "../../core/commands/remove.ts";
import { syncWorktrees } from "../../core/commands/sync.ts";
import { GroveError } from "../../core/errors.ts";
import { type Commit, recentCommits } from "../../core/history.ts";
import { type RepoPaths, repoPaths } from "../../core/layout.ts";
import { describeSetup, failureFor, pendingCommands, trustAndRun } from "../../core/setup.ts";
import { listWorktrees, resolveTarget } from "../../core/worktrees.ts";
import type { Reporter } from "../../report/reporter.ts";

/**
 * What the screen is allowed to do: make a worktree, sync one, remove one.
 *
 * The app talks to this rather than to `core/commands` directly, for the same
 * reason the components take props rather than reading state: a test can hand
 * over a stub and drive the whole interface without a git repository, and the
 * screen cannot quietly grow a capability the command line does not have.
 *
 * Deliberately narrow. Everything else git can do — a stash, a bisect, a
 * force-push, a PR — stays on the command line, where it has to be typed out
 * on purpose rather than reached with one finger.
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
  /** `target` omitted means every worktree — the app's `S`. */
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
function describeSync(outcomes: readonly { kind: string; dir: string }[]): string {
  if (outcomes.length === 0) return "nothing to sync";
  if (outcomes.length === 1) {
    const only = outcomes[0];

    return only === undefined ? "nothing to sync" : `${only.dir} ${only.kind}`;
  }

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
        { branch, from, fetch: true, push: false, setup: true, trust: false },
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
      // Deepest first, so `remove` can prune the folder it empties instead of
      // tripping over a worktree still sitting inside it.
      const ordered = targets.toSorted(
        (a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b),
      );

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

      const plural = removed === 1 ? "" : "s";
      if (refusals.length === 0) return `removed ${removed} worktree${plural}`;

      return `removed ${removed} worktree${plural}, ${refusals.length} refused`;
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

      return describeSync(outcomes);
    },
  };
}
