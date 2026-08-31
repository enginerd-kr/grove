import { join } from "node:path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { version } from "../../../package.json";
import type { Drift } from "../../core/branches.ts";
import {
  describeRemote,
  describeTouched,
  describeTrunk,
  noteParts,
  type WorktreeSummary,
} from "../../core/commands/list.ts";
import type { PullRequest } from "../../core/commands/pr.ts";
import { describeDiscard } from "../../core/commands/reset.ts";
import type { Commit } from "../../core/history.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";
import { Banner } from "./Banner.tsx";
import { clip, Files } from "./Files.tsx";
import { Log } from "./Log.tsx";
import { columnWidths, GAP, hintsFor, LOG_ROWS, regionsFor, type Widths } from "./layout.ts";
import { type CommandName, commandsFor, Menu, matching } from "./Menu.tsx";
import { MessageView } from "./MessageView.tsx";
import { type Message, messageFor } from "./message.ts";
import { PullRequests } from "./PullRequests.tsx";
import type { PendingOpen, WorktreeService } from "./service.ts";
import { buildTree, firstChildOf, parentOf, type TreeRow } from "./tree.ts";

/**
 * `grove` with nothing to do: the worktrees, and making, syncing and removing
 * them as keystrokes.
 *
 * The screen owns no git knowledge — it asks a `WorktreeService` — and it runs
 * exactly the commands the command line does, with the destructive spellings
 * (`--force`, `--delete-branch`) left off. Anything this refuses is still
 * reachable by typing it out on the command line, which is the point: a
 * keystroke should not be able to do something you would have had to be
 * explicit about.
 *
 * It fills the terminal. The layout is a column pinned top and bottom — header,
 * list, activity, keys — with the list taking whatever is left, so the keys are
 * always on the last row and nothing reflows as work scrolls past.
 */

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
type Pending =
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

type Mode =
  | { readonly kind: "list" }
  /**
   * `from` is the branch the new one starts on, taken from wherever the cursor
   * was when the prompt opened — not from wherever it is when you press enter.
   * The list re-reads itself on a timer, and a base that could change while you
   * were still typing the name would be a different branch than the one the
   * prompt said.
   */
  /**
   * `caret` is where the next character lands, counted in characters before
   * it: 0 is the start of `value` and `value.length` is the end. Kept beside
   * the text rather than left at the end of it, because a name typed with a
   * typo three characters back is fixed by walking `←` to it, not by deleting
   * everything after it.
   */
  | {
      readonly kind: "add";
      readonly value: string;
      readonly caret: number;
      readonly from?: string;
    }
  | { readonly kind: "confirm"; readonly target: Pending }
  /**
   * The open pull requests, and which one the cursor is on.
   *
   * The rows are read before the popup opens rather than while it is up, for
   * the same reason `add` carries its base: a list that filled itself in under
   * the cursor would move what `enter` is aimed at.
   */
  | { readonly kind: "pick"; readonly prs: readonly PullRequest[]; readonly index: number }
  /**
   * The slash menu: everything the list can do that has no key of its own.
   *
   * The rows are *not* carried here, unlike `pick`'s. They are a constant
   * narrowed by `query`, so holding them would be holding a derivation — and
   * the one thing they depend on besides the query, `logOn`, is changed only
   * by running the command that closes the menu.
   *
   * `index` counts into what the query matched rather than into every command,
   * which is why every edit to `query` puts it back to 0: a cursor left on the
   * fourth row of a list that is now one row long is aimed at nothing.
   */
  | { readonly kind: "menu"; readonly query: string; readonly index: number }
  | { readonly kind: "busy"; readonly label: string };

type Props = {
  readonly service: WorktreeService;
  /** Shown in the header; the repository the keystrokes act on. */
  readonly repoRoot: string;
  /** Progress from the commands the keys start. */
  readonly store: LineStore;
  /** Ctrl-C while busy: stop the git child before the screen goes away. */
  readonly onCancel?: () => void;
  /** How often to refresh, in ms. Defaults to `REFRESH_MS`; tests drive it faster. */
  readonly refreshMs?: number;
  /** How often the message slot turns to its next tip, in ms. Defaults to `TIP_ROTATE_MS`; tests drive it faster. */
  readonly tipRotateMs?: number;
  /**
   * Resolves to a newer released version, or `undefined` for nothing to say.
   * Absent means don't ask at all — the source tree and the tests have no
   * upgrade to be told about.
   */
  readonly checkUpdate?: () => Promise<string | undefined>;
  /**
   * Overrides the live terminal size. Absent everywhere but the tests: a real
   * screen answers this itself, and `ink-testing-library`'s stub stdout never
   * reports a row count, which would otherwise leave the banner's roomy/narrow
   * choice depending on whatever terminal happens to be running the tests.
   */
  readonly columns?: number;
  readonly rows?: number;
};

/**
 * The narrowest and widest the uncommitted-files panel is allowed to be.
 *
 * The panel is drawn in the slack to the right of the list and nowhere else —
 * every column of the list is sized to its own contents, and on most terminals
 * there is a stretch of empty screen past the last one. Taking only that is
 * what makes the panel free: it appears and disappears as the cursor crosses a
 * dirty row, and a panel that took a column's worth of width with it would
 * shear the whole table every time it did.
 *
 * Below the minimum there is no room to say anything a path would survive, so
 * nothing is drawn. Above the maximum the panel would be a third of the screen
 * given over to filenames — the list is what is being worked in, and the empty
 * space to its right is still the list's.
 */
const MIN_FILES_COLS = 26;
const MAX_FILES_COLS = 48;

/**
 * How often the screen brings itself up to date, in the absence of any reason
 * to think it needs to.
 *
 * Both halves are on this one clock. The local half — is anything dirty, has a
 * worktree appeared — is edited from somewhere else, an editor or a build or
 * another terminal, so waiting for `/ refresh` would make the screen a photograph
 * of whenever you last pressed a key. The remote half is counted against
 * `origin/main`, which is a *local* ref: without a fetch of our own, a
 * colleague's push never appears at all.
 *
 * A minute because that is the pace the slower half sets, and running the
 * cheaper half faster buys little: an action you take refreshes immediately,
 * `/ refresh` refreshes on demand, and the rest is other people's work
 * arriving, which does not arrive by the second.
 *
 * The fetch is also why this is quiet. It can fail for reasons that are nobody's
 * fault — a train, a VPN, a key that is not loaded — and a screen that reported
 * each one would be unusable offline while telling you nothing you could act on.
 */
const REFRESH_MS = 60_000;
// Long enough to read a tip and its hint before it turns — this is standing
// advice, not a spinner, so it should not feel like it is racing the reader.
const TIP_ROTATE_MS = 60_000;

/**
 * How far the clock is let drift once nobody is at the keyboard, and how long
 * "nobody" has to have been true before it starts.
 *
 * A fetch every minute is right while someone is driving the screen, but
 * `grove` left open on a desk pays that cost with nobody there to spend it
 * on — the network round trip and the `git` calls behind it are real work,
 * done for an answer nobody is about to read. Idle is measured from the last
 * key, not the last render, so typing a name into `a`'s prompt counts as
 * being there even though nothing in the list moved. Both scale off
 * `refreshMs` rather than standing as fixed minutes, so a test driving the
 * interval in milliseconds exercises the same backoff a real session would,
 * only compressed.
 */
const IDLE_AFTER_FACTOR = 2;
const MAX_REFRESH_FACTOR = 5;

// Standing advice about features that are easy to miss, shown alongside
// whatever the session earned (a release waiting to be upgraded to) so the
// slot always has more than one thing to say and rotation is never a no-op.
const GENERAL_TIPS: readonly Message[] = [
  { kind: "info", text: "tip: h and l don't stop at the first fold — they keep going" },
  { kind: "info", text: "tip: a starts the new branch from wherever the cursor is" },
  { kind: "info", text: "tip: r on a folder removes every worktree under it, after one question" },
  { kind: "info", text: "tip: s syncs the row under the cursor, / sync-all syncs every one" },
  {
    kind: "info",
    text: "tip: / opens everything that has no key of its own — type to narrow it",
  },
  { kind: "info", text: "tip: enter copies the path under the cursor, for a paste elsewhere" },
  { kind: "info", text: "tip: / log puts the commits away when the list wants the rows" },
  {
    kind: "info",
    text: "tip: a row reading merged or gone has nothing left in it — r clears one",
    hint: "or `grove prune` clears every one of them at once",
  },
];

/**
 * The directory a row stands for, as an absolute path.
 *
 * A folder is a real directory on disk, so it answers too. Group keys carry
 * their trailing slash (it is how they are drawn); a path handed around as a
 * location should not.
 */
export function pathOf(row: TreeRow, repoRoot: string): string {
  return row.kind === "group" ? join(repoRoot, row.key.replace(/\/+$/, "")) : row.summary.path;
}

/** A new set with `key` flipped in or out — `Set` is mutable and state is not. */
function toggled(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);

  return next;
}

/** `1 command`, `2 commands` — the label a confirmed action is given. */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Pads or truncates to exactly `width`, so columns stay columns. */
function padTo(text: string, width: number): string {
  return clip(text, width).padEnd(width);
}

/**
 * One drift column, with the two directions coloured apart.
 *
 * They are not the same news. `↑` is work that exists only here — yours to push
 * or to merge, and yours to lose with the laptop, which is why it reads as
 * something you have rather than something wrong. `↓` is work you have not got,
 * and it is the half that bites: against the remote it is what makes "it worked
 * on my machine" true and useless, and against the trunk it is what `sync`
 * exists to close. Colouring them the same would make the row a number to
 * decode rather than a thing to glance at.
 *
 * A zero is dimmed whichever side it is on and whichever column it is in. Green
 * `↑0` down a whole column would be decoration competing with the rows that have
 * actually moved.
 *
 * Both columns are drawn by this, deliberately: `↑2 ↓1` means the same shape of
 * thing under `origin` and under `main`, so it is one convention to learn rather
 * than two.
 */
function DriftCell({
  drift,
  text,
  width,
  selected,
}: {
  readonly drift: Drift | undefined;
  /** What to draw; `drift` is what to colour it by. */
  readonly text: string;
  readonly width: number;
  readonly selected: boolean;
}) {
  // Nothing to point at, and nothing the arrows could honestly say about it —
  // `no upstream`, or the trunk's own blank row.
  if (drift === undefined || text.length > width) {
    return <Text dimColor={!selected}>{padTo(text, width)}</Text>;
  }

  return (
    <>
      <Text color={drift.ahead > 0 ? theme.ok : undefined} dimColor={drift.ahead === 0}>
        {`↑${drift.ahead}`}
      </Text>{" "}
      <Text color={drift.behind > 0 ? theme.warn : undefined} dimColor={drift.behind === 0}>
        {`↓${drift.behind}`}
      </Text>
      {" ".repeat(width - text.length)}
    </>
  );
}

/**
 * The working tree as one glyph, and only the unusual states as words.
 *
 * `clean` was a word the eye had to read on every row to learn nothing — it is
 * true of almost every worktree almost all the time, and the one row that is
 * dirty was the same shape and length as the rest. A filled dot has weight and a
 * hollow one does not, so the row that has changes is now the row that looks
 * different from across the terminal.
 *
 * Shape as well as colour, deliberately. Green-versus-yellow is invisible to a
 * good number of people and to anyone whose terminal theme has opinions, and a
 * status column nobody can read is worse than the word it replaced.
 */
function StateCell({
  summary,
  width,
  selected,
}: {
  readonly summary: WorktreeSummary;
  readonly width: number;
  readonly selected: boolean;
}) {
  const parts = noteParts(summary);
  const notes = parts.length === 0 ? "" : ` ${parts.join(", ")}`;
  const room = Math.max(0, width - 1);

  const dot = (
    <Text color={summary.dirty ? theme.warn : undefined} dimColor={!summary.dirty}>
      {summary.dirty ? "●" : "○"}
    </Text>
  );

  // One padded run when it does not fit, so the ellipsis lands where `padTo`
  // would have put it. A cell being truncated has bigger problems than colour.
  if (notes.length > room) {
    return (
      <>
        {dot}
        <Text dimColor={!selected}>{padTo(notes, room)}</Text>
      </>
    );
  }

  return (
    <>
      {dot}
      {parts.map((part, at) => (
        <Fragment key={part}>
          <Text dimColor={!selected}>{at === 0 ? " " : ", "}</Text>
          {/* The one word in this column that is an invitation rather than a
              warning: `merged` and `gone` both mean the work landed and the
              directory is free to go, which is news of the same kind as a green
              `↑`. Everything beside it stays the colour of an aside. */}
          <Text
            color={part === summary.finished ? theme.ok : undefined}
            dimColor={part !== summary.finished && !selected}
          >
            {part}
          </Text>
        </Fragment>
      ))}
      <Text>{" ".repeat(room - notes.length)}</Text>
    </>
  );
}

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

  // Nothing published is nothing to overwrite. `publish` returns early on
  // exactly this, which is its own problem and not one a prompt can fix.
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
 * The question a destructive key asks, and what it costs to answer `y`.
 *
 * Each one says what survives, since that is what the person is actually
 * weighing: for `r` the directory goes, the branch stays, and any uncommitted
 * changes go with the directory — and for `x` the honest answer is nothing, so
 * it says that rather than something softer.
 *
 * How loudly to ask comes back with the words, because it is the same question
 * asked once: which of the five wordings this is decides the colour too.
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

function Row({
  row,
  selected,
  widths,
  now,
}: {
  readonly row: TreeRow;
  readonly selected: boolean;
  readonly widths: Widths;
  /**
   * The moment the ages are measured from — the same one `columnWidths` sized
   * the column with, handed down rather than read again here. A second
   * `Date.now()` is how the label and the column it sits in came to disagree.
   */
  readonly now: number;
}) {
  const indent = "  ".repeat(row.depth);

  // A folder has no state of its own, and never the `*`: you cannot be standing
  // in a folder, only in one of the worktrees under it.
  if (row.kind === "group") {
    return (
      <Text color={selected ? theme.accent : undefined} dimColor={!selected} wrap="truncate">
        {`${selected ? "▸" : " "}   `}
        {indent}
        {row.label}
        {/* The whole fold indicator, and only when shut. A chevron beside it
            would be saying the same thing twice: a folder with its worktrees
            indented underneath is visibly open, and one with a count and
            nothing under it is visibly not. The count is also what the folded
            rows were telling you, which a chevron is not. */}
        {row.collapsed ? `  ${row.leaves.length}` : ""}
      </Text>
    );
  }

  return (
    <Text color={selected ? theme.accent : undefined} wrap="truncate">
      {`${selected ? "▸" : " "} ${row.summary.current ? "*" : " "} `}
      {padTo(`${indent}${row.label}`, widths.tree)}
      {GAP}
      {widths.remote > 0 ? (
        <>
          <DriftCell
            drift={
              row.summary.upstream === undefined
                ? undefined
                : { ahead: row.summary.ahead, behind: row.summary.behind }
            }
            text={describeRemote(row.summary)}
            width={widths.remote}
            selected={selected}
          />
          {GAP}
        </>
      ) : null}
      {widths.trunk > 0 ? (
        <>
          <DriftCell
            drift={row.summary.trunk}
            text={describeTrunk(row.summary)}
            width={widths.trunk}
            selected={selected}
          />
          {GAP}
        </>
      ) : null}
      <StateCell summary={row.summary} width={widths.state} selected={selected} />
      {/* Right beside the state, without a heading of its own: "when was I
          last here" is an aside about the row, not a column the eye scans
          down — and the state column is content-sized so this sits next to
          the dot rather than at the far edge of the screen. */}
      {widths.touched > 0 ? (
        <>
          {GAP}
          <Text dimColor={!selected}>
            {padTo(describeTouched(row.summary, now), widths.touched)}
          </Text>
        </>
      ) : null}
    </Text>
  );
}

export function App({
  service,
  repoRoot,
  store,
  onCancel,
  refreshMs = REFRESH_MS,
  tipRotateMs = TIP_ROTATE_MS,
  checkUpdate,
  columns: columnsOverride,
  rows: rowsOverride,
}: Props) {
  const { exit } = useApp();
  const live = useWindowSize();
  const columns = columnsOverride ?? live.columns;
  const terminalRows = rowsOverride ?? live.rows;
  const [rows, setRows] = useState<readonly WorktreeSummary[]>([]);
  const [cursorKey, setCursorKey] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode>({ kind: "busy", label: "reading worktrees" });
  const [message, setMessage] = useState<Message | undefined>(undefined);
  // Every tip that earned the slot on this open: the release tip when there is
  // one to give, plus the standing `GENERAL_TIPS`.
  // Never empty once set. See the rotation `useInterval` below.
  const [tipPool, setTipPool] = useState<readonly Message[]>([]);
  /**
   * Whether the commits are drawn under the list at all, and the last read.
   *
   * On by default, because the panel is the answer to the question the columns
   * raise — `↑2` is a number until you can see what the two commits were — and
   * a view you have to know about to turn on is one most people never see.
   * `/ log` puts it away for the session when the rows are wanted for the list
   * instead; it is a view, so it is not remembered anywhere on disk.
   *
   * The read is held with the path it was read for, so the panel can tell its
   * own commits from the ones still on screen from the row before.
   */
  const [logOn, setLogOn] = useState(true);
  const [log, setLog] = useState<
    { readonly path: string; readonly commits: readonly Commit[] } | undefined
  >(undefined);

  const lines = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  // The cursor walks every drawn row, folders included: a folder is what you
  // reach for to act on the branches under it in one go.
  //
  // Folded folders are held by key rather than by row, so a fold survives the
  // list re-reading itself — which it does every two seconds, and which would
  // otherwise flick every folder back open while you were looking at it.
  const tree = useMemo(() => buildTree(rows, collapsed), [rows, collapsed]);

  /**
   * Where the cursor is, remembered as the row rather than as its position.
   *
   * The list re-reads itself on a timer now, so a worktree appearing above the
   * selected one would otherwise slide the selection down a row without anybody
   * touching a key — and the next `r` would be aimed at something else. Held by
   * row, the selection stays on what was selected.
   *
   * The position is still what a vanished row falls back to: when the thing
   * under the cursor is removed, staying near it beats jumping to the top.
   */
  const lastIndex = useRef(0);
  const anchored = tree.findIndex((row) => row.key === cursorKey);
  const index =
    tree.length === 0 ? 0 : anchored >= 0 ? anchored : Math.min(lastIndex.current, tree.length - 1);
  const current = tree[index];

  useEffect(() => {
    lastIndex.current = index;
  }, [index]);
  const selected = current?.kind === "leaf" ? current.summary : undefined;
  // Off the row itself, not read back from the rows below it: a folded folder
  // has none, and `r` there still removes everything it holds.
  const under = current?.kind === "group" ? current.leaves : [];

  /**
   * Cursor movement, computed from the previous cursor rather than from the
   * rendered one.
   *
   * Keys arrive faster than React commits: two presses in the same frame both
   * read the same `index` and the second one goes nowhere, which is exactly
   * what holding the arrow key does. Resolving the pending row to its position
   * inside the updater is what makes the second press count. Clamping lives in
   * here too, so a list that shrank under the cursor cannot leave it past the
   * end.
   */
  const move = useCallback(
    (delta: number) => {
      setCursorKey((previous) => {
        const last = Math.max(0, tree.length - 1);
        const at = tree.findIndex((row) => row.key === previous);
        const from = at >= 0 ? at : Math.min(lastIndex.current, last);

        return tree[Math.min(last, Math.max(0, from + delta))]?.key;
      });
    },
    [tree],
  );

  const refresh = useCallback(async () => {
    setRows(await service.list());
  }, [service]);

  /**
   * Every action, in one shape: clear the last run's lines, block the keys,
   * then say what happened whether it worked or not.
   */
  const perform = useCallback(
    async (label: string, action: () => Promise<string>) => {
      store.clear();
      setMessage(undefined);
      setMode({ kind: "busy", label });

      try {
        setMessage({ kind: "info", text: await action() });
      } catch (error) {
        setMessage(messageFor(error));
      }

      // The list is re-read even after a failure: a refusal often happens
      // half-way, and a stale screen is how someone acts on the wrong row.
      try {
        await refresh();
      } catch {
        // Nothing to add — the failure above is the one worth reporting.
      }
      setMode({ kind: "list" });
    },
    [refresh, store],
  );

  /**
   * Refetch and re-read, and hand the rows back as well as drawing them.
   *
   * `catchUp` below does the same two calls on a timer and keeps nothing; this
   * is for the one caller that has to *decide* on what came back, before the
   * screen is drawn from it.
   */
  const reread = useCallback(async (): Promise<readonly WorktreeSummary[]> => {
    // Reports `false` rather than throwing when it cannot reach the remote, and
    // that is left alone here on purpose: offline, the push at the end of the
    // sync fails too, so no force-push anybody was not asked about reaches
    // anything. What is stale is the question, not the answer.
    await service.fetch();
    const summaries = await service.list();
    setRows(summaries);

    return summaries;
  }, [service]);

  /**
   * `s`: fetch, then decide whether this is a question or just a command.
   *
   * The fetch has to come first and it has to come *before* anything is
   * touched. The numbers on the screen are from the last background tick, and
   * deciding on those would mean the one case that matters — a trunk that moved
   * since — is the case the prompt misses. And a rebase already done is not a
   * decision anybody can still be offered: answering `no` there would leave the
   * branch rewritten and adrift from its remote, which is the exact state
   * `sync` learned to push in order to prevent. So: fetch, ask, then everything
   * or nothing.
   *
   * It costs a second round trip, since `syncWorktrees` fetches again when it
   * runs. That is the price of the question being about what is there now
   * rather than about what was there a minute ago, and a fetch that finds
   * nothing new is the cheap half of this screen's existing timer anyway.
   */
  const beginSync = useCallback(
    async (summary: WorktreeSummary) => {
      store.clear();
      setMessage(undefined);
      setMode({ kind: "busy", label: `checking ${summary.dir}` });

      const run = () => void perform(`syncing ${summary.dir}`, () => service.sync(summary.path));

      let fresh: readonly WorktreeSummary[];
      try {
        fresh = await reread();
      } catch {
        // The read failed, so there is nothing to decide on. `sync` is about to
        // do the same reads and will say what went wrong in its own words.
        return run();
      }

      // Gone from under the cursor between the keystroke and the fetch. Run it
      // anyway: `sync` resolves the target itself and says so properly.
      const now = fresh.find((row) => row.path === summary.path);
      if (now === undefined || !wouldForcePush(now)) return run();

      return setMode({ kind: "confirm", target: { kind: "sync", summary: now } });
    },
    [perform, reread, service, store],
  );

  /** The same question for `/sync-all`, asked once for however many it covers. */
  const beginSyncAll = useCallback(async () => {
    store.clear();
    setMessage(undefined);
    setMode({ kind: "busy", label: "checking every worktree" });

    const run = () => void perform("syncing every worktree", () => service.sync());

    let fresh: readonly WorktreeSummary[];
    try {
      fresh = await reread();
    } catch {
      return run();
    }

    const count = fresh.filter(wouldForcePush).length;
    if (count === 0) return run();

    return setMode({ kind: "confirm", target: { kind: "sync-all", count } });
  }, [perform, reread, service, store]);

  /**
   * `/open`: find out whether the line has been read here, then run it or show
   * it to be read.
   *
   * The command line answers an untrusted `open` with a warning and the flag to
   * pass next time, and it has to: `grove open` in a pipe has nobody to ask, and
   * behaving one way there and another under a terminal would make it two
   * commands. The screen is the surface that does have somebody sitting at it,
   * and what trust wants is exactly that they saw the line before it ran — so
   * here the refusal becomes the question, with the command on the row above the
   * `y`.
   *
   * The read comes first and costs a second look at the file, the way `s`'s does:
   * a prompt is only worth putting up where there is something to agree to, and
   * every repository whose file is already trusted goes straight to opening.
   */
  const beginOpen = useCallback(
    async (summary: WorktreeSummary) => {
      store.clear();
      setMessage(undefined);
      setMode({ kind: "busy", label: `opening ${summary.dir}` });

      const run = () => void perform(`opening ${summary.dir}`, () => service.open(summary.path));

      let waiting: PendingOpen | undefined;
      try {
        waiting = await service.pendingOpen(summary.path);
      } catch {
        // Nothing to decide on. `open` reads the same file a moment from now
        // and says what went wrong in its own words.
        return run();
      }

      if (waiting === undefined) return run();

      return setMode({ kind: "confirm", target: { kind: "trust-open", summary, waiting } });
    },
    [perform, service, store],
  );

  /**
   * What follows an `a` that made a worktree whose file wants to run commands.
   *
   * Run here and not asked about, unlike `grove add` on the command line: that
   * surface has to behave the same in a pipe as under a terminal, so it prints
   * the commands and skips them. The screen just made the worktree itself, so
   * there is nothing left to confirm — the commands run the same way `--trust`
   * would make them.
   *
   * Nothing runs when the file has no commands, which is every ordinary
   * repository.
   */
  const runPendingCommands = useCallback(
    async (branch: string) => {
      try {
        const commands = await service.pendingCommands();
        if (commands.length === 0) return;

        await perform(`running ${plural(commands.length, "command")}`, () =>
          service.trustAndRun(branch),
        );
      } catch {
        // The worktree is made and its files are in place; failing to work out
        // whether there were commands to run is not worth a second red line.
      }
    },
    [service, perform],
  );

  /**
   * `p`: ask the forge what is open, then draw it.
   *
   * Not a `perform`, because there is no outcome to report — the answer is a
   * popup, not a line. What it does borrow is `busy`, which is the loading
   * state and comes for free: keys are dropped while `gh` is out, the refresh
   * tick is paused, and Ctrl-C still reaches the child.
   */
  const openPrs = useCallback(async () => {
    store.clear();
    setMessage(undefined);
    setMode({ kind: "busy", label: "reading pull requests" });

    try {
      const prs = await service.pullRequests();

      // An empty list is an answer, not a popup: one there is nothing to pick
      // from is chrome, so it goes on the message line where the other answers
      // to a keypress go.
      if (prs.length === 0) {
        setMessage({ kind: "info", text: "no open pull requests" });
      } else {
        setMode({ kind: "pick", prs, index: 0 });
        return;
      }
    } catch (error) {
      setMessage(messageFor(error));
    }

    setMode({ kind: "list" });
  }, [service, store]);

  // The first read is not an action: it reports no outcome, and going through
  // `perform` would open the screen with an empty message line.
  useEffect(() => {
    let live = true;

    // Started before the list is awaited so the two overlap, and the screen
    // never waits on the network to become interactive. A rejection is the
    // same as "nothing to say" — a check nobody asked for reports no failure.
    const update =
      checkUpdate === undefined
        ? Promise.resolve(undefined)
        : checkUpdate().then(
            (latest) => latest,
            () => undefined,
          );

    void (async () => {
      try {
        const summaries = await service.list();
        if (live) setRows(summaries);
      } catch (error) {
        if (live) setMessage(messageFor(error));
        return;
      } finally {
        if (live) setMode({ kind: "list" });
      }

      const latest = await update;
      if (!live) return;
      // One slot, several claims: whatever already owns the line — an error,
      // an action's outcome — keeps it. A released upgrade goes first because
      // it is news; the rest is standing advice, so it can wait its turn.
      const tips: Message[] = [];
      if (latest !== undefined) {
        tips.push({
          kind: "info",
          text: `tip: grove v${latest} is out — this is v${version}`,
          hint: "upgrade: brew upgrade grove",
        });
      }
      tips.push(...GENERAL_TIPS);

      setTipPool(tips);
      setMessage((previous) => (previous !== undefined ? previous : tips[0]));
    })();

    return () => {
      live = false;
    };
  }, [service, checkUpdate]);

  // Jumps the slot to a random tip in the pool, never the one just shown —
  // unless something else has claimed the slot since, in which case there is
  // nothing left to rotate and this quietly does nothing. A pool of one
  // ticks forever without changing anything, which costs nothing, so there
  // is no separate case for it.
  useInterval(
    () => {
      setMessage((current) => {
        // biome-ignore lint/complexity/useIndexOf: current may be undefined, which indexOf's Message-typed search element rejects
        const at = tipPool.findIndex((tip) => tip === current);
        if (at === -1 || tipPool.length < 2) return current;

        let next = at;
        while (next === at) next = Math.floor(Math.random() * tipPool.length);
        return tipPool[next];
      });
    },
    tipPool.length > 1 ? tipRotateMs : null,
  );

  const mounted = useRef(true);
  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * One tick: bring the remote refs up to date, then re-read everything.
   *
   * The fetch first, so the read behind it sees what it brought. Its failure is
   * not the read's problem — offline, on a VPN, or with no key loaded, the local
   * half of the screen is still worth refreshing, and swallowing the error here
   * is what keeps that true.
   *
   * Paused while `busy`, where a command already owns the repository and is
   * going to re-read it when it finishes anyway — a `git status` racing a
   * `git worktree add` reports a state that was true for neither.
   *
   * A tick that finds nothing changed costs a React render and no terminal
   * write: Ink compares the frame it produced against the last one and returns
   * early when they match, so an idle screen stays genuinely idle.
   */
  const reading = useRef(false);
  const catchUp = useCallback(async () => {
    // One at a time. A fetch over a slow link, or a `git status` across thirty
    // worktrees, can outlast the interval — and ticks queueing up behind each
    // other would never let go.
    if (reading.current) return;
    reading.current = true;

    try {
      await service.fetch();
      const summaries = await service.list();
      if (mounted.current) setRows(summaries);
    } catch {
      // A read nobody asked for reports nothing. The next tick either succeeds,
      // or the next keystroke runs a command that says why.
    } finally {
      reading.current = false;
    }
  }, [service]);

  // Once on open, because opening the screen is exactly when what it is showing
  // is most likely to be from another day.
  useEffect(() => {
    void catchUp();
  }, [catchUp]);

  // The clock's own delay, separate from `refreshMs` itself: the interval
  // reads this, and each tick is what's allowed to widen it. A ref for the
  // last keystroke rather than state — it moves on every key, and nothing
  // should re-render because of that, only because the delay it feeds
  // eventually changes.
  const lastInputAt = useRef(Date.now());
  const [refreshDelay, setRefreshDelay] = useState(refreshMs);
  const idleAfterMs = refreshMs * IDLE_AFTER_FACTOR;
  const maxRefreshMs = refreshMs * MAX_REFRESH_FACTOR;

  useInterval(
    () => {
      void catchUp();
      setRefreshDelay((current) => {
        const idleFor = Date.now() - lastInputAt.current;
        return idleFor < idleAfterMs ? refreshMs : Math.min(current * 2, maxRefreshMs);
      });
    },
    mode.kind === "busy" ? null : refreshDelay,
  );

  /**
   * The commits for the row under the cursor, re-read whenever it could have
   * changed.
   *
   * Kept out of `list` deliberately. That walks every worktree on the refresh
   * tick, and a `git log` per row would pay for thirty answers to draw one —
   * this asks about the one row that is being looked at, when it starts being
   * looked at.
   *
   * `rows` is a dependency on purpose: the panel shows the selection as the
   * list last saw it, so a refresh that brings in a commit re-reads the panel
   * with it rather than leaving it a minute behind the row above. The lookup
   * through `rows` is also what keeps a vanished worktree from being read.
   *
   * A failure is an empty panel, never a message: nobody pressed a key for
   * this, and a red line about a background read would be the screen
   * interrupting itself.
   */
  const selectedPath = selected?.path;

  useEffect(() => {
    const target = rows.find((summary) => summary.path === selectedPath);
    if (!logOn || target === undefined) return;

    let live = true;

    void service.log(target.path, LOG_ROWS).then(
      (commits) => {
        if (live) setLog({ path: target.path, commits });
      },
      () => {
        if (live) setLog({ path: target.path, commits: [] });
      },
    );

    return () => {
      live = false;
    };
  }, [logOn, selectedPath, rows, service]);

  /**
   * The menu's rows, and what `enter` on one does.
   *
   * The list is rebuilt whenever `logOn` changes because one row's summary
   * reads off it, and narrowed by whatever has been typed. Both are needed in
   * the key handler as well as in the render, which is why they are up here
   * rather than beside the popup.
   */
  const commands = useMemo(() => commandsFor(logOn), [logOn]);
  const narrowed = useCallback((query: string) => matching(commands, query), [commands]);

  /**
   * What a slash command does, which is exactly what its old key did.
   *
   * `/open` is the one thing here that was never a key, and the one aimed at
   * the row rather than at the repository — see `Menu.tsx` for why it is behind
   * the slash anyway. The menu closes first in
   * every branch — `perform`, `openPrs` and `beginOpen` each put the screen into
   * `busy` and take it somewhere else afterwards, and a popup still up
   * underneath that would be a menu waiting for a key nobody can press.
   */
  const runCommand = useCallback(
    (name: CommandName) => {
      setMode({ kind: "list" });

      switch (name) {
        // The one command here aimed at the row under the cursor, which is why
        // it is the only one that can find nothing to act on: a folder is not a
        // worktree, and there is nothing to open about one.
        case "open":
          if (!selected) return;
          return void beginOpen(selected);
        // Aimed at the row for the same reason `open` is, and can find nothing
        // to act on for the same one: a folder is not a worktree, and there is
        // nothing to fill in about one.
        case "setup":
          if (!selected) return;
          return void perform(`filling in ${selected.dir}`, () => service.setup(selected.path));
        case "sync-all":
          return void beginSyncAll();
        case "review":
          return void openPrs();
        case "refresh":
          return void perform("reading worktrees", async () => "refreshed");
        // A view, not an action: nothing is read, nothing is written, and the
        // rows it gives back go straight to the list.
        case "log":
          return setLogOn((on) => !on);
      }
    },
    [perform, beginOpen, beginSyncAll, openPrs, selected, service],
  );

  useInput((input, key) => {
    // Any key is "somebody's here," whatever it does — including the ones
    // handled below that leave the mode untouched. Snapping the delay back
    // now, rather than waiting for the next tick to notice, is what keeps a
    // backed-off clock from making the screen wait minutes for its first
    // refresh after being read again.
    lastInputAt.current = Date.now();
    setRefreshDelay(refreshMs);

    if (key.ctrl && input === "c") {
      // `onCancel` is this key and nothing else, which is what lets `runApp`
      // read it as the interrupt an exit code is owed for. The screen still
      // comes down the ordinary way — alternate buffer released, cursor
      // restored — because a code nobody can see yet is worth nothing.
      onCancel?.();
      exit();

      return;
    }

    if (mode.kind === "busy") return;

    if (mode.kind === "pick") {
      // Arrows and enter, and nothing that types: `Prompt.tsx` was removed on
      // purpose, and a filter box here would quietly bring the text buffer it
      // took with it back.
      if (key.escape || input === "q") return setMode({ kind: "list" });
      if (key.upArrow || input === "k") {
        return setMode((now) =>
          now.kind === "pick" ? { ...now, index: Math.max(0, now.index - 1) } : now,
        );
      }
      if (key.downArrow || input === "j") {
        return setMode((now) =>
          now.kind === "pick"
            ? { ...now, index: Math.min(now.prs.length - 1, now.index + 1) }
            : now,
        );
      }
      if (key.return) {
        const pr = mode.prs[mode.index];
        if (pr === undefined) return setMode({ kind: "list" });

        return void perform(`checking out pull request ${pr.number}`, () =>
          service.checkoutPr(pr.number),
        ).then(() => runPendingCommands(`pr/${pr.number}`));
      }

      return;
    }

    if (mode.kind === "menu") {
      if (key.escape) return setMode({ kind: "list" });
      // Arrows only. `j` and `k` are letters here, and a menu you type into
      // cannot have both — which is the trade `/` makes for being searchable
      // at all, and why the popup advertises `↑↓` and nothing else.
      if (key.upArrow) {
        return setMode((now) =>
          now.kind === "menu" ? { ...now, index: Math.max(0, now.index - 1) } : now,
        );
      }
      if (key.downArrow) {
        return setMode((now) =>
          now.kind === "menu"
            ? {
                ...now,
                index: Math.max(0, Math.min(narrowed(now.query).length - 1, now.index + 1)),
              }
            : now,
        );
      }
      if (key.return) {
        // Clamped the way the marker is, so `enter` cannot be aimed at a row
        // other than the one the popup is pointing at.
        const rows = narrowed(mode.query);
        // Enter on nothing is a cancel, the same as it is in `add`: a query
        // that matched no command is what "never mind" looks like from here.
        const command = rows[Math.min(mode.index, rows.length - 1)];

        return command === undefined ? setMode({ kind: "list" }) : runCommand(command.name);
      }
      if (key.backspace || key.delete) {
        return setMode((now) => {
          if (now.kind !== "menu") return now;
          // Backspacing through the `/` that opened the menu closes it. The
          // slash is on screen at the head of the prompt, and deleting back
          // over it is the same "never mind" as `esc` — stopping dead at an
          // empty query would leave the popup up with nothing left to delete.
          if (now.query.length === 0) return { kind: "list" };

          return { ...now, query: now.query.slice(0, -1), index: 0 };
        });
      }
      // The same printable test the branch prompt uses, so an arrow key cannot
      // type itself into the query.
      if (input.length > 0 && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
        // A second `/` is a slip rather than a filter — no command name holds
        // one — and dropping it is what makes `/` idempotent: pressing it again
        // on an open menu leaves the menu exactly as it was, which is what the
        // PTY tests lean on to know the app is reading keys at all.
        const typed = input.replace(/\//g, "");
        if (typed.length === 0) return;

        return setMode((now) =>
          now.kind !== "menu" ? now : { ...now, query: now.query + typed, index: 0 },
        );
      }

      return;
    }

    if (mode.kind === "add") {
      if (key.escape) return setMode({ kind: "list" });
      /*
       * A paste arrives as one string, and a branch name copied off a terminal
       * line brings the newline that ended it. Ink reads that newline as Enter,
       * so the whole paste used to land on the branch below as a submit of an
       * empty prompt: the name typed nowhere, the popup gone, nothing added.
       *
       * The text goes in and the newline is dropped rather than submitting,
       * because acting on a name that was never on screen is not what pasting
       * asked for — one more keypress is cheap next to creating the wrong
       * branch. An escape sequence has no trailing newline to lose, so it
       * still fails the printable test below rather than typing itself in.
       */
      const pasted = input.replace(/[\r\n]+$/, "");
      if (pasted.length > 0 && pasted !== input && !key.ctrl && !key.meta) {
        if (!/^[\x20-\x7e]+$/.test(pasted)) return;

        return setMode((now) =>
          now.kind !== "add"
            ? now
            : {
                ...now,
                value: now.value.slice(0, now.caret) + pasted + now.value.slice(now.caret),
                caret: now.caret + pasted.length,
              },
        );
      }
      if (key.return) {
        const value = mode.value.trim();
        // Enter on nothing is a cancel, not an error: the empty popup is what
        // "never mind" looks like from inside one.
        if (value.length === 0) return setMode({ kind: "list" });

        // The file's commands run after, not instead: `perform` has drawn what
        // the worktree got, and this runs the half it did not.
        return void perform(`adding ${value}`, () => service.add(value, mode.from)).then(() =>
          runPendingCommands(value),
        );
      }
      /*
       * Every edit below reads the mode it is changing out of the updater, not
       * out of the render this handler was built in — the same guard `move`
       * puts on the cursor, for the same reason. A frame can carry several
       * keys, and `{ ...mode }` would have each of them start from the value
       * as it was before any of them landed, so only the last would survive:
       * typing `ab` quickly gave `b`, and two `←` in one frame moved the caret
       * once. Typing fast is not an edge case, and neither is holding a key.
       *
       * The caret itself moves through the name and stops at either end rather
       * than wrapping: a key that jumps from the start to the end is one you
       * have to look at the screen to use.
       */
      if (key.leftArrow) {
        return setMode((now) =>
          now.kind === "add" ? { ...now, caret: Math.max(0, now.caret - 1) } : now,
        );
      }
      if (key.rightArrow) {
        return setMode((now) =>
          now.kind === "add" ? { ...now, caret: Math.min(now.value.length, now.caret + 1) } : now,
        );
      }
      // Backspace takes the character the caret sits after, wherever that is,
      // and the caret follows it back so the next one takes its neighbour.
      // Both keys mean backspace here: the key labelled Backspace arrives as
      // `delete` on a mac, and a forward delete is not worth losing that to.
      if (key.backspace || key.delete) {
        return setMode((now) => {
          if (now.kind !== "add" || now.caret === 0) return now;

          return {
            ...now,
            value: now.value.slice(0, now.caret - 1) + now.value.slice(now.caret),
            caret: now.caret - 1,
          };
        });
      }
      // Control sequences arrive here as multi-character strings; taking only
      // printable input keeps an arrow key from typing itself into the name.
      if (input.length > 0 && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
        return setMode((now) =>
          now.kind !== "add"
            ? now
            : {
                ...now,
                value: now.value.slice(0, now.caret) + input + now.value.slice(now.caret),
                caret: now.caret + input.length,
              },
        );
      }

      return;
    }

    if (mode.kind === "confirm") {
      const target = mode.target;
      if (input === "y" || input === "Y") {
        if (target.kind === "reset") {
          return void perform(`discarding changes in ${target.summary.dir}`, () =>
            service.reset(target.summary.path),
          );
        }

        // Both sync answers run the command unchanged: the question was about
        // whether to start it, and `syncWorktrees` decides the rest exactly as
        // it does from the command line.
        if (target.kind === "sync") {
          return void perform(`syncing ${target.summary.dir}`, () =>
            service.sync(target.summary.path),
          );
        }

        if (target.kind === "sync-all") {
          return void perform("syncing every worktree", () => service.sync());
        }

        // `y` here records having read the line that was on the row, which is
        // what the trust record is — and it is one record for the whole file,
        // so the same `.grove.toml`'s setup commands run from `a` afterwards
        // without asking again. That is the same thing `grove open --trust`
        // does, reached from the one surface that can show the line first.
        if (target.kind === "trust-open") {
          return void perform(`opening ${target.summary.dir}`, () =>
            service.open(target.summary.path, true),
          );
        }

        // `discardDirty` carries the answer just given: the question counted
        // the uncommitted changes, so the removal may now discard them.
        return void (target.kind === "one"
          ? perform(`removing ${target.summary.dir}`, () =>
              service.remove(target.summary.path, target.summary.dirty),
            )
          : perform(`removing ${target.paths.length} under ${target.label}`, () =>
              service.removeMany(target.paths, target.dirty > 0),
            ));
      }

      return setMode({ kind: "list" });
    }

    if (key.upArrow || input === "k") return move(-1);
    if (key.downArrow || input === "j") return move(1);

    /**
     * Folding and traversing, as one pair of keys that mirror each other.
     *
     * `→` opens a shut folder, and otherwise goes in: to the first row nested
     * under this one. `←` shuts an open folder, and otherwise goes out: to the
     * folder this row is in. From six rows deep, `←←←` is how you get back out
     * and fold up what you came from without counting rows on the way.
     *
     * And when there is nothing to go into or out of, they keep going the way
     * they point rather than stopping dead. Without that they are not a pair:
     * `←` walks out through as many levels as there are while `→` stops at the
     * first worktree it meets, so holding one of them travels and holding the
     * other does nothing. A key that sometimes moves and sometimes does not is
     * a key you have to look at the screen to use.
     */
    if (key.rightArrow || input === "l") {
      if (current?.kind === "group" && current.collapsed) {
        return setCollapsed(toggled(collapsed, current.key));
      }

      const child = current === undefined ? undefined : firstChildOf(tree, current);

      return child === undefined ? move(1) : setCursorKey(child.key);
    }

    if (key.leftArrow || input === "h") {
      if (current?.kind === "group" && !current.collapsed) {
        return setCollapsed(toggled(collapsed, current.key));
      }

      const parent = current === undefined ? undefined : parentOf(tree, current);

      return parent === undefined ? move(-1) : setCursorKey(parent.key);
    }

    /**
     * Enter hands the row's path to whatever is not this screen.
     *
     * The path is wanted somewhere `grove` is not — another terminal tab, an
     * editor's "open folder" box — and the clipboard is the only way across.
     * `a` already ends by copying a `cd` line for the worktree it made; this
     * is the same handoff for one that already exists, on the key that reads
     * as "take this one" rather than a letter to remember — and the path
     * alone, since the box being pasted into is as likely to be an editor's
     * as a shell's.
     *
     * A folder answers too: it is a real directory on disk, and a key that
     * works on some rows and not others is one you have to look at the screen
     * to use.
     *
     * Unlike add's best-effort copy, a failed copy here is the whole outcome,
     * so it reports as a refusal with the tools to install rather than
     * pretending the clipboard changed.
     */
    if (key.return && current !== undefined) {
      return void perform(`copying the path of ${current.label}`, () =>
        service.copyPath(pathOf(current, repoRoot)),
      );
    }

    // On a folder, `a` starts the name where the cursor already is: reaching for
    // it there is how you say "another one of these".
    //
    // And it starts the *branch* where the cursor is too. Branching off the
    // remote's default was right when there was nothing to point at, but the
    // cursor is already pointing at something: the worktree you are looking at
    // when you decide you want another one is almost always the one you want to
    // carry on from, unpushed commits and all. A folder is not a branch and a
    // detached HEAD has no name to pass, so both fall back to the default.
    if (input === "a") {
      const value = current?.kind === "group" ? current.key : "";

      return setMode({ kind: "add", value, caret: value.length, from: selected?.branch });
    }
    if (input === "r" && selected) {
      return setMode({ kind: "confirm", target: { kind: "one", summary: selected } });
    }
    if (input === "r" && current?.kind === "group" && under.length > 0) {
      return setMode({
        kind: "confirm",
        target: {
          kind: "many",
          label: current.key,
          paths: under.map((summary) => summary.path),
          dirty: under.filter((summary) => summary.dirty).length,
        },
      });
    }
    // Only where there is something to throw away. A confirmation for a reset
    // that would do nothing is a prompt that teaches people to answer `y`
    // without reading, which is the last habit this key should be building.
    if (input === "x" && selected?.dirty === true) {
      return setMode({ kind: "confirm", target: { kind: "reset", summary: selected } });
    }
    if (input === "s" && selected) {
      return void beginSync(selected);
    }
    // The one key here not aimed at the row under the cursor, and the reason
    // the others are still few: everything that acts on the repository rather
    // than on a row, and every view the screen has an opinion about, is behind
    // this rather than on a letter of its own. See `Menu.tsx`.
    if (input === "/") return setMode({ kind: "menu", query: "", index: 0 });
    if (input === "q" || key.escape) return exit();
  });

  // The heading of the trunk column, and the branch it compares against. Read
  // off the rows rather than assumed, because `master` and `trunk` are both
  // things people call it.
  const trunkName = rows.find((summary) => summary.isDefault)?.branch ?? "trunk";

  // The confirmation's `y` is spelled for the key that opened it: `discard` and
  // `remove` are not interchangeable words on a prompt that cannot be undone.
  const confirming = mode.kind === "confirm" ? mode.target.kind : undefined;
  const hints = useMemo(
    () => hintsFor(mode.kind, current, confirming),
    [mode.kind, current, confirming],
  );

  // What the menu is showing, which the height budget needs before the popup
  // is drawn and `enter` needed before it was pressed. One derivation, read
  // twice, rather than the mode carrying a copy that could fall behind it.
  const matches = mode.kind === "menu" ? narrowed(mode.query) : [];
  // Clamped here as well as where the arrows move it: `logOn` flipping is not
  // the only way the list under the cursor can change length, and a popup
  // drawing a marker beside no row is worse than one that has moved it.
  const menuIndex =
    mode.kind === "menu" ? Math.min(mode.index, Math.max(0, matches.length - 1)) : 0;

  const labelled = rows.length > 0;
  // Every section's height, worked out in `layout.ts` — see `regionsFor`, which
  // is where the arithmetic and the reasons for it now live.
  const { prBody, menuBody, clipped, activity, logBody, logHeight, listHeight, visible } =
    regionsFor({
      terminalRows,
      columns,
      hints,
      // The one mode the layout cannot take as it stands: it needs the height
      // the popup will be, and that is however many rows the query matched.
      mode: mode.kind === "menu" ? { kind: "menu", matches: matches.length } : mode,
      message,
      lines,
      logOn,
      tree,
      index,
      labelled,
    });

  /**
   * The moment every age on the screen is measured from, read once for the
   * whole render and handed to both the columns and the rows.
   *
   * Read here rather than inside the widths below and again inside each row,
   * which is what it used to be: the memo held whichever `Date.now()` it last
   * ran with — a cursor move does not rebuild `tree`, so a minute later the
   * rows drew `1m ago` into a column still sized for `now`, and the label came
   * out as `1m…` until the next refresh happened to agree with it. One moment
   * per render is what makes the column and the label the same measurement.
   */
  const now = Date.now();

  // Recomputed on every render, because `now` moves on every render and a
  // column sized from a stale one is the truncation above. It is a few dozen
  // string lengths over the rows already in memory, and renders here are
  // keystrokes and a once-a-minute refresh — the memo is kept for the shape of
  // the thing, not for a saving it can still make.
  const widths = useMemo(
    () => columnWidths(tree, columns, trunkName, now),
    [tree, columns, trunkName, now],
  );

  /**
   * The uncommitted-files panel's width, out of the screen the list is not on.
   *
   * Only for a worktree with something uncommitted in it: a clean row has no
   * files to name, and a panel that stayed to say so would be a wide blank
   * gutter beside the rows that are almost all of them. A folder is not a
   * worktree and has no working tree of its own, so it draws none either.
   */
  const filesWidth =
    selected?.dirty === true && widths.slack >= MIN_FILES_COLS
      ? Math.min(widths.slack, MAX_FILES_COLS)
      : 0;

  const rule = "─".repeat(Math.max(0, columns));
  // The banner already says how many there are, so the last row is left with
  // the one thing it cannot answer: where the cursor is in a list too long to
  // show at once. Counted in drawn rows, which is what the cursor walks.
  const position = visible.length < tree.length ? `${index + 1} of ${tree.length}` : "";
  const here = rows.find((summary) => summary.current)?.dir;

  // Only the commits that were read for the row the cursor is on now: a read
  // for the row before is still on its way back, and showing its subjects
  // under this heading would be the panel lying about whose history it is.
  const commits = selected !== undefined && log?.path === selected.path ? log.commits : [];
  const logLabel = selected?.dir ?? current?.label ?? "";
  const logNote =
    current?.kind === "group"
      ? "a folder has no commits of its own — the worktrees under it do"
      : commits.length === 0 && log?.path === selectedPath
        ? "no commits on this branch yet"
        : undefined;

  // The destructive question and its colour, decided together because they are
  // the same answer: see `describePending`.
  const pending = mode.kind === "confirm" ? describePending(mode.target) : undefined;

  return (
    <Box flexDirection="column" width={columns} height={terminalRows} paddingTop={1}>
      <Banner
        repoRoot={repoRoot}
        worktrees={rows.length}
        here={here}
        columns={columns}
        rows={terminalRows}
      />

      {/* The breath between the card and the table under it — counted into
          `headerRows` above, like every other row this column draws. */}
      <Box height={1} />

      {labelled ? (
        <Text dimColor wrap="truncate">
          {"    "}
          {padTo("worktree", widths.tree)}
          {GAP}
          {widths.remote > 0 ? `${padTo("origin", widths.remote)}${GAP}` : ""}
          {/* Named after the branch it compares against, since `master` and
              `trunk` are both things people call it. */}
          {widths.trunk > 0 ? `${padTo(trunkName, widths.trunk)}${GAP}` : ""}
          state
        </Text>
      ) : null}
      <Text dimColor>{rule}</Text>

      {/* The list, and to its right whatever the row under the cursor has
          open. A row rather than a column, and the only one on this screen:
          the files belong beside the worktree they are in, not under a list
          the eye would have to travel back up. */}
      <Box flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          {rows.length === 0 && mode.kind !== "busy" ? (
            <Text dimColor>no worktrees here yet — press a to add one</Text>
          ) : (
            visible.map((row) => (
              <Row key={row.key} row={row} selected={row === current} widths={widths} now={now} />
            ))
          )}
        </Box>

        {filesWidth > 0 && selected !== undefined ? (
          <Files
            label={selected.dir}
            files={selected.files}
            total={selected.changed}
            rows={listHeight}
            width={filesWidth}
          />
        ) : null}
      </Box>

      {/* Under the list and above the activity: it belongs to the row the
          cursor is on, so it sits against the list rather than at the bottom
          of the screen with the things that come and go. */}
      {logHeight > 0 ? (
        <Log label={logLabel} commits={commits} note={logNote} rows={logBody} columns={columns} />
      ) : null}

      {activity.length > 0 ? (
        <>
          <Text dimColor>{rule}</Text>
          <Box flexDirection="column">
            {clipped > 0 ? (
              <Text
                dimColor
                wrap="truncate"
              >{`… ${clipped} earlier line${clipped === 1 ? "" : "s"}`}</Text>
            ) : null}
            {activity.map((line) => (
              <StepRow key={line.id} line={line} truncate />
            ))}
          </Box>
        </>
      ) : null}

      {mode.kind === "pick" ? (
        <PullRequests prs={mode.prs} index={mode.index} rows={prBody} />
      ) : null}

      {mode.kind === "menu" ? (
        <Menu
          commands={matches}
          index={menuIndex}
          query={mode.query}
          total={commands.length}
          rows={menuBody}
        />
      ) : null}

      {mode.kind === "add" ? (
        // The base is on the label rather than left to be inferred: `a` on one
        // row and `a` on another now start the branch in different places, and
        // that is not something to find out from the result line.
        <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text wrap="truncate">
            <Text dimColor>
              {mode.from === undefined ? "new branch " : `new branch from ${mode.from}   `}
            </Text>
            <Text color={theme.accent}>{mode.value.slice(0, mode.caret)}</Text>
            {/* The caret is drawn as the block over the character it sits on,
                which at the end of the name is a space: one shape for "you are
                about to overwrite this" and "you are about to type here". */}
            <Text inverse>{mode.value.slice(mode.caret, mode.caret + 1) || " "}</Text>
            <Text color={theme.accent}>{mode.value.slice(mode.caret + 1)}</Text>
          </Text>
        </Box>
      ) : null}

      {pending !== undefined ? (
        // Red for anything that discards uncommitted changes, amber for a
        // clean removal, because they are not the same risk: a removed clean
        // worktree leaves its branch and its commits behind and `grove add`
        // brings it back, while discarded changes leave nothing at all.
        <Text color={pending.colour} wrap="truncate">
          {pending.text}
        </Text>
      ) : null}

      {mode.kind === "busy" ? (
        // The one row that says a key was heard. `perform` blocks the keyboard
        // while it runs, and two of the actions it wraps — copying a path, and
        // re-reading the list — narrate nothing through the reporter, so
        // without this the screen just stops answering. `·` is the reporter's
        // own mark for a step that has not settled, which is what this is.
        <Text dimColor wrap="truncate">
          {`· ${mode.label}`}
        </Text>
      ) : message !== undefined ? (
        <Box flexDirection="column">
          <MessageView message={message} />
        </Box>
      ) : null}

      {/* A rule rather than a blank row: the keys are chrome, not content, and
          the line is what says so — the same convention that already separates
          the header and the activity from the list. */}
      <Text dimColor>{rule}</Text>
      <StatusBar hints={hints} columns={columns} />

      {/* Last row, under the keys: how far into the list the cursor is. The row
          is kept even when there is nothing to say, so that a list scrolling
          past the bottom does not shift everything above it by a line. */}
      <Box justifyContent="flex-end">
        <Text dimColor>{position}</Text>
      </Box>
    </Box>
  );
}
