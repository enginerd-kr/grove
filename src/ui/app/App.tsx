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
import { SETUP_FILE } from "../../core/setup-file.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar, statusBarRows } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";
import { Banner, bannerRows } from "./Banner.tsx";
import { rank } from "./filter.ts";
import { type Message, messageFor } from "./message.ts";
import { bodyOf, modeOf, PROMPT_ROWS, Prompt, tokenize } from "./Prompt.tsx";
import type { WorktreeService } from "./service.ts";
import { buildTree, firstChildOf, leavesOf, parentOf, type TreeRow } from "./tree.ts";

/**
 * `grove` with nothing to do: the worktrees, and the five commands as keystrokes.
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
  | { readonly kind: "reset"; readonly summary: WorktreeSummary }
  /**
   * The one entry here that deletes nothing, and the most serious of them.
   *
   * A worktree has just been made, its files are in place, and its
   * `.grove.toml` wants to run commands that arrived with a pull. Saying yes
   * is saying they may run on this machine — so the commands themselves are the
   * question, because reading them is the whole of the safeguard.
   */
  | { readonly kind: "trust"; readonly branch: string; readonly commands: readonly string[] };

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
  /**
   * The popup that ends in something leaving the machine: a PR title, typed
   * over the commits it would propose. It carries the context that was true
   * when it opened — the body, the subjects — for the same reason `add`
   * carries `from`: the list refreshes itself, and a popup that re-read the
   * world at enter-time could propose something other than what it showed.
   */
  | {
      readonly kind: "pr";
      readonly value: string;
      readonly target: { readonly path: string; readonly dir: string };
      readonly branch: string;
      readonly base: string;
      readonly body: string;
      readonly context: readonly string[];
    }
  /** The open-ended line: `!` runs git, anything else narrows the list. */
  | { readonly kind: "prompt"; readonly value: string }
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
  /**
   * Where enter takes the shell, when there is a shell function to catch it.
   *
   * Present only when the app was started through the wrapper `shell-init`
   * installs — it hands over a path, the wrapper cds to it after the screen
   * closes. Absent, enter stays inert and its hint never appears: a key that
   * quit the app to accomplish nothing would be a trap, not a shortcut.
   */
  readonly onCd?: (path: string) => Promise<void> | void;
  /** How often to refresh, in ms. Defaults to `REFRESH_MS`; tests drive it faster. */
  readonly refreshMs?: number;
  /**
   * Resolves to a newer released version, or `undefined` for nothing to say.
   * Absent means don't ask at all — the source tree and the tests have no
   * upgrade to be told about.
   */
  readonly checkUpdate?: () => Promise<string | undefined>;
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
 * The share of the screen a `!` command's output may take instead.
 *
 * Six rows is wrong for that. `git status` is seven lines before it has said
 * anything unusual, so it lost `On branch …` off the top — the one line that
 * says which worktree you are even looking at. Output you asked for by typing a
 * command is the thing on the screen at that moment, not a footnote under the
 * list, so it gets half the terminal and the list keeps the rest.
 */
const OUTPUT_SHARE = 0.5;

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

/** A new set with `key` in it, and one without — `Set` is mutable and state is not. */
function with_(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...set, key]);
}

function without(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...set].filter((each) => each !== key));
}

/**
 * At most this much context under a popup's input; the rest becomes a count.
 *
 * A worktree with forty changed files does not need forty rows to say "this
 * commits a lot" — and the list underneath is what says where you are.
 */
const CONTEXT_ROWS = 8;

function capped(lines: readonly string[]): readonly string[] {
  if (lines.length <= CONTEXT_ROWS) return lines;

  const rest = lines.length - (CONTEXT_ROWS - 1);

  return [...lines.slice(0, CONTEXT_ROWS - 1), `# … ${rest} more`];
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

  // The commands themselves, not a count of them. "trust 2 commands?" is a
  // question nobody can answer, and this is the one place in the app where the
  // answer is what stands between a pull and code running on your machine.
  if (target.kind === "trust") {
    const commands = target.commands.map((command) => JSON.stringify(command)).join(", ");

    return `${SETUP_FILE} wants to run ${commands} — run it here?`;
  }

  // Both kinds, counted apart. `x` deletes untracked files too, and one of
  // those may be work git has never seen a copy of — folding it into "3
  // changes" would be the sentence someone regrets having skimmed.
  const { changed, untracked, dir } = target.summary;

  return `discard ${describeDiscard(changed - untracked, untracked)} in ${dir}? there is no undo`;
}

/** How loudly to ask, which is not the same for all three questions. */
function colourFor(target: Pending): string | undefined {
  // Agreeing to run code that came in over the network is a risk of the same
  // order as throwing work away, and of a different kind from a removal.
  if (target.kind === "reset" || target.kind === "trust") return theme.danger;

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
  onCd,
  refreshMs = REFRESH_MS,
  checkUpdate,
}: Props) {
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [rows, setRows] = useState<readonly WorktreeSummary[]>([]);
  const [cursorKey, setCursorKey] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Kept outside the prompt, because it outlives it: you narrow the list in
  // order to work in what is left, and closing the box should not undo that.
  const [filter, setFilter] = useState("");
  /** Whether what the activity area is holding is command output rather than progress. */
  const [roomy, setRoomy] = useState(false);
  // What is on the prompt line right now, as opposed to at the last render. See
  // the `prompt` branch of `useInput` for why the difference matters.
  const typed = useRef("");
  const [mode, setMode] = useState<Mode>({ kind: "busy", label: "reading worktrees" });
  const [message, setMessage] = useState<Message | undefined>(undefined);

  const lines = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  // The cursor walks every drawn row, folders included: a folder is what you
  // reach for to act on the branches under it in one go.
  //
  // Folded folders are held by key rather than by row, so a fold survives the
  // list re-reading itself — which it does every two seconds, and which would
  // otherwise flick every folder back open while you were looking at it.
  // Two shapes, and which one is on screen is decided by whether anything has
  // been typed. Folders group the whole set, which is what you are reading with
  // no filter; a ranked list answers a name, which is what you are reading with
  // one. Trying to be both would bury the best match under a heading.
  const tree = useMemo(
    () => (filter.length === 0 ? buildTree(rows, collapsed) : rank(rows, filter)),
    [rows, collapsed, filter],
  );

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
    async (label: string, action: () => Promise<string>, isOutput = false) => {
      store.clear();
      setMessage(undefined);
      // Held as a flag rather than a row count, so a terminal resized while the
      // output is on screen re-divides what it has instead of keeping a number
      // that was right for the old height.
      setRoomy(isOutput);
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
   * The dialog is here and not on the command line because this is the only
   * surface that can hold one. `grove add` has to behave the same in a pipe as
   * under a terminal, so there it prints the commands and skips them; the
   * screen is already a terminal by construction, the worktree is on the row in
   * front of you, and the question is one keystroke from the answer.
   *
   * Nothing is asked when the file has no commands or the answer is already
   * recorded, which is every ordinary repository.
   */
  const askAboutCommands = useCallback(
    async (branch: string) => {
      try {
        const commands = await service.pendingCommands();
        if (commands.length === 0) return;

        setMode({ kind: "confirm", target: { kind: "trust", branch, commands } });
      } catch {
        // The worktree is made and its files are in place; failing to work out
        // whether to ask about the commands is not worth a second red line.
      }
    },
    [service],
  );

  /**
   * `p`, up to the point of asking.
   *
   * Reads before it draws — the popup promises what would be proposed, and a
   * promise built from a row that might be a minute stale is one the enter key
   * could break. The read is quick and the busy state keeps the refresh tick
   * out of the way while it happens.
   */
  const openPr = useCallback(
    async (target: { readonly path: string; readonly dir: string }) => {
      store.clear();
      setMessage(undefined);
      setRoomy(false);
      setMode({ kind: "busy", label: `reading ${target.dir}` });

      try {
        const preview = await service.prPreview(target.path);
        const plural = preview.commits === 1 ? "" : "s";
        // The commits being proposed, whatever shape the body takes — with the
        // title asked for rather than guessed, this block is how you know what
        // you are naming.
        const context = [
          `# ${preview.commits} commit${plural} onto ${preview.base}`,
          ...preview.subjects.map((subject) => `- ${subject}`),
        ];

        return setMode({
          kind: "pr",
          value: "",
          target,
          branch: preview.branch,
          base: preview.base,
          body: preview.body,
          context: capped(context),
        });
      } catch (error) {
        setMessage(messageFor(error));

        return setMode({ kind: "list" });
      }
    },
    [service, store],
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
      // One slot, three claims, one setter: whatever already owns the line —
      // an error, an action's outcome — keeps it; a released upgrade outranks
      // the shell tip because it is news and the shell tip is standing advice.
      setMessage((previous) => {
        if (previous !== undefined) return previous;
        if (latest !== undefined) {
          return {
            kind: "info",
            text: `tip: grove v${latest} is out — this is v${version}`,
            hint: "upgrade: brew upgrade grove",
          };
        }
        // With no shell function listening, half of what this screen does is
        // quietly unavailable — q cannot land the shell where enter walked —
        // and nothing on screen would ever say so. A rule that hides is a rule
        // nobody can learn, so the one line that installs it opens the
        // session, in the message slot the first action reclaims.
        if (onCd === undefined) {
          return {
            kind: "info",
            text: "tip: the shell function is not installed, so q cannot land your shell where you stood",
            hint: `install once: eval "$(grove shell-init zsh)" in your shell's rc file — or bash, fish`,
          };
        }
        return previous;
      });
    })();

    return () => {
      live = false;
    };
  }, [service, onCd, checkUpdate]);

  // Where the shell really is: the standpoint at launch, for `q` to compare
  // against before deciding the shell needs moving at all.
  const startedAt = useRef<string | undefined>(undefined);
  if (startedAt.current === undefined) startedAt.current = service.standpoint();

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

    if (mode.kind === "add" || mode.kind === "pr") {
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        const value = mode.value.trim();
        // Enter on nothing is a cancel, not an error: the empty popup is what
        // "never mind" looks like from inside one.
        if (value.length === 0) return setMode({ kind: "list" });

        if (mode.kind === "pr") {
          return void perform(`opening a PR for ${mode.branch}`, () =>
            service.createPr(mode.target.path, value, mode.body),
          );
        }

        // The question about the file's commands comes after, not instead:
        // `perform` has drawn what the worktree got, and this asks about the
        // half it did not.
        return void perform(`adding ${value}`, () => service.add(value, mode.from)).then(() =>
          askAboutCommands(value),
        );
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

    if (mode.kind === "prompt") {
      // The list is still the thing being looked at, so the keys that move
      // around it still move around it. Only the real arrows — `j` and `k` are
      // letters here, and typing `jk` into a filter should type `jk`.
      if (key.upArrow) return move(-1);
      if (key.downArrow) return move(1);

      // Escape takes one layer at a time: the line first, and the box only once
      // there is no line left to clear. Closing on the first press would mean a
      // typo costs you the box as well as the word.
      if (key.escape) {
        const cleared = typed.current.length > 0;
        typed.current = "";
        setFilter("");

        return setMode(cleared ? { kind: "prompt", value: "" } : { kind: "list" });
      }

      // A paste arrives as one event and carries its own newline, so the text
      // and the `enter` after it are the same keystroke as far as this is
      // concerned. Splitting on the newline is what makes pasting a command and
      // running it one motion rather than a line that silently vanishes.
      const arrived = input.split(/[\r\n]/);
      const submitted = key.return || arrived.length > 1;
      // Printable only: an arrow key arrives as a control sequence that would
      // otherwise type itself into the middle of the line.
      const text = key.ctrl || key.meta ? "" : (arrived[0] ?? "").replace(/[^\x20-\x7e]/g, "");

      // Read from a ref rather than from `mode`, because keys arrive faster than
      // React commits: a paste followed by `enter` in the same frame would have
      // `enter` acting on the line as it was *before* the paste, which is empty.
      let next = typed.current;
      if (key.backspace || key.delete) next = next.slice(0, -1);
      else if (text.length > 0) next = next + text;

      if (next !== typed.current) {
        typed.current = next;
        // Live, rather than on `enter`: narrowing a list you cannot see the
        // effect of is guessing, and the whole value of it is watching rows go.
        setFilter(modeOf(next) === "filter" ? bodyOf(next) : "");
        setMode({ kind: "prompt", value: next });
      }

      if (!submitted) return;

      typed.current = "";

      if (modeOf(next) === "git") {
        const args = tokenize(bodyOf(next));
        if (args.length === 0) return setMode({ kind: "list" });

        // Where the cursor is, or the repository itself when it is on a folder —
        // which is also where a `git worktree`-ish command wants to be run from.
        const at = selected?.path ?? repoRoot;

        // The one action whose output *is* the result, rather than a note about
        // how the result was reached — so it gets the room to be read in.
        return void perform(`git ${args[0]}`, () => service.git(args, at), true);
      }

      // The row survives, the narrowing does not. Filtering is how you found
      // the worktree; what you wanted was the worktree. Pinned explicitly rather
      // than left to the cursor's own anchoring, which only knows where you are
      // if you moved — and typing one name until one row is left is not moving.
      //
      if (current !== undefined) setCursorKey(current.key);
      setFilter("");

      return setMode({ kind: "list" });
    }

    if (mode.kind === "confirm") {
      const target = mode.target;
      if (input === "y" || input === "Y") {
        if (target.kind === "reset") {
          return void perform(`resetting ${target.summary.dir}`, () =>
            service.reset(target.summary.path),
          );
        }

        if (target.kind === "trust") {
          return void perform(`running ${plural(target.commands.length, "command")}`, () =>
            service.trustAndRun(target.branch),
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
    /**
     * Enter moves *you*, inside the app: the standpoint walks to the row the
     * cursor is on, the app stays open, and everything that depends on where
     * you stand follows — the `*` marker, and above all the refusal to remove
     * the worktree you are standing in, which stops applying the moment you
     * step out of it. That is the whole reason this key exists: "cd somewhere
     * else first" is now one keystroke that never leaves the screen.
     *
     * The real shell has not moved — it cannot be moved from here — so `q` is
     * where the two meet: with the shell function listening, quitting hands it
     * the standpoint and the shell lands where you stood. Without it the shell
     * stays put, and `remove` keeps measuring against where it really is.
     *
     * A folder is a real directory on disk, so it is a destination too.
     */
    if (key.return && current !== undefined) {
      // Group keys carry their trailing slash (it is how they are drawn); a
      // path handed around as a location should not.
      const destination =
        current.kind === "group"
          ? join(repoRoot, current.key.replace(/\/+$/, ""))
          : current.summary.path;

      return void perform(`moving to ${current.label ?? destination}`, () =>
        service.moveTo(destination),
      );
    }

    /**
     * `p` proposes, behind a popup that says what it would do before anybody
     * has typed a word. It sits on any branch that is not the trunk: whether
     * there is anything to propose is part of what its popup answers.
     */
    if (input === "p" && selected && !selected.isDefault && !selected.detached) {
      return void openPr({ path: selected.path, dir: selected.dir });
    }
    if (input === "s" && selected) {
      return void perform(`syncing ${selected.dir}`, () => service.sync(selected.path));
    }
    if (input === "S") return void perform("syncing every worktree", () => service.sync());
    if (input === "R") return void perform("reading worktrees", async () => "refreshed");
    if (input === "?") {
      typed.current = filter;

      return setMode({ kind: "prompt", value: filter });
    }
    if (input === "q" || key.escape) {
      // The handoff: the shell function reads this file after the app closes.
      // Only worth writing when the standpoint actually moved — an empty file
      // is the wrapper's cue to leave the shell where it already is.
      const standpoint = service.standpoint();
      if (onCd !== undefined && standpoint !== startedAt.current) {
        return void (async () => {
          await onCd(standpoint);
          exit();
        })();
      }

      return exit();
    }
  });

  // The heading of the trunk column, and the branch it compares against. Read
  // off the rows rather than assumed, because `master` and `trunk` are both
  // things people call it.
  const trunkName = rows.find((summary) => summary.isDefault)?.branch ?? "trunk";

  const hints = useMemo(() => {
    if (mode.kind === "busy") return [{ keys: "ctrl+c", action: "cancel" }];
    if (mode.kind === "prompt") {
      const leave = { keys: "esc", action: mode.value.length > 0 ? "clear" : "close" };

      return modeOf(mode.value) === "git"
        ? [{ keys: "↑↓", action: "move" }, { keys: "enter", action: "run" }, leave]
        : [
            { keys: "↑↓", action: "move" },
            { keys: "enter", action: "select" },
            leave,
            { keys: "!", action: "run git" },
          ];
    }
    if (mode.kind === "add" || mode.kind === "pr") {
      return [
        { keys: "enter", action: mode.kind === "add" ? "add" : "open PR" },
        { keys: "esc", action: "cancel" },
      ];
    }
    if (mode.kind === "confirm") {
      // Named for what `y` actually does, which is not always removing.
      if (mode.target.kind === "trust") {
        return [
          { keys: "y", action: "run it" },
          { keys: "n", action: "skip" },
        ];
      }

      return [
        { keys: "y", action: mode.target.kind === "reset" ? "discard" : "remove" },
        { keys: "n", action: "keep" },
      ];
    }

    // A folder offers what a folder can do. Leaving `s` and `r` on it to mean
    // what they mean on a worktree would be a menu that lies.
    if (current?.kind === "group") {
      return [
        { keys: "↑↓", action: "move" },
        { keys: "←→", action: current.collapsed ? "open" : "fold" },
        { keys: "enter", action: "go" },
        { keys: "?", action: "filter · !git" },
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
      { keys: "enter", action: "go" },
      { keys: "?", action: "filter · !git" },
      { keys: "a", action: "add" },
      { keys: "r", action: "remove" },
      ...(selected?.dirty === true ? [{ keys: "x", action: "discard" }] : []),
      ...(selected !== undefined && !selected.isDefault && !selected.detached
        ? [{ keys: "p", action: "PR" }]
        : []),
      { keys: "s", action: "sync" },
      { keys: "S", action: "sync all" },
      { keys: "R", action: "refresh" },
      { keys: "q", action: "quit" },
    ];
  }, [mode, current, under.length, selected]);

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
    (mode.kind === "prompt" ? PROMPT_ROWS : 0) +
    (mode.kind === "add" ? 3 : 0) +
    (mode.kind === "pr" ? 3 + mode.context.length : 0) +
    (mode.kind === "confirm" ? 1 : 0) +
    (message === undefined || mode.kind === "busy" ? 0 : message.hint === undefined ? 1 : 2);

  /**
   * How many rows the activity area may take, out of what is actually left.
   *
   * Asked of the leftovers rather than of the terminal, because a share of the
   * whole is a number that can exceed the space there is: 200 lines of `git log`
   * with `Math.max(1, …)` holding the list open underneath adds up to more rows
   * than the terminal has, and Ink draws the overflow on top of the banner.
   *
   * The list keeps a floor either way. It is the thing being worked in, and a
   * screen that answers one question by hiding the other is not an improvement.
   */
  const spare = terminalRows - headerRows - detailRows - footerRows - MIN_LIST_ROWS - 1;
  const wanted = roomy ? Math.floor(terminalRows * OUTPUT_SHARE) : ACTIVITY_ROWS;
  const room = Math.max(0, Math.min(wanted, spare));

  // What did not fit is said rather than silently dropped — the whole reason
  // this exists is that a line went missing off the top without saying so.
  const clipped = Math.max(0, lines.length - room);
  // `room - 1` can reach zero, and `slice(-0)` is the whole array — which on a
  // cramped screen is every line drawn over whatever sat below the activity.
  const activity = clipped > 0 ? (room > 1 ? lines.slice(-(room - 1)) : []) : lines;
  const activityRows = activity.length > 0 ? activity.length + (clipped > 0 ? 1 : 0) + 1 : 0;

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

      {mode.kind === "prompt" ? (
        <Prompt
          value={mode.value}
          mode={modeOf(mode.value)}
          columns={columns}
          where={selected?.dir ?? "the repository"}
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
            <Text color={theme.accent}>{mode.value}</Text>
            <Text inverse> </Text>
          </Text>
        </Box>
      ) : null}

      {mode.kind === "pr" ? (
        // The title being typed, and under it the commits the decision rests
        // on. Dimmed because it is context, not content: what is typed is the
        // only part that leaves the popup.
        <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column">
          <Text wrap="truncate">
            <Text dimColor>{`PR ${mode.branch} → ${mode.base}   `}</Text>
            <Text color={theme.accent}>{mode.value}</Text>
            <Text inverse> </Text>
          </Text>
          {mode.context.map((line, index) => (
            // Index keys, because two files can produce the same line and the
            // block never reorders while it is up.
            // biome-ignore lint/suspicious/noArrayIndexKey: static block
            <Text key={index} dimColor wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {mode.kind === "confirm" ? (
        // Red for the reset, amber for the removals, because they are not the
        // same risk: a removed worktree leaves its branch and its commits behind
        // and `grove add` brings it back, while a reset leaves nothing at all.
        // The configure question is neither — nothing it writes destroys
        // anything — so it is asked in the colour of an ordinary line.
        <Text color={colourFor(mode.target)} wrap="truncate">
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
