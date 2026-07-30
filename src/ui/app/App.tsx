import { Box, Spacer, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { describeState, type WorktreeSummary } from "../../core/commands/list.ts";
import { isWtError } from "../../core/errors.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { theme } from "../theme.ts";
import type { WorktreeService } from "./service.ts";
import { buildTree, leavesOf, type TreeRow } from "./tree.ts";

/**
 * `wt` with nothing to do: the worktrees, and the five commands as keystrokes.
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

type Mode =
  | { readonly kind: "list" }
  | { readonly kind: "add"; readonly value: string }
  | { readonly kind: "confirm"; readonly target: WorktreeSummary }
  | { readonly kind: "busy"; readonly label: string };

type Message = {
  readonly kind: "info" | "error";
  readonly text: string;
  readonly hint?: string;
};

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

/**
 * The header is a label, not a path to copy: `~` for home, and the front cut
 * away when it is long, because a repository path that wraps costs a line of
 * the list and the tail is the part that identifies it anyway.
 */
function shortenPath(path: string, max: number): string {
  const home = process.env.HOME;
  const short =
    home !== undefined && home.length > 0 && path.startsWith(home)
      ? `~${path.slice(home.length)}`
      : path;

  return short.length <= max ? short : `…${short.slice(short.length - max + 1)}`;
}

/** Pads or truncates to exactly `width`, so columns stay columns. */
function padTo(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text.padEnd(width);

  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function messageFor(error: unknown): Message {
  if (isWtError(error)) return { kind: "error", text: error.message, hint: error.hint };

  return { kind: "error", text: error instanceof Error ? error.message : String(error) };
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

  // A folder is a heading: no marker, no state, nothing to act on.
  if (row.kind === "group") {
    return (
      <Text dimColor wrap="truncate">
        {"    "}
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

  // The tree is what is drawn; the cursor counts worktrees, because a folder
  // row is a heading with nothing to sync or remove.
  const tree = useMemo(() => buildTree(rows), [rows]);
  const leaves = useMemo(() => leavesOf(tree), [tree]);

  // Clamped rather than corrected on change: removing the last worktree would
  // otherwise leave the cursor pointing past the end for one render.
  const index = leaves.length === 0 ? 0 : Math.min(cursor, leaves.length - 1);
  const selected = leaves[index]?.summary;

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
        return void perform(`removing ${target.dir}`, () => service.remove(target.path));
      }

      return setMode({ kind: "list" });
    }

    if (key.upArrow || input === "k") return setCursor(Math.max(0, index - 1));
    if (key.downArrow || input === "j") return setCursor(Math.min(leaves.length - 1, index + 1));

    if (input === "a") return setMode({ kind: "add", value: "" });
    if (input === "r" && selected) return setMode({ kind: "confirm", target: selected });
    if (input === "s" && selected) {
      return void perform(`syncing ${selected.dir}`, () => service.sync(selected.path));
    }
    if (input === "S") return void perform("syncing every worktree", () => service.sync());
    if (input === "R") return void perform("reading worktrees", async () => "refreshed");
    if (input === "q" || key.escape) return exit();
  });

  const activity = lines.slice(-ACTIVITY_ROWS);

  // Every section's height, decided here rather than left to the renderer: the
  // list can only be sliced to fit if something knows what "fit" is.
  const labelled = rows.length > 0;
  // A blank row above the labels, and another between the last thing reported
  // and the keys: the two places the screen would otherwise start and end hard
  // against the terminal's own output.
  const headerRows = (labelled ? 2 : 1) + 1;
  const footerRows = 2 + 1;
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
  const onCursor = leaves[index];
  const cursorRow = onCursor === undefined ? 0 : Math.max(0, tree.indexOf(onCursor));
  const start = Math.min(
    Math.max(0, cursorRow - Math.floor(listHeight / 2)),
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
    const asides = leaves.map((leaf) => branchAside(leaf.summary).length);
    const branch = Math.max(0, ...asides) === 0 ? 0 : Math.min(Math.max(...asides), 24);

    return {
      tree: treeColumn,
      branch,
      state: Math.max(0, columns - treeColumn - branch - (branch > 0 ? 8 : 6)),
    };
  }, [tree, leaves, columns]);

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

    return [
      { keys: "↑↓", action: "move" },
      { keys: "a", action: "add" },
      { keys: "r", action: "remove" },
      { keys: "s", action: "sync" },
      { keys: "S", action: "sync all" },
      { keys: "R", action: "refresh" },
      { keys: "q", action: "quit" },
    ];
  }, [mode.kind]);

  const rule = "─".repeat(Math.max(0, columns));
  const counted =
    rows.length === 0
      ? "no worktrees"
      : visible.length < tree.length
        ? `${index + 1} of ${rows.length}`
        : `${rows.length} worktree${rows.length === 1 ? "" : "s"}`;

  return (
    <Box flexDirection="column" width={columns} height={terminalRows} paddingTop={1}>
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
            <Row
              key={row.key}
              row={row}
              selected={row.kind === "leaf" && row.summary === selected}
              widths={widths}
            />
          ))
        )}
      </Box>

      {activity.length > 0 ? (
        <>
          <Text dimColor>{rule}</Text>
          <Box flexDirection="column">
            {activity.map((line) => (
              <StepRow key={line.id} line={line} />
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
          remove {mode.target.dir}? the directory goes, the branch stays
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
        <StatusBar hints={hints} />
      </Box>

      {/* Last row, under the keys: which repository this is, and how much of it
          is on screen. It sits here rather than on top because it is the answer
          to a question nobody asks twice — the list is what the eye starts on. */}
      <Box>
        <Box marginRight={1}>
          <Text bold color={theme.accent}>
            wt
          </Text>
        </Box>
        <Text dimColor wrap="truncate">
          {shortenPath(repoRoot, Math.max(10, columns - 24))}
        </Text>
        <Spacer />
        <Text dimColor>{counted}</Text>
      </Box>
    </Box>
  );
}
