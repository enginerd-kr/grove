import { addWorktree } from "../../core/commands/add.ts";
import { listWorktreeSummaries, type WorktreeSummary } from "../../core/commands/list.ts";
import { removeWorktree } from "../../core/commands/remove.ts";
import { syncWorktrees } from "../../core/commands/sync.ts";
import type { RepoPaths } from "../../core/layout.ts";
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
  /** Each action answers with the one line worth showing afterwards. */
  readonly add: (branch: string) => Promise<string>;
  readonly remove: (target: string) => Promise<string>;
  /**
   * Every worktree under one folder, removed one at a time.
   *
   * Not a new power — it is `remove` in a loop, and each one faces the same
   * refusals — which is what makes a folder safe to select at all. One that
   * refuses does not stop the rest; the answer says how many did what.
   */
  readonly removeMany: (targets: readonly string[]) => Promise<string>;
  /** `target` omitted means every worktree — the app's `S`. */
  readonly sync: (target?: string) => Promise<string>;
};

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

    add: async (branch) => {
      const result = await addWorktree(repo, { branch, fetch: true, push: false }, reporter);

      if (result.alreadyPresent) return `${result.branch} already has a worktree`;

      return `added ${result.branch} (${result.source})`;
    },

    remove: async (target) => {
      // Never forced and never deleting the branch: the destructive spellings
      // stay on the command line, where they have to be typed out on purpose.
      const result = await removeWorktree(
        repo,
        cwd,
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
          await removeWorktree(repo, cwd, { target, force: false, deleteBranch: false }, reporter);
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

    sync: async (target) => {
      const outcomes = await syncWorktrees(
        repo,
        cwd,
        { target, all: target === undefined, abortOnConflict: true },
        reporter,
      );

      return describeSync(outcomes);
    },
  };
}
