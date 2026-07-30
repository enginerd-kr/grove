import { afterEach, expect, test } from "bun:test";
import { withTempRepo } from "../../core/test-utils.ts";
import { runCli, startUi, type UiSession } from "../e2e-utils.ts";

/**
 * The app, as a user meets it: a bare `wt` in a real repository, in a real
 * terminal, doing real git work.
 *
 * `ink-testing-library` can drive the screen (`App.test.tsx` does) but it cannot
 * answer the question this file exists for — whether typing `wt` and nothing
 * else opens anything at all, which depends on `process.stdin.isTTY`.
 */

const onPosix = test.skipIf(process.platform === "win32");

const sessions: UiSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.kill();
    await session.exited;
  }
});

function start(options: Parameters<typeof startUi>[0]): UiSession {
  const session = startUi(options);
  sessions.push(session);

  return session;
}

onPosix(
  "a bare `wt` opens the worktrees, runs a command from a keystroke, and quits",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const cloned = await runCli(["clone", originUrl, "repo"], { cwd: work });
      expect(cloned.exitCode).toBe(0);

      const ui = start({ cwd: `${work}/repo/main`, rows: 30 });

      const opened = await ui.waitForFrame((frame) => frame.includes("q quit"));
      expect(opened).toContain("main");
      // `*` is the worktree the app was started from.
      expect(opened).toMatch(/▸ \* main/);

      // `S` syncs everything: idempotent, so `pressUntil` may resend it while
      // the child is still enabling raw mode.
      ui.clear();
      const synced = await ui.pressUntil("S", (frame) => frame.includes("up-to-date"), 20_000);
      expect(synced).toContain("fetched");

      expect(await ui.pressUntilExit("q")).toBe(0);
    });
  },
  60_000,
);

// Built from a char code so the escape byte never appears literally in source.
const ESC = String.fromCharCode(27);

// What makes it a screen rather than output: the app runs in the alternate
// buffer, so quitting gives the terminal back with the shell history intact.
onPosix(
  "takes the alternate screen and hands it back on exit",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      expect((await runCli(["clone", originUrl, "repo"], { cwd: work })).exitCode).toBe(0);

      const ui = start({ cwd: `${work}/repo/main` });
      await ui.waitForFrame((frame) => frame.includes("q quit"));

      expect(ui.raw()).toContain(`${ESC}[?1049h`);
      expect(await ui.pressUntilExit("q")).toBe(0);
      expect(ui.raw()).toContain(`${ESC}[?1049l`);
    });
  },
  60_000,
);

// The layout is measured against the terminal, so a resize has to reach it.
onPosix(
  "redraws to fit a resized terminal",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      expect((await runCli(["clone", originUrl, "repo"], { cwd: work })).exitCode).toBe(0);

      const ui = start({ cwd: `${work}/repo/main`, cols: 100, rows: 30 });
      await ui.waitForFrame((frame) => frame.includes("q quit"));

      ui.clear();
      ui.resize(70, 14);

      // The rule spans the full width, so a line of exactly 70 is proof the new
      // size reached the layout — matched as a whole line, because the 100-wide
      // rule still sitting in the buffer contains 70 dashes too.
      const resized = await ui.waitForFrame((frame) => frame.split("\n").includes("─".repeat(70)));

      expect(resized).toContain("q quit");
    });
  },
  60_000,
);

// The same invocation without a terminal: there is nothing to draw on and
// nothing to read keys from, so it answers the way it always did.
onPosix(
  "a bare `wt` through a pipe prints the usage and exits 0",
  async () => {
    const { exitCode, stdout } = await runCli();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: wt <command>");
  },
  20_000,
);
