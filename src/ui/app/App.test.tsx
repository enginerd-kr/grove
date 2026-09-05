import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { render } from "ink-testing-library";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import type { BranchPullRequest, PullRequest } from "../../core/commands/pr.ts";
import type { RebaseBase, RebaseChoice } from "../../core/commands/rebase.ts";
import { GroveError } from "../../core/errors.ts";
import type { Commit } from "../../core/history.ts";
import { LineStore } from "../../report/lines.ts";
import { keys, nextFrame, plain, waitFor } from "../test-utils.ts";
import { theme } from "../theme.ts";
import { App } from "./App.tsx";
import { commandsFor } from "./Menu.tsx";
import { describePending, wouldForcePush, wouldPublish } from "./pending.ts";
import type { WorktreeService } from "./service.ts";
import { buildTree, pathOf, type TreeRow } from "./tree.ts";

/**
 * The screen, driven by keystrokes against a stubbed service.
 *
 * No git, no repository, no terminal: what is checked here is that a key
 * reaches the action it claims to, that the mode machine ends up where it says,
 * and that what comes back is drawn. Whether the actions themselves do the
 * right thing is `core/commands`' own tests, and whether the arithmetic adds up
 * is `layout.test.ts`'s.
 *
 * `App.e2e.test.tsx` already drives the keys that decide what the app *is*
 * through a real pseudo-terminal — the list paints, the cursor moves, `r` asks
 * first, `a` opens the prompt, `L` toggles the panel, ctrl-c exits 130 — so
 * none of that is repeated here. What is here is the half a PTY suite cannot
 * afford to reach: every wording of the removal question, the caret inside the
 * add prompt, and the transitions between the four modes.
 *
 * Colours are asserted through `describePending`, which hands its colour back
 * as a value, and nowhere else: chalk writes no escape sequences into a frame
 * rendered without a terminal, so a colour is simply not in the text these
 * tests read.
 */

/**
 * How long a frame is given to arrive, and how long a whole test is.
 *
 * Generous on purpose. `waitFor`'s own default is a second, which is right for
 * a predicate that has already failed — but every wait here is on a React
 * render behind a promise behind a timer, and a machine with a test suite of
 * its own running beside this one can spend a second not scheduling any of
 * them. Being slow is not the same as being wrong, and a suite that goes red
 * when the laptop is busy is a suite nobody trusts.
 */
const WAIT = 10_000;
setDefaultTimeout(30_000);

function summary(overrides: Partial<WorktreeSummary> & { readonly dir: string }): WorktreeSummary {
  return {
    path: `/repo/${overrides.dir}`,
    branch: overrides.dir,
    detached: false,
    dirty: false,
    changed: 0,
    untracked: 0,
    files: [],
    // Tracking by default, because git only reports ahead/behind for a branch
    // that has an upstream — a summary with counts and no upstream is a state
    // no repository can be in.
    upstream: `origin/${overrides.dir}`,
    ahead: 0,
    behind: 0,
    locked: false,
    rebasing: false,
    setupStale: false,
    isDefault: false,
    publishRemote: "origin",
    current: false,
    ...overrides,
  };
}

// Drawn as `main`, `feat/`, `login`, `search` — four rows the cursor walks, of
// which one is a folder.
const ROWS: readonly WorktreeSummary[] = [
  summary({ dir: "main", isDefault: true, current: true }),
  summary({ dir: "feat/login", ahead: 2, trunk: { ahead: 5, behind: 3 } }),
  summary({ dir: "feat/search", trunk: { ahead: 1, behind: 0 } }),
];

/** What `rebaseChoices` answers for a branch on no remote in a repository with no other worktree. */
const TRUNK_ONLY: readonly RebaseChoice[] = [
  { base: { kind: "trunk" }, ref: "origin/main", label: "trunk" },
];

/** What the forge says about a branch, for the `pr` column. */
function badge(head: string, overrides: Partial<BranchPullRequest> = {}): BranchPullRequest {
  return {
    number: 42,
    url: "https://forge/pull/42",
    head,
    base: "main",
    isDraft: false,
    conflicts: false,
    ...overrides,
  };
}

function pullRequest(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `Change number ${number}`,
    author: "someone",
    isDraft: false,
    headRefName: `feat/pr-${number}`,
    updatedAt: Date.now(),
    ...overrides,
  };
}

type Calls = {
  fetched: number;
  readonly logged: string[];
  readonly copied: string[];
  readonly added: { branch: string; from?: string }[];
  readonly removed: { target: string; discardDirty?: boolean }[];
  readonly removedMany: { targets: readonly string[]; discardDirty?: boolean }[];
  readonly discarded: string[];
  readonly checkedOut: number[];
  readonly synced: (string | undefined)[];
  /** The targets `sync` was told to publish, apart from the syncs themselves. */
  readonly published: string[];
  readonly rebased: { target: string; base: RebaseBase }[];
  readonly proposed: string[];
  pruned: number;
  readonly opened: { target: string; trust: boolean }[];
  readonly filledIn: string[];
  readonly trusted: string[];
  readonly followed: { url: string; force: boolean }[];
};

function stub(overrides: Partial<WorktreeService> = {}): {
  service: WorktreeService;
  calls: Calls;
} {
  const calls: Calls = {
    fetched: 0,
    logged: [],
    copied: [],
    added: [],
    removed: [],
    removedMany: [],
    discarded: [],
    checkedOut: [],
    synced: [],
    published: [],
    rebased: [],
    proposed: [],
    pruned: 0,
    opened: [],
    filledIn: [],
    trusted: [],
    followed: [],
  };

  return {
    calls,
    service: {
      // A fresh array per call, as the real service gives: it rebuilds every
      // summary from git each time. Returning the same reference would let
      // React skip the re-render and quietly make the polling tests prove
      // nothing.
      list: async () => [...ROWS],
      // Answering "nothing changed" keeps the background fetch out of every
      // other test: no re-read, so no frame nobody was waiting for.
      fetch: async () => {
        calls.fetched += 1;
        return false;
      },
      // No commits by default, so the panel under the list draws its
      // `no commits on this branch yet` note and never a subject a
      // `not.toContain` would trip over.
      log: async (path): Promise<readonly Commit[]> => {
        calls.logged.push(path);
        return [];
      },
      // The trunk alone by default: no row in `ROWS` is stacked, so this is
      // never asked; the test about the panel hands over rows of its own.
      stack: async () => ({ trunk: "main", rows: [] }),
      copyPath: async (path) => {
        calls.copied.push(path);
        return `copied ${path}`;
      },
      add: async (branch, from) => {
        calls.added.push({ branch, from });
        return `added ${branch}`;
      },
      remove: async (target, discardDirty) => {
        calls.removed.push({ target, discardDirty });
        return `removed ${target}`;
      },
      removeMany: async (targets, discardDirty) => {
        calls.removedMany.push({ targets, discardDirty });
        return `removed ${targets.length} worktrees`;
      },
      reset: async (target) => {
        calls.discarded.push(target);
        return `discarded 2 changes in ${target}`;
      },
      open: async (target, trust = false) => {
        calls.opened.push({ target, trust });
        return `opened ${target} with code .`;
      },
      // Nothing waiting by default, the way `pendingCommands` answers nothing:
      // a file already read here is every ordinary repository, and `/open`
      // there opens rather than asking.
      pendingOpen: async () => undefined,
      setup: async (target) => {
        calls.filledIn.push(target);
        return `2 copied, 1 run in ${target}`;
      },
      // Nothing open by default: the popup is the thing being tested when it is
      // being tested, and everywhere else `p` should be a message line.
      pullRequests: async () => [],
      // Nothing from the forge by default, so the `pr` column is absent from
      // every frame the other tests read; the tests about the column hand
      // over an answer of their own.
      branchPullRequests: async () => [],
      checkoutPr: async (number) => {
        calls.checkedOut.push(number);
        return `added pr/${number} — Change number ${number}`;
      },
      sync: async (target, options) => {
        calls.synced.push(target);
        if (options?.publish && target !== undefined) calls.published.push(target);
        return "1 up-to-date";
      },
      // The trunk and nothing else by default — the list is never empty, and
      // the test about the popup hands over rows of its own.
      rebaseChoices: async () => [...TRUNK_ONLY],
      rebase: async (target, base) => {
        calls.rebased.push({ target, base });
        return `${target} rebased onto origin/main`;
      },
      // Onto the trunk, already published, and no pull request yet: the
      // question `/propose` asks over an ordinary row. The tests about the
      // stack and about an existing pull request hand over answers of their own.
      pendingPropose: async () => ({ base: "main", remote: "origin", publish: false }),
      propose: async (target) => {
        calls.proposed.push(target);
        return `opened pull request 7 for ${target} onto main — https://forge/pull/7`;
      },
      // Nothing waiting by default, which is every repository with no
      // `.grove.toml` and every one whose file is already trusted: nothing runs
      // after `a`, and the other tests never see a second action.
      pendingCommands: async () => [],
      trustAndRun: async (branch) => {
        calls.trusted.push(branch);
        return `1 run in ${branch}`;
      },
      // Nothing finished by default, so `/prune` runs and says so without a
      // question; the test about the question hands over entries of its own.
      pendingPrune: async () => ({ entries: [], dryRun: true }),
      prune: async () => {
        calls.pruned += 1;
        return "nothing is finished with";
      },
      // No `upstream` remote by default, so `/upstream` runs without a question.
      pendingUpstream: async () => undefined,
      upstream: async (url, force = false) => {
        calls.followed.push({ url, force });
        return `main now follows upstream/main; branches are pushed to origin`;
      },
      ...overrides,
    },
  };
}

/**
 * Every screen a test opened, unmounted once it is over.
 *
 * The app holds two intervals — the refresh clock and the tip rotation — and an
 * `ink-testing-library` instance that is never unmounted leaves both of them
 * ticking against a component nobody is looking at any more, into the next
 * test's run.
 */
const opened: { unmount: () => void }[] = [];

afterEach(() => {
  for (const instance of opened.splice(0)) instance.unmount();
});

/**
 * The app at a size nothing here has to reason about.
 *
 * Pinned rather than left to `useWindowSize`: `ink-testing-library`'s stub
 * stdout never reports a row count, so Ink falls back to asking the real
 * terminal running the tests — and a banner that turns roomy or narrow with
 * whatever window happens to be open is not a size any test meant to assert
 * against. 24 rows keeps the banner in its one-line form; 100 columns is wide
 * enough for every column of the list to survive.
 */
function mount(
  service: WorktreeService,
  { refreshMs, remoteRefreshMs, store = new LineStore(), columns = 100 }: MountOptions = {},
) {
  const instance = render(
    <App
      service={service}
      repoRoot="/repo"
      store={store}
      refreshMs={refreshMs}
      remoteRefreshMs={remoteRefreshMs}
      columns={columns}
      rows={24}
    />,
  );
  opened.push(instance);

  return { ...instance, frame: () => plain(instance.lastFrame()) };
}

type MountOptions = {
  readonly refreshMs?: number;
  readonly remoteRefreshMs?: number;
  readonly store?: LineStore;
  readonly columns?: number;
};

/** The app, opened and holding a list — where every keystroke test starts. */
async function opened_with(service: WorktreeService, options?: MountOptions) {
  const ui = mount(service, options);
  await settled(ui, (frame) => frame.includes("login"));

  return ui;
}

type Driven = { readonly stdin: { readonly write: (data: string) => void } };

/**
 * One key, and the frame it caused, before the next one is sent.
 *
 * Not politeness, but not correctness either any more: every popup edit now
 * resolves its mode inside the `setMode` updater, the way `move` always has
 * for the cursor, so a frame carrying several keys keeps all of them — which
 * is what "the add prompt keeps every key of a frame" pins. Sending one key
 * per frame is what makes a test read like the thing it describes, and it is
 * how `App.e2e.test.tsx` drives the real binary too.
 *
 * Driving a key per frame is what keeps the tests below about the caret rather
 * than about that difference — which is pinned on its own, once, in `the keys`.
 */
async function press(ui: Driven, key: string): Promise<void> {
  ui.stdin.write(key);
  await nextFrame();
}

/** `waitFor` against a screen, on the deadline every wait here shares. */
function settled(
  ui: { readonly lastFrame: () => string | undefined },
  predicate: (frame: string) => boolean,
): Promise<string> {
  return waitFor(ui.lastFrame, predicate, { timeoutMs: WAIT });
}

/** Walks the cursor down onto `feat/login`, two rows below `main`. */
async function toLogin(ui: Driven & { lastFrame: () => string | undefined }) {
  await press(ui, keys.down);
  await press(ui, keys.down);
  await settled(ui, (frame) => /▸ +login/.test(frame));
}

/**
 * Runs a slash command the way somebody would: `/`, the name, enter.
 *
 * The four commands that used to be `p`, `S`, `R` and `L` have no key of their
 * own any more — `Menu.tsx` says which side of the line each fell and why — so
 * the tests that are about what those commands *do* reach them through the
 * menu rather than around it.
 *
 * The wait after the name is on the count rather than on the row: every row
 * this could type is already on screen when the menu opens, so `/refresh` is
 * true of the frame before a single character of it has been read. `1 of N`
 * only appears once the query has narrowed the list, which is the thing that
 * has to have happened before `enter` is aimed at anything.
 */
async function run(ui: Driven & { readonly lastFrame: () => string | undefined }, name: string) {
  ui.stdin.write("/");
  await settled(ui, (frame) => frame.includes("/sync-all"));
  ui.stdin.write(name);
  await settled(ui, (frame) => frame.includes(`1 of ${MENU_TOTAL}`));
  ui.stdin.write(keys.enter);
  // One key per frame, the way `press` does it: without this the enter that
  // runs the command and whatever the caller sends next arrive together, and
  // the second is dropped by the `busy` the first one opened.
  await nextFrame();
}

/**
 * How many commands the menu holds, read off the menu rather than counted here.
 *
 * The narrowing waits below are on `1 of N`, which is the one thing on the
 * popup that says a query has been read — so `N` has to be right, and a command
 * added to `Menu.tsx` would otherwise fail every one of these tests with a
 * timeout rather than with anything about a menu.
 */
const MENU_TOTAL = commandsFor(false).length;

/** `q quit` is on the key bar in `list` and in no other mode — see `MODE_HINTS`. */
const IN_LIST = (frame: string) => frame.includes("q quit");
/** `ctrl+c cancel` is the whole of the key bar while an action is out. */
const BUSY = (frame: string) => frame.includes("ctrl+c cancel");

describe("describePending", () => {
  /**
   * The question `r`, `x` and `s` ask, in every one of their wordings.
   *
   * These are the app's only prompts, and the colour is decided with the words
   * rather than beside them — so both are asserted together, as the one answer
   * the function actually gives. Amber and red are a distinction the words
   * cannot make on their own: a removal and a force-push can be walked back
   * from, and what `x` takes cannot.
   */
  test("one clean worktree: what goes, what stays, and amber for a risk you can undo", () => {
    expect(describePending({ kind: "one", summary: summary({ dir: "feat/login" }) })).toEqual({
      text: "remove feat/login? the directory goes, the branch stays",
      colour: theme.warn,
    });
  });

  test("one dirty worktree counts what `y` discards, and asks in red", () => {
    // Counted the way the reset counts them: tracked changes and untracked
    // files apart, because one of those may be work git has never seen a copy
    // of. `changed` is the total, so the tracked half is what is left of it.
    const dirty = summary({ dir: "feat/login", dirty: true, changed: 4, untracked: 1 });

    expect(describePending({ kind: "one", summary: dirty })).toEqual({
      text: "remove feat/login and discard 3 changes and 1 untracked file? the branch stays",
      colour: theme.danger,
    });
  });

  test("`x` names both kinds apart, says a copy is kept, and asks in amber", () => {
    // Amber and not red: what `x` takes is saved as a commit first, so it is
    // a risk of the same kind as a force-push — recoverable, and worth a
    // question — rather than the removal of a dirty worktree, which keeps
    // nothing and stays red.
    const dirty = summary({ dir: "feat/login", dirty: true, changed: 4, untracked: 1 });

    expect(describePending({ kind: "reset", summary: dirty })).toEqual({
      text: "discard 3 changes and 1 untracked file in feat/login? a copy is kept for git stash apply",
      colour: theme.warn,
    });
  });

  test("`/propose` names the base, and the push that comes first", () => {
    const stacked = summary({ dir: "feat/login-api" });

    // The base is the sentence: a pull request onto the wrong one is the
    // mistake the command exists to prevent.
    expect(
      describePending({
        kind: "propose",
        summary: stacked,
        proposal: { base: "feat/login", remote: "origin", publish: false },
      }),
    ).toEqual({
      text: "open a pull request for feat/login-api onto feat/login? what is ahead is pushed first",
      colour: theme.warn,
    });

    // A branch on no remote is also being published, and the prompt names
    // where — the same fact `s` puts on its question.
    expect(
      describePending({
        kind: "propose",
        summary: summary({ dir: "feat/search", upstream: undefined }),
        proposal: { base: "main", remote: "origin", publish: true },
      }),
    ).toEqual({
      text: "open a pull request for feat/search onto main? it is pushed to origin/feat/search first",
      colour: theme.warn,
    });
  });

  test("a folder of clean worktrees asks once, in the plural, and still in amber", () => {
    const target = {
      kind: "many",
      label: "feat/",
      paths: ["/repo/feat/login", "/repo/feat/search"],
      dirty: 0,
    } as const;

    expect(describePending(target)).toEqual({
      text: "remove all 2 under feat/? the directories go, the branches stay",
      colour: theme.warn,
    });
  });

  test("a folder with anything uncommitted in it is the red question, counted and agreeing", () => {
    const under = (dirty: number) =>
      describePending({
        kind: "many",
        label: "feat/",
        paths: ["/repo/feat/login", "/repo/feat/search"],
        dirty,
      });

    expect(under(1)).toEqual({
      text: "remove all 2 under feat/? 1 has uncommitted changes, which go too — the branches stay",
      colour: theme.danger,
    });
    // The verb follows the count, because the sentence is read aloud in the
    // head before `y` is pressed and a `1 have` is a sentence you re-read.
    expect(under(2).text).toContain("2 have uncommitted changes");
    expect(under(2).colour).toBe(theme.danger);
  });

  /**
   * The one question here that grants rather than takes, and the only one whose
   * text is doing the work: `y` means "I have read this", so the thing read has
   * to be the line itself rather than a description of it.
   */
  test("`/open` on an unread line quotes it, names the file, and asks in amber", () => {
    const target = {
      kind: "trust-open",
      summary: summary({ dir: "feat/login" }),
      waiting: { command: "code .", files: ["main/.grove.toml"] },
    } as const;

    expect(describePending(target)).toEqual({
      text: "open feat/login with `code .`? nobody here has read main/.grove.toml",
      colour: theme.warn,
    });
    // Amber, not red: nothing is being thrown away, and the red is what says
    // "this keeps no copy" everywhere else on this prompt.
    expect(describePending(target).colour).not.toBe(theme.danger);
  });

  test("`s` counts the commits it would rewrite, names where they go, and asks in amber", () => {
    // `trunk.ahead` is the count, because those are the commits the rebase
    // replays and therefore the ones that come out with new shas.
    const behind = summary({ dir: "feat/login", ahead: 2, trunk: { ahead: 5, behind: 3 } });

    expect(describePending({ kind: "sync", summary: behind })).toEqual({
      text: "sync feat/login? 5 commits rewritten and force-pushed to origin/feat/login",
      colour: theme.warn,
    });
    // Amber and not red: the commits are in the reflog either side of this, so
    // it is the `r` kind of risk rather than the `x` kind.
    expect(describePending({ kind: "sync", summary: behind }).colour).not.toBe(theme.danger);
  });

  test("one commit is said in the singular, and no count at all when git could not give one", () => {
    const one = summary({ dir: "feat/login", trunk: { ahead: 1, behind: 2 } });
    expect(describePending({ kind: "sync", summary: one }).text).toContain("1 commit rewritten");

    // git older than 2.41 answers nothing for the trunk column, and a sentence
    // that made a number up would be worse than one that leaves it out.
    const unknown = summary({ dir: "feat/login" });
    expect(describePending({ kind: "sync", summary: unknown }).text).toBe(
      "sync feat/login? commits rewritten and force-pushed to origin/feat/login",
    );
  });

  test("`s` over a branch no remote has says where it would go, in amber", () => {
    const local = summary({ dir: "feat/login", upstream: undefined });

    expect(describePending({ kind: "publish", summary: local })).toEqual({
      text: "sync feat/login? it is on no remote yet, so this pushes it to origin/feat/login",
      colour: theme.warn,
    });
  });

  test("`/prune` names what goes and counts what stays, in amber", () => {
    const entry = (dir: string, skipped?: string) => ({
      path: `/repo/${dir}`,
      dir,
      branch: dir,
      reason: "merged" as const,
      branchDeleted: false,
      ...(skipped === undefined ? {} : { skipped }),
    });

    expect(
      describePending({
        kind: "prune",
        result: { dryRun: true, entries: [entry("feat/login"), entry("pr/42")] },
      }),
    ).toEqual({
      text: "remove 2 finished worktrees — feat/login, pr/42? the branches stay",
      colour: theme.warn,
    });
    // Amber and not red: prune never takes a dirty worktree, so nothing
    // uncommitted goes, and what it declined is counted on the same line.
    expect(
      describePending({
        kind: "prune",
        result: {
          dryRun: true,
          entries: [entry("feat/login"), entry("feat/search", "holds 2 changes")],
        },
      }).text,
    ).toBe("remove 1 finished worktree — feat/login? the branches stay, 1 left alone");
  });

  test("`/sync-all` asks once, counting the branches rather than the worktrees", () => {
    expect(describePending({ kind: "sync-all", count: 3 })).toEqual({
      text: "sync every worktree? 3 branches are force-pushed",
      colour: theme.warn,
    });
    // The verb follows the count here for the same reason it does above.
    expect(describePending({ kind: "sync-all", count: 1 }).text).toContain(
      "1 branch is force-pushed",
    );
  });
});

/**
 * The test `s` runs before it decides whether to ask.
 *
 * Every `false` here has to be a case `syncWorktrees` really does handle
 * without rewriting anything on the remote, because a `false` that is wrong is
 * a force-push nobody was asked about — the whole reason this function exists.
 * A wrong `true` only costs a prompt.
 */
describe("wouldForcePush", () => {
  test("the trunk never does: after its rebase it is ahead, so the push is a plain one", () => {
    expect(
      wouldForcePush(summary({ dir: "main", isDefault: true, trunk: { ahead: 2, behind: 3 } })),
    ).toBe(false);
  });

  test("a branch behind the trunk with commits of its own does", () => {
    expect(wouldForcePush(summary({ dir: "feat/login", trunk: { ahead: 5, behind: 3 } }))).toBe(
      true,
    );
  });

  test("so does one whose own remote gained a commit, even with the trunk level", () => {
    // The rebase onto `origin/feat/login` replays this branch's commits over a
    // colleague's, which rewrites them just as surely as the trunk would.
    expect(
      wouldForcePush(summary({ dir: "feat/login", behind: 1, trunk: { ahead: 2, behind: 0 } })),
    ).toBe(true);
  });

  test("level with both is a rebase that moves nothing, so there is nothing to ask", () => {
    expect(wouldForcePush(summary({ dir: "feat/login", trunk: { ahead: 2, behind: 0 } }))).toBe(
      false,
    );
  });

  test("a branch with nothing of its own has nothing to rewrite", () => {
    expect(wouldForcePush(summary({ dir: "feat/login", trunk: { ahead: 0, behind: 4 } }))).toBe(
      false,
    );
  });

  test("nothing published is nothing to overwrite", () => {
    expect(
      wouldForcePush(
        summary({ dir: "feat/login", upstream: undefined, trunk: { ahead: 2, behind: 3 } }),
      ),
    ).toBe(false);
  });

  test("the two states `sync` skips are not asked about, because it will decline anyway", () => {
    const base = { dir: "feat/login", trunk: { ahead: 2, behind: 3 } } as const;

    expect(wouldForcePush(summary({ ...base, dirty: true, changed: 1 }))).toBe(false);
    expect(wouldForcePush(summary({ ...base, rebasing: true }))).toBe(false);
  });

  test("a detached HEAD has no branch to move", () => {
    expect(
      wouldForcePush(
        summary({
          dir: "feat/login",
          branch: undefined,
          detached: true,
          trunk: { ahead: 2, behind: 3 },
        }),
      ),
    ).toBe(false);
  });

  test("an unanswered question is asked rather than assumed away", () => {
    // No trunk drift at all is git too old to have answered. The prompt is the
    // safe direction, and it is the direction with the cheaper mistake.
    expect(wouldForcePush(summary({ dir: "feat/login", ahead: 2 }))).toBe(true);
  });
});

/**
 * The other test `s` runs, after `wouldForcePush` has said no.
 *
 * A wrong `true` here is a prompt over a branch that `sync` would have pushed
 * plainly, and a wrong `false` is a branch rebased and left on no remote with
 * nothing on the screen having said so — which is the state this exists to end.
 */
describe("wouldPublish", () => {
  test("a branch with no upstream is one nobody has pushed", () => {
    expect(wouldPublish(summary({ dir: "feat/login", upstream: undefined }))).toBe(true);
  });

  test("one with an upstream is `wouldForcePush`'s question, not this one", () => {
    expect(wouldPublish(summary({ dir: "feat/login", trunk: { ahead: 2, behind: 3 } }))).toBe(
      false,
    );
  });

  test("the trunk always has a remote, and a detached HEAD has no branch to push", () => {
    expect(wouldPublish(summary({ dir: "main", isDefault: true, upstream: undefined }))).toBe(
      false,
    );
    expect(
      wouldPublish(
        summary({ dir: "feat/login", branch: undefined, detached: true, upstream: undefined }),
      ),
    ).toBe(false);
  });

  test("the two states `sync` skips are not asked about, because it will decline anyway", () => {
    const base = { dir: "feat/login", upstream: undefined } as const;

    expect(wouldPublish(summary({ ...base, dirty: true, changed: 1 }))).toBe(false);
    expect(wouldPublish(summary({ ...base, rebasing: true }))).toBe(false);
  });
});

describe("pathOf", () => {
  const tree = buildTree(ROWS, new Set());
  const group = tree.find(
    (row): row is Extract<TreeRow, { kind: "group" }> => row.kind === "group",
  );
  const leaf = tree.find((row) => row.kind === "leaf");

  test("a worktree answers with its own path, whatever the repository root says", () => {
    if (leaf === undefined) throw new Error("the fixture tree has no worktree in it");

    // The path came from git; the root is only there for the rows that have no
    // path of their own.
    expect(pathOf(leaf, "/somewhere/else")).toBe("/repo/main");
  });

  test("a folder answers with the directory, without the slash it is drawn with", () => {
    if (group === undefined) throw new Error("the fixture tree has no folder in it");

    // `feat/` is how the row is labelled — the trailing slash is what makes it
    // read as a folder. A path handed around as a location should not carry it.
    expect(group.key).toBe("feat/");
    expect(pathOf(group, "/repo")).toBe("/repo/feat");
  });
});

describe("the list", () => {
  test("the two drifts are separate columns, and a branch with no upstream says so", async () => {
    const { service } = stub({
      list: async () => [
        summary({ dir: "main", isDefault: true, current: true }),
        summary({ dir: "feat/login", ahead: 2, behind: 1, trunk: { ahead: 5, behind: 3 } }),
        summary({ dir: "feat/local", upstream: undefined, trunk: { ahead: 1, behind: 0 } }),
      ],
    });
    const ui = await opened_with(service);
    const frame = ui.frame();

    // Two questions, two columns, one shape: what is there to push, and how far
    // the trunk has moved out from under you.
    expect(frame).toMatch(/login\s+↑2 ↓1\s+↑5 ↓3\s+○/);
    // A branch that was never pushed has no answer to give about its remote —
    // `↑0 ↓0` there would claim it is in step with something — but it still has
    // one about the trunk.
    expect(frame).toMatch(/local\s+no upstream\s+↑1 ↓0/);
    // Nothing to compare the trunk against but itself, so its column is blank
    // rather than a `↑0 ↓0` answering a question nobody asked.
    expect(frame).toMatch(/main\s+↑0 ↓0\s+○/);
    // The drift is said once per column, in the columns that exist for it.
    expect(frame).not.toContain("2 ahead");
  });

  test("the working tree is a dot, and only the unusual states are still words", async () => {
    const { service } = stub({
      list: async () => [
        summary({ dir: "main", isDefault: true, current: true }),
        summary({ dir: "feat/login", dirty: true, changed: 2, untracked: 0 }),
        summary({ dir: "chore/old", finished: "merged" }),
        summary({ dir: "ops/box", rebasing: true, locked: true }),
      ],
    });
    const ui = await opened_with(service);
    const frame = ui.frame();

    // Filled has changes in it, hollow does not — the word `clean` was true of
    // almost every row almost all the time.
    expect(frame).toMatch(/login\s+↑0 ↓0\s+●/);
    expect(frame).toMatch(/main\s+↑0 ↓0\s+○/);
    expect(frame).not.toContain("clean");
    expect(frame).not.toContain("dirty");
    // The three that a dot cannot say, in the order `noteParts` puts them.
    expect(frame).toContain("merged");
    expect(frame).toMatch(/box\s+↑0 ↓0\s+○ rebasing, locked/);
  });

  test("a state column too narrow for its words is truncated rather than allowed to shear", async () => {
    const { service } = stub({
      list: async () => [
        summary({ dir: "main", isDefault: true, current: true }),
        summary({ dir: "ops/box", detached: true, branch: undefined, locked: true }),
      ],
    });

    // Wide first, so what the narrow one loses is visible as a difference
    // rather than asserted as an absence.
    const roomy = mount(service, { columns: 100 });
    expect(await settled(roomy, (frame) => frame.includes("box"))).toContain("detached, locked");

    // At 30 columns the drift columns are dropped whole — that is
    // `columnWidths`' own decision, covered in `layout.test.ts` — and the state
    // column is left with less room than it asked for. This is the one cell
    // that gives up characters instead of disappearing, because the dot beside
    // it is the thing the column exists for.
    const cramped = mount(service, { columns: 30 });
    const frame = await settled(cramped, (each) => each.includes("box"));

    expect(frame).not.toContain("detached, locked");
    expect(frame).toContain("detached, l…");
    // And every row still ends inside the terminal it was drawn for.
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(30);
  });

  test("an empty grove says what to press instead of drawing an empty table", async () => {
    const { service } = stub({ list: async () => [] });
    const ui = mount(service);

    const frame = await settled(ui, (each) => each.includes("no worktrees here yet"));

    expect(frame).toContain("press a to add one");
    // No column headings over nothing: they are drawn once there are rows.
    expect(frame).not.toContain("worktree    origin");
  });

  /**
   * The failure this prevents: a worktree created in another terminal appears
   * above the selected one, the selection slides down a row on its own, and the
   * next `r` is aimed at something the user never pointed at.
   */
  test("the cursor stays on the row it was on when the list changes underneath", async () => {
    let listed: readonly WorktreeSummary[] = ROWS;
    const { service } = stub({ list: async () => listed });
    const ui = await opened_with(service);

    await toLogin(ui);

    // `chore/` sorts before `feat/`, so this pushes `login` two rows down. Read
    // back through `R` rather than through the timer, so what is under test is
    // the cursor and not the polling.
    listed = [...ROWS, summary({ dir: "chore/deps" })];
    await run(ui, "refresh");

    const frame = await settled(ui, (each) => each.includes("deps"));

    expect(frame).toMatch(/▸ +login/);
    expect(frame).not.toMatch(/▸ +deps/);
  });

  /**
   * The state column is about a working tree, and a working tree is edited from
   * somewhere else. Waiting for `R` would make the screen a photograph of
   * whenever you last pressed a key.
   */
  test("the list keeps up with the worktrees without a keypress", async () => {
    let listed: readonly WorktreeSummary[] = ROWS;
    const { service, calls } = stub({ list: async () => listed });
    const ui = await opened_with(service, { refreshMs: 50 });
    expect(ui.frame()).not.toContain("●");

    // What another terminal doing the editing looks like from in here.
    listed = ROWS.map((row) => (row.dir === "feat/login" ? { ...row, dirty: true } : row));

    expect(await settled(ui, (each) => each.includes("●"))).toMatch(/login\s+↑2 ↓0\s+↑5 ↓3\s+●/);
    // The remote half of the answer is fetched, not merely re-read: without it
    // a colleague's push never arrives at all.
    expect(calls.fetched).toBeGreaterThan(0);
  });

  test("local changes remain visible while a remote fetch is pending, then show its result", async () => {
    let listed: readonly WorktreeSummary[] = ROWS;
    const pending = Promise.withResolvers<boolean>();
    let fetched = 0;
    const { service } = stub({
      list: async () => listed,
      fetch: () => {
        fetched += 1;
        return pending.promise;
      },
    });
    const ui = await opened_with(service, { refreshMs: 25, remoteRefreshMs: 30 });
    listed = [...ROWS, summary({ dir: "local-change" })];
    await settled(ui, (frame) => frame.includes("local-change"));
    expect(fetched).toBe(1);
    expect(ui.frame()).toContain("remote: not synced");
    pending.resolve(true);
    await settled(ui, (frame) => frame.includes("remote: just fetched"));
  });

  test("a failed fetch leaves local polling active and a slower remote clock independent", async () => {
    let listed: readonly WorktreeSummary[] = ROWS;
    let fetched = 0;
    const { service } = stub({
      list: async () => listed,
      fetch: async () => {
        fetched += 1;
        throw new Error("offline");
      },
    });
    const ui = await opened_with(service, { refreshMs: 25, remoteRefreshMs: 60_000 });
    listed = [...ROWS, summary({ dir: "offline-change" })];
    await settled(ui, (frame) => frame.includes("offline-change"));
    expect(fetched).toBe(1);
    expect(ui.frame()).toContain("offline or unavailable");
  });

  test("a background read cannot overwrite a newer command refresh", async () => {
    const pending = Promise.withResolvers<readonly WorktreeSummary[]>();
    let reads = 0;
    const { service } = stub({
      list: async () => {
        reads += 1;
        if (reads === 2) return pending.promise;
        return reads === 1 ? ROWS : [...ROWS, summary({ dir: "fresh-result" })];
      },
    });
    const ui = await opened_with(service, { refreshMs: 25 });
    await waitFor(
      () => String(reads),
      (value) => value === "2",
      { timeoutMs: WAIT },
    );
    await run(ui, "refresh");
    await settled(ui, (frame) => frame.includes("fresh-result"));
    const start = ui.frames.length;
    pending.resolve([...ROWS, summary({ dir: "stale-result" })]);
    await nextFrame();
    expect(ui.frames.slice(start).some((frame) => plain(frame).includes("stale-result"))).toBe(
      false,
    );
    expect(ui.frame()).toContain("fresh-result");
  });

  /**
   * The list re-reads itself on a timer. A fold held by row rather than by key
   * would spring every folder open on the next tick, under the cursor.
   */
  test("a fold survives the list re-reading itself", async () => {
    let listed: readonly WorktreeSummary[] = ROWS;
    const { service } = stub({ list: async () => listed });
    const ui = await opened_with(service, { refreshMs: 50 });

    ui.stdin.write(keys.down);
    await settled(ui, (each) => /▸ +feat\//.test(each));
    ui.stdin.write(keys.left);
    await settled(ui, (each) => /▸ +feat\/\s+2/.test(each));

    // Something only a refresh can bring in, so what follows is an assertion
    // about a tick that demonstrably happened rather than one that may not
    // have: waiting and then finding the fold intact would pass just as well if
    // the timer had never fired.
    listed = [...ROWS, summary({ dir: "zebra" })];
    await settled(ui, (each) => each.includes("zebra"));

    expect(ui.frame()).not.toContain("login");
    expect(ui.frame()).toMatch(/▸ +feat\/\s+2/);
  });
});

describe("the add prompt", () => {
  /** Opens `a` on `main` and returns the screen with the prompt up. */
  async function prompting(service: WorktreeService) {
    const ui = await opened_with(service);
    ui.stdin.write("a");
    await settled(ui, (frame) => frame.includes("new branch from main"));

    return ui;
  }

  /**
   * The caret is drawn as an inverse block over the character it sits on, which
   * is a colour and not a character — so it is invisible in a frame read as
   * plain text. Every test below asks where the caret is by typing at it, which
   * is also the only thing anybody uses it for.
   */
  test("the caret walks back into the name, and what is typed lands where it stopped", async () => {
    const { service, calls } = stub();
    const ui = await prompting(service);

    await press(ui, "abc");
    await settled(ui, (frame) => frame.includes("abc"));
    await press(ui, keys.left);
    await press(ui, keys.left);
    await press(ui, "X");

    await settled(ui, (frame) => frame.includes("aXbc"));
    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("added aXbc"));

    // And the name that was built is the name that was asked for — the prompt
    // is not a display of one string over a different one.
    expect(calls.added).toEqual([{ branch: "aXbc", from: "main" }]);
  });

  test("the caret stops at both ends rather than wrapping round", async () => {
    const { service } = stub();
    const ui = await prompting(service);

    await press(ui, "abc");
    await settled(ui, (frame) => frame.includes("abc"));

    // Five presses against a three-character name: a caret that wrapped, or one
    // that went negative, would put the next character somewhere else.
    for (let at = 0; at < 5; at += 1) await press(ui, keys.left);
    await press(ui, "<");
    await settled(ui, (frame) => frame.includes("<abc"));

    for (let at = 0; at < 9; at += 1) await press(ui, keys.right);
    await press(ui, ">");
    await settled(ui, (frame) => frame.includes("<abc>"));
  });

  test("backspace takes the character the caret sits after, wherever that is", async () => {
    const { service } = stub();
    const ui = await prompting(service);

    await press(ui, "abcd");
    await settled(ui, (frame) => frame.includes("abcd"));
    await press(ui, keys.left);
    await press(ui, keys.backspace);
    // `c`, not `d`: backspace is aimed at the caret and not at the end of the
    // name. The caret follows it back, so the next character typed lands there.
    await settled(ui, (frame) => frame.includes("abd") && !frame.includes("abcd"));

    await press(ui, "Z");
    await settled(ui, (frame) => frame.includes("abZd"));
  });

  test("backspace at the start of the name does nothing, rather than the mode ending", async () => {
    const { service } = stub();
    const ui = await prompting(service);

    await press(ui, "ab");
    await settled(ui, (frame) => frame.includes("ab"));
    // Twice as many backspaces as there are characters: the caret clamps at
    // zero, and the two presses past the start have nothing left to take.
    for (let at = 0; at < 4; at += 1) await press(ui, keys.backspace);
    await settled(ui, (frame) => !/new branch[^\n]*ab/.test(frame));

    // The prompt is still up and still taking text: an empty name is a thing to
    // type into, not a cancel.
    await press(ui, "ok");
    expect(await settled(ui, (frame) => frame.includes("ok"))).toContain("new branch");
  });

  /**
   * The key labelled Backspace is not the only one that reaches this: the
   * forward-delete key arrives as `key.delete`, and it is spelled the same way
   * here on purpose — a forward delete is not worth losing the mac's Backspace
   * to, on the terminals that report it that way.
   */
  test("the forward-delete key is a backspace too", async () => {
    const { service } = stub();
    const ui = await prompting(service);

    await press(ui, "abc");
    await settled(ui, (frame) => frame.includes("abc"));
    // What a terminal actually sends for the key labelled Delete.
    await press(ui, `${String.fromCharCode(27)}[3~`);

    await settled(ui, (frame) => frame.includes("ab") && !frame.includes("abc"));
  });

  /**
   * The failure this prevents: an arrow key, or any other control sequence,
   * typing itself into the branch name. The filter is printable ASCII only, and
   * a name outside it is silently refused rather than mangled — git would take
   * it, but nobody could type it back at a terminal to find the worktree again.
   */
  test("a name that is not printable ASCII is refused without a word", async () => {
    const { service, calls } = stub();
    const ui = await prompting(service);

    await press(ui, "café");
    await press(ui, "브랜치");
    // Nothing to wait for — the point is that nothing happened — so a printable
    // name is typed after them and the frame is read once it lands.
    await press(ui, "plain");
    const frame = await settled(ui, (each) => each.includes("plain"));

    expect(frame).not.toContain("café");
    expect(frame).not.toContain("브랜치");

    await press(ui, keys.enter);
    await settled(ui, (each) => each.includes("added plain"));
    expect(calls.added).toEqual([{ branch: "plain", from: "main" }]);
  });

  // The failure this prevents: `a` opening the prompt and the very next
  // keypress being read as a command instead of as text.
  test("keys typed into the prompt are text, not commands", async () => {
    const { service, calls } = stub();
    const ui = await prompting(service);

    ui.stdin.write("s");
    await settled(ui, (frame) => /new branch from main\s+s/.test(frame));

    expect(calls.synced).toEqual([]);
  });

  test("enter on an empty name is a cancel, not a refusal", async () => {
    const { service, calls } = stub();
    const ui = await prompting(service);

    // Whitespace as well as nothing: the name is trimmed before it is weighed,
    // so a space bar pressed while thinking is still an empty prompt.
    await press(ui, "   ");
    await press(ui, keys.enter);
    await settled(ui, (frame) => !frame.includes("new branch"));

    expect(calls.added).toEqual([]);
    expect(IN_LIST(ui.frame())).toBe(true);
  });

  test("a new branch starts from the worktree the cursor is on", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await toLogin(ui);
    ui.stdin.write("a");
    // Said on the prompt, not left to be discovered from the result: `a` on one
    // row and `a` on another start the branch in different places.
    await settled(ui, (frame) => frame.includes("new branch from feat/login"));

    await press(ui, "feat/login-part-2");
    await settled(ui, (frame) => frame.includes("feat/login-part-2"));
    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("added feat/login-part-2"));

    expect(calls.added).toEqual([{ branch: "feat/login-part-2", from: "feat/login" }]);
  });

  // Nothing to carry on from: a detached HEAD has no branch name to pass, so
  // the base falls back to the remote's default rather than being invented.
  test("a detached worktree offers no base", async () => {
    const { service, calls } = stub({
      list: async () => [
        summary({ dir: "main", isDefault: true, detached: true, branch: undefined }),
      ],
    });
    const ui = mount(service);
    await settled(ui, (frame) => frame.includes("main"));

    ui.stdin.write("a");
    const frame = await settled(ui, (each) => each.includes("new branch"));
    expect(frame).not.toContain("new branch from");

    await press(ui, "fix/crash");
    await settled(ui, (each) => each.includes("fix/crash"));
    await press(ui, keys.enter);
    await settled(ui, (each) => each.includes("added fix/crash"));

    expect(calls.added).toEqual([{ branch: "fix/crash", from: undefined }]);
  });

  test("`a` on a folder starts the name inside it, with the caret after it", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    ui.stdin.write(keys.down);
    await settled(ui, (frame) => /▸ +feat\//.test(frame));
    ui.stdin.write("a");
    await settled(ui, (frame) => frame.includes("new branch feat/"));

    // Typed straight on the end, which is what a caret parked at `value.length`
    // is for — reaching for `a` on a folder is how you say "another one of
    // these".
    await press(ui, "chat");
    await settled(ui, (frame) => frame.includes("feat/chat"));
    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("added feat/chat"));

    // A folder is not a branch, so there is nothing to carry on from.
    expect(calls.added).toEqual([{ branch: "feat/chat", from: undefined }]);
  });

  /**
   * The price of a configuration that travels with the project: `copy` and
   * `link` move files already on the disk, and a command came in with a pull.
   * `grove add` on the command line has to behave the same in a pipe as under a
   * terminal, so it prints them and skips; the screen just made the worktree
   * itself, so it runs them right after, the way `--trust` would.
   */
  test("`a` runs the commands the new worktree's file wants to run", async () => {
    const { service, calls } = stub({
      pendingCommands: async () => ["bun install", "./scripts/postinstall.sh"],
    });
    const ui = await opened_with(service);

    ui.stdin.write("a");
    await settled(ui, (frame) => frame.includes("new branch"));
    await press(ui, "feat/new");
    await settled(ui, (frame) => frame.includes("feat/new"));
    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("1 run in"));

    // The worktree was made, and the commands ran right after it — nothing
    // asked, because the keystroke that made it was the asking.
    expect(calls.added).toEqual([{ branch: "feat/new", from: "main" }]);
    expect(calls.trusted).toEqual(["feat/new"]);
  });

  // Every ordinary repository: no file, or one whose commands already ran as
  // part of `add` itself.
  test("nothing runs a second time when nothing is waiting", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("a");
    await settled(ui, (frame) => frame.includes("new branch"));
    await press(ui, "feat/new");
    await settled(ui, (frame) => frame.includes("feat/new"));
    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("added feat/new"));

    expect(calls.trusted).toEqual([]);
  });
});

describe("the upstream prompt", () => {
  test("`/upstream` asks for a URL, says what enter does, and follows it without a question", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await run(ui, "upstream");
    const prompt = await settled(ui, (frame) => frame.includes("upstream "));
    // The consent is the two lines above the box: what changes, and what does not.
    expect(prompt).toContain("main will be measured against this repository's trunk");
    expect(prompt).toContain("Your branches still go to origin");
    expect(prompt).toContain("enter follow");

    await press(ui, "https://example.test/them/repo.git");
    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("main now follows upstream/main"));

    expect(calls.followed).toEqual([{ url: "https://example.test/them/repo.git", force: false }]);
  });

  test("enter on nothing, and esc, both close it having followed nothing", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await run(ui, "upstream");
    await settled(ui, (frame) => frame.includes("upstream "));
    await press(ui, keys.enter);
    await settled(ui, IN_LIST);

    await run(ui, "upstream");
    await settled(ui, (frame) => frame.includes("upstream "));
    await press(ui, "u://x");
    await press(ui, keys.esc);
    await settled(ui, IN_LIST);

    expect(calls.followed).toEqual([]);
  });

  test("replacing a remote that is already there is the one part it asks about", async () => {
    const { service, calls } = stub({
      pendingUpstream: async (url) => (url === "u://old" ? undefined : "u://old"),
    });
    const ui = await opened_with(service);

    await run(ui, "upstream");
    await settled(ui, (frame) => frame.includes("upstream "));
    await press(ui, "u://new");
    await press(ui, keys.enter);
    const question = await settled(ui, (frame) => frame.includes("replace upstream?"));
    expect(question).toContain("it points at u://old, and would point at u://new");
    expect(question).toContain("y replace");

    await press(ui, "n");
    await settled(ui, IN_LIST);
    expect(calls.followed).toEqual([]);

    await run(ui, "upstream");
    await settled(ui, (frame) => frame.includes("upstream "));
    await press(ui, "u://new");
    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("replace upstream?"));
    await press(ui, "y");
    await settled(ui, (frame) => frame.includes("main now follows"));
    expect(calls.followed).toEqual([{ url: "u://new", force: true }]);
  });
});

describe("the keys", () => {
  /**
   * Keys arrive faster than React commits, which is exactly what holding an
   * arrow key down does: both presses reach the handler before the first has
   * been rendered. A cursor read off the rendered row would leave the second
   * one with nowhere to go — `move` resolves the previous row inside the
   * `setCursorKey` updater instead, and that is the only reason holding `↓`
   * travels rather than moving one row and stopping.
   *
   * This is the one place in the file where two keys are deliberately sent
   * inside one frame; everywhere else they are driven a frame apart.
   */
  test("two arrows inside one frame both count, which is what holding one down is", async () => {
    const { service } = stub();
    const ui = await opened_with(service);

    ui.stdin.write(keys.down);
    ui.stdin.write(keys.down);

    await settled(ui, (frame) => /▸ +login/.test(frame));
  });

  test("the add prompt keeps every key of a frame, not just the last one", async () => {
    const { service } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("a");
    await settled(ui, (frame) => frame.includes("branch"));

    // Written without awaiting between them, which is what typing quickly and
    // holding a key actually look like: ink delivers them to one handler call.
    // Reading the mode out of the render rather than the updater lost all but
    // the last of these — `ab` typed at speed used to arrive as `b`.
    ui.stdin.write("f");
    ui.stdin.write("e");
    ui.stdin.write("a");
    ui.stdin.write("t");
    await settled(ui, (frame) => frame.includes("feat"));

    // Two `←` in one frame move the caret twice, then a character lands
    // between the `e` and the `a`.
    ui.stdin.write(keys.left);
    ui.stdin.write(keys.left);
    ui.stdin.write("X");
    await settled(ui, (frame) => frame.includes("feXat"));

    // And backspace twice in one frame takes two characters, not one.
    ui.stdin.write(keys.backspace);
    ui.stdin.write(keys.backspace);
    await settled(ui, (frame) => /f(?!eXat)/.test(frame) && frame.includes("at"));
  });

  test("a pasted branch name keeps its text and does not submit itself", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("a");
    await settled(ui, (frame) => frame.includes("branch"));

    // One event carrying the newline that ended the line it was copied from.
    // Ink reads that newline as enter, so this used to arrive as a submit of
    // an empty prompt: the name typed nowhere and the popup gone.
    ui.stdin.write("feat/pasted\r");
    await settled(ui, (frame) => frame.includes("feat/pasted"));

    // Still open, and nothing was created: a name that was never on screen is
    // not one to act on.
    expect(ui.frame()).toContain("enter add");
    expect(calls.added).toEqual([]);

    // And it is a real value, not decoration — enter from here adds it.
    ui.stdin.write(keys.enter);
    await settled(ui, (frame) => !frame.includes("enter add"));
    expect(calls.added).toEqual([{ branch: "feat/pasted", from: "main" }]);
  });

  test("`enter` copies the path of whatever the cursor is on, folder included", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await toLogin(ui);
    ui.stdin.write(keys.enter);
    await settled(ui, (frame) => frame.includes("copied /repo/feat/login"));

    // A folder is a real directory on disk, and a key that works on some rows
    // and not others is one you have to look at the screen to use.
    ui.stdin.write(keys.up);
    await settled(ui, (frame) => /▸ +feat\//.test(frame));
    ui.stdin.write(keys.enter);
    await settled(ui, (frame) => frame.includes("copied /repo/feat"));

    expect(calls.copied).toEqual(["/repo/feat/login", "/repo/feat"]);
  });

  test("`s` syncs the row under the cursor and `/sync-all` syncs every worktree", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await toLogin(ui);
    ui.stdin.write("s");
    // `feat/login` has commits of its own under a trunk that has moved, so
    // both spellings of the sync stop to ask before they force-push — which
    // rows those are is `wouldForcePush`'s to pin, and answering is this
    // test's, since the key does nothing at all until it is answered.
    await settled(ui, (frame) => frame.includes("sync feat/login?"));
    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("1 up-to-date"));

    await run(ui, "sync-all");
    await settled(ui, (frame) => frame.includes("sync every worktree?"));
    ui.stdin.write("y");
    await settled(ui, (frame) => IN_LIST(frame) && frame.includes("1 up-to-date"));

    // The one action with no target, which is what `undefined` says here.
    expect(calls.synced).toEqual(["/repo/feat/login", undefined]);
  });

  /**
   * The gap this closes: `a` makes a branch on no remote, and `s` over it
   * synced and said `up-to-date` however many times it was pressed, with the
   * branch never reaching the origin. The screen can ask, so it does — and the
   * answer is what `grove sync --publish` spells out.
   */
  test("`s` over a branch no remote has asks, and `y` syncs it with the push", async () => {
    const rows = [
      summary({ dir: "main", isDefault: true, current: true }),
      summary({ dir: "feat/login", upstream: undefined }),
      summary({ dir: "feat/search", trunk: { ahead: 1, behind: 0 } }),
    ];
    const { service, calls } = stub({ list: async () => [...rows] });
    const ui = await opened_with(service);

    await toLogin(ui);
    ui.stdin.write("s");
    await settled(ui, (frame) => frame.includes("it is on no remote yet"));
    // `n` leaves it: nothing runs, and the branch stays where it was.
    ui.stdin.write("n");
    await settled(ui, (frame) => IN_LIST(frame) && !frame.includes("no remote"));
    expect(calls.synced).toEqual([]);

    ui.stdin.write("s");
    await settled(ui, (frame) => frame.includes("it is on no remote yet"));
    ui.stdin.write("y");
    await settled(ui, (frame) => IN_LIST(frame) && frame.includes("1 up-to-date"));

    expect(calls.synced).toEqual(["/repo/feat/login"]);
    expect(calls.published).toEqual(["/repo/feat/login"]);
  });

  /**
   * The list badges `merged` and `gone`, and until now clearing them meant `r`
   * on each row or a terminal for `grove prune`. `/prune` is that command
   * behind the slash, with the dry run as the question.
   */
  test("`/prune` asks with the directories named, and `y` runs the prune", async () => {
    const finished = {
      path: "/repo/feat/search",
      dir: "feat/search",
      branch: "feat/search",
      reason: "merged" as const,
      branchDeleted: false,
    };
    const { service, calls } = stub({
      pendingPrune: async () => ({ entries: [finished], dryRun: true }),
      prune: async () => {
        calls.pruned += 1;
        return "removed 1";
      },
    });
    const ui = await opened_with(service);

    await run(ui, "prune");
    await settled(ui, (frame) => frame.includes("remove 1 finished worktree — feat/search?"));
    ui.stdin.write("n");
    await settled(ui, (frame) => IN_LIST(frame) && !frame.includes("finished worktree"));
    expect(calls.pruned).toBe(0);

    await run(ui, "prune");
    await settled(ui, (frame) => frame.includes("remove 1 finished worktree — feat/search?"));
    ui.stdin.write("y");
    await settled(ui, (frame) => IN_LIST(frame) && frame.includes("removed 1"));
    expect(calls.pruned).toBe(1);
  });

  test("`/prune` with nothing finished says so, without a question", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await run(ui, "prune");
    await settled(ui, (frame) => IN_LIST(frame) && frame.includes("nothing is finished with"));
    expect(calls.pruned).toBe(1);
  });

  test("`/open` opens the row under the cursor, and does nothing on a folder", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "open");
    await settled(ui, (frame) => IN_LIST(frame) && frame.includes("opened"));

    expect(calls.opened).toEqual([{ target: "/repo/feat/login", trust: false }]);

    // One of the two commands behind the slash that are aimed at a row, so it
    // is also one of the two that can be aimed at something that is not one.
    ui.stdin.write(keys.up);
    await settled(ui, (frame) => /▸ +feat\//.test(frame));
    await run(ui, "open");
    await settled(ui, IN_LIST);

    expect(calls.opened).toEqual([{ target: "/repo/feat/login", trust: false }]);
  });

  /**
   * The gap this closes: a clone whose `.grove.toml` nobody has read here had
   * no way to read it. `/open` reported the refusal the command line reports
   * and stopped there, and the only way through was to leave for a terminal and
   * type `grove open --trust` — on the one surface that could have shown the
   * line and asked.
   */
  test("`/open` on a line nobody has read asks with the line, and `y` trusts it", async () => {
    const { service, calls } = stub({
      pendingOpen: async () => ({ command: "code .", files: ["main/.grove.toml"] }),
    });
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "open");
    const asked = await settled(ui, (frame) => frame.includes("nobody here has read"));

    // The command itself, because that is what `y` agrees to: a prompt that
    // said "an untrusted line" would be asking somebody to trust a description.
    expect(asked).toContain("open feat/login with `code .`?");
    expect(asked).toContain("main/.grove.toml");
    expect(asked).toContain("y trust and open");
    // Nothing has run yet — the question is asked before the line is.
    expect(calls.opened).toEqual([]);

    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("opened /repo/feat/login"));

    expect(calls.opened).toEqual([{ target: "/repo/feat/login", trust: true }]);
  });

  test("`n` on that question leaves the line untrusted and nothing opened", async () => {
    const { service, calls } = stub({
      pendingOpen: async () => ({ command: "code .", files: ["main/.grove.toml"] }),
    });
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "open");
    await settled(ui, (frame) => frame.includes("nobody here has read"));

    ui.stdin.write("n");
    await settled(ui, IN_LIST);

    // Not opened without trust either: an answer of `n` is not a quieter `y`.
    expect(calls.opened).toEqual([]);
  });

  test("`/setup` fills the row under the cursor in again, and does nothing on a folder", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "setup");
    await settled(ui, (frame) => IN_LIST(frame) && frame.includes("copied"));

    expect(calls.filledIn).toEqual(["/repo/feat/login"]);

    ui.stdin.write(keys.up);
    await settled(ui, (frame) => /▸ +feat\//.test(frame));
    await run(ui, "setup");
    await settled(ui, IN_LIST);

    expect(calls.filledIn).toEqual(["/repo/feat/login"]);
  });

  test("`s` on a folder does nothing, because a folder is not a worktree", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    ui.stdin.write(keys.down);
    await settled(ui, (frame) => /▸ +feat\//.test(frame));
    // The key bar already says so — `layout.test.ts` pins that — and the
    // dispatcher has to agree with it, which is what this asserts.
    expect(ui.frame()).not.toMatch(/\bs sync\b/);

    await press(ui, "s");
    // `/sync-all` after it, so the wait has something to land on: a key that
    // did nothing leaves no frame to wait for, and the sync that follows is
    // proof the screen was reading keys the whole time. It asks first, over
    // `feat/login`, which is also proof `s` opened no question of its own.
    await run(ui, "sync-all");
    await settled(ui, (frame) => frame.includes("sync every worktree?"));
    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("1 up-to-date"));

    expect(calls.synced).toEqual([undefined]);
  });

  test("`/refresh` re-reads the list and says it did", async () => {
    let reads = 0;
    const { service } = stub({
      list: async () => {
        reads += 1;
        return [...ROWS];
      },
    });
    const ui = await opened_with(service);
    const before = reads;

    await run(ui, "refresh");
    await settled(ui, (frame) => frame.includes("refreshed"));

    // Not a promise the screen makes and does not keep: the word is on the
    // message line because a read happened behind it.
    expect(reads).toBeGreaterThan(before);
  });

  /**
   * `y` carries the answer that was just given: the question counted the
   * uncommitted changes, so the removal is allowed to discard them. Anything
   * else would be a prompt that asked about one thing and did another.
   */
  test("`y` removes with the permission the question asked for", async () => {
    const { service, calls } = stub({
      list: async () => [
        summary({ dir: "main", isDefault: true, current: true }),
        summary({ dir: "feat/login", dirty: true, changed: 2, untracked: 1 }),
      ],
    });
    const ui = await opened_with(service);

    await toLogin(ui);
    ui.stdin.write("r");
    await settled(ui, (frame) => frame.includes("remove feat/login and discard"));
    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("removed /repo/feat/login"));

    expect(calls.removed).toEqual([{ target: "/repo/feat/login", discardDirty: true }]);
  });

  test("a clean worktree is removed without that permission", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("r");
    await settled(ui, (frame) => frame.includes("remove main?"));
    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("removed /repo/main"));

    expect(calls.removed).toEqual([{ target: "/repo/main", discardDirty: false }]);
  });

  /**
   * `x` is the one key that takes work rather than a directory, so the whole of
   * it is the question in front of it: what goes, that nothing brings it back,
   * and a `y` spelled for what it is about to do.
   */
  test("`x` asks before discarding, and `y` throws the changes away", async () => {
    const { service, calls } = stub({
      list: async () => [
        summary({ dir: "main", isDefault: true, current: true }),
        summary({ dir: "feat/login", dirty: true, changed: 3, untracked: 1 }),
      ],
    });
    const ui = await opened_with(service);

    await toLogin(ui);

    ui.stdin.write("x");
    const asked = await settled(ui, (frame) =>
      frame.includes(
        "discard 2 changes and 1 untracked file in feat/login? a copy is kept for git stash apply",
      ),
    );

    // The word on the key bar is the word in the question. `y remove` under a
    // prompt about discarding changes would be two answers to one question.
    expect(asked).toContain("y discard");

    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("discarded 2 changes in /repo/feat/login"));

    expect(calls.discarded).toEqual(["/repo/feat/login"]);
    // A discard is not a removal: the worktree stays, and nothing here may
    // reach for the key that takes the directory.
    expect(calls.removed).toEqual([]);
  });

  /**
   * A confirmation that would do nothing is a prompt that teaches people to
   * answer `y` without reading it, which is the last habit this key should be
   * building — so on a clean worktree `x` is neither offered nor heard.
   */
  test("`x` on a clean worktree neither asks nor appears on the key bar", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    const before = await settled(ui, IN_LIST);

    expect(before).not.toContain("x discard");

    await press(ui, "x");

    const after = await settled(ui, IN_LIST);

    expect(after).not.toContain("a copy is kept");
    expect(calls.discarded).toEqual([]);
  });

  /**
   * The failure this prevents: folding a folder quietly changing what `r` there
   * does, because what it removes was read off rows the fold had taken away.
   */
  test("`r` on a folder removes every worktree under it in one call, folded or not", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    ui.stdin.write(keys.down);
    await settled(ui, (frame) => /▸ +feat\//.test(frame));
    ui.stdin.write(keys.left);
    await settled(ui, (frame) => /▸ +feat\/\s+2/.test(frame));

    ui.stdin.write("r");
    await settled(ui, (frame) => frame.includes("remove all 2 under feat/"));
    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("removed 2 worktrees"));

    expect(calls.removedMany).toEqual([
      { targets: ["/repo/feat/login", "/repo/feat/search"], discardDirty: false },
    ]);
    // Never one at a time behind the user's back: the loop and its refusals
    // live in the service, where the command's own checks still apply to each.
    expect(calls.removed).toEqual([]);
  });

  /**
   * `/review` is the one command that leaves the machine for something that is
   * not git, so it is the one with a wait worth drawing. It borrows `busy`
   * rather than going through `perform`, because there is no outcome to report
   * — and borrowing it is what drops the keys while `gh` is out.
   */
  test("`/review` takes the keyboard while the forge is out, then opens the picker", async () => {
    let answer: (prs: readonly PullRequest[]) => void = () => {};
    const asked = new Promise<readonly PullRequest[]>((resolve) => {
      answer = resolve;
    });
    const { service } = stub({ pullRequests: () => asked });
    const ui = await opened_with(service);

    await run(ui, "review");
    await settled(ui, BUSY);

    // A key pressed while the forge is out is dropped, not queued: the cursor
    // is where it was when the popup finally arrives.
    ui.stdin.write("j");
    ui.stdin.write("r");
    expect(ui.frame()).toMatch(/▸ \* main/);
    expect(ui.frame()).not.toContain("remove main?");

    answer([pullRequest(12), pullRequest(34, { isDraft: true })]);
    // Waited for by a row only the popup has: `busy` now says "· reading pull
    // requests" on the message row, so the heading alone no longer tells the
    // two apart.
    const popup = await settled(ui, (frame) => frame.includes("feat/pr-12"));

    expect(popup).toContain("feat/pr-12");
    expect(popup).toContain("Change number 34");
    expect(popup).toContain("enter check out");
  });

  // An empty list is an answer, not a popup: one there is nothing to pick from
  // is chrome, so it goes where the other answers to a keypress go.
  test("`/review` with nothing open says so on the message line", async () => {
    const { service } = stub();
    const ui = await opened_with(service);

    await run(ui, "review");
    const frame = await settled(ui, (each) => each.includes("no open pull requests"));

    expect(frame).not.toContain("pull requests   0");
    expect(IN_LIST(frame)).toBe(true);
  });

  test("a forge that refuses is a red line, not a dead session", async () => {
    const { service } = stub({
      pullRequests: async () => {
        throw new GroveError("refused", "gh is not installed", {
          hint: "install it from cli.github.com",
        });
      },
    });
    const ui = await opened_with(service);

    await run(ui, "review");
    const frame = await settled(ui, (each) => each.includes("gh is not installed"));

    // The refusal brought its advice with it, and the screen is still a screen.
    expect(frame).toContain("cli.github.com");
    expect(IN_LIST(frame)).toBe(true);
  });

  test("the picker moves with the arrows, stops at both ends, and enter checks one out", async () => {
    const { service, calls } = stub({
      pullRequests: async () => [pullRequest(12), pullRequest(34)],
      pendingCommands: async () => ["bun install"],
    });
    const ui = await opened_with(service);

    await run(ui, "review");
    await settled(ui, (frame) => frame.includes("enter check out"));

    // Up from the top row: clamped, rather than wrapping to the bottom of a
    // list you would then have to look at the screen to find. Then down twice
    // against two rows, which clamps at the other end for the same reason.
    await press(ui, keys.up);
    await press(ui, keys.up);
    await press(ui, "j");
    await press(ui, keys.down);
    await settled(ui, (frame) => /▸ +34/.test(frame));

    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("1 run in"));

    expect(calls.checkedOut).toEqual([34]);
    // The file's commands run after the worktree exists, under the name the
    // checkout gave it — `pr/<n>`, not the branch the pull request came from.
    expect(calls.trusted).toEqual(["pr/34"]);
  });

  /**
   * The menu is the key bar's overflow, so what is pinned here is the part
   * that makes it usable without one: `/` opens it, typing narrows it, and
   * every way out leaves the list as it was. What each command then does is
   * asserted where that command's own test is.
   */
  test("`/` opens the menu with everything that has no key of its own", async () => {
    const { service } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("/");
    const frame = await settled(ui, (each) => each.includes("/sync-all"));

    // Read off the menu: a command added there and drawn nowhere is exactly
    // what this test is for, and a hardcoded list would not notice one.
    for (const command of commandsFor(false)) {
      expect(frame).toContain(`/${command.name}`);
    }
    // And the popup's own keys, in place of the list's.
    expect(frame).toContain("enter run");
    expect(IN_LIST(frame)).toBe(false);
  });

  test("typing narrows the menu, and backspace widens it again", async () => {
    const { service } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("/");
    await settled(ui, (frame) => frame.includes("/sync-all"));

    // `re` is in four of the names, which is what makes this a filter rather
    // than a lookup.
    await press(ui, "re");
    let frame = await settled(ui, (each) => each.includes(`4 of ${MENU_TOTAL}`));
    expect(frame).toContain("/rebase");
    expect(frame).toContain("/review");
    expect(frame).toContain("/upstream");
    expect(frame).toContain("/refresh");
    expect(frame).not.toContain("/sync-all");

    await press(ui, "v");
    frame = await settled(ui, (each) => each.includes(`1 of ${MENU_TOTAL}`));
    expect(frame).toContain("/review");
    expect(frame).not.toContain("/refresh");

    ui.stdin.write(keys.backspace);
    frame = await settled(ui, (each) => each.includes(`4 of ${MENU_TOTAL}`));
    expect(frame).toContain("/refresh");
  });

  test("a query that matches nothing says so, and enter on it is a cancel", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("/");
    await settled(ui, (frame) => frame.includes("/sync-all"));
    await press(ui, "zzz");
    await settled(ui, (frame) => frame.includes("no command matches"));

    ui.stdin.write(keys.enter);
    await settled(ui, (frame) => IN_LIST(frame) && !frame.includes("no command matches"));

    expect(calls.synced).toEqual([]);
  });

  /**
   * Backspacing through the `/` that opened the menu closes it. The slash is
   * on screen at the head of the prompt, and deleting back over it is the same
   * "never mind" as `esc` — stopping dead at an empty query would leave the
   * popup up with nothing left to delete.
   */
  test("backspace past the slash closes the menu", async () => {
    const { service } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("/");
    await settled(ui, (frame) => frame.includes("/sync-all"));
    // `s` is in `setup`, `rebase`, `propose`, `sync-all`, `upstream` and
    // `refresh`, which is the whole of what a filter over a handful of short
    // names can narrow to.
    await press(ui, "s");
    await settled(ui, (frame) => frame.includes(`6 of ${MENU_TOTAL}`));

    await press(ui, keys.backspace);
    ui.stdin.write(keys.backspace);
    await settled(ui, (frame) => IN_LIST(frame) && !frame.includes("/sync-all"));
  });

  /**
   * No command name holds a slash, so a second `/` is a slip rather than a
   * filter — and dropping it is what makes the key idempotent. `App.e2e`'s
   * `open` leans on exactly that: raw mode is enabled from an effect after the
   * first paint, so the key that proves the app is reading has to survive
   * being sent twice.
   */
  test("a second slash leaves the menu exactly as it was", async () => {
    const { service } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("/");
    const opened = await settled(ui, (frame) => frame.includes("/sync-all"));

    await press(ui, "/");
    await press(ui, "/");

    expect(ui.frame()).toBe(opened);
  });

  test("the menu's cursor moves with the arrows and stops at both ends", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    ui.stdin.write("/");
    await settled(ui, (frame) => frame.includes("/sync-all"));

    // Up from the top row is clamped rather than wrapped, the same as the
    // picker's — and then down past the last row, which clamps the other way.
    await press(ui, keys.up);
    // One more than there are rows, so the last press is the one that clamps.
    for (let step = 0; step < MENU_TOTAL; step += 1) await press(ui, keys.down);
    await settled(ui, (frame) => /▸ +\/log/.test(frame));

    // And `enter` runs the row the marker is on, which is the last one.
    ui.stdin.write(keys.enter);
    await settled(ui, (frame) => IN_LIST(frame) && !frame.includes("commits in"));

    expect(calls.synced).toEqual([]);
  });

  // A view, not an action: nothing is read, nothing is written, and it is not
  // remembered anywhere on disk either.
  test("`/log` puts the commit panel away and brings it back", async () => {
    const { service } = stub();
    const ui = await opened_with(service);

    expect(await settled(ui, (frame) => frame.includes("commits in main"))).toContain("commits in");

    await run(ui, "log");
    await settled(ui, (frame) => IN_LIST(frame) && !frame.includes("commits in"));

    await run(ui, "log");
    await settled(ui, (frame) => frame.includes("commits in main"));
  });

  test("esc closes every popup, and leaves the list exactly as it was", async () => {
    const { service, calls } = stub({ pullRequests: async () => [pullRequest(12)] });
    const ui = await opened_with(service);

    // The prompt.
    ui.stdin.write("a");
    await settled(ui, (frame) => frame.includes("new branch"));
    await press(ui, "x");
    await press(ui, keys.esc);
    await settled(ui, (frame) => !frame.includes("new branch") && IN_LIST(frame));

    // The removal question — where any key but `y` is a no, and `esc` is the
    // one everybody presses.
    ui.stdin.write("r");
    await settled(ui, (frame) => frame.includes("remove main?"));
    ui.stdin.write(keys.esc);
    await settled(ui, (frame) => !frame.includes("remove main?") && IN_LIST(frame));

    // The picker.
    await run(ui, "review");
    await settled(ui, (frame) => frame.includes("enter check out"));
    ui.stdin.write(keys.esc);
    await settled(ui, (frame) => !frame.includes("enter check out") && IN_LIST(frame));

    // The menu, which is the one popup `esc` can be reached from twice: once
    // out of the picker it opened, and once out of the menu itself.
    ui.stdin.write("/");
    await settled(ui, (frame) => frame.includes("/sync-all"));
    ui.stdin.write(keys.esc);
    await settled(ui, (frame) => !frame.includes("/sync-all") && IN_LIST(frame));

    expect(calls.added).toEqual([]);
    expect(calls.removed).toEqual([]);
    expect(calls.checkedOut).toEqual([]);
    // And the cursor never moved: a popup that leaked its keystrokes into the
    // list would be worse than no popup.
    expect(ui.frame()).toMatch(/▸ \* main/);
  });

  /**
   * Whatever mode an action started in, it ends in the list.
   *
   * `perform` is the one shape every action has — clear the lines, take the
   * keys, say what happened, re-read, hand the keys back — and the handing back
   * is the part a mode could quietly keep hold of.
   */
  test("every action lands back in the list, whichever mode it started in", async () => {
    const { service } = stub({ pullRequests: async () => [pullRequest(12)] });
    const ui = await opened_with(service);

    ui.stdin.write("a");
    await settled(ui, (frame) => frame.includes("new branch"));
    await press(ui, "from-add");
    await press(ui, keys.enter);
    await settled(ui, (frame) => frame.includes("added from-add") && IN_LIST(frame));

    ui.stdin.write("r");
    await settled(ui, (frame) => frame.includes("remove main?"));
    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("removed /repo/main") && IN_LIST(frame));

    await run(ui, "review");
    await settled(ui, (frame) => frame.includes("enter check out"));
    ui.stdin.write(keys.enter);
    await settled(ui, (frame) => frame.includes("added pr/12") && IN_LIST(frame));

    // And from `busy` itself, which every one of those passed through.
    expect(BUSY(ui.frame())).toBe(false);
  });

  /**
   * A sync that stopped on a conflict is not a sync that worked, and the screen
   * draws what an action returns in the same accent colour it draws `rebased`
   * in — so the service raises it instead. What is pinned here is the screen's
   * half: a raised refusal reaches the message line rather than the session.
   */
  test("a refused action is reported on the screen instead of ending the app", async () => {
    const { service } = stub({
      sync: async () => {
        throw new GroveError("rebase-conflict", "feat/login stopped on a conflict", {
          hint: "fix it and run `grove sync` again",
          details: ["CONFLICT (content): Merge conflict in src/app.ts"],
        });
      },
    });
    const ui = await opened_with(service);

    await run(ui, "sync-all");
    await settled(ui, (each) => each.includes("sync every worktree?"));
    ui.stdin.write("y");
    const frame = await settled(ui, (each) => each.includes("stopped on a conflict"));

    // Everything the refusal carried, and a screen that is still a screen: the
    // list and the keys are both still there.
    expect(frame).toContain("Merge conflict in src/app.ts");
    expect(frame).toContain("fix it and run `grove sync` again");
    expect(frame).toContain("feat/");
    expect(IN_LIST(frame)).toBe(true);
  });

  // The list is re-read even after a failure: a refusal often happens half-way,
  // and a stale screen is how someone acts on the wrong row.
  test("a failed action still leaves the list up to date", async () => {
    let reads = 0;
    const { service } = stub({
      list: async () => {
        reads += 1;
        return [...ROWS];
      },
      remove: async () => {
        throw new GroveError("refused", "main is the default branch's worktree");
      },
    });
    const ui = await opened_with(service);
    const before = reads;

    ui.stdin.write("r");
    await settled(ui, (frame) => frame.includes("remove main?"));
    ui.stdin.write("y");
    await settled(ui, (frame) => frame.includes("default branch"));

    expect(reads).toBeGreaterThan(before);
  });

  // A screen that could not read the repository has one thing to say, and it is
  // not a tip about which key to press next.
  test("a first read that fails keeps the message line", async () => {
    const { service } = stub({
      list: async () => {
        throw new GroveError("refused", "fatal: not a grove");
      },
    });
    const ui = mount(service);

    const frame = await settled(ui, (each) => each.includes("fatal: not a grove"));

    expect(frame).not.toContain("tip:");
    // Still interactive rather than stuck reading: the mode falls back to the
    // list whether the read worked or not.
    expect(IN_LIST(frame)).toBe(true);
  });
});

/**
 * `/rebase`: the one command whose question has more than two answers, so it
 * opens a picker rather than a `confirm`. What the bases are is the service's
 * to say — the stub hands over three — and what `enter` on one does is the
 * whole of what is pinned here.
 */
describe("the rebase picker", () => {
  const CHOICES: readonly RebaseChoice[] = [
    { base: { kind: "upstream" }, ref: "origin/feat/login", label: "upstream" },
    { base: { kind: "trunk" }, ref: "origin/main", label: "trunk" },
    { base: { kind: "ref", ref: "feat/search" }, ref: "feat/search", label: "feat/search" },
  ];

  test("`/rebase` lists the bases for the row, esc leaves it, and enter rebases onto the one picked", async () => {
    const asked: string[] = [];
    const { service, calls } = stub({
      rebaseChoices: async (target) => {
        asked.push(target);
        return [...CHOICES];
      },
    });
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "rebase");
    const frame = await settled(ui, (each) => each.includes("enter rebase"));

    // Read for the row under the cursor, and drawn with the ref beside each
    // role — the two things that tell the rows apart.
    expect(asked).toEqual(["/repo/feat/login"]);
    expect(frame).toContain("rebase feat/login onto");
    expect(frame).toContain("origin/feat/login");
    expect(frame).toContain("feat/search");
    expect(IN_LIST(frame)).toBe(false);

    ui.stdin.write(keys.esc);
    await settled(ui, (each) => IN_LIST(each) && !each.includes("rebase feat/login onto"));
    expect(calls.rebased).toEqual([]);

    await run(ui, "rebase");
    await settled(ui, (each) => each.includes("enter rebase"));

    // Up from the top row clamps, the way the pull-request picker's does; then
    // one down is the trunk.
    await press(ui, keys.up);
    await press(ui, "j");
    await settled(ui, (each) => /▸ +trunk/.test(each));

    await press(ui, keys.enter);
    await settled(ui, (each) => IN_LIST(each) && each.includes("rebased onto origin/main"));

    expect(calls.rebased).toEqual([{ target: "/repo/feat/login", base: { kind: "trunk" } }]);
  });

  test("`/rebase` on a folder has no worktree to ask about, and does nothing", async () => {
    const asked: string[] = [];
    const { service, calls } = stub({
      rebaseChoices: async (target) => {
        asked.push(target);
        return [...CHOICES];
      },
    });
    const ui = await opened_with(service);

    // One down from `main` is the `feat/` folder.
    await press(ui, keys.down);
    await settled(ui, (frame) => /▸ +feat\//.test(frame));

    await run(ui, "rebase");
    await settled(ui, (frame) => IN_LIST(frame));

    expect(asked).toEqual([]);
    expect(calls.rebased).toEqual([]);
  });

  test("a service that refuses to list bases is a red line, not a dead session", async () => {
    const { service } = stub({
      rebaseChoices: async () => {
        throw new GroveError("git-failed", "cannot tell which branch origin considers default", {
          hint: "run `git remote set-head origin --auto`",
        });
      },
    });
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "rebase");
    const frame = await settled(ui, (each) => each.includes("considers default"));

    expect(frame).toContain("set-head");
    expect(IN_LIST(frame)).toBe(true);
  });
});

describe("proposing a pull request", () => {
  test("`/propose` asks with the base on the prompt, and `y` proposes the row", async () => {
    const asked: string[] = [];
    const { service, calls } = stub({
      pendingPropose: async (target) => {
        asked.push(target);
        return { base: "feat/search", remote: "origin", publish: false };
      },
    });
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "propose");
    const question = await settled(ui, (frame) =>
      frame.includes("open a pull request for feat/login onto feat/search?"),
    );

    // Read for the row under the cursor, and the key bar spelled for it: `y`
    // proposes, and `n` leaves the branch exactly where it is.
    expect(asked).toEqual(["/repo/feat/login"]);
    expect(question).toContain("y propose");
    expect(question).toContain("n leave it");

    ui.stdin.write("y");
    await settled(ui, (frame) => IN_LIST(frame) && frame.includes("opened pull request 7"));

    expect(calls.proposed).toEqual(["/repo/feat/login"]);
  });

  test("any key but `y` leaves it, and nothing reaches the forge", async () => {
    const { service, calls } = stub();
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "propose");
    await settled(ui, (frame) => frame.includes("open a pull request for feat/login onto main?"));

    ui.stdin.write("n");
    await settled(ui, (frame) => IN_LIST(frame) && !frame.includes("open a pull request"));

    expect(calls.proposed).toEqual([]);
  });

  test("a branch that already has a pull request is an answer, not a question", async () => {
    const { service, calls } = stub({
      pendingPropose: async () => ({
        base: "feat/search",
        remote: "origin",
        publish: false,
        existing: { number: 12, url: "https://forge/pull/12", base: "main" },
      }),
    });
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "propose");
    const frame = await settled(ui, (each) => each.includes("pull request 12 already proposes"));

    // The number, the base it actually has, and the URL to go and look at —
    // and the list back under it, with no `y` anywhere.
    expect(frame).toContain("feat/login onto main");
    expect(frame).toContain("https://forge/pull/12");
    expect(IN_LIST(frame)).toBe(true);
    expect(calls.proposed).toEqual([]);
  });

  test("`/propose` on a folder has no branch to propose, and does nothing", async () => {
    const asked: string[] = [];
    const { service, calls } = stub({
      pendingPropose: async (target) => {
        asked.push(target);
        return { base: "main", remote: "origin", publish: false };
      },
    });
    const ui = await opened_with(service);

    await press(ui, keys.down);
    await settled(ui, (frame) => /▸ +feat\//.test(frame));

    await run(ui, "propose");
    await settled(ui, (frame) => IN_LIST(frame));

    expect(asked).toEqual([]);
    expect(calls.proposed).toEqual([]);
  });

  test("a refusal before the question is a red line, not a dead session", async () => {
    const { service, calls } = stub({
      pendingPropose: async () => {
        throw new GroveError("gh", "this needs `gh`, which is not installed", {
          hint: "https://cli.github.com",
        });
      },
    });
    const ui = await opened_with(service);

    await toLogin(ui);
    await run(ui, "propose");
    const frame = await settled(ui, (each) => each.includes("which is not installed"));

    expect(frame).toContain("cli.github.com");
    expect(IN_LIST(frame)).toBe(true);
    expect(calls.proposed).toEqual([]);
  });
});

/**
 * The `pr` column: the forge's word on each row, read beside the list and
 * never waited for.
 *
 * The rows are on screen before the forge answers, and they stay on screen
 * when it refuses — a background read reports nothing — so what is checked
 * is that the column appears once there is something to draw, says the right
 * words for the right row, and is simply absent otherwise.
 */
describe("the pr column", () => {
  test("appears once the forge has answered, with the number, the checks and the review", async () => {
    const { service } = stub({
      branchPullRequests: async () => [
        badge("feat/login", { checks: "passing", review: "approved" }),
        badge("feat/search", { number: 43, checks: "failing", isDraft: true }),
      ],
    });
    const ui = await opened_with(service);

    const frame = await settled(ui, (each) => each.includes("#42 ✓ approved"));

    expect(frame).toContain("#43 ✗ draft");
    // The heading, between the trunk's column and the state.
    expect(frame).toMatch(/main\s+pr\s+state/);
    // The row keeps its other columns: the badge is one more, not a replacement.
    expect(frame).toMatch(/login\s+↑2 ↓0\s+↑5 ↓3\s+#42 ✓ approved/);
  });

  test("a review worktree is matched by its number, since its branch is grove's own name", async () => {
    const { service } = stub({
      list: async () => [...ROWS, summary({ dir: "pr/7", upstream: undefined })],
      branchPullRequests: async () => [
        badge("fix/crash", { number: 7, checks: "pending", conflicts: true }),
      ],
    });
    const ui = await opened_with(service);

    const frame = await settled(ui, (each) => each.includes("#7 · conflicts"));

    expect(frame).toMatch(/pr\/\s*\n?.*7.*#7 · conflicts/s);
  });

  test("a forge that refuses leaves the list as it was, with no column and no red line", async () => {
    let asked = 0;
    const { service } = stub({
      branchPullRequests: async () => {
        asked += 1;
        throw new GroveError("gh", "this needs `gh`, which is not installed");
      },
    });
    const ui = await opened_with(service);

    // The read happens on the open, beside the fetch; wait for it to have
    // been made and refused, then look at what the screen did about it.
    await waitFor(
      () => String(asked),
      (count) => count === "1",
      { timeoutMs: WAIT },
    );
    await nextFrame();

    const frame = plain(ui.lastFrame());
    expect(frame).not.toContain("not installed");
    expect(frame).not.toMatch(/\bpr\s+state/);
    expect(IN_LIST(frame)).toBe(true);
  });
});

/**
 * The stack panel: `grove stack`'s picture beside the list, for a row that is
 * in a stack, in the space the files panel would otherwise take.
 */
describe("the stack panel", () => {
  const STACKED: readonly WorktreeSummary[] = [
    summary({ dir: "main", isDefault: true, current: true }),
    summary({ dir: "feat/login" }),
    summary({ dir: "feat/login-api", parent: "feat/login" }),
  ];

  const PICTURE = {
    trunk: "main",
    rows: [
      { branch: "main", depth: 0, dir: "main", exists: true, current: true },
      {
        branch: "feat/login",
        parent: "main",
        depth: 1,
        dir: "feat/login",
        ahead: 2,
        behind: 0,
        exists: true,
        current: false,
      },
      {
        branch: "feat/login-api",
        parent: "feat/login",
        depth: 2,
        dir: "feat/login-api",
        ahead: 1,
        behind: 1,
        exists: true,
        current: false,
      },
    ],
  };

  test("appears beside a stacked row, with the drift against each parent, and not beside the rest", async () => {
    const asked: string[] = [];
    const { service } = stub({
      list: async () => [...STACKED],
      stack: async (target) => {
        asked.push(target);
        return PICTURE;
      },
    });
    const ui = await opened_with(service, { columns: 120 });

    // The cursor opens on `main`, which is in no stack: nothing is asked.
    expect(plain(ui.lastFrame())).not.toContain("stack under");

    // Down onto `login`, the bottom of the stack: the panel draws the whole
    // of it, the guides and the drift each branch has against its parent.
    await press(ui, "j");
    await press(ui, "j");
    const frame = await settled(ui, (each) => each.includes("stack under main"));

    expect(asked).toEqual(["/repo/feat/login"]);
    expect(frame).toMatch(/└─ feat\/login\s+↑2 ↓0/);
    expect(frame).toMatch(/└─ feat\/login-api\s+↑1 ↓1/);

    // And the child is drawn one step in under it in the list itself.
    expect(frame).toMatch(/▸\s+login\b[^\n]*\n\s{8}login-api/);
  });

  test("the files win the space when the row is dirty as well", async () => {
    const { service } = stub({
      list: async () => [
        ...STACKED.slice(0, 2),
        summary({
          dir: "feat/login-api",
          parent: "feat/login",
          dirty: true,
          changed: 1,
          files: ["api.ts"],
        }),
      ],
      stack: async () => PICTURE,
    });
    const ui = await opened_with(service, { columns: 120 });

    await press(ui, "j");
    await press(ui, "j");
    await press(ui, "j");
    const frame = await settled(ui, (each) => each.includes("uncommitted in feat/login-api"));

    expect(frame).not.toContain("stack under");
  });
});
