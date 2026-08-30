import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "../../cli/test-cli.ts";
import { pathExists } from "../../core/fs.ts";
import { type TempRepo, withTempRepo } from "../../core/test-utils.ts";
import { startUi, type UiSession } from "../e2e-utils.ts";
import { keys } from "../test-utils.ts";

/**
 * The app, driven through a real pseudo-terminal.
 *
 * A smoke suite on purpose: this is the one layer where an assertion can be
 * true of the screen and still fail on a slow machine, so it covers the keys
 * that decide what the app *is* — the list paints, the cursor moves, the
 * destructive key asks first — and leaves the rest to the tests below it.
 *
 * Every wait is on a frame rather than on a clock, and every one is given a
 * generous deadline: the child is a whole `bun` process reading a git
 * repository, and being slow is not the same as being wrong.
 */

// The alternate screen, in and out. An assertion about escape sequences is the
// only way to make one — built from a char code so the escape byte stays out of
// the source, the way `test-utils` does it.
const ESC = String.fromCharCode(27);
const ALT_SCREEN_IN = `${ESC}[?1049h`;
const ALT_SCREEN_OUT = `${ESC}[?1049l`;
const CTRL_C = String.fromCharCode(3);

/** A whole `bun` process, a clone, and a repaint per key: minutes, not seconds. */
const SLOW = 90_000;
const WAIT = 30_000;

/** POSIX only — `startUi` needs a PTY, and there is none to give it on Windows. */
const describeUi = process.platform === "win32" ? describe.skip : describe;

async function managed(repo: TempRepo): Promise<string> {
  const clone = await runCli(["clone", repo.originUrl], { cwd: repo.work });
  expect(clone.exitCode).toBe(0);
  const root = join(repo.work, "origin");

  for (const branch of ["feat/login", "feat/signup"]) {
    expect((await runCli(["add", branch], { cwd: root })).exitCode).toBe(0);
  }
  // One dirty worktree, so the files panel has something to appear for.
  await Bun.write(join(root, "feat", "login", "scratch.txt"), "half-finished\n");

  return root;
}

/**
 * The newest repaint in the buffer, rather than every repaint since the clear.
 *
 * Ink rewrites the whole frame on every update, so a buffer holding three of
 * them satisfies "contains" for anything any of them said — which is how a
 * `not.toContain` passes over a screen that still shows the thing. The column
 * heading is on every frame the list draws, so the last one starts there.
 */
const HEADING = "    worktree";

function lastPaint(frame: string): string {
  const at = frame.lastIndexOf(HEADING);

  return at === -1 ? frame : frame.slice(at);
}

/** The label of the row the cursor is on, as the marker column reports it. */
function selected(frame: string): string {
  const rows = frame.split("\n").filter((line) => line.trimStart().startsWith("▸"));
  const row = (rows.at(-1) ?? "").replace("▸", "").trim();

  return row.split(/\s{2,}/)[0] ?? "";
}

/**
 * Starts the app and waits until it is reading keys.
 *
 * `R` rather than a sleep: raw mode is enabled from an effect that runs after
 * the first paint, so a key sent into that window is eaten by the line
 * discipline. `R` is the one key worth resending — it refreshes however often
 * it arrives — and the activity line it leaves is proof the app took it.
 */
async function open(cwd: string, cols = 100, rows = 30): Promise<UiSession> {
  const ui = startUi({ cwd, cols, rows });
  await ui.waitForFrame((frame) => frame.includes("worktree"), WAIT);
  await ui.pressUntil("R", (frame) => frame.includes("refreshed"), WAIT);

  return ui;
}

/**
 * Sends one key and waits for the repaint it caused.
 *
 * The heading is required as well as the predicate, because the buffer starts
 * empty after the clear and an empty buffer satisfies every `not` a caller
 * could ask for — the wait would then pass before the key had been read.
 */
async function press(
  ui: UiSession,
  key: string,
  settled: (frame: string) => boolean,
): Promise<void> {
  ui.clear();
  ui.press(key);
  await ui.waitForFrame((frame) => frame.includes(HEADING) && settled(lastPaint(frame)), WAIT);
}

describeUi("the app", () => {
  test(
    "paints the worktrees, takes the alternate screen, survives a narrow terminal, and quits on q",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const ui = await open(root);

        try {
          const frame = ui.frame();
          expect(frame).toContain("main");
          expect(frame).toContain("feat/");
          expect(frame).toContain("login");
          expect(frame).toContain("signup");
          // The card counts them, which is the app's own answer rather than ours.
          expect(frame).toContain("3 worktrees");
          expect(ui.raw()).toContain(ALT_SCREEN_IN);

          // Half the width and half the height: the layout gives up columns
          // rather than drawing off the edge of the screen.
          ui.clear();
          ui.resize(40, 14);
          const narrow = await ui.waitForFrame(
            (each) =>
              lastPaint(each).includes(HEADING) &&
              lastPaint(each)
                .split("\n")
                .every((line) => line.length <= 40),
            WAIT,
          );
          // Fewer columns and fewer rows than the list wants, and it is still a
          // list with keys under it rather than a wrapped mess.
          expect(lastPaint(narrow)).toContain("main");
          expect(lastPaint(narrow)).toContain("q quit");

          expect(await ui.pressUntilExit("q", WAIT)).toBe(0);
          // Handed back exactly as it was found.
          expect(ui.raw()).toContain(ALT_SCREEN_OUT);
        } finally {
          ui.kill();
        }
      });
    },
    SLOW,
  );

  test(
    "moves the cursor with the arrows and with j and k, and folds a branch folder with either spelling",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const ui = await open(root);

        try {
          expect(selected(ui.frame())).toBe("main");

          await press(ui, keys.down, (frame) => selected(frame) === "feat/");
          await press(ui, keys.down, (frame) => selected(frame) === "login");
          // The row under the cursor is the dirty one, so its files are beside it.
          expect(lastPaint(ui.frame())).toContain("uncommitted in feat/login");
          expect(lastPaint(ui.frame())).toContain("scratch.txt");

          await press(ui, "j", (frame) => selected(frame) === "signup");
          // ...and a clean row has nothing to say there.
          expect(lastPaint(ui.frame())).not.toContain("uncommitted in");

          await press(ui, "k", (frame) => selected(frame) === "login");
          await press(ui, keys.up, (frame) => selected(frame) === "feat/");

          // Shut, opened, and both again with the letters — the pair is only a
          // pair if each spelling does both halves.
          await press(ui, keys.left, (frame) => !frame.includes("signup"));
          await press(ui, keys.right, (frame) => frame.includes("signup"));
          await press(ui, "h", (frame) => !frame.includes("signup"));
          await press(ui, "l", (frame) => frame.includes("signup"));

          expect(selected(ui.frame())).toBe("feat/");
        } finally {
          ui.kill();
        }
      });
    },
    SLOW,
  );

  test(
    "L takes the commit panel away and brings it back, and esc quits",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const ui = await open(root);

        try {
          // `open` already pressed R, so the refresh has been through the list
          // once and the panel below it belongs to the row under the cursor.
          expect(lastPaint(ui.frame())).toContain("commits in main");

          await press(ui, "L", (frame) => !frame.includes("commits in"));
          await press(ui, "L", (frame) => frame.includes("commits in main"));

          expect(await ui.pressUntilExit(keys.esc, WAIT)).toBe(0);
        } finally {
          ui.kill();
        }
      });
    },
    SLOW,
  );

  test(
    "r asks before removing and says what it would discard; n and esc keep the worktree, y removes it",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const worktree = join(root, "feat", "login");
        const ui = await open(root);

        try {
          await press(ui, keys.down, (frame) => selected(frame) === "feat/");
          await press(ui, keys.down, (frame) => selected(frame) === "login");

          // The question counts what `y` costs, untracked files included.
          const asked = (frame: string) =>
            frame.includes("remove feat/login and discard 1 untracked file?");

          await press(ui, "r", asked);
          await press(ui, "n", (frame) => !asked(frame) && frame.includes("q quit"));
          expect(await pathExists(worktree)).toBe(true);

          await press(ui, "r", asked);
          await press(ui, keys.esc, (frame) => !asked(frame) && frame.includes("q quit"));
          expect(await pathExists(worktree)).toBe(true);

          await press(ui, "r", asked);
          await press(ui, "y", (frame) => frame.includes("removed feat/login"));
          expect(await pathExists(worktree)).toBe(false);
          // Gone from the list too — the message line still names it, which is
          // why this asks about rows rather than about the frame.
          const rows = lastPaint(ui.frame()).split("\n");
          expect(rows.some((line) => /^\s*▸?\s*login\b/.test(line))).toBe(false);
        } finally {
          ui.kill();
        }
      });
    },
    SLOW,
  );

  test(
    "a opens the branch-name prompt, which takes typed characters and backspace",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const ui = await open(root);

        try {
          await press(ui, "a", (frame) => frame.includes("new branch from main"));

          await press(ui, "topic", (frame) => frame.includes("topic"));
          await press(ui, keys.backspace, (frame) => !frame.includes("topic"));
          expect(lastPaint(ui.frame())).toContain("topi");

          // Nothing was made: the prompt is a question, and esc is a no.
          await press(ui, keys.esc, (frame) => !frame.includes("new branch"));
          expect(await pathExists(join(root, "topi"))).toBe(false);
        } finally {
          ui.kill();
        }
      });
    },
    SLOW,
  );

  // An interrupt, not a quit: the screen comes down the same way `q` brings it
  // down, but the process reports 128 + SIGINT so a script wrapping the app can
  // tell the two apart.
  test(
    "ctrl-c exits 130",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const ui = await open(root);

        try {
          expect(await ui.pressUntilExit(CTRL_C, WAIT)).toBe(130);
        } finally {
          ui.kill();
        }
      });
    },
    SLOW,
  );
});
