import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
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
    ahead: 0,
    behind: 0,
    locked: false,
    rebasing: false,
    isDefault: false,
    current: false,
    ...overrides,
  };
}

const ROWS: readonly WorktreeSummary[] = [
  summary({ dir: "main", isDefault: true, current: true }),
  summary({ dir: "feat/login", ahead: 2 }),
];

type Calls = {
  readonly added: string[];
  readonly removed: string[];
  readonly synced: (string | undefined)[];
};

function stub(overrides: Partial<WorktreeService> = {}): {
  service: WorktreeService;
  calls: Calls;
} {
  const calls: Calls = { added: [], removed: [], synced: [] };

  return {
    calls,
    service: {
      list: async () => ROWS,
      add: async (branch) => {
        calls.added.push(branch);
        return `added ${branch}`;
      },
      remove: async (target) => {
        calls.removed.push(target);
        return `removed ${target}`;
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

  expect(frame).toContain("wt");
  expect(frame).toMatch(/worktree\s+state/);
  // `*` is the worktree you are standing in, `▸` the one the keys act on.
  expect(frame).toMatch(/▸ \* main/);
  expect(frame).toContain("2 ahead");
  expect(frame).toContain("q quit");
  // The prefix is a folder heading with the worktree indented under it, not a
  // `feat/login` repeated on every row.
  expect(frame).toMatch(/feat\/\n\s+login/);
  expect(frame).not.toContain("feat/login");
});

test("the cursor moves and `s` syncs whatever it is on", async () => {
  const { service, calls } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("login"));

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

  expect(calls.added).toEqual(["fix/crash"]);
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
  await waitFor(ui.lastFrame, (f) => /new branch s/.test(f));

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
