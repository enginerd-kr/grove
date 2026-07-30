import { Box, Spacer, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { describeState, type WorktreeSummary } from "../../core/commands/list.ts";
import { isWtError } from "../../core/errors.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { theme } from "../theme.ts";
import type { WorktreeService } from "./service.ts";

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

type Widths = { readonly branch: number; readonly dir: number; readonly state: number };

function Row({
  summary,
  selected,
  widths,
}: {
  readonly summary: WorktreeSummary;
  readonly selected: boolean;
  readonly widths: Widths;
}) {
  const branch = summary.branch ?? "(detached)";

  return (
    <Text color={selected ? theme.accent : undefined} wrap="truncate">
      {`${selected ? "▸" : " "} ${summary.current ? "*" : " "} `}
      {padTo(branch, widths.branch)}
      {"  "}
      {padTo(summary.dir, widths.dir)}
      {"  "}
      <Text dimColor={!selected}>{padTo(describeState(summary), widths.state)}</Text>
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

  // Clamped rather than corrected on change: removing the last worktree would
  // otherwise leave the cursor pointing past the end for one render.
  const index = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1);
  const selected = rows[index];

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
    if (key.downArrow || input === "j") return setCursor(Math.min(rows.length - 1, index + 1));

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
  const detailRows =
    (mode.kind === "add" ? 3 : 0) +
    (mode.kind === "confirm" ? 1 : 0) +
    (message === undefined || mode.kind === "busy" ? 0 : message.hint === undefined ? 1 : 2);
  const listHeight = Math.max(
    1,
    terminalRows - 2 - 1 - (activity.length > 0 ? activity.length + 1 : 0) - detailRows - 1,
  );

  // A window onto the list that keeps the cursor roughly centred, and stops
  // scrolling once the end is on screen.
  const start = Math.min(
    Math.max(0, index - Math.floor(listHeight / 2)),
    Math.max(0, rows.length - listHeight),
  );
  const visible = rows.slice(start, start + listHeight);

  const widths = useMemo((): Widths => {
    const branch = Math.min(
      Math.max(6, ...rows.map((row) => (row.branch ?? "(detached)").length)),
      Math.max(6, Math.floor(columns * 0.35)),
    );
    const dir = Math.min(
      Math.max(3, ...rows.map((row) => row.dir.length)),
      Math.max(3, Math.floor(columns * 0.3)),
    );

    return { branch, dir, state: Math.max(0, columns - branch - dir - 8) };
  }, [rows, columns]);

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
      : visible.length < rows.length
        ? `${start + 1}–${start + visible.length} of ${rows.length}`
        : `${rows.length} worktree${rows.length === 1 ? "" : "s"}`;

  return (
    <Box flexDirection="column" width={columns} height={terminalRows}>
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
      <Text dimColor>{rule}</Text>

      <Box flexDirection="column" flexGrow={1}>
        {rows.length === 0 && mode.kind !== "busy" ? (
          <Text dimColor>no worktrees here yet — press a to add one</Text>
        ) : (
          visible.map((summary) => (
            <Row
              key={summary.path}
              summary={summary}
              selected={summary === rows[index]}
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

      <StatusBar hints={hints} />
    </Box>
  );
}
