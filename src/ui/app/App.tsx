import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { describeState, type WorktreeSummary } from "../../core/commands/list.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar, statusBarRows } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { theme } from "../theme.ts";
import { Banner, bannerRows } from "./Banner.tsx";
import { type Message, messageFor } from "./message.ts";
import type { WorktreeService } from "./service.ts";
import { buildTree, leavesOf, leavesUnder, type TreeRow } from "./tree.ts";

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

/** What a `r` is about to delete: one worktree, or a folder's worth of them. */
type Removal =
  | { readonly kind: "one"; readonly summary: WorktreeSummary }
  | { readonly kind: "many"; readonly label: string; readonly paths: readonly string[] };

type Mode =
  | { readonly kind: "list" }
  | { readonly kind: "add"; readonly value: string }
  | { readonly kind: "confirm"; readonly target: Removal }
  | { readonly kind: "busy"; readonly label: string };

type Props = {
  readonly service: WorktreeService;
  /** Shown in the header; the repository the keystrokes act on. */
  readonly repoRoot: string;
  /** Progress from the commands the keys start. */
  readonly store: LineStore;
  /** Ctrl-C while busy: stop the git child before the screen goes away. */
  readonly onCancel?: () => void;
};

/** The most progress worth keeping on screen; older lines scroll out of it. */
const ACTIVITY_ROWS = 6;

/** Pads or truncates to exactly `width`, so columns stay columns. */
function padTo(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);

  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

type Widths = { readonly tree: number; readonly branch: number; readonly state: number };

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
      <Text dimColor={!selected}>{padTo(describeState(row.summary), widths.state)}</Text>
    </Text>
  );
}

export function App({ service, repoRoot, store, onCancel }: Props) {
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [rows, setRows] = useState<readonly WorktreeSummary[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "busy", label: "reading worktrees" });
  const [message, setMessage] = useState<Message | undefined>(undefined);

  const lines = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  // The cursor walks every drawn row, folders included: a folder is what you
  // reach for to act on the branches under it in one go.
  const tree = useMemo(() => buildTree(rows), [rows]);

  // Clamped rather than corrected on change: removing the last worktree would
  // otherwise leave the cursor pointing past the end for one render.
  const index = tree.length === 0 ? 0 : Math.min(cursor, tree.length - 1);
  const current = tree[index];
  const selected = current?.kind === "leaf" ? current.summary : undefined;
  const under = useMemo(
    () => (current === undefined || current.kind !== "group" ? [] : leavesUnder(tree, current)),
    [tree, current],
  );

  /**
   * Cursor movement, computed from the previous cursor rather than from the
   * rendered one.
   *
   * Keys arrive faster than React commits: two presses in the same frame both
   * read the same `index` and the second one goes nowhere, which is exactly
   * what holding the arrow key does. Clamping lives in here too, so a list that
   * shrank under the cursor cannot leave it past the end.
   */
  const move = useCallback(
    (delta: number) => {
      setCursor((previous) => {
        const last = Math.max(0, tree.length - 1);

        return Math.min(last, Math.max(0, Math.min(previous, last) + delta));
      });
    },
    [tree.length],
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

        return void perform(`adding ${branch}`, () => service.add(branch));
      }
      if (key.backspace || key.delete) {
        return setMode({ kind: "add", value: mode.value.slice(0, -1) });
      }
      // Control sequences arrive here as multi-character strings; taking only
      // printable input keeps an arrow key from typing itself into the name.
      if (input.length > 0 && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
        return setMode({ kind: "add", value: mode.value + input });
      }

      return;
    }

    if (mode.kind === "confirm") {
      const target = mode.target;
      if (input === "y" || input === "Y") {
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

    // On a folder, `a` starts the name where the cursor already is: reaching for
    // it there is how you say "another one of these".
    if (input === "a") {
      return setMode({
        kind: "add",
        value: current?.kind === "group" ? current.key : "",
      });
    }
    if (input === "r" && selected) {
      return setMode({ kind: "confirm", target: { kind: "one", summary: selected } });
    }
    if (input === "r" && current?.kind === "group" && under.length > 0) {
      return setMode({
        kind: "confirm",
        target: { kind: "many", label: current.key, paths: under.map((leaf) => leaf.summary.path) },
      });
    }
    if (input === "s" && selected) {
      return void perform(`syncing ${selected.dir}`, () => service.sync(selected.path));
    }
    if (input === "S") return void perform("syncing every worktree", () => service.sync());
    if (input === "R") return void perform("reading worktrees", async () => "refreshed");
    if (input === "q" || key.escape) return exit();
  });

  const activity = lines.slice(-ACTIVITY_ROWS);

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
        { keys: "a", action: `add under ${current.label}` },
        { keys: "r", action: `remove all ${under.length}` },
        { keys: "S", action: "sync all" },
        { keys: "R", action: "refresh" },
        { keys: "q", action: "quit" },
      ];
    }

    return [
      { keys: "↑↓", action: "move" },
      { keys: "a", action: "add" },
      { keys: "r", action: "remove" },
      { keys: "s", action: "sync" },
      { keys: "S", action: "sync all" },
      { keys: "R", action: "refresh" },
      { keys: "q", action: "quit" },
    ];
  }, [mode.kind, current, under.length]);

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
    // Only when something has one to show: a branch matching its directory is
    // the ordinary case, and a column of blanks would be worse than no column.
    const asides = leavesOf(tree).map((leaf) => branchAside(leaf.summary).length);
    const branch = Math.max(0, ...asides) === 0 ? 0 : Math.min(Math.max(...asides), 24);

    return {
      tree: treeColumn,
      branch,
      state: Math.max(0, columns - treeColumn - branch - (branch > 0 ? 8 : 6)),
    };
  }, [tree, columns]);

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
        <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text>
            <Text dimColor>new branch </Text>
            <Text color={theme.accent}>{mode.value}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}

      {mode.kind === "confirm" ? (
        <Text color={theme.warn} wrap="truncate">
          {mode.target.kind === "one"
            ? `remove ${mode.target.summary.dir}? the directory goes, the branch stays`
            : `remove all ${mode.target.paths.length} under ${mode.target.label}? the directories go, the branches stay`}
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
