import type { WorktreeSummary } from "../../core/commands/list.ts";
import { describeDiscard } from "../../core/commands/reset.ts";
import { plural } from "../../core/text.ts";
import { theme } from "../theme.ts";
import type { PendingOpen, WorktreeService } from "./service.ts";

/**
 * What a key is about to do that nobody should be able to do by accident, held
 * until it is confirmed.
 *
 * One worktree, a folder's worth of them, or one worktree's changes, asked the
 * same `y`/`n` every way: the question is the same one — is this the row you
 * meant — and the answer should not depend on how many rows are behind it or on
 * remembering which key you pressed.
 *
 * `trust-open` is the one that is not destructive at all, and it belongs here
 * anyway: what it asks about is a command somebody else wrote arriving on this
 * machine, which is a thing to agree to on purpose even though every part of it
 * can be undone.
 */
export type Pending =
  | { readonly kind: "one"; readonly summary: WorktreeSummary }
  | {
      readonly kind: "many";
      readonly label: string;
      readonly paths: readonly string[];
      /** How many of `paths` are dirty — what makes this question a red one. */
      readonly dirty: number;
    }
  /** `x`: the directory stays, everything uncommitted in it does not. */
  | { readonly kind: "reset"; readonly summary: WorktreeSummary }
  /** `s`, where the sync it starts would rewrite commits the remote already has. */
  | { readonly kind: "sync"; readonly summary: WorktreeSummary }
  /** `s`, where the branch is on no remote and `y` puts it on one. */
  | { readonly kind: "publish"; readonly summary: WorktreeSummary }
  /** `/sync-all`, where `count` of the worktrees would. */
  | { readonly kind: "sync-all"; readonly count: number }
  /**
   * `/open`, where the line that would open it is one nobody here has read.
   *
   * The one question here that grants something instead of taking it away, and
   * the only one whose *text* is the point rather than the count: trust is
   * somebody having read the exact line, so the line is what the prompt says,
   * and pressing `y` is the reading.
   */
  | {
      readonly kind: "trust-open";
      readonly summary: WorktreeSummary;
      readonly waiting: PendingOpen;
    };

/**
 * Whether syncing this worktree would rewrite commits the remote already has.
 *
 * The question `s` has to answer before it acts, and it is answered from the
 * numbers already on the screen rather than by asking git a second time — the
 * caller has just refetched, so these are as fresh as the push itself will be.
 *
 * It mirrors what `syncOne` does, in the same order, and every `false` here is
 * a case that command handles without a force-push. Getting one of them wrong
 * costs a prompt in front of something harmless, or — the direction that
 * matters — no prompt in front of something that is not.
 */
export function wouldForcePush(summary: WorktreeSummary): boolean {
  // The trunk is the one branch `sync` pushes plainly: after its rebase it is
  // strictly ahead, so there is nothing on the remote to overwrite. A detached
  // HEAD has no branch to move at all.
  if (summary.isDefault || summary.branch === undefined) return false;

  // Both of these `sync` skips before it touches anything, so a prompt here
  // would stand in front of a command that is about to decline — which is the
  // prompt that teaches people to answer `y` without reading it.
  if (summary.dirty || summary.rebasing) return false;

  // Nothing published is nothing to overwrite. It is `wouldPublish`'s question
  // instead, and the two are asked in that order.
  if (summary.upstream === undefined) return false;

  // Absent means git could not answer — 2.41 for `%(ahead-behind:)` — and an
  // unanswered question about a force-push is asked rather than assumed away.
  const trunk = summary.trunk;
  if (trunk === undefined) return true;

  // Nothing of its own is nothing to rewrite; and level with both the trunk
  // and its own remote is a rebase that moves no commit anywhere.
  if (trunk.ahead === 0) return false;

  return trunk.behind > 0 || summary.behind > 0;
}

/**
 * Whether syncing this worktree would leave a branch on no remote.
 *
 * The other question `s` asks before it acts. `sync` rebases such a branch and
 * then reports that it is nowhere, because a first push is one the remote has
 * never agreed to and the command line has to be told to make it. The screen
 * can ask, so it does — and `y` is `--publish`.
 *
 * The same states `wouldForcePush` leaves alone are left alone here, for the
 * same reason: `sync` declines a dirty or mid-rebase worktree before it looks
 * at the remote, and the trunk always has one.
 */
export function wouldPublish(summary: WorktreeSummary): boolean {
  if (summary.isDefault || summary.branch === undefined) return false;
  if (summary.dirty || summary.rebasing) return false;

  return summary.upstream === undefined;
}

/**
 * The question a destructive key asks, and what it costs to answer `y`.
 *
 * Each one says what survives, since that is what the person is actually
 * weighing: for `r` the directory goes, the branch stays, and any uncommitted
 * changes go with the directory — and for `x` the honest answer is nothing, so
 * it says that rather than something softer.
 *
 * How loudly to ask comes back with the words, because it is the same question
 * asked once: which of the wordings this is decides the colour too.
 */
export function describePending(target: Pending): {
  readonly text: string;
  readonly colour: string;
} {
  // A dirty worktree is not refused any more — it is asked about instead, and
  // the question has to carry what `y` now costs: the uncommitted changes go
  // with the directory, counted the same way the reset counts them. A removal
  // that discards them is a risk of a different kind from one that only takes a
  // directory back, which is what the danger colour is for.
  if (target.kind === "one") {
    const { dir, dirty, changed, untracked } = target.summary;
    if (dirty) {
      return {
        text: `remove ${dir} and discard ${describeDiscard(changed - untracked, untracked)}? the branch stays`,
        colour: theme.danger,
      };
    }

    return { text: `remove ${dir}? the directory goes, the branch stays`, colour: theme.warn };
  }

  // Both kinds, counted apart. `x` deletes untracked files too, and one of
  // those may be work git has never seen a copy of — folding it into "3
  // changes" would be the sentence someone regrets having skimmed. Always red:
  // discarding changes for good is a risk of a different kind from a removal,
  // which leaves the branch and its commits where they were.
  if (target.kind === "reset") {
    const { dir, changed, untracked } = target.summary;

    return {
      text: `discard ${describeDiscard(changed - untracked, untracked)} in ${dir}? there is no undo`,
      colour: theme.danger,
    };
  }

  // Both spellings of the same question, and the number is the point of it:
  // "3 commits rewritten" is something to weigh, "this force-pushes" is
  // something to wave through. `warn` rather than `danger` because a
  // force-push is recoverable from the reflog and `x` is recoverable from
  // nothing — keeping the two colours apart is what makes either mean
  // anything.
  if (target.kind === "sync") {
    const { dir, trunk, upstream } = target.summary;
    // No count where git is too old to have given one; see `wouldForcePush`.
    const rewritten = trunk === undefined ? "commits" : plural(trunk.ahead, "commit");

    return {
      text: `sync ${dir}? ${rewritten} rewritten and force-pushed to ${upstream}`,
      colour: theme.warn,
    };
  }

  // The one sync question that takes nothing away: a branch nobody has pushed
  // gains a remote copy. Amber all the same, because it is the moment the
  // branch stops being only yours, and the name on the far end is the part
  // worth reading before answering.
  if (target.kind === "publish") {
    const { dir, branch } = target.summary;

    return {
      text: `sync ${dir}? it is on no remote yet, so this pushes it to origin/${branch}`,
      colour: theme.warn,
    };
  }

  if (target.kind === "sync-all") {
    const branches = `${target.count} ${target.count === 1 ? "branch is" : "branches are"}`;

    return {
      text: `sync every worktree? ${branches} force-pushed`,
      colour: theme.warn,
    };
  }

  // The one question here that takes nothing away, and the only one that has to
  // quote something: what `y` agrees to is this exact text, so the text is the
  // prompt. Amber and not red, which is the distinction the two colours are
  // carrying — a line that opens an editor is a thing to look at before it runs,
  // not a thing there is no coming back from.
  if (target.kind === "trust-open") {
    const { command, files } = target.waiting;

    return {
      text: `open ${target.summary.dir} with \`${command}\`? nobody here has read ${files.join(" or ")}`,
      colour: theme.warn,
    };
  }

  const all = `remove all ${target.paths.length} under ${target.label}?`;
  if (target.dirty > 0) {
    return {
      text: `${all} ${target.dirty} ${target.dirty === 1 ? "has" : "have"} uncommitted changes, which go too — the branches stay`,
      colour: theme.danger,
    };
  }

  return { text: `${all} the directories go, the branches stay`, colour: theme.warn };
}

/**
 * What `y` does, beside the words it was asked in.
 *
 * The question and its consequence are decided in the same file so a kind
 * cannot say one thing and do another: `describePending` writes the prompt,
 * and this hands back the label and the call the prompt was about. Adding a
 * kind to `Pending` breaks both, which is the maintenance the screen wants.
 */
export function commitPending(
  target: Pending,
  service: WorktreeService,
): { readonly label: string; readonly run: () => Promise<string> } {
  if (target.kind === "reset") {
    return {
      label: `discarding changes in ${target.summary.dir}`,
      run: () => service.reset(target.summary.path),
    };
  }

  // Both sync answers run the command unchanged: the question was about
  // whether to start it, and `syncWorktrees` decides the rest exactly as it
  // does from the command line.
  if (target.kind === "sync") {
    return {
      label: `syncing ${target.summary.dir}`,
      run: () => service.sync(target.summary.path),
    };
  }
  if (target.kind === "sync-all") {
    return { label: "syncing every worktree", run: () => service.sync() };
  }
  // `y` is the `--publish` the command line would have been given.
  if (target.kind === "publish") {
    return {
      label: `syncing ${target.summary.dir}`,
      run: () => service.sync(target.summary.path, { publish: true }),
    };
  }

  // `y` here records having read the line that was on the row, which is what
  // the trust record is — and it is one record for the whole file, so the same
  // `.grove.toml`'s setup commands run from `a` afterwards without asking
  // again. That is the same thing `grove open --trust` does, reached from the
  // one surface that can show the line first.
  if (target.kind === "trust-open") {
    return {
      label: `opening ${target.summary.dir}`,
      run: () => service.open(target.summary.path, true),
    };
  }

  // `dirty` carries the answer just given: the question counted the
  // uncommitted changes, so the removal may now discard them.
  if (target.kind === "one") {
    return {
      label: `removing ${target.summary.dir}`,
      run: () => service.remove(target.summary.path, target.summary.dirty),
    };
  }

  return {
    label: `removing ${target.paths.length} under ${target.label}`,
    run: () => service.removeMany(target.paths, target.dirty > 0),
  };
}
