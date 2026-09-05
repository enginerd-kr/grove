import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli } from "../../cli/test-cli.ts";
import { pathExists } from "../../core/fs.ts";
import { type TempRepo, withTempRepo } from "../../core/test-utils.ts";
import { type Cell, startUi, type UiSession } from "../e2e-utils.ts";
import { keys } from "../test-utils.ts";
import { commandsFor } from "./Menu.tsx";

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

/** `theme.warn`, which is chalk's `yellow`, as the palette slot it lands in. */
const YELLOW = 3;

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

/** The label of the row the cursor is on, as the marker column reports it. */
function selected(frame: string): string {
  const row = frame.split("\n").find((line) => line.trimStart().startsWith("▸")) ?? "";
  const columns = row
    .replace("▸", "")
    .trim()
    .split(/\s{2,}/);

  return columns[0] ?? "";
}

/**
 * The state dot on the row for `label`, as the terminal actually drew it.
 *
 * The column is a string index into the rendered line, which is the cell index
 * only while every glyph to its left is one cell wide — so the cell's own
 * character is read back rather than assumed. Rows are matched on carrying a
 * dot as well as the label, since the label also appears in the column heading
 * and in a ref name down in the commit panel.
 */
function stateDot(ui: UiSession, label: string): Cell {
  const rows = ui.frame().split("\n");
  const row = rows.findIndex((line) => line.includes(label) && /[●○]/.test(line));
  const cell = row === -1 ? undefined : ui.cellAt(row, rows[row]?.search(/[●○]/) ?? -1);

  if (cell === undefined || !/[●○]/.test(cell.chars)) {
    throw new Error(`no state dot for ${label} on:\n${rows.join("\n")}`);
  }

  return cell;
}

/** The app's opening `busy` label, which is also the row that says the keyboard is blocked. */
const FIRST_READ = "reading worktrees";

/**
 * Starts the app and waits until it is reading keys.
 *
 * `/` rather than a sleep: raw mode is enabled from an effect that runs after
 * the first paint, so a key sent into that window is eaten by the line
 * discipline. `/` is the one key worth resending — a second one lands in the
 * menu the first one opened and is dropped there, since no command name holds
 * a slash — and the popup it leaves is proof the app took it.
 *
 * The first read has to be waited out before that key is sent, and the column
 * heading is not the signal for it: the heading is drawn while the app is still
 * `busy`, and `perform` blocks the keyboard for as long as it is. A `/` sent
 * there is dropped rather than queued, so what followed was a resend landing on
 * an app that had just started reading the first one — and the test's next key
 * arriving inside that second refresh, to be dropped in turn.
 *
 * It then runs `/refresh` on the way out, which is what the old `R` did here:
 * one read has to have been through the list before the panels below it belong
 * to the row under the cursor.
 */
/** How many commands the menu holds — read off the menu, not counted here. */
const MENU_TOTAL = commandsFor(false).length;

async function open(cwd: string, cols = 100, rows = 30): Promise<UiSession> {
  const ui = startUi({ cwd, cols, rows });
  await ui.waitForFrame((frame) => frame.includes("worktree") && !frame.includes(FIRST_READ), WAIT);
  // `/sync-all` and not the last row: the popup takes only the rows the list
  // can spare, and on the thirty rows this opens with that is fewer than the
  // menu holds — the tail scrolls out of the window, and a wait on it would
  // be a wait on a row that is never drawn. The fourth row is inside the
  // window at every size the card is drawn on.
  await ui.pressUntil("/", (frame) => frame.includes("/sync-all"), WAIT);
  // Not through `press`: its `clear()` is the barrier the later waits need, and
  // it takes the bytes the session has seen so far with it — including the
  // alternate-screen sequence one test below asserts the app opened with.
  // Nothing here needs the barrier anyway, since neither frame this waits for
  // is on screen before its key is sent.
  ui.press("refresh");
  await ui.waitForFrame((frame) => frame.includes(`1 of ${MENU_TOTAL}`), WAIT);
  ui.press(keys.enter);
  await ui.waitForFrame((frame) => frame.includes("refreshed"), WAIT);

  return ui;
}

/**
 * Runs a slash command: the menu, the name, and enter.
 *
 * The commands that used to be `p`, `S`, `R` and `L` have no key of their own
 * any more — `Menu.tsx` says which side of that line each fell and why — so
 * the tests reach them the way a person does.
 */
async function runCommand(
  ui: UiSession,
  name: string,
  done: (frame: string) => boolean,
): Promise<void> {
  await press(ui, "/", (frame) => frame.includes("/sync-all"));
  await press(ui, name, (frame) => frame.includes(`1 of ${MENU_TOTAL}`));
  await press(ui, keys.enter, done);
}

/**
 * Sends one key and waits for the repaint it caused.
 *
 * `clear()` first, and it earns its place: the screen is already there, so a
 * predicate of the shape most of these are — the panel is gone, the row is no
 * longer listed — is true of it before the key has even been read, and the
 * wait would return on its first poll against the screen the key was meant to
 * change. Clearing marks the point the child has to have spoken since.
 */
async function press(
  ui: UiSession,
  key: string,
  settled: (frame: string) => boolean,
): Promise<void> {
  ui.clear();
  ui.press(key);
  await ui.waitForFrame(settled, WAIT);
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
          const narrow = await ui.waitForFrame((each) => each.includes("q quit"), WAIT);

          // Fewer columns and fewer rows than the list wants, and it is still a
          // list with keys under it rather than a wrapped mess. Finding the key
          // bar *is* the width assertion now: a row the app drew too wide would
          // not run off the edge, it would wrap onto the next one and shove the
          // bottom of the layout past row 14, where there is no screen left.
          expect(narrow).toContain("main");
          expect(narrow).toContain("q quit");
          // And the banner traded its box for its one-line form. The emulator
          // is what makes that assertable: the box was on this terminal a
          // moment ago, and against an accumulated buffer this would have
          // matched the frame from before the resize.
          expect(narrow).not.toContain("╭─ grove");

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
          expect(ui.frame()).toContain("uncommitted in feat/login");
          expect(ui.frame()).toContain("scratch.txt");

          await press(ui, "j", (frame) => selected(frame) === "signup");
          // ...and a clean row has nothing to say there.
          expect(ui.frame()).not.toContain("uncommitted in");
          expect(ui.frame()).not.toContain("scratch.txt");

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

  // The one assertion in the suite that is about a cell rather than about text:
  // `StateCell` dims on the worktree's own state rather than on where the
  // cursor is, and a screen scraped back to plain text says nothing either way.
  // It was checked by eye in a PTY until the emulator made it checkable.
  test(
    "the state dot colours on the row's own contents, not on the cursor",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const ui = await open(root);

        try {
          // The cursor is still on `main`, which makes `login` the row worth
          // asking about: dirty, and nobody pointing at it. Every other column
          // on that row is dimmed for being unselected — the dot is not,
          // because what it answers is about the worktree and not about the
          // cursor, and a dimmed dot is exactly how it would stop reading from
          // across the terminal.
          const dirty = stateDot(ui, "login");
          expect(dirty.chars).toBe("●");
          expect(dirty.dim).toBe(false);
          expect(dirty.color).toBe(YELLOW);

          // Its clean neighbour, equally unselected, and the reason this test
          // is worth anything: with chalk off every cell comes back undimmed
          // and default-coloured, so "not dimmed" alone would pass against a
          // screen with no colour in it at all.
          const clean = stateDot(ui, "signup");
          expect(clean.chars).toBe("○");
          expect(clean.dim).toBe(true);
          expect(clean.color).toBeUndefined();
        } finally {
          ui.kill();
        }
      });
    },
    SLOW,
  );

  test(
    "`/log` takes the commit panel away and brings it back, and esc quits",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const ui = await open(root);

        try {
          // `open` already ran `/refresh`, so the read has been through the
          // list once and the panel below it belongs to the row under the
          // cursor.
          expect(ui.frame()).toContain("commits in main");

          await runCommand(ui, "log", (frame) => !frame.includes("commits in"));
          await runCommand(ui, "log", (frame) => frame.includes("commits in main"));

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

          // Gone from the list too, but on the list's own schedule: the message
          // is painted the moment the command returns and the rows are re-read
          // a repaint or two later, so reading them out of the frame the
          // message arrived in is a coin flip — and was one long before the
          // screen was emulated. It asks about rows rather than about the frame
          // because that message line names `feat/login` as well.
          const listed = (frame: string) =>
            frame.split("\n").some((line) => /^\s*▸?\s*login\b/.test(line));
          const after = await ui.waitForFrame((frame) => !listed(frame), WAIT);
          // ...and the message outlives the re-read that removed the row.
          expect(after).toContain("removed feat/login");
        } finally {
          ui.kill();
        }
      });
    },
    SLOW,
  );

  test(
    "x discards a worktree's changes through the real git, and leaves the worktree",
    async () => {
      await withTempRepo(async (repo) => {
        const root = await managed(repo);
        const worktree = join(root, "feat", "login");
        const scratch = join(worktree, "scratch.txt");
        const ui = await open(root);

        try {
          await press(ui, keys.down, (frame) => selected(frame) === "feat/");
          await press(ui, keys.down, (frame) => selected(frame) === "login");

          const asked = (frame: string) =>
            frame.includes(
              "discard 1 untracked file in feat/login? a copy is kept for git stash apply",
            );

          await press(ui, "x", asked);
          await press(ui, "n", (frame) => !asked(frame) && frame.includes("q quit"));
          expect(await pathExists(scratch)).toBe(true);

          await press(ui, "x", asked);
          await press(ui, "y", (frame) => frame.includes("discarded 1 untracked file"));

          // `git clean -fd` really ran: the file git had never been told about
          // is what a `reset --hard` on its own would have left behind.
          expect(await pathExists(scratch)).toBe(false);
          // And the directory it was in is still there — this is the key that
          // takes the changes, not the one that takes the worktree.
          expect(await pathExists(worktree)).toBe(true);

          // The dot follows, on the list's own schedule: a worktree still drawn
          // dirty after you discarded its changes is the confusion the dot was
          // added to prevent.
          const cleanRow = (frame: string) =>
            frame.split("\n").some((line) => /\blogin\b/.test(line) && line.includes("○"));

          await ui.waitForFrame(cleanRow, WAIT);
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
          await press(ui, "a", (frame) => frame.includes("new branch from remote main"));

          await press(ui, "topic", (frame) => frame.includes("topic"));
          await press(ui, keys.backspace, (frame) => !frame.includes("topic"));
          expect(ui.frame()).toContain("topi");

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
