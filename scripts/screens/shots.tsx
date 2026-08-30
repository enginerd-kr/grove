import "./colour.ts";
import "./clock.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStoreReporter, LineStore } from "../../src/report/lines.ts";
import { App } from "../../src/ui/app/App.tsx";
import { createWorktreeService } from "../../src/ui/app/service.ts";
import { keys } from "../../src/ui/test-utils.ts";
import { buildFixture, type Fixture } from "./fixture.ts";
import { open, type Session } from "./screen.tsx";
import { toSvg } from "./svg.ts";

/**
 * The README's pictures, taken from the program rather than written by hand.
 *
 * Each shot opens the real screen on a terminal of its own, over a real
 * repository with real worktrees (`fixture.ts`), drives it the way a person
 * would — a key pressed, a name typed — and saves the frame Ink actually drew.
 * Nothing between the keystroke and the picture is stubbed: the rows are what
 * `grove list` counted, and a picture can only go stale by the UI changing,
 * which is the point of re-shooting them from a script.
 */

const OUT = join(import.meta.dir, "..", "..", "docs", "screens");

type Shot = {
  readonly name: string;
  readonly columns: number;
  readonly rows: number;
  /** What the window's title bar says — the caption, in the picture's own chrome. */
  readonly title: string;
  readonly drive: (session: Session) => Promise<void>;
  /**
   * Text the finished frame has to hold, checked before the picture is saved.
   *
   * The point each shot is making, written down: a picture that stopped making
   * it is a picture to fix rather than one to publish, and the only way anybody
   * would otherwise notice is by looking at the README months later.
   */
  readonly expects: readonly string[];
};

/**
 * The last row's `4 of 8`, which the screen draws only when the list is
 * scrolled.
 *
 * That is the one state a README picture must never be taken in — the shot is
 * of the grove, and a grove with three of its eight rows showing is a picture
 * of a cramped terminal instead. It is also the failure that actually happened:
 * the commit panel arrived under the list, took six rows out of its share, and
 * every shot went on being taken at the height that fitted before it. Nothing
 * said so, because a shot that is merely *wrong* still renders.
 */
const SCROLLED = /\b\d+ of \d+\b/;

/**
 * A spinner glyph, which is a coin flip rather than a picture.
 *
 * Whichever animation tick the save happened to land on is what a frame with
 * one in it holds, so the same shot is a different picture on a machine a few
 * milliseconds slower — and the committed pictures are checked byte for byte
 * against a re-shoot on a machine nobody chose. A caught spinner always means
 * the same thing: the shot stopped waiting while something was still running,
 * and the fix is to wait for that thing's settled spelling rather than for a
 * number of milliseconds.
 */
const SPINNING = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

/**
 * The refresh is turned off for the pictures, not sped up.
 *
 * It fetches, and a fetch landing between the frame being drawn and the frame
 * being saved would redraw the list under the shot. An hour is longer than
 * every shot put together.
 */
const NO_REFRESH = 3_600_000;

/**
 * Refuses to publish a frame that is not the picture it was asked for.
 *
 * The frame comes with it, because the useful half of "the shot is wrong" is
 * seeing what was drawn instead — and the fix is almost always a row count.
 */
function check(shot: Shot, frame: string, root: string): void {
  const missing = shot.expects.filter((text) => !frame.includes(text));
  const scrolled = SCROLLED.test(frame);
  const spinning = SPINNING.test(frame);
  // The fixture's temp directory, which is a different path on every run and on
  // every machine. It reaches the screen only through a bug — the banner
  // shortens it to `~/work/acme` against the `HOME` the fixture set — but a
  // published picture with one in it is a drift check that can never pass, and
  // the character that gives it away is easy to miss by eye.
  const leaked = frame.includes(root);
  if (missing.length === 0 && !scrolled && !spinning && !leaked) return;

  const why = [
    ...missing.map((text) => `it never drew ${JSON.stringify(text)}`),
    ...(scrolled ? [`the list is scrolled — give ${shot.name} more rows`] : []),
    ...(spinning ? ["something was still spinning — wait for it to settle"] : []),
    ...(leaked ? [`the fixture's own path is in the frame: ${root}`] : []),
  ];

  throw new Error(
    `${shot.name} is not the picture it should be:\n  ${why.join("\n  ")}\n\n${frame}`,
  );
}

async function shoot(fixture: Fixture, shot: Shot): Promise<void> {
  const store = new LineStore();
  const reporter = createStoreReporter(store, (text) => {
    for (const line of text.trimEnd().split("\n")) store.addNote("info", line);
  });
  const service = createWorktreeService(fixture.repo, fixture.cwd, reporter);

  const session = open(
    <App
      service={service}
      repoRoot={fixture.repo.root}
      store={store}
      columns={shot.columns}
      rows={shot.rows}
      refreshMs={NO_REFRESH}
      tipRotateMs={NO_REFRESH}
    />,
    shot.columns,
    shot.rows,
  );

  try {
    // Every shot waits for the list to have read itself: the first frame is an
    // empty screen, and a picture of that is a picture of nothing.
    //
    // Waited for in the banner rather than in the list, because the banner
    // cannot scroll: a row of the list is only drawn if the window happens to
    // reach it, so waiting on one would make "has it loaded" depend on how tall
    // the terminal is — which is how this came to time out with a screen that
    // had loaded perfectly well and simply had no room to show that row.
    await session.until(`${fixture.branches.length} worktrees`);
    await shot.drive(session);
    check(shot, session.plain(), fixture.root);
    await mkdir(OUT, { recursive: true });
    await writeFile(
      join(OUT, `${shot.name}.svg`),
      toSvg(session.frame(), { columns: shot.columns, title: shot.title }),
    );
    process.stdout.write(`  docs/screens/${shot.name}.svg\n`);
  } finally {
    session.close();
  }
}

/** The screen a bare `grove` opens: every worktree, and what has moved under it. */
const list: Shot = {
  name: "list",
  columns: 112,
  // The banner's card wants 28 and the commits panel under the list wants six
  // more, which leaves one spare row over the eight the tree draws — any taller
  // and the picture is mostly the empty space under the last row. `SCROLLED` is
  // what holds this honest when something else moves in below the list again.
  rows: 34,
  title: "grove — every worktree, and what has moved under it",
  async drive(session) {
    // Onto `feat/login`: the row that has drifted from the trunk, so `s` on the
    // key bar has something to do.
    for (let step = 0; step < 4; step++) await session.press(keys.down);
    await session.settle(200);
  },
  // The row the cursor was walked to, and the panel that row is the subject of.
  expects: ["login", "commits in feat/login"],
};

/** A branch typed, and the worktree that is ready to work in by the time it appears. */
const add: Shot = {
  name: "add",
  columns: 112,
  // Taller than `list` by the rows the shot adds to it: the worktree it makes
  // is a ninth row of the tree, and the setup's lines of progress come out of
  // the list's share too. The tree should still be whole underneath them.
  rows: 41,
  title: "grove — a add, and .grove.toml fills the worktree in",
  async drive(session) {
    await session.press("a");
    await session.type("feat/paging");
    await session.press(keys.enter);
    // The settled spelling, not the ambiguous one: the step reads `running bun
    // install` while it runs and `ran bun install` once it has, and a wait on
    // `bun install` alone is satisfied by the first — so the picture was a
    // spinner and a half-written panel on any machine where the install took
    // longer than the pause that followed. It takes a fraction of a second
    // here and it will not on a cold runner.
    await session.until("ran bun install");
    await session.settle(200);
  },
  // The worktree the shot is of, the file's own command having run in it, and
  // the summary the setup closes with — which is the shot's real subject, and
  // the last thing drawn, so a frame holding it is a frame that waited.
  expects: ["paging", "ran bun install", "kept in feat/paging"],
};

process.stdout.write("shooting the README:\n");
const fixture = await buildFixture();
try {
  for (const shot of [list, add]) await shoot(fixture, shot);
} finally {
  await fixture.dispose();
}
process.stdout.write("done.\n");
process.exit(0);
