import { join } from "node:path";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { version } from "../../../package.json";
import type { Drift } from "../../core/branches.ts";
import {
  describeNotes,
  describeRemote,
  describeTouched,
  describeTrunk,
  type WorktreeSummary,
} from "../../core/commands/list.ts";
import { describeDiscard } from "../../core/commands/reset.ts";
import type { Commit } from "../../core/history.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar, statusBarRows } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";
import { Banner, bannerRows } from "./Banner.tsx";
import { Files } from "./Files.tsx";
import { Log } from "./Log.tsx";
import { MessageView } from "./MessageView.tsx";
import { type Message, messageFor, messageRows } from "./message.ts";
import type { WorktreeService } from "./service.ts";
import { buildTree, firstChildOf, leavesOf, parentOf, type TreeRow } from "./tree.ts";

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
 * What `r` is about to do that cannot be undone, held until it is confirmed.
 *
 * One worktree or a folder's worth of them, asked the same `y`/`n` either way:
 * the question is the same one — is this the row you meant — and the answer
 * should not depend on how many rows are behind it.
 */
type Pending =
  | { readonly kind: "one"; readonly summary: WorktreeSummary }
  | {
      readonly kind: "many";
      readonly label: string;
      readonly paths: readonly string[];
      /** How many of `paths` are dirty — what makes this question a red one. */
      readonly dirty: number;
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
const LOG_ROWS = 5;

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
 * The rows the list keeps whatever else wants them.
 *
 * The list is the thing being worked in. A screen that answers "what did that
 * command say" by hiding "which worktree am I on" has moved the problem rather
 * than solved it.
 */
const MIN_LIST_ROWS = 3;

/**
 * How often the screen brings itself up to date, in the absence of any reason
 * to think it needs to.
 *
 * Both halves are on this one clock. The local half — is anything dirty, has a
 * worktree appeared — is edited from somewhere else, an editor or a build or
 * another terminal, so waiting for `R` would make the screen a photograph of
 * whenever you last pressed a key. The remote half is counted against
 * `origin/main`, which is a *local* ref: without a fetch of our own, a
 * colleague's push never appears at all.
 *
 * A minute because that is the pace the slower half sets, and running the
 * cheaper half faster buys little: an action you take refreshes immediately, `R`
 * refreshes on demand, and the rest is other people's work arriving, which does
 * not arrive by the second.
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
// whatever the session earned (a release, a missing shell function) so the
// slot always has more than one thing to say and rotation is never a no-op.
const GENERAL_TIPS: readonly Message[] = [
  { kind: "info", text: "tip: h and l don't stop at the first fold — they keep going" },
  { kind: "info", text: "tip: a starts the new branch from wherever the cursor is" },
  { kind: "info", text: "tip: r on a folder removes every worktree under it, after one question" },
  { kind: "info", text: "tip: s syncs the row under the cursor, S syncs every worktree" },
  { kind: "info", text: "tip: enter copies the path under the cursor, for a paste elsewhere" },
  { kind: "info", text: "tip: L puts the commits away when the list wants the rows" },
];

/**
 * The directory a row stands for, as an absolute path.
 *
 * A folder is a real directory on disk, so it answers too. Group keys carry
 * their trailing slash (it is how they are drawn); a path handed around as a
 * location should not.
 */
function pathOf(row: TreeRow, repoRoot: string): string {
  return row.kind === "group" ? join(repoRoot, row.key.replace(/\/+$/, "")) : row.summary.path;
}

/** A new set with `key` in it, and one without — `Set` is mutable and state is not. */
function with_(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...set, key]);
}

function without(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...set].filter((each) => each !== key));
}

/** `1 command`, `2 commands` — the label a confirmed action is given. */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The space between the list's columns, one constant so the header and every
 * row agree on it — a gap that drifted between them would shear the columns.
 */
const GAP = "    ";

/** Pads or truncates to exactly `width`, so columns stay columns. */
function padTo(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);

  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

type Widths = {
  readonly tree: number;
  readonly remote: number;
  readonly trunk: number;
  readonly touched: number;
  readonly state: number;
};

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
  const notes = describeNotes(summary);

  return (
    <>
      <Text color={summary.dirty ? theme.warn : undefined} dimColor={!summary.dirty}>
        {summary.dirty ? "●" : "○"}
      </Text>
      <Text dimColor={!selected}>{padTo(notes.length === 0 ? "" : ` ${notes}`, width - 1)}</Text>
    </>
  );
}

/**
 * The question `r` asks, and what it costs to answer `y`.
 *
 * Each one says what survives, since that is what the person is actually
 * weighing: the directory goes, the branch stays, and any uncommitted changes
 * go with the directory.
 */
function describePending(target: Pending): string {
  // A dirty worktree is not refused any more — it is asked about instead, and
  // the question has to carry what `y` now costs: the uncommitted changes go
  // with the directory, counted the same way the reset counts them.
  if (target.kind === "one") {
    const { dir, dirty, changed, untracked } = target.summary;
    if (dirty) {
      return `remove ${dir} and discard ${describeDiscard(changed - untracked, untracked)}? the branch stays`;
    }

    return `remove ${dir}? the directory goes, the branch stays`;
  }

  const all = `remove all ${target.paths.length} under ${target.label}?`;
  if (target.dirty > 0) {
    return `${all} ${target.dirty} ${target.dirty === 1 ? "has" : "have"} uncommitted changes, which go too — the branches stay`;
  }

  return `${all} the directories go, the branches stay`;
}

/** How loudly to ask, which is not the same for both questions. */
function colourFor(target: Pending): string | undefined {
  // A removal that discards uncommitted changes is a risk of a different kind
  // from one that only takes a directory back.
  if (target.kind === "one" && target.summary.dirty) return theme.danger;
  if (target.kind === "many" && target.dirty > 0) return theme.danger;

  return theme.warn;
}

function Row({
  row,
  selected,
  widths,
}: {
  readonly row: TreeRow;
  readonly selected: boolean;
  readonly widths: Widths;
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
            {padTo(describeTouched(row.summary, Date.now()), widths.touched)}
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
  // Every tip that earned the slot on this open: whichever of the release
  // and missing-shell-function tips apply, plus the standing `GENERAL_TIPS`.
  // Never empty once set. See the rotation `useInterval` below.
  const [tipPool, setTipPool] = useState<readonly Message[]>([]);
  /**
   * Whether the commits are drawn under the list at all, and the last read.
   *
   * On by default, because the panel is the answer to the question the columns
   * raise — `↑2` is a number until you can see what the two commits were — and
   * a view you have to know about to turn on is one most people never see. `L`
   * puts it away for the session when the rows are wanted for the list instead;
   * it is a view, so it is not remembered anywhere on disk.
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
      // it is news; the shell tip is standing advice, so it can wait its turn.
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

  useInput((input, key) => {
    // Any key is "somebody's here," whatever it does — including the ones
    // handled below that leave the mode untouched. Snapping the delay back
    // now, rather than waiting for the next tick to notice, is what keeps a
    // backed-off clock from making the screen wait minutes for its first
    // refresh after being read again.
    lastInputAt.current = Date.now();
    setRefreshDelay(refreshMs);

    if (key.ctrl && input === "c") {
      onCancel?.();
      exit();

      return;
    }

    if (mode.kind === "busy") return;

    if (mode.kind === "add") {
      if (key.escape) return setMode({ kind: "list" });
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
      // The caret moves through the name, and stops at either end rather than
      // wrapping: a key that jumps from the start to the end is one you have
      // to look at the screen to use.
      if (key.leftArrow) {
        return setMode({ ...mode, caret: Math.max(0, mode.caret - 1) });
      }
      if (key.rightArrow) {
        return setMode({ ...mode, caret: Math.min(mode.value.length, mode.caret + 1) });
      }
      // Backspace takes the character the caret sits after, wherever that is,
      // and the caret follows it back so the next one takes its neighbour.
      // Both keys mean backspace here: the key labelled Backspace arrives as
      // `delete` on a mac, and a forward delete is not worth losing that to.
      if (key.backspace || key.delete) {
        if (mode.caret === 0) return;

        return setMode({
          ...mode,
          value: mode.value.slice(0, mode.caret - 1) + mode.value.slice(mode.caret),
          caret: mode.caret - 1,
        });
      }
      // Control sequences arrive here as multi-character strings; taking only
      // printable input keeps an arrow key from typing itself into the name.
      if (input.length > 0 && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
        return setMode({
          ...mode,
          value: mode.value.slice(0, mode.caret) + input + mode.value.slice(mode.caret),
          caret: mode.caret + input.length,
        });
      }

      return;
    }

    if (mode.kind === "confirm") {
      const target = mode.target;
      if (input === "y" || input === "Y") {
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
        return setCollapsed(without(collapsed, current.key));
      }

      const child = current === undefined ? undefined : firstChildOf(tree, current);

      return child === undefined ? move(1) : setCursorKey(child.key);
    }

    if (key.leftArrow || input === "h") {
      if (current?.kind === "group" && !current.collapsed) {
        return setCollapsed(with_(collapsed, current.key));
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
    if (input === "s" && selected) {
      return void perform(`syncing ${selected.dir}`, () => service.sync(selected.path));
    }
    if (input === "S") return void perform("syncing every worktree", () => service.sync());
    if (input === "R") return void perform("reading worktrees", async () => "refreshed");
    // A view, not an action: nothing is read, nothing is written, and the rows
    // it gives back go straight to the list.
    if (input === "L") return setLogOn((on) => !on);
    if (input === "q" || key.escape) return exit();
  });

  // The heading of the trunk column, and the branch it compares against. Read
  // off the rows rather than assumed, because `master` and `trunk` are both
  // things people call it.
  const trunkName = rows.find((summary) => summary.isDefault)?.branch ?? "trunk";

  const hints = useMemo(() => {
    if (mode.kind === "busy") return [{ keys: "ctrl+c", action: "cancel" }];
    if (mode.kind === "add") {
      return [
        { keys: "enter", action: "add" },
        { keys: "esc", action: "cancel" },
      ];
    }
    if (mode.kind === "confirm") {
      return [
        { keys: "y", action: "remove" },
        { keys: "n", action: "keep" },
      ];
    }

    // A folder offers what a folder can do. Leaving `s` on it to mean what it
    // means on a worktree would be a menu that lies.
    if (current?.kind === "group") {
      return [
        { keys: "↑↓", action: "move" },
        { keys: "←→", action: current.collapsed ? "open" : "fold" },
        { keys: "enter", action: "copy path" },
        { keys: "a", action: `add under ${current.label}` },
        { keys: "r", action: `remove all ${under.length}` },
        { keys: "S", action: "sync all" },
        { keys: "R", action: "refresh" },
        { keys: "L", action: logOn ? "hide log" : "show log" },
        { keys: "q", action: "quit" },
      ];
    }

    return [
      { keys: "↑↓", action: "move" },
      { keys: "enter", action: "copy path" },
      { keys: "a", action: "add" },
      { keys: "r", action: "remove" },
      { keys: "s", action: "sync" },
      { keys: "S", action: "sync all" },
      { keys: "R", action: "refresh" },
      { keys: "L", action: logOn ? "hide log" : "show log" },
      { keys: "q", action: "quit" },
    ];
  }, [mode, current, under.length, logOn]);

  // Every section's height, decided here rather than left to the renderer: the
  // list can only be sliced to fit if something knows what "fit" is.
  const labelled = rows.length > 0;
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
  const detailRows =
    (mode.kind === "add" ? 3 : 0) +
    (mode.kind === "confirm" ? 1 : 0) +
    (message === undefined || mode.kind === "busy" ? 0 : messageRows(message));

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

  // A window onto the tree that keeps the cursor roughly centred, and stops
  // scrolling once the end is on screen. Measured in drawn rows, which include
  // the folder headings the cursor itself skips over.
  const start = Math.min(
    Math.max(0, index - Math.floor(listHeight / 2)),
    Math.max(0, tree.length - listHeight),
  );
  const visible = tree.slice(start, start + listHeight);

  const widths = useMemo((): Widths => {
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
    const now = Date.now();
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

    return {
      tree: treeColumn,
      remote,
      trunk,
      touched,
      state: Math.max(0, Math.min(stateWidth, spare(...taken))),
    };
  }, [tree, columns, trunkName]);

  /**
   * How much of a row the list actually draws on, gaps and marker included.
   *
   * Counted the same way `widths` budgeted it — the marker, then each column
   * that survived with the gap in front of it — so the two cannot disagree
   * about where the list ends and the empty screen begins.
   */
  const listWidth =
    4 +
    widths.tree +
    GAP.length +
    (widths.remote > 0 ? widths.remote + GAP.length : 0) +
    (widths.trunk > 0 ? widths.trunk + GAP.length : 0) +
    widths.state +
    (widths.touched > 0 ? GAP.length + widths.touched : 0);

  /**
   * The uncommitted-files panel's width, out of the screen the list is not on.
   *
   * Only for a worktree with something uncommitted in it: a clean row has no
   * files to name, and a panel that stayed to say so would be a wide blank
   * gutter beside the rows that are almost all of them. A folder is not a
   * worktree and has no working tree of its own, so it draws none either.
   */
  const slack = columns - listWidth;
  const filesWidth =
    selected?.dirty === true && slack >= MIN_FILES_COLS ? Math.min(slack, MAX_FILES_COLS) : 0;

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
              <Row key={row.key} row={row} selected={row === current} widths={widths} />
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

      {mode.kind === "confirm" ? (
        // Red for a removal that discards uncommitted changes, amber for a
        // clean one, because they are not the same risk: a removed clean
        // worktree leaves its branch and its commits behind and `grove add`
        // brings it back, while discarded changes leave nothing at all.
        <Text color={colourFor(mode.target)} wrap="truncate">
          {describePending(mode.target)}
        </Text>
      ) : null}

      {message !== undefined && mode.kind !== "busy" ? (
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
