import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { pathExists } from "../../core/fs.ts";
import { withTempRepo } from "../../core/test-utils.ts";
import { runCli, startUi, type UiSession } from "../e2e-utils.ts";

/**
 * The app, as a user meets it: a bare `grove` in a real repository, in a real
 * terminal, doing real git work.
 *
 * `ink-testing-library` can drive the screen (`App.test.tsx` does) but it cannot
 * answer the question this file exists for — whether typing `grove` and nothing
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
  "a bare `grove` opens the worktrees, runs a command from a keystroke, and quits",
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

// The scenario that earned the feature: launched inside a worktree, `r` on it
// is refused — so enter steps out to main first, the removal goes through, and
// quitting hands the shell the standpoint via GROVE_CD_FILE so it is not left
// in a directory that no longer exists.
onPosix(
  "enter steps out, remove unlocks, and q hands the shell the standpoint",
  async () => {
    await withTempRepo(async ({ work, originUrl, root }) => {
      const cloned = await runCli(["clone", originUrl, "repo"], { cwd: work });
      expect(cloned.exitCode).toBe(0);
      const added = await runCli(["add", "feat/doomed"], { cwd: `${work}/repo/main` });
      expect(added.exitCode).toBe(0);

      const cdFile = `${root}/cd-goes-here`;
      process.env.GROVE_CD_FILE = cdFile;
      try {
        // Launched from inside the worktree about to be removed.
        const ui = start({ cwd: `${work}/repo/feat/doomed`, rows: 30 });
        const opened = await ui.waitForFrame((frame) => frame.includes("q quit"));
        expect(opened).toContain("enter go");

        // The cursor opens on the first row, which is main: enter steps out.
        ui.clear();
        await ui.pressUntil("\r", (frame) => frame.includes("now in main"), 10_000);

        // Standing in main now, the refusal is gone: remove the launch dir.
        ui.clear();
        await ui.pressUntil("\u001B[B", (frame) => /▸ +doomed/.test(frame), 10_000);
        // Single presses from here: a retried `r` would land inside the confirm,
        // where any key that is not y is a no.
        ui.clear();
        ui.press("r");
        await ui.waitForFrame((frame) => frame.includes("remove feat/doomed?"), 10_000);
        ui.clear();
        ui.press("y");
        await ui.waitForFrame((frame) => frame.includes("removed"), 20_000);

        expect(await ui.pressUntilExit("q")).toBe(0);
      } finally {
        delete process.env.GROVE_CD_FILE;
      }

      // The worktree is gone, and the shell has somewhere real to land.
      expect(await pathExists(`${work}/repo/feat/doomed`)).toBe(false);
      expect((await Bun.file(cdFile).text()).trim()).toBe(`${work}/repo/main`);
    });
  },
  60_000,
);

// The whole point of the setup screen: `grove` used to exit 3 here. Driven end
// to end because what it produces — `.bare`, the `.git` pointer, a worktree for
// the default branch — is the part a stubbed clone could not vouch for.
onPosix(
  "a bare `grove` in an empty folder clones into it and becomes the app",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const empty = `${work}/grove`;
      await mkdir(empty, { recursive: true });

      const ui = start({ cwd: empty, rows: 28 });
      await ui.waitForFrame((frame) => frame.includes("enter clone"));

      // Written once, not through `pressUntil`: a URL typed twice is a URL twice.
      ui.clear();
      ui.press(originUrl);
      await ui.waitForFrame((frame) => frame.includes("repository file://"));

      ui.clear();
      ui.press("\r");
      const opened = await ui.waitForFrame((frame) => frame.includes("q quit"), 30_000);
      // The newest repaint only. The setup frames are still in the buffer behind
      // it, and the point of this assertion is that they are behind it.
      const screen = opened.split("\n").slice(-28).join("\n");

      // The list, not the prompt: the screen became the app on its own.
      expect(screen).toContain("main");
      expect(screen).toContain("1 worktree");
      expect(screen).not.toContain("no repository here yet");

      expect(await pathExists(`${empty}/.bare`)).toBe(true);
      expect(await pathExists(`${empty}/.git`)).toBe(true);
      expect(await pathExists(`${empty}/main`)).toBe(true);

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

      // Narrower than the key bar: it takes a second row rather than squeezing
      // every hint until the keys and their actions land on different lines, and
      // the layout knows it took one — so `q quit` is still on the screen.
      ui.clear();
      ui.resize(46, 20);

      const narrow = await ui.waitForFrame((frame) => frame.split("\n").includes("─".repeat(46)));

      // The tail of the buffer is the newest repaint — one whole 20-row screen.
      // The 70-wide frames before it are still in there, so the width check has
      // to be made against the screen rather than against everything drawn.
      const screen = narrow.split("\n").slice(-20);

      expect(screen.join("\n")).toContain("↑↓ move");
      expect(screen.join("\n")).toContain("q quit");
      for (const line of screen) expect(line.length).toBeLessThanOrEqual(46);
    });
  },
  60_000,
);

// The same invocation without a terminal: there is nothing to draw on and
// nothing to read keys from, so it answers the way it always did.
onPosix(
  "a bare `grove` through a pipe prints the usage and exits 0",
  async () => {
    const { exitCode, stdout } = await runCli();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: grove <command>");
  },
  20_000,
);
