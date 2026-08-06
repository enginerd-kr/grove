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
  readonly ran: { args: readonly string[]; at: string }[];
  readonly synced: (string | undefined)[];
  readonly trusted: string[];
  readonly moved: string[];
  readonly proposed: { target: string; title: string; body: string }[];
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
    ran: [],
    synced: [],
    trusted: [],
    moved: [],
    proposed: [],
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
      git: async (args, at) => {
        calls.ran.push({ args, at });
        return `git ${args[0]} ok`;
      },
      sync: async (target) => {
        calls.synced.push(target);
        return "1 up-to-date";
      },
      // Nothing waiting by default, which is every repository with no
      // `.grove.toml` and every one whose file is already trusted: no
      // question is drawn, and the other tests never see one.
      pendingCommands: async () => [],
      moveTo: async (path) => {
        calls.moved.push(path);
        return `now in ${path}`;
      },
      standpoint: () => calls.moved.at(-1) ?? "/repo/main",
      prPreview: async (target) => ({
        path: target,
        dir: "feat/login",
        branch: "feat/login",
        base: "main",
        subjects: ["Add login"],
        body: "- Add login",
        commits: 1,
      }),
      createPr: async (target, title, body) => {
        calls.proposed.push({ target, title, body });
        return "https://example.com/pr/1";
      },
      trustAndRun: async (branch) => {
        calls.trusted.push(branch);
        return `1 run in ${branch}`;
      },
      ...overrides,
    },
  };
}

// The app refreshes once a minute. The tests that are *about* the refreshing
// drive it faster; the rest inherit it and are simply never ticked.
function mount(service: WorktreeService, refreshMs?: number, store = new LineStore()) {
  const instance = render(
    <App service={service} repoRoot="/repo" store={store} refreshMs={refreshMs} />,
  );

  return { ...instance, frame: () => plain(instance.lastFrame()) };
}

test("lists the worktrees, marking where you are and where the cursor is", async () => {
  const { service } = stub();
  const ui = mount(service);

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("login"));

  // The welcome, which is the only place the version and the opened folder are
  // said at all — the app took the alternate buffer, so the command that started
  // it is no longer on screen to read them off.
  expect(frame).toContain(`grove v${version}`);
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
  const ui = mount(service, 50);

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
// `grove add` brings it back, where this leaves nothing at all.
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

// The price of a configuration that travels with the project: `copy` and
// `link` move files already on the disk, and a command came in with a pull.
// The screen is the only surface that can hold the question — `grove add` has
// to behave the same in a pipe as under a terminal — so it asks here.
test("`a` asks about the commands the new worktree's file wants to run", async () => {
  const { service, calls } = stub({
    pendingCommands: async () => ["bun install", "./scripts/postinstall.sh"],
  });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("a");
  await waitFor(ui.lastFrame, (f) => f.includes("new branch"));
  ui.stdin.write("feat/new");
  await waitFor(ui.lastFrame, (f) => f.includes("feat/new"));
  ui.stdin.write(keys.enter);

  const asked = await waitFor(ui.lastFrame, (f) => f.includes("run it here?"));

  // The commands themselves, not a count of them: "trust 2 commands?" is a
  // question nobody can answer.
  expect(asked).toContain('"bun install"');
  expect(asked).toContain('"./scripts/postinstall.sh"');
  expect(asked).toContain("y run it");
  // The worktree was made either way; only the commands waited.
  expect(calls.added).toEqual([{ branch: "feat/new", from: "main" }]);
  expect(calls.trusted).toEqual([]);

  ui.stdin.write("n");
  await waitFor(ui.lastFrame, (f) => !f.includes("run it here?"));
  expect(calls.trusted).toEqual([]);
});

test("`y` to that question runs them, against the worktree just made", async () => {
  const { service, calls } = stub({ pendingCommands: async () => ["bun install"] });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("a");
  await waitFor(ui.lastFrame, (f) => f.includes("new branch"));
  ui.stdin.write("feat/new");
  await waitFor(ui.lastFrame, (f) => f.includes("feat/new"));
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("run it here?"));

  ui.stdin.write("y");
  await waitFor(ui.lastFrame, (f) => f.includes("1 run in"));

  expect(calls.trusted).toEqual(["feat/new"]);
});

// Every ordinary repository: no file, or one whose commands are already
// recorded. Nothing is drawn, and `a` is the one-step thing it has always been.
test("nothing is asked when nothing is waiting", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("a");
  await waitFor(ui.lastFrame, (f) => f.includes("new branch"));
  ui.stdin.write("feat/new");
  await waitFor(ui.lastFrame, (f) => f.includes("feat/new"));
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("added feat/new"));

  expect(ui.frame()).not.toContain("run it here?");
  expect(calls.trusted).toEqual([]);
});

// The title starts empty on purpose — it is the one thing the popup exists to
// ask for, and a prefilled answer to a question is how questions stop being
// read. The commits being proposed sit under it as context.
test("`p` opens a PR popup that asks for a title, and enter proposes", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));
  expect(ui.frame()).toContain("p PR");

  ui.stdin.write("p");
  const popup = await waitFor(ui.lastFrame, (f) => f.includes("PR feat/login → main"));
  expect(popup).toContain("# 1 commit onto main");
  expect(popup).toContain("- Add login");

  // Enter on the empty title is a cancel, not a PR with a guessed name.
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => !f.includes("PR feat/login → main"));
  expect(calls.proposed).toEqual([]);

  ui.stdin.write("p");
  await waitFor(ui.lastFrame, (f) => f.includes("PR feat/login → main"));
  ui.stdin.write("Fix the login flow");
  await waitFor(ui.lastFrame, (f) => f.includes("Fix the login flow"));
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("https://example.com/pr/1"));

  expect(calls.proposed).toEqual([
    { target: "/repo/feat/login", title: "Fix the login flow", body: "- Add login" },
  ]);
});

// The trunk is what PRs merge into; offering to propose it would be a menu
// that lies.
test("`p` is absent on the default branch", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  expect(ui.frame()).not.toContain("p PR");
  ui.stdin.write("p");
  await waitFor(ui.lastFrame, (f) => f.includes("q quit"));
  expect(calls.proposed).toEqual([]);
});

// Esc is the other half of every popup, and a popup that leaks its keystrokes
// into the list would be worse than none.
test("esc closes the PR popup with nothing proposed", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));
  ui.stdin.write("p");
  await waitFor(ui.lastFrame, (f) => f.includes("PR feat/login → main"));
  ui.stdin.write(keys.esc);
  await waitFor(ui.lastFrame, (f) => !f.includes("PR feat/login → main"));

  expect(calls.proposed).toEqual([]);
});

// Half of the screen's promise — q landing your shell where enter walked — is
// quietly unavailable without the shell function, and nothing else would ever
// say so. The tip opens the session and the first action reclaims the slot.
test("opening without a listening shell tips the one line that installs it", async () => {
  const { service } = stub();
  const ui = mount(service);

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("shell-init"));
  expect(frame).toContain("the shell function is not installed");
  expect(frame).toContain('eval "$(grove shell-init zsh)"');
});

test("opening with a listening shell says nothing about it", async () => {
  const { service } = stub();
  const instance = render(
    <App
      service={service}
      repoRoot="/repo"
      store={new LineStore()}
      refreshMs={100000}
      onCd={() => {}}
    />,
  );

  const frame = await waitFor(
    () => plain(instance.lastFrame()),
    (f) => f.includes("login"),
  );
  expect(frame).not.toContain("shell-init");
});

// The update check is a prop for the same reason the service is: the screen
// should not know about GitHub, only about having been told a version.
function mountChecking(service: WorktreeService, checkUpdate: () => Promise<string | undefined>) {
  const instance = render(
    <App service={service} repoRoot="/repo" store={new LineStore()} checkUpdate={checkUpdate} />,
  );

  return { ...instance, frame: () => plain(instance.lastFrame()) };
}

test("a newer release opens the session with the upgrade tip", async () => {
  const { service } = stub();
  const ui = mountChecking(service, async () => "9.9.9");

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("9.9.9"));
  expect(frame).toContain("grove v9.9.9 is out");
  expect(frame).toContain(`this is v${version}`);
  expect(frame).toContain("brew upgrade grove");
});

// One slot, and news outranks standing advice: the shell tip will still be
// true tomorrow, the release is what changed today.
test("the upgrade tip wins the slot over the shell tip", async () => {
  const { service } = stub();
  const ui = mountChecking(service, async () => "9.9.9");

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("9.9.9"));
  expect(frame).not.toContain("shell-init");
});

test("a check that fails leaves the shell tip to open the session", async () => {
  const { service } = stub();
  const ui = mountChecking(service, () => Promise.reject(new Error("offline")));

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("shell-init"));
  expect(frame).not.toContain("offline");
});

test("a check that finds nothing changes nothing", async () => {
  const { service } = stub();
  const ui = mountChecking(service, async () => undefined);

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("shell-init"));
  expect(frame).toContain("the shell function is not installed");
});

// A screen that failed to list has one thing to say, and it is not a tip.
test("a failed first read keeps the slot, upgrade or not", async () => {
  const { service } = stub({
    list: async () => {
      throw new Error("fatal: not a grove");
    },
  });
  const ui = mountChecking(service, async () => "9.9.9");

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("fatal: not a grove"));
  expect(frame).not.toContain("9.9.9");
});

// Enter moves the standpoint inside the app — the whole reason it exists is
// that "cd somewhere else first" should be one keystroke that never leaves the
// screen. The real shell is `q`'s business, not enter's.
test("enter moves the standpoint to the row under the cursor, app still open", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));
  expect(ui.frame()).toContain("enter go");

  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));

  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("now in"));

  expect(calls.moved).toEqual(["/repo/feat/login"]);
  // Still running, list still on screen.
  expect(ui.frame()).toContain("q quit");
});

// A folder is a real directory on disk — the tree mirrors it — so it is a
// destination too.
test("enter on a folder stands in the folder", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("now in"));

  expect(calls.moved).toEqual(["/repo/feat"]);
});

// `q` is where the app's standpoint and the real shell meet: if a function is
// listening and you moved, it gets the place you stood; if you never moved,
// an untouched shell needs nothing.
test("`q` hands the shell the standpoint, but only when it moved", async () => {
  const landed: string[] = [];
  const { service } = stub();
  const store = new LineStore();
  const instance = render(
    <App
      service={service}
      repoRoot="/repo"
      store={store}
      refreshMs={100000}
      onCd={(path) => {
        landed.push(path);
      }}
    />,
  );
  await waitFor(
    () => plain(instance.lastFrame()),
    (f) => f.includes("login"),
  );

  instance.stdin.write(keys.down);
  instance.stdin.write(keys.down);
  await waitFor(
    () => plain(instance.lastFrame()),
    (f) => /▸ +login/.test(f),
  );
  instance.stdin.write(keys.enter);
  // Wait for the move to *settle* — during busy the keys are off, and a q
  // pressed then would vanish.
  await waitFor(
    () => plain(instance.lastFrame()),
    (f) => f.includes("now in"),
  );

  instance.stdin.write("q");
  await waitFor(
    () => (landed.length > 0 ? "y" : ""),
    (f) => f === "y",
  );

  expect(landed).toEqual(["/repo/feat/login"]);
});

test("`q` without having moved leaves the shell alone", async () => {
  const landed: string[] = [];
  const { service } = stub();
  const instance = render(
    <App
      service={service}
      repoRoot="/repo"
      store={new LineStore()}
      refreshMs={100000}
      onCd={(path) => {
        landed.push(path);
      }}
    />,
  );
  await waitFor(
    () => plain(instance.lastFrame()),
    (f) => f.includes("login"),
  );

  instance.stdin.write("q");
  // The app exits without calling onCd; give it a beat to prove the negative.
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(landed).toEqual([]);
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

// The one open-ended thing you can type at this screen. Live, because narrowing
// a list you cannot see the effect of is guessing.
test("`?` opens a line that narrows the list as it is typed", async () => {
  const { service } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));

  ui.stdin.write("sea");
  const narrowed = await waitFor(ui.lastFrame, (f) => !f.includes("login"));

  expect(narrowed).toContain("search");
  expect(narrowed).toContain("filter");
  // `main` went too: this narrows to what matched, it does not merely highlight.
  expect(narrowed).not.toMatch(/\* main/);
});

test("`enter` keeps the worktree you found and drops the narrowing", async () => {
  const { service } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));
  ui.stdin.write("sea");
  const narrowed = await waitFor(ui.lastFrame, (f) => f.includes("❯ sea"));
  expect(narrowed).not.toContain("login");

  ui.stdin.write(keys.enter);
  const picked = await waitFor(ui.lastFrame, (f) => f.includes("login"));

  // Every row back — filtering was how the worktree was found, not a state to
  // stay in — with the cursor left on the one that was found.
  expect(picked).toMatch(/▸ +search/);
  expect(picked).toContain("main");
  expect(picked).not.toContain("❯");
  expect(picked).not.toContain("filter: sea");
});

// Typing one name until a single row is left is not moving, so the cursor never
// learned where it was. `enter` has to pin the row rather than trust the anchor.
test("`enter` lands on the row even when no arrow was ever pressed", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));
  ui.stdin.write("logi");
  await waitFor(ui.lastFrame, (f) => f.includes("❯ logi"));
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("search"));

  // And the row it landed on is the one the next key acts on.
  ui.stdin.write("s");
  await waitFor(ui.lastFrame, (f) => f.includes("1 up-to-date"));

  expect(calls.synced).toEqual(["/repo/feat/login"]);
});

// The deliberate hole in a service that is otherwise four commands with their
// destructive spellings filed off.
test("a `!` line runs git in the worktree the cursor is on", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));
  ui.stdin.write('!commit -m "two words"');
  // The line says where it is about to run, so that is never a guess.
  await waitFor(ui.lastFrame, (f) => f.includes("git in feat/login"));

  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("git commit ok"));

  // Quoted argument kept whole, and no filtering happened on the way.
  expect(calls.ran).toEqual([{ args: ["commit", "-m", "two words"], at: "/repo/feat/login" }]);
  expect(ui.frame()).toContain("main");
});

test("`!git log` means `!log` — the name of the thing you are talking to", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));
  ui.stdin.write("!git log --oneline");
  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("git log ok"));

  expect(calls.ran[0]?.args).toEqual(["log", "--oneline"]);
});

// The list is still the thing being looked at while the box is open, so the
// keys that move around it still do. Narrowing and then picking is one motion.
test("the arrows still move the cursor while the filter line is open", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));
  ui.stdin.write("feat");
  // Ranked and flat while filtering, so the first row is already a worktree and
  // carries its whole path — there is no heading to step over.
  await waitFor(ui.lastFrame, (f) => /▸ +feat\/login/.test(f));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\/search/.test(f));

  // The line is still the line: `j` and `k` are letters in here, not movement.
  // It lands in the filter, which then matches nothing — which is the proof.
  ui.stdin.write("j");
  const typed = await waitFor(ui.lastFrame, (f) => f.includes("❯ featj"));
  expect(typed).not.toContain("feat/login");

  // Backspace brings the rows back, and the cursor is where the arrows left it.
  // Waited on the rows rather than on the line, since `❯ featj` contains `❯ feat`.
  ui.stdin.write(keys.backspace);
  expect(await waitFor(ui.lastFrame, (f) => f.includes("feat/login"))).toMatch(/▸ +feat\/search/);

  // `!` only means git at the head of the line, so a command needs the filter
  // out of the way first. Clearing it puts every row back — and the cursor
  // stays on the one the arrows chose, because it is held by row and not by
  // position.
  ui.stdin.write(keys.esc);
  // `esc close` on the key bar is the line reporting itself empty, which is a
  // sharper signal than looking for an absence in the frame.
  await waitFor(ui.lastFrame, (f) => f.includes("esc close"));
  ui.stdin.write("!status\r");
  await waitFor(ui.lastFrame, (f) => f.includes("git status ok"));

  expect(calls.ran[0]?.at).toBe("/repo/feat/search");
});

// One layer at a time. Closing on the first press would mean a typo costs you
// the box as well as the word.
test("`esc` clears the line, and only closes the box once there is none", async () => {
  const { service } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));
  ui.stdin.write("sea");
  await waitFor(ui.lastFrame, (f) => f.includes("❯ sea"));

  ui.stdin.write(keys.esc);
  // Line gone, rows back, box still open and ready for the next attempt.
  const cleared = await waitFor(ui.lastFrame, (f) => !f.includes("❯ sea"));
  expect(cleared).toContain("❯");
  expect(cleared).toContain("login");
  expect(cleared).toContain("esc close");

  ui.stdin.write(keys.esc);
  expect(await waitFor(ui.lastFrame, (f) => !f.includes("❯"))).toContain("q quit");
});

// Keys arrive faster than React commits. A line typed and submitted inside one
// frame — which is what pasting is — used to run against the line as it was
// *before* the paste, and a paste carrying its own newline was dropped whole by
// the printable-only filter.
test("a command pasted with its newline runs, rather than vanishing", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));

  // One event: the text and the enter after it, with no frame in between.
  ui.stdin.write("!stash list\r");
  await waitFor(ui.lastFrame, (f) => f.includes("git stash ok"));

  expect(calls.ran[0]?.args).toEqual(["stash", "list"]);
});

// Six rows is right for a command narrating itself and wrong for output you
// asked for: `git status` is seven lines before it says anything unusual, and it
// was losing `On branch …` off the top — the line that says which worktree you
// are even looking at.
//
// Asserted as the difference between the two paths rather than as a count, since
// how many rows there are to divide depends on the terminal the tests run in.
test("a `!` command's output gets room that progress does not", async () => {
  const store = new LineStore();
  const seven = () => {
    for (let line = 1; line <= 7; line += 1) store.addNote("info", `line ${line}`);
  };
  const { service } = stub({
    sync: async () => {
      seven();
      return "synced";
    },
    git: async () => {
      seven();
      return "git status ok";
    },
  });
  const ui = mount(service, undefined, store);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  // Progress keeps the last six, so the first of seven falls off the top.
  ui.stdin.write("S");
  const progress = await waitFor(ui.lastFrame, (f) => f.includes("synced"));
  expect(progress).toContain("line 7");
  expect(progress).not.toContain("line 1");

  // The same seven lines, asked for rather than narrated, arrive whole.
  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));
  ui.stdin.write("!status\r");
  const output = await waitFor(ui.lastFrame, (f) => f.includes("git status ok"));

  expect(output).toContain("line 1");
  expect(output).toContain("line 7");
  expect(output).not.toContain("earlier line");
});

// What does not fit is said. The whole reason this changed is that a line went
// missing off the top without the screen admitting it.
test("output too long for the room says how much went above it", async () => {
  const store = new LineStore();
  const { service } = stub({
    git: async () => {
      for (let line = 1; line <= 200; line += 1) store.addNote("info", `line ${line}`);

      return "git log ok";
    },
  });
  const ui = mount(service, undefined, store);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write("?");
  await waitFor(ui.lastFrame, (f) => f.includes("❯"));
  ui.stdin.write("!log\r");

  const shown = await waitFor(ui.lastFrame, (f) => f.includes("git log ok"));

  expect(shown).toMatch(/… \d+ earlier lines/);
  expect(shown).toContain("line 200");
  // And the screen still fits: the list is not squeezed out to make room, and
  // nothing is drawn over the banner.
  expect(shown).toContain("grove v");
  expect(shown).toMatch(/▸ \* main/);
});

// A folder is a destination, not just a heading: it is what you reach for to
// act on everything under it at once.
test("landing on a folder changes the keys to what a folder can do", async () => {
  const { service } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  const frame = await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));

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
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));

  ui.stdin.write(keys.left);
  // A count where the rows used to be, which is the whole indicator: a folder
  // with nothing under it and a `2` beside it is visibly shut, and the count is
  // what those rows were telling you.
  const folded = await waitFor(ui.lastFrame, (f) => /▸ +feat\/\s+2/.test(f));
  expect(folded).not.toContain("login");
  expect(folded).toContain("←→ open");

  ui.stdin.write(keys.right);
  expect(await waitFor(ui.lastFrame, (f) => f.includes("login"))).toMatch(/▸ +feat\//);
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
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));

  ui.stdin.write(keys.right);
  expect(await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f))).toMatch(/▸ +login/);
});

// They have to be a pair. `←` used to walk out through as many levels as there
// were while `→` stopped at the first worktree it met, so holding one travelled
// and holding the other did nothing — and a key that sometimes moves and
// sometimes does not is a key you have to look at the screen to use.
test("`←` and `→` both keep moving when there is no level to step through", async () => {
  const { service } = stub({
    list: async () => [
      summary({ dir: "main", isDefault: true, current: true }),
      summary({ dir: "feat/login" }),
      summary({ dir: "feat/search" }),
    ],
  });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  // Down the tree with `→` alone: into the folder, then on through its rows.
  ui.stdin.write(keys.right);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));
  ui.stdin.write(keys.right);
  await waitFor(ui.lastFrame, (f) => /▸ +login/.test(f));
  // A worktree has nothing nested under it, and `→` carries on rather than
  // stopping — which is what it used to do here.
  ui.stdin.write(keys.right);
  await waitFor(ui.lastFrame, (f) => /▸ +search/.test(f));

  // And back out with `←` alone, past the folder and on up.
  ui.stdin.write(keys.left);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));
  // The folder is open, so this shuts it rather than moving.
  ui.stdin.write(keys.left);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\/\s+2/.test(f));
  // Shut and at the top level: nothing to step out to, so it keeps going up.
  ui.stdin.write(keys.left);
  expect(await waitFor(ui.lastFrame, (f) => /▸ \* main/.test(f))).toMatch(/▸ \* main/);
});

// The failure this prevents: folding a folder quietly changing what `r` there
// does, because what it removes was read off rows the fold had taken away.
test("`r` on a folded folder still removes everything inside it", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));
  ui.stdin.write(keys.left);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\/\s+2/.test(f));

  ui.stdin.write("r");
  await waitFor(ui.lastFrame, (f) => f.includes("remove all 2 under feat/"));
  ui.stdin.write("y");
  await waitFor(ui.lastFrame, (f) => f.includes("removed 2 worktrees"));

  expect(calls.removedMany).toEqual([["/repo/feat/login", "/repo/feat/search"]]);
}, 10_000);

// The list re-reads itself every couple of seconds. A fold held by row rather
// than by key would spring open on the next tick.
test("a fold survives the list re-reading itself", async () => {
  let listed: readonly WorktreeSummary[] = ROWS;
  const { service } = stub({ list: async () => listed });
  const ui = mount(service, 50);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));
  ui.stdin.write(keys.left);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\/\s+2/.test(f));

  // Something only a refresh can bring in, so what follows is an assertion
  // about a tick that demonstrably happened rather than one that may not have.
  // Waiting and then finding the fold intact would pass just as well if the
  // timer had never fired at all.
  listed = [...ROWS, summary({ dir: "zebra" })];
  await waitFor(ui.lastFrame, (f) => f.includes("zebra"));

  expect(ui.frame()).not.toContain("login");
  expect(ui.frame()).toMatch(/▸ +feat\/\s+2/);
});

test("`r` on a folder removes every worktree under it, after asking", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

  ui.stdin.write(keys.down);
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));

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
  await waitFor(ui.lastFrame, (f) => /▸ +feat\//.test(f));

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
