import {
  describeNotes,
  describeRemote,
  describeTouched,
  describeTrunk,
} from "../../core/commands/list.ts";
import type { Line } from "../../report/lines.ts";
import { type Hint, statusBarRows } from "../components/StatusBar.tsx";
import { bannerRows } from "./Banner.tsx";
import { baseRows } from "./Bases.tsx";
import { menuRows } from "./Menu.tsx";
import { type Message, messageRows } from "./message.ts";
import { pullRequestRows } from "./PullRequests.tsx";
import type { Pending } from "./pending.ts";
import { leavesOf, type TreeRow } from "./tree.ts";
import { windowOf } from "./window.ts";

/**
 * The arithmetic the screen is laid out by, with nothing on screen in it.
 *
 * `App` decides *what* to draw; this decides *how much room* each part gets and
 * how wide each column is. Both are pure functions of plain numbers, rows and
 * strings — which is the only reason either can be checked at a terminal size
 * nobody has, and the reason the two defects that lived here (a column sized
 * against a clock that had stopped, a budget nobody could add up) were
 * invisible until they were pulled out of the component.
 */

/**
 * The most progress worth keeping on screen; older lines scroll out of it.
 *
 * Six is right for what a command reports about itself — a spinner, a clone
 * percentage, a line per step — where the last thing said is the interesting
 * one and the rest is history.
 */
const ACTIVITY_ROWS = 6;

/**
 * How many commits the panel under the list shows, and asks git for.
 *
 * One number for both, so the read is exactly as big as the drawing: asking
 * for more would be a `git log` walking history nobody can see, and asking for
 * fewer would leave blank rows on a screen with the space for them.
 *
 * Five is what "what have I been doing here" takes to answer. Past that it is a
 * history to page through, and paging through it is what `git log` in the
 * worktree is for — the panel exists so that the usual question does not need
 * another terminal, not so that this one grows a pager.
 */
export const LOG_ROWS = 5;

/**
 * Below this many commits the panel is not drawn at all.
 *
 * A heading and a single subject is a rule with a commit stuck to it: it costs
 * two of the few rows a short terminal has and answers nothing the list did not
 * already say. Handing them back keeps the list readable, and `L` is not what
 * anyone should have to press to get out of that.
 */
const LOG_MIN_ROWS = 2;

/**
 * The most pull requests the popup draws at once.
 *
 * Eight is where a list stops being something you glance down and starts being
 * something you page through, and the popup takes its rows out of the list
 * underneath it. A repository with more open than that is one where the number
 * is worth typing: `grove pr <n>` takes it directly, and the window scrolls
 * either way.
 */
const PR_ROWS = 8;

/**
 * The most bases the rebase popup draws at once.
 *
 * The pull-request popup's number, for the pull-request popup's reason: the
 * list is as long as the repository has worktrees, which is not ours to pin,
 * and past eight it scrolls. `--onto <ref>` on the command line is where a
 * name gets typed when the list is longer than a glance.
 */
const BASE_ROWS = 8;

/**
 * The most commands the slash menu draws at once.
 *
 * The same as the pull-request popup's eight now, but for a different reason:
 * how many pull requests are open is the forge's business, while how many
 * commands there are is ours. It is pinned to exactly how many there are, so
 * the menu is a list you read and never one you scroll — and adding a command
 * means raising this on purpose, having decided the list is still short enough
 * to be read whole. `rebase` made it eight, which is the edge of it; the next
 * one is an argument for fewer commands rather than a taller popup.
 */
const MENU_ROWS = 8;

/**
 * The rows the list keeps whatever else wants them.
 *
 * The list is the thing being worked in. A screen that answers "what did that
 * command say" by hiding "which worktree am I on" has moved the problem rather
 * than solved it.
 */
const MIN_LIST_ROWS = 3;

/**
 * The space between the list's columns, one constant so the header and every
 * row agree on it — a gap that drifted between them would shear the columns.
 */
export const GAP = "    ";

export type Widths = {
  readonly tree: number;
  readonly remote: number;
  readonly trunk: number;
  readonly touched: number;
  readonly state: number;
  readonly slack: number;
};

/**
 * As much of the mode as the height budget depends on.
 *
 * Structural rather than the screen's own `Mode`, so the arithmetic can be
 * driven from a test without a state machine behind it — every variant the
 * component has is assignable to one of these.
 */
export type LayoutMode =
  | { readonly kind: "list" }
  | { readonly kind: "busy" }
  | { readonly kind: "add" }
  | { readonly kind: "confirm" }
  | { readonly kind: "pick"; readonly prs: { readonly length: number } }
  /** `/rebase`'s popup: the bases offered for the row under the cursor. */
  | { readonly kind: "onto"; readonly choices: { readonly length: number } }
  /** `matches` is what the query narrowed to, which is what the popup draws. */
  | { readonly kind: "menu"; readonly matches: number };

/** Which of them it is, which is all the key bar needs to know. */
export type ModeKind = LayoutMode["kind"];

/**
 * Which destructive key a confirmation is standing in front of.
 *
 * The screen's own `Pending["kind"]`, not a re-spelling: `pending.ts` is as
 * pure as this file is, so naming its kinds does not pull a component into the
 * arithmetic — and `CONFIRM_WORDS` below now breaks the moment a kind is added
 * without deciding what its two keys say.
 */
export type ConfirmKind = Pending["kind"];

// The keys each popup answers to. A mode that takes the keyboard says so here
// rather than in `hintsFor` below, where only the list's own hints are decided.
// `confirm` is the exception and is not in the table: it answers to the same two
// keys either way, but `y` is spelled for the key that opened it.
const MODE_HINTS: Partial<Record<ModeKind, readonly Hint[]>> = {
  busy: [{ keys: "ctrl+c", action: "cancel" }],
  add: [
    { keys: "enter", action: "add" },
    { keys: "esc", action: "cancel" },
  ],
  pick: [
    { keys: "↑↓", action: "move" },
    { keys: "enter", action: "check out" },
    { keys: "esc", action: "cancel" },
  ],
  onto: [
    { keys: "↑↓", action: "move" },
    { keys: "enter", action: "rebase" },
    { keys: "esc", action: "cancel" },
  ],
  // No `type to narrow` hint: the prompt is on screen with a caret blinking in
  // it, which says the same thing in the place you are already looking.
  menu: [
    { keys: "↑↓", action: "move" },
    { keys: "enter", action: "run" },
    { keys: "esc", action: "cancel" },
  ],
};

/**
 * What `y` and `n` do, said in the words the question used.
 *
 * A prompt that asks about discarding changes and offers `y remove` is two
 * answers to one question. `n` is spelled the same way: it is `keep` where
 * something was about to be taken away, and `leave it` where nothing was —
 * a sync that does not happen leaves the branch where it stands, and an open
 * line nobody trusted stays a line in a file.
 *
 * A record rather than a chain of ternaries, so a new confirmation cannot be
 * added without deciding what its two keys say.
 */
const CONFIRM_WORDS: Record<ConfirmKind, readonly Hint[]> = {
  one: [
    { keys: "y", action: "remove" },
    { keys: "n", action: "keep" },
  ],
  many: [
    { keys: "y", action: "remove" },
    { keys: "n", action: "keep" },
  ],
  reset: [
    { keys: "y", action: "discard" },
    { keys: "n", action: "keep" },
  ],
  sync: [
    { keys: "y", action: "sync" },
    { keys: "n", action: "leave it" },
  ],
  "sync-all": [
    { keys: "y", action: "sync" },
    { keys: "n", action: "leave it" },
  ],
  prune: [
    { keys: "y", action: "remove" },
    { keys: "n", action: "keep" },
  ],
  // `y` is the push, since that is the half of the sync the question is about.
  publish: [
    { keys: "y", action: "push" },
    { keys: "n", action: "leave it" },
  ],
  // The one `y` that is an answer to "have you read this" rather than to "shall
  // I", so it says both halves: what is being agreed to and what happens next.
  "trust-open": [
    { keys: "y", action: "trust and open" },
    { keys: "n", action: "leave it" },
  ],
};

/**
 * What the key bar says, given the mode and the row under the cursor.
 *
 * Deliberately not derived from the key handler, and not a table the handler
 * reads either. The bar under-reports in four places and each one is right:
 * `←→` is offered on a folder though a leaf traverses too, `h`/`j`/`k`/`l` are
 * never advertised, `esc` quits the list and appears in no list here, and
 * `confirm` says `n keep` when in fact any key but `y` keeps. Joining the two
 * would make "which spelling to advertise" a field of the dispatcher, which is
 * presentation living in the wrong place.
 *
 * What it does *not* under-report is a whole command. Everything the list can
 * do is either a key here or a row in `/`, and nothing is both — see
 * `Menu.tsx` for where the line falls and why. That is also what stops this
 * list growing: it is the keys aimed at the row under the cursor, and there
 * are only so many things you can do to a worktree.
 */
export function hintsFor(
  modeKind: ModeKind,
  current: TreeRow | undefined,
  confirming?: ConfirmKind,
): readonly Hint[] {
  if (modeKind === "confirm") {
    return CONFIRM_WORDS[confirming ?? "one"];
  }

  const popup = MODE_HINTS[modeKind];
  if (popup !== undefined) return popup;

  // A folder offers what a folder can do. Leaving `s` on it to mean what it
  // means on a worktree would be a menu that lies. An empty tree has no row
  // under the cursor at all, and takes the worktree list.
  const group = current?.kind === "group" ? current : undefined;

  return [
    { keys: "↑↓", action: "move" },
    ...(group !== undefined ? [{ keys: "←→", action: group.collapsed ? "open" : "fold" }] : []),
    { keys: "enter", action: "copy path" },
    { keys: "a", action: group !== undefined ? `add under ${group.label}` : "add" },
    { keys: "r", action: group !== undefined ? `remove all ${group.leaves.length}` : "remove" },
    // `x` stays a key rather than moving behind `/` with the others: it acts on
    // the row under the cursor, which is the whole of what the bar is for. And
    // only where it would do something — offering it on a clean worktree would
    // be an entry whose whole effect is to say "nothing to discard".
    ...(current?.kind === "leaf" && current.summary.dirty
      ? [{ keys: "x", action: "discard" }]
      : []),
    ...(group === undefined ? [{ keys: "s", action: "sync" }] : []),
    // The one hint that is not a thing to do to the row under the cursor, and
    // the reason the rest of this list can stay this short: everything aimed
    // at the repository rather than at a row is behind it.
    { keys: "/", action: "more" },
    { keys: "q", action: "quit" },
  ];
}

export type Regions = {
  readonly headerRows: number;
  readonly footerRows: number;
  readonly detailRows: number;
  /** How many pull requests the popup may draw. */
  readonly prBody: number;
  /** How many bases the rebase popup may draw. */
  readonly baseBody: number;
  /** How many commands the slash menu may draw. */
  readonly menuBody: number;
  /** Lines the activity area could not fit, said rather than silently dropped. */
  readonly clipped: number;
  readonly activity: readonly Line[];
  readonly activityRows: number;
  /** Commits the panel may draw; zero when it is not drawn at all. */
  readonly logBody: number;
  readonly logHeight: number;
  readonly listHeight: number;
  /** The first drawn row of the window onto the tree. */
  readonly start: number;
  readonly visible: readonly TreeRow[];
};

export type RegionInput = {
  readonly terminalRows: number;
  readonly columns: number;
  readonly hints: readonly Hint[];
  readonly mode: LayoutMode;
  readonly message: Message | undefined;
  readonly lines: readonly Line[];
  readonly logOn: boolean;
  readonly tree: readonly TreeRow[];
  readonly index: number;
  /** Whether the list draws its column headings — it does once there are rows. */
  readonly labelled: boolean;
};

/**
 * Every section's height, decided here rather than left to the renderer: the
 * list can only be sliced to fit if something knows what "fit" is.
 */
export function regionsFor({
  terminalRows,
  columns,
  hints,
  mode,
  message,
  lines,
  logOn,
  tree,
  index,
  labelled,
}: RegionInput): Regions {
  // The banner shrinks to one line on a small terminal, so its height is asked
  // for rather than assumed — getting it wrong is a row of the list drawn off
  // the bottom of the screen.
  const banner = bannerRows(columns, terminalRows);
  // A blank row above the banner and one between it and the column headings:
  // the places the screen would otherwise run hard against the terminal's
  // output or its own furniture.
  const headerRows = banner + 1 + (labelled ? 2 : 1) + 1;
  // The rule over the keys, the bar itself, and the position row. The bar is
  // one row until the terminal is too narrow to hold the keys on one, which
  // the folder hints (`a add under feat/`) reach first. Asked for rather than
  // assumed, for the same reason as the banner.
  const footerRows = 1 + statusBarRows(hints, columns) + 1;
  /**
   * How many body rows a popup may draw, out of what is actually free.
   *
   * Budgeted like the log panel rather than like the `add` box: `add` reserves
   * a flat three rows however long the branch name is, while both popups are
   * as tall as their contents — so each is capped at its own maximum and then
   * capped again by the rows left once the header, the key bar and
   * `MIN_LIST_ROWS` have taken theirs. At least one row either way: a popup you
   * cannot see the cursor in is worse than a short one.
   *
   * One number behind both, because they are the same shape of thing in the
   * same place, and two arithmetics for one hole is how they come to disagree
   * about where the bottom of the screen is.
   */
  const popupBody = Math.max(1, terminalRows - headerRows - footerRows - 3 - MIN_LIST_ROWS);
  const prBody = Math.min(PR_ROWS, popupBody);
  const baseBody = Math.min(BASE_ROWS, popupBody);
  const menuBody = Math.min(MENU_ROWS, popupBody);

  const detailRows =
    (mode.kind === "add" ? 3 : 0) +
    (mode.kind === "pick" ? pullRequestRows(mode.prs.length, prBody) : 0) +
    (mode.kind === "onto" ? baseRows(mode.choices.length, baseBody) : 0) +
    (mode.kind === "menu" ? menuRows(mode.matches, menuBody) : 0) +
    (mode.kind === "confirm" ? 1 : 0) +
    // `busy` takes the message row rather than leaving it empty: it is one
    // line saying which key is being answered, and the message it displaces
    // is the previous action's, which `perform` has already cleared.
    (mode.kind === "busy" ? 1 : message === undefined ? 0 : messageRows(message));

  /**
   * How many rows the activity area may take, out of what is actually left.
   *
   * Asked of the leftovers rather than of the terminal, because a fixed number
   * is one that can exceed the space there is: six rows of progress with
   * `Math.max(1, …)` holding the list open underneath adds up to more rows than
   * a short terminal has, and Ink draws the overflow on top of the banner.
   *
   * The list keeps a floor either way. It is the thing being worked in, and a
   * screen that answers one question by hiding the other is not an improvement.
   */
  const spare = terminalRows - headerRows - detailRows - footerRows - MIN_LIST_ROWS - 1;
  const room = Math.max(0, Math.min(ACTIVITY_ROWS, spare));

  // What did not fit is said rather than silently dropped — the whole reason
  // this exists is that a line went missing off the top without saying so.
  const clipped = Math.max(0, lines.length - room);
  // `room - 1` can reach zero, and `slice(-0)` is the whole array — which on a
  // cramped screen is every line drawn over whatever sat below the activity.
  const activity = clipped > 0 ? (room > 1 ? lines.slice(-(room - 1)) : []) : lines;
  const activityRows = activity.length > 0 ? activity.length + (clipped > 0 ? 1 : 0) + 1 : 0;

  /**
   * The commit panel's height, out of what is left once everything else has
   * taken its own.
   *
   * Budgeted after the activity rather than beside it, which is the precedence
   * on purpose: while a command is running, what it is doing now beats what was
   * committed yesterday, and on a terminal too short for both the panel is the
   * one that gives way. The list keeps `MIN_LIST_ROWS` underneath either way,
   * and the panel takes nothing at all rather than a row too few to read — one
   * commit under a heading is a heading with a commit stuck to it.
   */
  const logSpare =
    terminalRows - headerRows - activityRows - detailRows - footerRows - MIN_LIST_ROWS - 1;
  const logBody = logOn && logSpare >= LOG_MIN_ROWS ? Math.min(LOG_ROWS, logSpare) : 0;
  // The heading is a row of the panel: it is the rule the commits hang from,
  // and it says which row they belong to.
  const logHeight = logBody > 0 ? logBody + 1 : 0;

  const listHeight = Math.max(
    1,
    terminalRows - headerRows - activityRows - logHeight - detailRows - footerRows,
  );

  // A window onto the tree, measured in drawn rows — which include the folder
  // headings the cursor itself skips over.
  const start = windowOf(tree.length, index, listHeight);
  const visible = tree.slice(start, start + listHeight);

  return {
    headerRows,
    footerRows,
    detailRows,
    prBody,
    baseBody,
    menuBody,
    clipped,
    activity,
    activityRows,
    logBody,
    logHeight,
    listHeight,
    start,
    visible,
  };
}

/**
 * How wide each column of the list is, given the rows it has to hold.
 *
 * `now` is a parameter rather than a `Date.now()` of its own, which is the
 * whole of the fix for a column that used to be sized against a clock the
 * caller had stopped reading: the row draws `1m ago` with one moment and the
 * column was sized for `now` with another, and the difference came out as a
 * label truncated to `1m…` until the next refresh happened to agree with it.
 * One moment in, one set of widths out, and the two cannot disagree.
 */
export function columnWidths(
  tree: readonly TreeRow[],
  columns: number,
  trunkName: string,
  now: number,
): Widths {
  const width = (row: TreeRow) => row.depth * 2 + row.label.length;
  const treeColumn = Math.min(
    Math.max(8, ...tree.map(width)),
    Math.max(8, Math.floor(columns * 0.45)),
  );
  // The heading is content too: a column sized only to its rows truncates its
  // own label the moment the rows are shorter than it (`↑0 ↓0` under `remo…`).
  const LABELS = { remote: 6, state: 5 };

  const leaves = leavesOf(tree);

  // Each sized to its contents and its own heading — `no upstream` for one,
  // the trunk's name for the other, which is however long someone called it.
  const remoteWidth = Math.max(
    LABELS.remote,
    ...leaves.map((leaf) => describeRemote(leaf.summary).length),
  );
  const trunkWidth = Math.max(
    trunkName.length,
    ...leaves.map((leaf) => describeTrunk(leaf.summary).length),
  );

  // Only when something has a time to show. No heading and no minimum,
  // because it trails the row rather than heading a column — its width is
  // just the longest thing it will say.
  const touchedWidth = Math.max(
    0,
    ...leaves.map((leaf) => describeTouched(leaf.summary, now).length),
  );

  // The state column stopped being the row's flexible remainder when the
  // touched aside moved in behind it: sized to what it actually says — the
  // dot, plus the unusual states written out — the time sits beside the
  // state rather than at the far edge of the screen.
  const stateWidth = Math.max(
    LABELS.state,
    ...leaves.map((leaf) => {
      const notes = describeNotes(leaf.summary);

      return notes.length === 0 ? 1 : notes.length + 2;
    }),
  );

  // Dropped when what is left cannot hold the state column's own heading.
  // `touched` goes first, then `trunk`: "is there anything uncommitted here"
  // and "is there anything to push" are the two a narrow terminal should keep.
  // The constant 4 is the marker prefix (`▸ * `); each column then costs its
  // width plus one `GAP` in front of it.
  const gaps = 4 + GAP.length;
  const spare = (...widths: number[]) =>
    columns - treeColumn - gaps - widths.reduce((a, b) => a + b + GAP.length, 0);
  const fits = (...widths: number[]) => spare(...widths) >= LABELS.state;

  const remote = fits(remoteWidth) ? remoteWidth : 0;
  const trunk = remote > 0 && fits(remoteWidth, trunkWidth) ? trunkWidth : 0;
  // The aside must leave the state column whole, not just its heading.
  const touched =
    touchedWidth > 0 && trunk > 0 && spare(remoteWidth, trunkWidth, touchedWidth) >= stateWidth
      ? touchedWidth
      : 0;

  const taken = [remote, trunk, touched].filter((width) => width > 0);
  const state = Math.max(0, Math.min(stateWidth, spare(...taken)));

  return {
    tree: treeColumn,
    remote,
    trunk,
    touched,
    state,
    /**
     * What is left of the row once the list has had its columns, gaps and
     * marker.
     *
     * Taken out of the same budget the columns were sized from, rather than
     * counted back off the marker and each column that survived — so the two
     * cannot disagree about where the list ends and the empty screen begins.
     */
    slack: spare(...taken) - state,
  };
}
