import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { version } from "../../../package.json";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import type { PullRequest } from "../../core/commands/pr.ts";
import type { Commit } from "../../core/history.ts";
import { plural } from "../../core/text.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";
import { Banner } from "./Banner.tsx";
import { Files } from "./Files.tsx";
import { Log } from "./Log.tsx";
import { columnWidths, GAP, hintsFor, LOG_ROWS, regionsFor } from "./layout.ts";
import { type CommandName, commandsFor, Menu, matching } from "./Menu.tsx";
import { MessageView } from "./MessageView.tsx";
import { type Message, messageFor } from "./message.ts";
import { PullRequests } from "./PullRequests.tsx";
import {
  commitPending,
  describePending,
  type Pending,
  wouldForcePush,
  wouldPublish,
} from "./pending.ts";
import { padTo, Row } from "./Row.tsx";
import type { WorktreeService } from "./service.ts";
import { buildTree, firstChildOf, parentOf, pathOf } from "./tree.ts";
import { editPrompt, type Prompt, typed } from "./typing.ts";

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

type Mode =
  | { readonly kind: "list" }
  /**
   * `from` is the branch the new one starts on, taken from wherever the cursor
   * was when the prompt opened — not from wherever it is when you press enter.
   * The list re-reads itself on a timer, and a base that could change while you
   * were still typing the name would be a different branch than the one the
   * prompt said.
   */
  | ({ readonly kind: "add"; readonly from?: string } & Prompt)
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

/** A new set with `key` flipped in or out — `Set` is mutable and state is not. */
function toggled(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);

  return next;
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
   * The keys blocked and the last answer gone — how every action starts,
   * whether it ends in a message or in a question.
   */
  const busy = useCallback(
    (label: string) => {
      store.clear();
      setMessage(undefined);
      setMode({ kind: "busy", label });
    },
    [store],
  );

  /**
   * Every action, in one shape: clear the last run's lines, block the keys,
   * then say what happened whether it worked or not.
   */
  const perform = useCallback(
    async (label: string, action: () => Promise<string>) => {
      busy(label);

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
    [busy, refresh],
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
   * Ask first, act second — the shape `s`, `/sync-all` and `/open` share.
   *
   * The probe finds the question worth putting up, or `undefined` where there
   * is none. A probe that *fails* falls through to the action too: it is about
   * to do the same work, and will say what went wrong in its own words.
   */
  const askThen = useCallback(
    async (checking: string, probe: () => Promise<Pending | undefined>, act: () => void) => {
      busy(checking);

      let target: Pending | undefined;
      try {
        target = await probe();
      } catch {
        return act();
      }

      return target === undefined ? act() : setMode({ kind: "confirm", target });
    },
    [busy],
  );

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
    (summary: WorktreeSummary) =>
      askThen(
        `checking ${summary.dir}`,
        async () => {
          // Gone from under the cursor between the keystroke and the fetch is
          // not a question: `sync` resolves the target itself and says so
          // properly.
          const now = (await reread()).find((row) => row.path === summary.path);
          if (now === undefined) return undefined;

          // Two questions, and a row can only need one of them: a branch on no
          // remote has nothing there to rewrite.
          if (wouldForcePush(now)) return { kind: "sync", summary: now };
          if (wouldPublish(now)) return { kind: "publish", summary: now };

          return undefined;
        },
        () => void perform(`syncing ${summary.dir}`, () => service.sync(summary.path)),
      ),
    [askThen, perform, reread, service],
  );

  /** The same question for `/sync-all`, asked once for however many it covers. */
  const beginSyncAll = useCallback(
    () =>
      askThen(
        "checking every worktree",
        async () => {
          const count = (await reread()).filter(wouldForcePush).length;

          return count > 0 ? { kind: "sync-all", count } : undefined;
        },
        () => void perform("syncing every worktree", () => service.sync()),
      ),
    [askThen, perform, reread, service],
  );

  /**
   * `/prune`: find out what is finished with, then ask about it by name.
   *
   * The dry run is the question. The list already badges these rows, but a
   * badge is not a list of what one key is about to remove, and the whole
   * argument for `r` confirming is that the directory is named before it goes.
   * Nothing finished is not a question — it falls through to the run, which
   * says so in `prune`'s own words rather than in a second copy of them here.
   */
  const beginPrune = useCallback(
    () =>
      askThen(
        "looking for finished worktrees",
        async () => {
          const result = await service.pendingPrune();
          const going = result.entries.some((entry) => entry.skipped === undefined);

          return going ? { kind: "prune", result } : undefined;
        },
        () => void perform("pruning finished worktrees", () => service.prune()),
      ),
    [askThen, perform, service],
  );

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
    (summary: WorktreeSummary) =>
      askThen(
        `opening ${summary.dir}`,
        async () => {
          const waiting = await service.pendingOpen(summary.path);

          return waiting === undefined ? undefined : { kind: "trust-open", summary, waiting };
        },
        () => void perform(`opening ${summary.dir}`, () => service.open(summary.path)),
      ),
    [askThen, perform, service],
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
    busy("reading pull requests");

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
  }, [busy, service]);

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
        case "prune":
          return void beginPrune();
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
    [perform, beginOpen, beginSyncAll, beginPrune, openPrs, selected, service],
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
      if (typed(input, key)) {
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

      // Applied to the mode inside the updater and not to the one this handler
      // was built with — the same guard `move` puts on the cursor, and for the
      // same reason: a frame can carry several keys, and each has to start from
      // what the one before it left. A key `editPrompt` does not take comes
      // back as the mode itself, which React draws nothing for.
      return setMode((now) => (now.kind === "add" ? (editPrompt(now, input, key) ?? now) : now));
    }

    if (mode.kind === "confirm") {
      // `y` is the only key that commits; everything else is the `no` it reads
      // as. What `y` runs is decided in `pending.ts` beside the words it was
      // asked in, so the question and its consequence cannot drift apart.
      if (input !== "y" && input !== "Y") return setMode({ kind: "list" });

      const { label, run } = commitPending(mode.target, service);

      return void perform(label, run);
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
              <Text dimColor wrap="truncate">{`… ${plural(clipped, "earlier line")}`}</Text>
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
