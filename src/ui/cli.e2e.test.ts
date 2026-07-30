import { afterEach, expect, test } from "bun:test";
import { runUiWithoutTty, startUi, type UiSession } from "./e2e-utils.ts";
import { keys } from "./test-utils.ts";

/**
 * End-to-end: the real `cli.tsx` process in a real pseudo-terminal.
 *
 * These cover what `ink-testing-library` structurally cannot — the `isTTY`
 * guard, the exit code, and a resize — so they stay deliberately thin.
 * Everything about view behaviour belongs in the component tests next door.
 */

// `Bun.spawn({ terminal })` is POSIX-only.
const onPosix = test.skipIf(process.platform === "win32");

const sessions: UiSession[] = [];

function start(options?: { cols: number; rows: number }): UiSession {
  const session = startUi(options);
  sessions.push(session);
  return session;
}

afterEach(async () => {
  // A test that failed mid-session leaves the child running; kill it either way.
  for (const session of sessions.splice(0)) {
    session.kill();
    await session.exited;
  }
});

onPosix(
  "boots in a real terminal and exits 0 on q",
  async () => {
    const ui = start();

    const frame = await ui.waitForFrame((f) => f.includes("Count 0"));
    expect(frame).toContain("1 Counter");
    expect(frame).toContain("q quit");

    ui.press("q");
    expect(await ui.exited).toBe(0);
  },
  20_000,
);

onPosix(
  "refuses to start when stdin is not a TTY",
  async () => {
    const { exitCode, stderr } = await runUiWithoutTty();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("needs an interactive terminal");
  },
  20_000,
);

onPosix(
  "routes real keypresses to the visible view",
  async () => {
    const ui = start();
    await ui.waitForFrame((f) => f.includes("Count 0"));

    // Clearing first means the next repaint is read on its own, so the
    // absence of "Count 0" proves the counter is gone rather than scrolled off.
    ui.clear();
    ui.press("2");
    const tasks = await ui.waitForFrame((f) => f.includes("2/5 done"));
    expect(tasks).toContain("space toggle");
    expect(tasks).not.toContain("Count 0");

    ui.clear();
    ui.press("1");
    await ui.waitForFrame((f) => f.includes("Count 0"));

    // Arrow keys as the terminal actually sends them, not Ink's `key` object.
    ui.clear();
    ui.press(keys.right);
    ui.press(keys.right);
    expect(await ui.waitForFrame((f) => f.includes("Count 2"))).toContain("Count 2");
  },
  20_000,
);

onPosix(
  "reflows when the terminal is resized",
  async () => {
    const ui = start({ cols: 80, rows: 24 });
    await ui.waitForFrame((f) => f.includes("Count 0"));

    ui.clear();
    ui.resize(40, 24);

    const narrow = await ui.waitForFrame((f) => f.includes("Count 0"));
    const widest = Math.max(...narrow.split("\n").map((line) => line.length));

    // The rounded border must fit the new width instead of wrapping.
    expect(widest).toBeLessThanOrEqual(40);
    expect(narrow).toContain("╮");
    expect(narrow).toContain("╯");
  },
  20_000,
);
