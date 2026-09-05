import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { version } from "../../../package.json";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import { pullRequestFor } from "../../core/commands/pr.ts";
import type { StackResult } from "../../core/commands/stack.ts";
import type { Commit } from "../../core/history.ts";
import { upgradeHint } from "../../core/install-channel.ts";
import { plural } from "../../core/text.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";
import { Banner } from "./Banner.tsx";
import { Bases } from "./Bases.tsx";
import { Files } from "./Files.tsx";
import { Log } from "./Log.tsx";
import { columnWidths, GAP, hintsFor, LOG_ROWS, regionsFor } from "./layout.ts";
import { type CommandName, commandsFor, Menu, matching } from "./Menu.tsx";
import { MessageView } from "./MessageView.tsx";
import { type Message, messageFor } from "./message.ts";
import type { Mode } from "./mode.ts";
import { PullRequests } from "./PullRequests.tsx";
import { commitPending, describePending, type Pending, wouldForcePush } from "./pending.ts";
import { padTo, Row } from "./Row.tsx";
import { Stack } from "./Stack.tsx";
import type { WorktreeService } from "./service.ts";
import { pathOf } from "./tree.ts";
import { editPrompt, typed } from "./typing.ts";
import { useCommandRunner } from "./useCommandRunner.ts";
import { LOCAL_REFRESH_MS, REMOTE_REFRESH_MS, useWorktreeRefresh } from "./useWorktreeRefresh.ts";
import { useWorktreeSelection } from "./useWorktreeSelection.ts";

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

type Props = {
  readonly initialSetup?: boolean;
  readonly service: WorktreeService;
  /** Shown in the header; the repository the keystrokes act on. */
  readonly repoRoot: string;
  /** Progress from the commands the keys start. */
  readonly store: LineStore;
  /** Ctrl-C while busy: stop the git child before the screen goes away. */
  readonly onCancel?: () => void;
  /** How often to refresh, in ms. Defaults to `LOCAL_REFRESH_MS`; tests drive it faster. */
  readonly refreshMs?: number;
  readonly remoteRefreshMs?: number;
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

const TIP_ROTATE_MS = 60_000;

// Standing advice about features that are easy to miss, shown alongside
// whatever the session earned (a release waiting to be upgraded to) so the
// slot always has more than one thing to say and rotation is never a no-op.
const GENERAL_TIPS: readonly Message[] = [
  { kind: "info", text: "tip: h and l don't stop at the first fold — they keep going" },
  {
    kind: "info",
    text: "tip: a starts from the latest trunk; A branches from the selected worktree",
  },
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
  {
    kind: "info",
    text: "tip: setup stale on a row means .grove.toml changed since it was filled in",
    hint: "/ setup catches it up, or `grove setup --all` catches up every one",
  },
  {
    kind: "info",
    text: "tip: x keeps a copy of what it discards — the line under it says how to get it back",
  },
  {
    kind: "info",
    text: "tip: the pr column is the forge's word — ✓ ✗ · for the checks, then what the reviewers said",
    hint: "read through gh once a minute; a repository gh cannot reach has no column",
  },
  {
    kind: "info",
    text: "tip: a row indented under another sits on it — the panel beside the list draws the whole stack",
    hint: "`grove stack` prints the same picture, and `propose --stack` opens every pull request in it",
  },
];

export function App({
  initialSetup = false,
  service,
  repoRoot,
  store,
  onCancel,
  refreshMs = LOCAL_REFRESH_MS,
  remoteRefreshMs = REMOTE_REFRESH_MS,
  tipRotateMs = TIP_ROTATE_MS,
  checkUpdate,
  columns: columnsOverride,
  rows: rowsOverride,
}: Props) {
  const { exit } = useApp();
  const live = useWindowSize();
  const columns = columnsOverride ?? live.columns;
  const terminalRows = rowsOverride ?? live.rows;
  const [mode, setMode] = useState<Mode>({ kind: "busy", label: "reading worktrees" });
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const { rows, refresh, noteInput, pullRequests, remoteStatus } = useWorktreeRefresh(
    service,
    mode.kind === "busy",
    refreshMs,
    remoteRefreshMs,
  );
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
  /**
   * The stack the row under the cursor is in, for the panel beside the list.
   *
   * Held with the path it was read for, the way the commits are, and for the
   * same reason: a read for the row before is still on its way back, and a
   * picture under this row's heading has to be this row's picture.
   */
  const [stack, setStack] = useState<
    { readonly path: string; readonly result: StackResult } | undefined
  >(undefined);

  const lines = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  /**
   * The rows with the forge's answer on each, for the ones it had one for.
   *
   * Matched here rather than in `list`, which never asks the forge: the
   * summary carries the field so the row and the column can be drawn from
   * one object, and this is where the two reads meet. Nothing listed means
   * the rows as git gave them, which is also the whole screen before the
   * first answer arrives and after every one that failed.
   */
  const badged = useMemo(() => {
    if (pullRequests.length === 0) return rows;

    return rows.map((row) => {
      const pullRequest =
        row.branch === undefined ? undefined : pullRequestFor(pullRequests, row.branch);

      return pullRequest === undefined ? row : { ...row, pullRequest };
    });
  }, [rows, pullRequests]);

  const { tree, index, current, selected, under, move, traverse } = useWorktreeSelection(badged);
  const { busy, perform } = useCommandRunner(store, refresh, setMode, setMessage);

  /**
   * Refetch and re-read, and hand the rows back as well as drawing them.
   *
   * This is for the caller that has to *decide* on what came back, before the
   * screen is drawn from it.
   */
  const reread = useCallback(async (): Promise<readonly WorktreeSummary[]> => {
    // Reports `false` rather than throwing when it cannot reach the remote, and
    // that is left alone here on purpose: offline, the push at the end of the
    // sync fails too, so no force-push anybody was not asked about reaches
    // anything. What is stale is the question, not the answer.
    await service.fetch();
    return refresh();
  }, [service, refresh]);

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

          // Only a push that rewrites remote commits needs confirmation.
          if (wouldForcePush(now)) return { kind: "sync", summary: now };

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
   * `/propose`: find out where the pull request would go, then ask — or say
   * which one already exists.
   *
   * `askThen`'s shape, and the base is why the question is worth putting up
   * at all: a stacked branch goes onto its parent, and that is a fact to read
   * before it reaches other people's screens. The probe asks the forge on the
   * way, so a branch that already has a pull request is answered on the
   * message line rather than proposed twice — `openPrs`'s rule for an empty
   * list, applied to a full one.
   */
  const beginPropose = useCallback(
    async (summary: WorktreeSummary) => {
      busy(`checking ${summary.dir}`);

      try {
        const proposal = await service.pendingPropose(summary.path);
        if (proposal.existing === undefined) {
          return setMode({ kind: "confirm", target: { kind: "propose", summary, proposal } });
        }

        const { number, base, url } = proposal.existing;
        setMessage({
          kind: "info",
          text: `pull request ${number} already proposes ${summary.dir} onto ${base}`,
          hint: url,
        });
      } catch (error) {
        setMessage(messageFor(error));
      }

      setMode({ kind: "list" });
    },
    [busy, service],
  );

  /** Offer unapproved commands after creating a development or review checkout. */
  const runPendingCommands = useCallback(
    async (branch: string) => {
      try {
        const commands = await service.pendingCommands(branch);
        if (commands.length === 0) return;

        setMode({ kind: "confirm", target: { kind: "trust-setup", branch, commands, open: true } });
      } catch {
        // The worktree is made and its files are in place; failing to work out
        // whether there were commands to run is not worth a second red line.
      }
    },
    [service],
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

  /**
   * `/rebase`: read the bases for the row, then draw them to pick from.
   *
   * `openPrs`'s shape, for `openPrs`'s reason: the answer is a popup, not a
   * line, and `busy` is the loading state that comes with it. There is no
   * empty case to say anything about — the trunk is always on the list — so
   * the only way back to the list without a popup is a refusal.
   */
  const beginRebase = useCallback(
    async (summary: WorktreeSummary) => {
      busy(`reading bases for ${summary.dir}`);

      try {
        const choices = await service.rebaseChoices(summary.path);
        setMode({ kind: "onto", summary, choices, index: 0 });

        return;
      } catch (error) {
        setMessage(messageFor(error));
      }

      setMode({ kind: "list" });
    },
    [busy, service],
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
        await refresh();
      } catch (error) {
        if (live) setMessage(messageFor(error));
        return;
      } finally {
        if (live) setMode({ kind: "list" });
      }

      if (initialSetup && live) {
        const worktrees = await service.list();
        const main = worktrees.find((row) => row.isDefault);
        if (main) await runPendingCommands(main.branch ?? main.path);
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
          hint: upgradeHint(),
        });
      }
      tips.push(...GENERAL_TIPS);

      setTipPool(tips);
      setMessage((previous) => (previous !== undefined ? previous : tips[0]));
    })();

    return () => {
      live = false;
    };
  }, [refresh, checkUpdate, initialSetup, service, runPendingCommands]);

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
   * The stack for the row under the cursor, read when it could have changed.
   *
   * `log`'s shape, and only for a row that is in a stack: one that sits on
   * another branch, or that another branch sits on. Every other row — which is
   * every row in most repositories — asks nothing and draws nothing. The read
   * is a handful of `rev-list` calls, one per edge, which is why it is asked
   * of the one row being looked at rather than of every row on the tick.
   */
  const stacked =
    selected !== undefined &&
    (selected.parent !== undefined || rows.some((row) => row.parent === selected.branch));

  useEffect(() => {
    const target = rows.find((summary) => summary.path === selectedPath);
    if (!stacked || target === undefined) return;

    let live = true;

    void service.stack(target.path).then(
      (result) => {
        if (live) setStack({ path: target.path, result });
      },
      () => {
        if (live) setStack(undefined);
      },
    );

    return () => {
      live = false;
    };
  }, [stacked, selectedPath, rows, service]);

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
          return void askThen(
            "reading setup",
            async () => {
              const commands = await service.pendingCommands(selected.path);
              return commands.length
                ? { kind: "trust-setup", branch: selected.path, commands }
                : undefined;
            },
            () => void perform(`filling in ${selected.dir}`, () => service.setup(selected.path)),
          );
        // The third row-aimed command, and the one whose question has more
        // than two answers — so it opens a popup rather than a `confirm`.
        case "rebase":
          if (!selected) return;
          return void beginRebase(selected);
        // Row-aimed like the three above, and a `confirm` rather than a
        // popup: the only thing to choose is whether to send it.
        case "propose":
          if (!selected) return;
          return void beginPropose(selected);
        case "sync-all":
          return void beginSyncAll();
        case "prune":
          return void beginPrune();
        case "review":
          return void openPrs();
        case "upstream":
          return setMode({ kind: "upstream", value: "", caret: 0 });
        case "refresh":
          return void perform("reading worktrees", async () => "refreshed");
        // A view, not an action: nothing is read, nothing is written, and the
        // rows it gives back go straight to the list.
        case "log":
          return setLogOn((on) => !on);
      }
    },
    [
      perform,
      beginOpen,
      askThen,
      beginRebase,
      beginPropose,
      beginSyncAll,
      beginPrune,
      openPrs,
      selected,
      service,
    ],
  );

  useInput((input, key) => {
    // Any key is "somebody's here," whatever it does — including the ones
    // handled below that leave the mode untouched. Snapping the delay back
    // now, rather than waiting for the next tick to notice, is what keeps a
    // backed-off clock from making the screen wait minutes for its first
    // refresh after being read again.
    noteInput();

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

    if (mode.kind === "onto") {
      // The picker's keys, for the picker's reasons: arrows and enter, clamped
      // at both ends, and nothing that types.
      if (key.escape || input === "q") return setMode({ kind: "list" });
      if (key.upArrow || input === "k") {
        return setMode((now) =>
          now.kind === "onto" ? { ...now, index: Math.max(0, now.index - 1) } : now,
        );
      }
      if (key.downArrow || input === "j") {
        return setMode((now) =>
          now.kind === "onto"
            ? { ...now, index: Math.min(now.choices.length - 1, now.index + 1) }
            : now,
        );
      }
      if (key.return) {
        const choice = mode.choices[mode.index];
        if (choice === undefined) return setMode({ kind: "list" });

        return void perform(`rebasing ${mode.summary.dir} onto ${choice.ref}`, () =>
          service.rebase(mode.summary.path, choice.base),
        );
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

    if (mode.kind === "upstream") {
      if (key.escape) return setMode({ kind: "list" });
      if (key.return) {
        const url = mode.value.trim();
        if (url.length === 0) return setMode({ kind: "list" });

        // Asked only where it would replace a remote somebody chose; the URL
        // typed here is the consent for everything else it does.
        return void (async () => {
          const existing = await service.pendingUpstream(url);
          if (existing !== undefined) {
            return setMode({ kind: "confirm", target: { kind: "upstream", url, existing } });
          }

          return perform(`following ${url}`, () => service.upstream(url));
        })();
      }

      return setMode((now) =>
        now.kind === "upstream" ? (editPrompt(now, input, key) ?? now) : now,
      );
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

    if (key.rightArrow || input === "l") return traverse(1);
    if (key.leftArrow || input === "h") return traverse(-1);

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

    // Preserve a folder prefix for both actions; only A uses the selected local base.
    if (input === "a" || input === "A") {
      const value = current?.kind === "group" ? current.key : "";

      return setMode({
        kind: "add",
        value,
        caret: value.length,
        from: input === "A" ? selected?.branch : undefined,
      });
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
  const { prBody, baseBody, menuBody, clipped, activity, logBody, logHeight, listHeight, visible } =
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

  /**
   * The stack panel's width, out of the same slack — and only when the files
   * are not in it.
   *
   * The files win: what is uncommitted is the thing about to be lost or
   * carried, and where the branch sits is a fact that keeps. Drawn only from a
   * read made for this row, so a picture of the row before never sits under
   * this row's name.
   */
  const stackShown =
    filesWidth === 0 && stacked && selected !== undefined && stack?.path === selected.path
      ? stack.result
      : undefined;
  const stackWidth =
    stackShown !== undefined && widths.slack >= MIN_FILES_COLS
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
      <Box height={1}>
        <Text dimColor wrap="truncate">
          {remoteStatus}
        </Text>
      </Box>

      {labelled ? (
        <Text dimColor wrap="truncate">
          {"    "}
          {padTo("worktree", widths.tree)}
          {GAP}
          {widths.remote > 0 ? `${padTo("remote", widths.remote)}${GAP}` : ""}
          {/* Named after the branch it compares against, since `master` and
              `trunk` are both things people call it. */}
          {widths.trunk > 0 ? `${padTo(trunkName, widths.trunk)}${GAP}` : ""}
          {/* The forge's column, only when the forge had something to say
              about some row: a heading over a column of blanks would be
              the screen announcing a feature it has nothing to show for. */}
          {widths.pr > 0 ? `${padTo("pr", widths.pr)}${GAP}` : ""}
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

        {stackWidth > 0 && stackShown !== undefined && selected?.branch !== undefined ? (
          <Stack
            result={stackShown}
            selected={selected.branch}
            rows={listHeight}
            width={stackWidth}
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

      {mode.kind === "onto" ? (
        <Bases dir={mode.summary.dir} choices={mode.choices} index={mode.index} rows={baseBody} />
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
              {mode.from === undefined
                ? `new branch from remote ${trunkName}   `
                : `new branch from ${mode.from}   `}
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

      {mode.kind === "upstream" ? (
        // What enter will do, said above the box rather than asked afterwards:
        // reading these two lines is the agreement, the way the first-run
        // screen says what a clone does before the URL is typed.
        <Box flexDirection="column">
          <Text dimColor wrap="truncate">
            {trunkName} will be measured against this repository's trunk from now on.
          </Text>
          <Text dimColor wrap="truncate">
            Your branches still go to origin.
          </Text>
          <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
            <Text wrap="truncate">
              <Text dimColor>upstream </Text>
              <Text color={theme.accent}>{mode.value.slice(0, mode.caret)}</Text>
              <Text inverse>{mode.value.slice(mode.caret, mode.caret + 1) || " "}</Text>
              <Text color={theme.accent}>{mode.value.slice(mode.caret + 1)}</Text>
            </Text>
          </Box>
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
