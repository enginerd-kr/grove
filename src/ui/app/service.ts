import { relative } from "node:path";
import { fetchRemotes } from "../../core/branches.ts";
import { addWorktree } from "../../core/commands/add.ts";
import { cloneRepo } from "../../core/commands/clone.ts";
import { listWorktreeSummaries, type WorktreeSummary } from "../../core/commands/list.ts";
import { createPr, type PrPreview, prPreview } from "../../core/commands/pr.ts";
import { removeWorktree } from "../../core/commands/remove.ts";
import { describeDiscard, resetWorktree } from "../../core/commands/reset.ts";
import { syncWorktrees } from "../../core/commands/sync.ts";
import { runGit } from "../../core/git.ts";
import { type RepoPaths, repoPaths } from "../../core/layout.ts";
import { describeSetup, failureFor, pendingCommands, trustAndRun } from "../../core/setup.ts";
import { listWorktrees, resolveTarget } from "../../core/worktrees.ts";
import type { Reporter } from "../../report/reporter.ts";

/**
 * What the screen is allowed to do, as four functions.
 *
 * The app talks to this rather than to `core/commands` directly, for the same
 * reason the components take props rather than reading state: a test can hand
 * over a stub and drive the whole interface without a git repository, and the
 * screen cannot quietly grow a capability the command line does not have.
 */
export type WorktreeService = {
  readonly list: () => Promise<readonly WorktreeSummary[]>;
  /**
   * Move where the service stands, without moving any process at all.
   *
   * "Where you are" decides real things — which worktree `*` marks, and above
   * all which worktree `remove` refuses to delete out from under you. The app
   * is a resident process, so its standpoint is just state: enter changes it,
   * every later command reads it, and quitting hands it to the shell function
   * if one is listening. The OS cwd never moves; nothing here uses it.
   */
  readonly moveTo: (path: string) => Promise<string>;
  /** Where the service currently stands. What `q` hands the shell. */
  readonly standpoint: () => string;
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
   * Each action answers with the one line worth showing afterwards.
   *
   * `from` is where a *new* branch starts. It is ignored when the branch already
   * exists locally or on the remote, because those are checked out rather than
   * created — which is why the answer only mentions a base when there was one.
   */
  readonly add: (branch: string, from?: string) => Promise<string>;
  readonly remove: (target: string) => Promise<string>;
  /**
   * Every worktree under one folder, removed one at a time.
   *
   * Not a new power — it is `remove` in a loop, and each one faces the same
   * refusals — which is what makes a folder safe to select at all. One that
   * refuses does not stop the rest; the answer says how many did what.
   */
  readonly removeMany: (targets: readonly string[]) => Promise<string>;
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
  /** `target` omitted means every worktree — the app's `S`. */
  readonly sync: (target?: string) => Promise<string>;
  /**
   * The commands a worktree was just denied, if any.
   *
   * Asked straight after `a`, because that is when the question means
   * something: the files are in place, the commands are not, and what is being
   * agreed to is on the screen. Empty for every repository that has no
   * `.grove.toml` and every one whose file is already trusted.
   */
  readonly pendingCommands: () => Promise<readonly string[]>;
  /**
   * `y` to that question: record the file as read, then run what it says.
   *
   * The same record `grove add --trust` writes, so answering here answers for
   * the command line too — and a pull that changes the file asks again.
   */
  readonly trustAndRun: (branch: string) => Promise<string>;
  /** Title and body a PR would open with — `gh --fill`'s guesses, shown first. */
  readonly prPreview: (target: string) => Promise<PrPreview>;
  /** Push if needed, then `gh pr create`. Answers with the URL. */
  readonly createPr: (target: string, title: string, body: string) => Promise<string>;
  /**
   * Any git command at all, in one worktree.
   *
   * The deliberate hole in everything above. The rest of this interface is four
   * commands with their destructive spellings filed off, which is right for a
   * keystroke and wrong as the whole story — `git stash`, `git bisect`, and
   * `git push --force-with-lease` are not things this tool is going to grow
   * keys for, and being unable to reach them from the screen would just mean
   * quitting it to type them.
   *
   * So: typed out in full, on purpose, prefixed with a `!` that nothing else
   * uses. `args` is an argument list handed straight to `git` with no shell in
   * between, so a `;` in there is an argument and not a second command.
   */
  readonly git: (args: readonly string[], cwd: string) => Promise<string>;
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

/**
 * How much of a `!` command's output reaches the screen.
 *
 * The activity area holds six rows, and a `git log` is thousands — so the
 * cut-off is stated rather than left to look like the whole answer.
 */
const GIT_OUTPUT_LINES = 40;

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
  initialCwd: string,
  reporter: Reporter,
  options: { readonly shellFollows?: boolean } = {},
): WorktreeService {
  // The standpoint. `let`, because moving it is the point: every closure below
  // reads this variable, so one assignment moves the whole service.
  let cwd = initialCwd;

  /**
   * What the removal safety check measures against.
   *
   * The check exists to protect a shell from being stranded in a deleted
   * directory. With the shell function listening, quitting relocates the shell
   * to the standpoint, so the standpoint is the truth. Without it the real
   * shell never moves however far enter wanders, so the launch directory stays
   * the one that must not be deleted.
   */
  const shellCwd = () => (options.shellFollows === true ? cwd : initialCwd);

  return {
    list: () => listWorktreeSummaries(repo, cwd),

    moveTo: async (path) => {
      cwd = path;
      const dir = relative(repo.root, path) || ".";

      return `now in ${dir === "." ? "the repo root" : dir}`;
    },

    standpoint: () => cwd,

    fetch: () => fetchRemotes(repo.gitDir),

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

      if (result.alreadyPresent) return `${result.branch} already has a worktree`;
      // Said back rather than assumed: `from` is only honoured for a branch that
      // did not already exist, and the difference is worth a word.
      if (result.source === "new" && from !== undefined) {
        return `added ${result.branch} from ${from}`;
      }

      return `added ${result.branch} (${result.source})`;
    },

    remove: async (target) => {
      // Never forced and never deleting the branch: the destructive spellings
      // stay on the command line, where they have to be typed out on purpose.
      const result = await removeWorktree(
        repo,
        shellCwd(),
        { target, force: false, deleteBranch: false },
        reporter,
      );

      return result.unpushedWarning ?? `removed ${result.branch ?? result.path}`;
    },

    removeMany: async (targets) => {
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
            shellCwd(),
            { target, force: false, deleteBranch: false },
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

    reset: async (target) => {
      const result = await resetWorktree(repo, cwd, { target, clean: true }, reporter);

      if (result.changed === 0) return `${result.dir} had nothing to discard`;

      const tracked = result.changed - result.untracked;

      return `discarded ${describeDiscard(tracked, result.untracked)} in ${result.dir}`;
    },

    prPreview: (target) => prPreview(repo, cwd, target),

    createPr: async (target, title, body) => {
      const result = await createPr(repo, cwd, { target, title, body }, reporter);

      return result.url;
    },

    git: async (args, at) => {
      const result = await runGit(args, { cwd: at });

      // Reported whichever stream it came on and whatever the exit code: git
      // says useful things on stderr when it succeeds, and the exit code is
      // information rather than a reason to hide the output.
      const output = [result.stdout, result.stderr]
        .join("\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

      for (const line of output.slice(0, GIT_OUTPUT_LINES)) reporter.info(line);

      const trimmed = output.length - GIT_OUTPUT_LINES;
      if (trimmed > 0) reporter.info(`… ${trimmed} more line(s)`);

      if (result.code !== 0) return `git ${args.join(" ")} exited ${result.code}`;

      return output.length === 0 ? `git ${args.join(" ")} — no output` : `git ${args[0] ?? ""} ok`;
    },

    pendingCommands: () => pendingCommands(repo),

    trustAndRun: async (branch) => {
      // Resolved rather than assembled: the directory a branch lives in is
      // whatever `git worktree list` says, and `--dir` and slugging both make
      // guessing it from the name wrong.
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
