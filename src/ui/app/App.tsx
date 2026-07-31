import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Drift } from "../../core/branches.ts";
import {
  describeNotes,
  describeRemote,
  describeTrunk,
  type WorktreeSummary,
} from "../../core/commands/list.ts";
import { describeDiscard } from "../../core/commands/reset.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar, statusBarRows } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";
import { Banner, bannerRows } from "./Banner.tsx";
import { type Message, messageFor } from "./message.ts";
import type { WorktreeService } from "./service.ts";
import { buildTree, leavesOf, parentOf, type TreeRow } from "./tree.ts";

/**
 * `garden` with nothing to do: the worktrees, and the five commands as keystrokes.
 *
 * The screen owns no git knowledge — it asks a `WorktreeService` — and it runs
 * exactly the commands the command line does, with the destructive spellings
 * (`--force`, `--delete-branch`) left off. Anything this refuses is still
 * reachable by typing it out, which is the point: a keystroke should not be able
 * to do something you would have had to be explicit about.
 *
 * It fills the terminal. The layout is a column pinned top and bottom — header,
 * list, activity, keys — with the list taking whatever is left, so the keys are
 * always on the last row and nothing reflows as work scrolls past.
 */

/**
 * What a key is about to do that cannot be undone, held until it is confirmed.
 *
 * Everything in here goes through the same `y`/`n`, because the question is
 * always the same one — is this the row you meant — and the answer should not
 * depend on remembering which destructive key you pressed.
 */
type Pending =
  | { readonly kind: "one"; readonly summary: WorktreeSummary }
  | { readonly kind: "many"; readonly label: string; readonly paths: readonly string[] }
  | { readonly kind: "reset"; readonly summary: WorktreeSummary };

type Mode =
  | { readonly kind: "list" }
  /**
   * `from` is the branch the new one starts on, taken from wherever the cursor
   * was when the prompt opened — not from wherever it is when you press enter.
   * The list re-reads itself on a timer, and a base that could change while you
   * were still typing the name would be a different branch than the one the
   * prompt said.
   */
  | { readonly kind: "add"; readonly value: string; readonly from?: string }
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
};

/** The most progress worth keeping on screen; older lines scroll out of it. */
const ACTIVITY_ROWS = 6;

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

/** A new set with `key` in it, and one without — `Set` is mutable and state is not. */
function with_(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...set, key]);
}

function without(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...set].filter((each) => each !== key));
}

/** Pads or truncates to exactly `width`, so columns stay columns. */
function padTo(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);

  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

type Widths = {
  readonly tree: number;
  readonly branch: number;
  readonly remote: number;
  readonly trunk: number;
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
 * The question a destructive key asks, and what it costs to answer `y`.
 *
 * Each one says what survives, since that is what the person is actually
 * weighing — and for the reset the honest answer is nothing, so it says that
 * rather than something softer.
 */
function describePending(target: Pending): string {
  if (target.kind === "one") {
    return `remove ${target.summary.dir}? the directory goes, the branch stays`;
  }

  if (target.kind === "many") {
    return `remove all ${target.paths.length} under ${target.label}? the directories go, the branches stay`;
  }

  // Both kinds, counted apart. `x` deletes untracked files too, and one of
  // those may be work git has never seen a copy of — folding it into "3
  // changes" would be the sentence someone regrets having skimmed.
  const { changed, untracked, dir } = target.summary;

  return `discard ${describeDiscard(changed - untracked, untracked)} in ${dir}? there is no undo`;
}

/** The branch, when the directory does not already say it. */
function branchAside(summary: WorktreeSummary): string {
  if (summary.branch === undefined) return "(detached)";

  return summary.branch === summary.dir ? "" : summary.branch;
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
      {"  "}
      {widths.branch > 0 ? (
        <>
          <Text dimColor={!selected}>{padTo(branchAside(row.summary), widths.branch)}</Text>
          {"  "}
        </>
      ) : null}
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
          {"  "}
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
          {"  "}
        </>
      ) : null}
      <StateCell summary={row.summary} width={widths.state} selected={selected} />
    </Text>
  );
}

export function App({ service, repoRoot, store, onCancel, refreshMs = REFRESH_MS }: Props) {
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [rows, setRows] = useState<readonly WorktreeSummary[]>([]);
  const [cursorKey, setCursorKey] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode>({ kind: "busy", label: "reading worktrees" });
  const [message, setMessage] = useState<Message | undefined>(undefined);

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

  // The first read is not an action: it reports no outcome, and going through
  // `perform` would open the screen with an empty message line.
  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const summaries = await service.list();
        if (live) setRows(summaries);
      } catch (error) {
        if (live) setMessage(messageFor(error));
      } finally {
        if (live) setMode({ kind: "list" });
      }
    })();

    return () => {
      live = false;
    };
  }, [service]);

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

  useInterval(() => void catchUp(), mode.kind === "busy" ? null : refreshMs);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel?.();
      exit();

      return;
    }

    if (mode.kind === "busy") return;

    if (mode.kind === "add") {
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        const branch = mode.value.trim();
        if (branch.length === 0) return setMode({ kind: "list" });

        return void perform(`adding ${branch}`, () => service.add(branch, mode.from));
      }
      if (key.backspace || key.delete) {
        return setMode({ ...mode, value: mode.value.slice(0, -1) });
      }
      // Control sequences arrive here as multi-character strings; taking only
      // printable input keeps an arrow key from typing itself into the name.
      if (input.length > 0 && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
        return setMode({ ...mode, value: mode.value + input });
      }

      return;
    }

    if (mode.kind === "confirm") {
      const target = mode.target;
      if (input === "y" || input === "Y") {
        if (target.kind === "reset") {
          return void perform(`resetting ${target.summary.dir}`, () =>
            service.reset(target.summary.path),
          );
        }

        return void (target.kind === "one"
          ? perform(`removing ${target.summary.dir}`, () => service.remove(target.summary.path))
          : perform(`removing ${target.paths.length} under ${target.label}`, () =>
              service.removeMany(target.paths),
            ));
      }

      return setMode({ kind: "list" });
    }

    if (key.upArrow || input === "k") return move(-1);
    if (key.downArrow || input === "j") return move(1);

    /**
     * Folding, the way every other tree does it.
     *
     * `→` opens a shut folder and steps into an open one; `←` shuts an open one
     * and otherwise walks out to the folder you are in. The second half is what
     * makes it feel like a tree rather than a pair of toggles: from six rows
     * deep, `←←←` is how you get back out and fold up what you came from,
     * without counting rows on the way.
     */
    if (key.rightArrow || input === "l") {
      if (current?.kind !== "group") return;
      if (current.collapsed) return setCollapsed(without(collapsed, current.key));

      return move(1);
    }

    if (key.leftArrow || input === "h") {
      if (current?.kind === "group" && !current.collapsed) {
        return setCollapsed(with_(collapsed, current.key));
      }

      const parent = current === undefined ? undefined : parentOf(tree, current);

      return parent === undefined ? undefined : setCursorKey(parent.key);
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
      return setMode({
        kind: "add",
        value: current?.kind === "group" ? current.key : "",
        from: selected?.branch,
      });
    }
    if (input === "r" && selected) {
      return setMode({ kind: "confirm", target: { kind: "one", summary: selected } });
    }
    if (input === "r" && current?.kind === "group" && under.length > 0) {
      return setMode({
        kind: "confirm",
        target: { kind: "many", label: current.key, paths: under.map((summary) => summary.path) },
      });
    }
    // Only where there is something to throw away. A confirmation for a reset
    // that would do nothing is a prompt that teaches people to answer `y`
    // without reading, which is the last habit this key should be building.
    if (input === "x" && selected?.dirty === true) {
      return setMode({ kind: "confirm", target: { kind: "reset", summary: selected } });
    }
    if (input === "s" && selected) {
      return void perform(`syncing ${selected.dir}`, () => service.sync(selected.path));
    }
    if (input === "S") return void perform("syncing every worktree", () => service.sync());
    if (input === "R") return void perform("reading worktrees", async () => "refreshed");
    if (input === "q" || key.escape) return exit();
  });

  const activity = lines.slice(-ACTIVITY_ROWS);
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

    // A folder offers what a folder can do. Leaving `s` and `r` on it to mean
    // what they mean on a worktree would be a menu that lies.
    if (current?.kind === "group") {
      return [
        { keys: "↑↓", action: "move" },
        { keys: "←→", action: current.collapsed ? "open" : "fold" },
        { keys: "a", action: `add under ${current.label}` },
        { keys: "r", action: `remove all ${under.length}` },
        { keys: "S", action: "sync all" },
        { keys: "R", action: "refresh" },
        { keys: "q", action: "quit" },
      ];
    }

    // `x` only where it would do something. Offering it on a clean worktree
    // would be a menu entry whose whole effect is to say "nothing to discard".
    return [
      { keys: "↑↓", action: "move" },
      { keys: "a", action: "add" },
      { keys: "r", action: "remove" },
      ...(selected?.dirty === true ? [{ keys: "x", action: "discard" }] : []),
      { keys: "s", action: "sync" },
      { keys: "S", action: "sync all" },
      { keys: "R", action: "refresh" },
      { keys: "q", action: "quit" },
    ];
  }, [mode.kind, current, under.length, selected?.dirty]);

  // Every section's height, decided here rather than left to the renderer: the
  // list can only be sliced to fit if something knows what "fit" is.
  const labelled = rows.length > 0;
  // The banner shrinks to one line on a small terminal, so its height is asked
  // for rather than assumed — getting it wrong is a row of the list drawn off
  // the bottom of the screen.
  const banner = bannerRows(columns, terminalRows);
  // A blank row above the banner, and another between the last thing reported
  // and the keys: the two places the screen would otherwise start and end hard
  // against the terminal's own output.
  const headerRows = banner + (labelled ? 2 : 1) + 1;
  // The key bar is one row until the terminal is too narrow to hold the keys on
  // one, which the folder hints (`a add under feat/`) reach first. Asked for
  // rather than assumed, for the same reason as the banner.
  const footerRows = 1 + statusBarRows(hints, columns) + 1;
  const activityRows = activity.length > 0 ? activity.length + 1 : 0;
  const detailRows =
    (mode.kind === "add" ? 3 : 0) +
    (mode.kind === "confirm" ? 1 : 0) +
    (message === undefined || mode.kind === "busy" ? 0 : message.hint === undefined ? 1 : 2);
  const listHeight = Math.max(
    1,
    terminalRows - headerRows - activityRows - detailRows - footerRows,
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
    const LABELS = { branch: 6, remote: 6, state: 5 };

    // Only when something has one to show: a branch matching its directory is
    // the ordinary case, and a column of blanks would be worse than no column.
    const leaves = leavesOf(tree);
    const asides = leaves.map((leaf) => branchAside(leaf.summary).length);
    const branch =
      Math.max(0, ...asides) === 0 ? 0 : Math.min(Math.max(LABELS.branch, ...asides), 24);

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

    // Dropped when what is left cannot hold the state column's own heading, and
    // the trunk column goes first: "is there anything uncommitted here" and "is
    // there anything to push" are the two a narrow terminal should keep.
    const gaps = branch > 0 ? 8 : 6;
    const fits = (...widths: number[]) =>
      columns - treeColumn - branch - gaps - widths.reduce((a, b) => a + b + 2, 0) >= LABELS.state;

    const remote = fits(remoteWidth) ? remoteWidth : 0;
    const trunk = remote > 0 && fits(remoteWidth, trunkWidth) ? trunkWidth : 0;

    const taken = [remote, trunk].filter((width) => width > 0);

    return {
      tree: treeColumn,
      branch,
      remote,
      trunk,
      state: Math.max(
        0,
        columns - treeColumn - branch - gaps - taken.reduce((a, b) => a + b + 2, 0),
      ),
    };
  }, [tree, columns, trunkName]);

  const rule = "─".repeat(Math.max(0, columns));
  // The banner already says how many there are, so the last row is left with
  // the one thing it cannot answer: where the cursor is in a list too long to
  // show at once. Counted in drawn rows, which is what the cursor walks.
  const position = visible.length < tree.length ? `${index + 1} of ${tree.length}` : "";
  const here = rows.find((summary) => summary.current)?.dir;

  return (
    <Box flexDirection="column" width={columns} height={terminalRows} paddingTop={1}>
      <Banner
        repoRoot={repoRoot}
        worktrees={rows.length}
        here={here}
        columns={columns}
        rows={terminalRows}
      />

      {/* The branch column appears only when some worktree's branch differs from
          the directory it sits in, so the label has to come and go with it. */}
      {labelled ? (
        <Text dimColor wrap="truncate">
          {"    "}
          {padTo("worktree", widths.tree)}
          {"  "}
          {widths.branch > 0 ? `${padTo("branch", widths.branch)}  ` : ""}
          {widths.remote > 0 ? `${padTo("origin", widths.remote)}  ` : ""}
          {/* Named after the branch it compares against, since `master` and
              `trunk` are both things people call it. */}
          {widths.trunk > 0 ? `${padTo(trunkName, widths.trunk)}  ` : ""}
          state
        </Text>
      ) : null}
      <Text dimColor>{rule}</Text>

      <Box flexDirection="column" flexGrow={1}>
        {rows.length === 0 && mode.kind !== "busy" ? (
          <Text dimColor>no worktrees here yet — press a to add one</Text>
        ) : (
          visible.map((row) => (
            <Row key={row.key} row={row} selected={row === current} widths={widths} />
          ))
        )}
      </Box>

      {activity.length > 0 ? (
        <>
          <Text dimColor>{rule}</Text>
          <Box flexDirection="column">
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
            <Text color={theme.accent}>{mode.value}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}

      {mode.kind === "confirm" ? (
        // Red for the reset, amber for the removals, because they are not the
        // same risk: a removed worktree leaves its branch and its commits behind
        // and `garden add` brings it back, while a reset leaves nothing at all.
        <Text color={mode.target.kind === "reset" ? theme.danger : theme.warn} wrap="truncate">
          {describePending(mode.target)}
        </Text>
      ) : null}

      {message !== undefined && mode.kind !== "busy" ? (
        <Box flexDirection="column">
          <Text color={message.kind === "error" ? theme.danger : undefined} wrap="truncate">
            {message.text}
          </Text>
          {message.hint === undefined ? null : (
            <Text dimColor wrap="truncate">
              {message.hint}
            </Text>
          )}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <StatusBar hints={hints} columns={columns} />
      </Box>

      {/* Last row, under the keys: how far into the list the cursor is. The row
          is kept even when there is nothing to say, so that a list scrolling
          past the bottom does not shift everything above it by a line. */}
      <Box justifyContent="flex-end">
        <Text dimColor>{position}</Text>
      </Box>
    </Box>
  );
}
