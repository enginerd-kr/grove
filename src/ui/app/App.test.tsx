import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { version } from "../../../package.json";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import { LineStore } from "../../report/lines.ts";
import { keys, plain, waitFor } from "../test-utils.ts";
import { App } from "./App.tsx";
import type { WorktreeService } from "./service.ts";

/**
 * The screen, driven by keystrokes against a stubbed service.
 *
 * No git, no repository: what is being checked here is that a key reaches the
 * action it claims to, and that the answer comes back onto the screen. Whether
 * the actions themselves do the right thing is `core/commands`' own tests.
 */

function summary(overrides: Partial<WorktreeSummary> & { dir: string }): WorktreeSummary {
  return {
    path: `/repo/${overrides.dir}`,
    branch: overrides.dir,
    detached: false,
    dirty: false,
    changed: 0,
    untracked: 0,
    // Tracking by default, because git only reports ahead/behind for a branch
    // that has an upstream — a summary with counts and no upstream is a state
    // no repository can be in.
    upstream: `origin/${overrides.dir}`,
    ahead: 0,
    behind: 0,
    locked: false,
    rebasing: false,
    isDefault: false,
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

type Calls = {
  fetched: number;
  readonly added: { branch: string; from?: string }[];
  readonly removed: string[];
  readonly removedMany: (readonly string[])[];
  readonly resetted: string[];
  readonly synced: (string | undefined)[];
};

function stub(overrides: Partial<WorktreeService> = {}): {
  service: WorktreeService;
  calls: Calls;
} {
  const calls: Calls = {
    fetched: 0,
    added: [],
    removed: [],
    removedMany: [],
    resetted: [],
    synced: [],
  };

  return {
    calls,
    service: {
      // A fresh array per call, as the real service gives: it rebuilds every
      // summary from git each time. Returning the same reference would let React
      // skip the re-render and quietly make the polling tests prove nothing.
      list: async () => [...ROWS],
      // Answering "nothing changed" keeps the background fetch out of every
      // other test: no re-read, so no frame nobody was waiting for.
      fetch: async () => {
        calls.fetched += 1;
        return false;
      },
      add: async (branch, from) => {
        calls.added.push({ branch, from });
        return `added ${branch}`;
      },
      remove: async (target) => {
        calls.removed.push(target);
        return `removed ${target}`;
      },
      removeMany: async (targets) => {
        calls.removedMany.push(targets);
        return `removed ${targets.length} worktrees`;
      },
      reset: async (target) => {
        calls.resetted.push(target);
        return `discarded 2 changes and 1 untracked file in ${target}`;
      },
      sync: async (target) => {
        calls.synced.push(target);
        return "1 up-to-date";
      },
      ...overrides,
    },
  };
}

function mount(service: WorktreeService) {
  const store = new LineStore();
  const instance = render(<App service={service} repoRoot="/repo" store={store} />);

  return { ...instance, frame: () => plain(instance.lastFrame()) };
}

test("lists the worktrees, marking where you are and where the cursor is", async () => {
  const { service } = stub();
  const ui = mount(service);

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("login"));

  // The welcome, which is the only place the version and the opened folder are
  // said at all — the app took the alternate buffer, so the command that started
  // it is no longer on screen to read them off.
  expect(frame).toContain(`garden v${version}`);
  expect(frame).toContain("/repo");
  expect(frame).toContain("3 worktrees · in main");
  expect(frame).toMatch(/worktree\s+origin\s+main\s+state/);
  // `*` is the worktree you are standing in, `▸` the one the keys act on.
  expect(frame).toMatch(/▸ \* main/);
  expect(frame).toContain("q quit");
  // The prefix is a folder heading with the worktree indented under it, not a
  // `feat/login` repeated on every row.
  expect(frame).toMatch(/feat\/\n\s+login/);
  expect(frame).not.toContain("feat/login");
});

// `↑` is what origin does not have and `↓` is what you do not, in a column of
// their own — the state column beside them would otherwise say "2 ahead" about
// the same two commits.
test("the remote column says how far each worktree has drifted from origin", async () => {
  const { service } = stub({
    list: async () => [
      summary({ dir: "main", isDefault: true, current: true }),
      summary({
        dir: "feat/login",
        ahead: 2,
        behind: 1,
        dirty: true,
        trunk: { ahead: 5, behind: 3 },
      }),
      summary({ dir: "feat/local", upstream: undefined, trunk: { ahead: 1, behind: 0 } }),
    ],
  });
  const ui = mount(service);

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("login"));

  // Two questions, two columns, one shape: what is there to push, and how far
  // the trunk has moved out from under you. `●` has changes in it, `○` does not.
  expect(frame).toMatch(/login\s+↑2 ↓1\s+↑5 ↓3\s+●/);
  // Nothing to compare the trunk against but itself, so its own column is blank
  // rather than a `↑0 ↓0` answering a question nobody asked.
  expect(frame).toMatch(/main\s+↑0 ↓0\s+○/);
  // A branch that was never pushed has no answer to give about its remote —
  // `↑0 ↓0` there would claim it is in step with something — but it still has
  // one about the trunk, which is the half that used to be missing entirely.
  expect(frame).toMatch(/local\s+no upstream\s+↑1 ↓0/);
  // The drift is said once per column, in the columns that exist for it.
  expect(frame).not.toContain("2 ahead");
});

// The state column is about a working tree, and a working tree is edited from
// somewhere else. Waiting for `R` makes the screen a photograph of whenever you
// last pressed a key.
test("the state column keeps up with the worktrees without a keypress", async () => {
  let listed: readonly WorktreeSummary[] = ROWS;
  const { service } = stub({ list: async () => listed });
  const ui = mount(service);

  await waitFor(ui.lastFrame, (f) => f.includes("login"));
  expect(ui.frame()).not.toContain("●");

  // What another terminal doing the editing looks like from in here.
  listed = ROWS.map((row) => (row.dir === "feat/login" ? { ...row, dirty: true } : row));

  expect(await waitFor(ui.lastFrame, (f) => f.includes("●"), { timeoutMs: 6000 })).toMatch(
    /login\s+↑2 ↓0\s+↑5 ↓3\s+●/,
  );
}, 10_000);

// The failure this prevents: a worktree created in another terminal appears
// above the selected one, the selection slides down a row on its own, and the
// next `r` is aimed at something the user never pointed at.
test("the cursor stays on the row it was on when the list changes underneath", async () => {
  let listed: readonly WorktreeSummary[] = ROWS;
  const { service } = stub({ list: async () => listed });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));

  // `chore/` sorts before `feat/`, so this pushes `login` two rows down. Read
  // back through `R` rather than through the timer, so what is under test is the
  // cursor and not the polling.
  listed = [...ROWS, summary({ dir: "chore/deps" })];
  ui.stdin.write("R");

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("deps"), { timeoutMs: 6000 });

  expect(frame).toMatch(/▸ +login/);
  expect(frame).not.toMatch(/▸ +deps/);
}, 10_000);

test("the cursor moves and `s` syncs whatever it is on", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  // Two rows down: the folder heading is a stop of its own.
  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));

  ui.stdin.write("s");
  await waitFor(ui.lastFrame, (f) => f.includes("1 up-to-date"));

  expect(calls.synced).toEqual(["/repo/feat/login"]);
});

test("`S` syncs every worktree, which is the one action with no target", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("S");
  await waitFor(ui.lastFrame, (f) => f.includes("1 up-to-date"));

  expect(calls.synced).toEqual([undefined]);
});

test("`a` takes a branch name and hands it to add", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("a");
  await waitFor(ui.lastFrame, (f) => f.includes("new branch"));

  ui.stdin.write("fix/crash");
  await waitFor(ui.lastFrame, (f) => f.includes("fix/crash"));

  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("added fix/crash"));

  // `main` because that is where the cursor was, which is the whole point.
  expect(calls.added).toEqual([{ branch: "fix/crash", from: "main" }]);
});

// Branching off the remote's default was right when there was nothing to point
// at. The cursor is already pointing at something, and the worktree you are
// looking at when you decide you want another one is almost always the one you
// mean to carry on from — including whatever is committed there and not pushed.
test("a new branch starts from the worktree the cursor is on", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));

  ui.stdin.write("a");
  // Said on the prompt, not left to be discovered from the result: `a` on one
  // row and `a` on another now start the branch in different places.
  await waitFor(ui.lastFrame, (f) => f.includes("new branch from feat/login"));

  ui.stdin.write("feat/login-part-2");
  await waitFor(ui.lastFrame, (f) => f.includes("feat/login-part-2"));
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("added feat/login-part-2"));

  expect(calls.added).toEqual([{ branch: "feat/login-part-2", from: "feat/login" }]);
});

// Nothing to carry on from: a detached HEAD has no branch name to pass, so the
// base falls back to the remote's default rather than being invented.
test("a detached worktree offers no base", async () => {
  const { service, calls } = stub({
    list: async () => [
      summary({ dir: "main", isDefault: true, detached: true, branch: undefined }),
    ],
  });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("main"));

  ui.stdin.write("a");
  const frame = await waitFor(ui.lastFrame, (f) => f.includes("new branch"));
  expect(frame).not.toContain("new branch from");

  ui.stdin.write("fix/crash");
  await waitFor(ui.lastFrame, (f) => f.includes("fix/crash"));
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("added fix/crash"));

  expect(calls.added).toEqual([{ branch: "fix/crash", from: undefined }]);
});

// The failure this prevents: `a` opening the prompt and the very next keypress
// being read as a command instead of as text.
test("keys typed into the prompt are text, not commands", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("a");
  await waitFor(ui.lastFrame, (f) => f.includes("new branch"));
  ui.stdin.write("s");
  await waitFor(ui.lastFrame, (f) => /new branch from main\s+s/.test(f));

  expect(calls.synced).toEqual([]);
});

test("escape leaves the prompt without adding anything", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("a");
  await waitFor(ui.lastFrame, (f) => f.includes("new branch"));
  ui.stdin.write("x");
  ui.stdin.write(keys.esc);
  await waitFor(ui.lastFrame, (f) => !f.includes("new branch"));

  expect(calls.added).toEqual([]);
});

// Removal is the one key that deletes something, so it asks first.
test("`r` confirms before removing, and `n` means no", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("r");
  await waitFor(ui.lastFrame, (f) => f.includes("remove main?"));
  ui.stdin.write("n");
  await waitFor(ui.lastFrame, (f) => !f.includes("remove main?"));
  expect(calls.removed).toEqual([]);

  ui.stdin.write("r");
  await waitFor(ui.lastFrame, (f) => f.includes("remove main?"));
  ui.stdin.write("y");
  await waitFor(ui.lastFrame, (f) => f.includes("removed"));
  expect(calls.removed).toEqual(["/repo/main"]);
});

// The one key that destroys work rather than moving it about, so it asks first
// and says what it costs — a removed worktree leaves its branch behind and
// `garden add` brings it back, where this leaves nothing at all.
test("`x` asks before discarding, and says how much is at stake", async () => {
  const { service, calls } = stub({
    list: async () => [
      summary({ dir: "main", isDefault: true, current: true }),
      summary({ dir: "feat/login", dirty: true, changed: 4, untracked: 1 }),
    ],
  });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));
  expect(ui.frame()).toContain("x discard");

  ui.stdin.write("x");
  // Counted apart: `x` deletes untracked files too, and one of those may be work
  // git has never seen a copy of.
  const asked = await waitFor(ui.lastFrame, (f) => f.includes("discard 3 changes"));
  expect(asked).toContain("and 1 untracked file");
  expect(asked).toContain("feat/login");
  expect(asked).toContain("no undo");

  ui.stdin.write("n");
  await waitFor(ui.lastFrame, (f) => !f.includes("no undo"));
  expect(calls.resetted).toEqual([]);

  ui.stdin.write("x");
  await waitFor(ui.lastFrame, (f) => f.includes("no undo"));
  ui.stdin.write("y");
  await waitFor(ui.lastFrame, (f) => f.includes("discarded 2 changes and 1 untracked file"));

  expect(calls.resetted).toEqual(["/repo/feat/login"]);
});

// A worktree whose only change is a file git has never seen is still a worktree
// with something to discard — and `x` used to leave it exactly as it was.
test("`x` works on a worktree that is dirty only from untracked files", async () => {
  const { service, calls } = stub({
    list: async () => [
      summary({
        dir: "main",
        isDefault: true,
        current: true,
        dirty: true,
        changed: 2,
        untracked: 2,
      }),
    ],
  });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("main"));

  ui.stdin.write("x");
  const asked = await waitFor(ui.lastFrame, (f) => f.includes("no undo"));

  expect(asked).toContain("2 untracked files");
  // No "0 changes" beside it: the count that is zero is left out rather than
  // padded in.
  expect(asked).not.toContain("0 changes");

  ui.stdin.write("y");
  await waitFor(ui.lastFrame, (f) => f.includes("discarded"));
  expect(calls.resetted).toEqual(["/repo/main"]);
});

// A confirmation for a reset that would do nothing is a prompt that teaches
// people to answer `y` without reading it.
test("`x` is absent, and does nothing, on a worktree with nothing to discard", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  expect(ui.frame()).not.toContain("x discard");

  ui.stdin.write("x");
  await waitFor(ui.lastFrame, (f) => f.includes("q quit"));

  expect(ui.frame()).not.toContain("no undo");
  expect(calls.resetted).toEqual([]);
});

// A folder is a destination, not just a heading: it is what you reach for to
// act on everything under it at once.
test("landing on a folder changes the keys to what a folder can do", async () => {
  const { service } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  const frame = await waitFor(ui.lastFrame, (f) => /▸ ▾ feat\//.test(f));

  expect(frame).toContain("remove all 2");
  expect(frame).toContain("add under feat/");
  // `s` syncs one worktree, and a folder is not one — a menu offering it would
  // be a menu that lies.
  expect(frame).not.toMatch(/s sync\b/);
});

test("`←` folds a folder shut and `→` opens it again", async () => {
  const { service } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ ▾ feat\//.test(f));

  ui.stdin.write(keys.left);
  // `▸` in the fold column rather than `▾`, and the count of what it is holding
  // back — which is the thing the folded rows were telling you.
  const folded = await waitFor(ui.lastFrame, (f) => /▸ ▸ feat\/\s+2/.test(f));
  expect(folded).not.toContain("login");
  expect(folded).toContain("←→ open");

  ui.stdin.write(keys.right);
  expect(await waitFor(ui.lastFrame, (f) => f.includes("login"))).toMatch(/▸ ▾ feat\//);
}, 10_000);

// The keys have to feel like a tree rather than a pair of toggles: `←` from
// inside a folder is how you get back out to it without counting rows.
test("`←` from a worktree walks out to its folder, and `→` steps back in", async () => {
  const { service } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));

  ui.stdin.write(keys.left);
  await waitFor(ui.lastFrame, (f) => /▸ ▾ feat\//.test(f));

  ui.stdin.write(keys.right);
  expect(await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f))).toMatch(/▸ +login/);
});

// The failure this prevents: folding a folder quietly changing what `r` there
// does, because what it removes was read off rows the fold had taken away.
test("`r` on a folded folder still removes everything inside it", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ ▾ feat\//.test(f));
  ui.stdin.write(keys.left);
  await waitFor(ui.lastFrame, (f) => /▸ ▸ feat\//.test(f));

  ui.stdin.write("r");
  await waitFor(ui.lastFrame, (f) => f.includes("remove all 2 under feat/"));
  ui.stdin.write("y");
  await waitFor(ui.lastFrame, (f) => f.includes("removed 2 worktrees"));

  expect(calls.removedMany).toEqual([["/repo/feat/login", "/repo/feat/search"]]);
}, 10_000);

// The list re-reads itself every couple of seconds. A fold held by row rather
// than by key would spring open on the next tick.
test("a fold survives the list re-reading itself", async () => {
  const { service } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ ▾ feat\//.test(f));
  ui.stdin.write(keys.left);
  await waitFor(ui.lastFrame, (f) => /▸ ▸ feat\//.test(f));

  // Long enough for two refresh ticks to have come and gone.
  await new Promise((resolve) => setTimeout(resolve, 4500));

  expect(ui.frame()).not.toContain("login");
  expect(ui.frame()).toMatch(/▸ ▸ feat\//);
}, 15_000);

test("`r` on a folder removes every worktree under it, after asking", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ ▾ feat\//.test(f));

  ui.stdin.write("r");
  await waitFor(ui.lastFrame, (f) => f.includes("remove all 2 under feat/"));
  ui.stdin.write("y");
  await waitFor(ui.lastFrame, (f) => f.includes("removed 2 worktrees"));

  expect(calls.removedMany).toEqual([["/repo/feat/login", "/repo/feat/search"]]);
  // Never one at a time behind the user's back: the loop and its refusals live
  // in the service, where the command's own checks still apply to each.
  expect(calls.removed).toEqual([]);
});

test("`a` on a folder starts the branch name inside it", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ ▾ feat\//.test(f));

  ui.stdin.write("a");
  await waitFor(ui.lastFrame, (f) => f.includes("new branch feat/"));
  ui.stdin.write("chat");
  await waitFor(ui.lastFrame, (f) => f.includes("new branch feat/chat"));

  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("added feat/chat"));

  // A folder is not a branch, so there is nothing to carry on from.
  expect(calls.added).toEqual([{ branch: "feat/chat", from: undefined }]);
});

test("a refused action is reported on the screen instead of ending the app", async () => {
  const { service } = stub({
    remove: async () => {
      throw new Error("main is the default branch's worktree");
    },
  });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("r");
  await waitFor(ui.lastFrame, (f) => f.includes("remove main?"));
  ui.stdin.write("y");

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("default branch"));
  // Still a working screen: the list and the keys are both still there.
  expect(frame).toContain("feat/");
  expect(frame).toContain("q quit");
});
