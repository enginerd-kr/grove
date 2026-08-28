import "./colour.ts";
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
};

/**
 * The refresh is turned off for the pictures, not sped up.
 *
 * It fetches, and a fetch landing between the frame being drawn and the frame
 * being saved would redraw the list under the shot. An hour is longer than
 * every shot put together.
 */
const NO_REFRESH = 3_600_000;

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
      // The shell function, listening. `grove install` is the second line of
      // the README's install block, so the pictures show the screen as the
      // people reading them will have it — and not its "you have not run that
      // yet" tip, which is advice about the install rather than about grove.
      onCd={async () => {}}
    />,
    shot.columns,
    shot.rows,
  );

  try {
    // Every shot waits for the list to have read itself: the first frame is an
    // empty screen, and a picture of that is a picture of nothing.
    await session.until("feat/");
    await shot.drive(session);
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
  // 28 rows: the banner card's own floor, and one more than the list needs —
  // any taller and the picture is mostly the empty space under the last row.
  rows: 28,
  title: "grove — every worktree, and what has moved under it",
  async drive(session) {
    // Onto `feat/login`: the row with commits of its own, so the key bar is the
    // full one — `p` for the PR it could open, and `s` for the trunk it is behind.
    for (let step = 0; step < 4; step++) await session.press(keys.down);
    await session.settle(200);
  },
};

/** One prompt, two jobs: narrowing the list, and running git in the row it lands on. */
const prompt: Shot = {
  name: "prompt",
  columns: 112,
  rows: 32,
  title: "grove — ! runs git in the worktree the cursor is on",
  async drive(session) {
    await session.press("?");
    await session.type("!log --oneline -5");
    await session.press(keys.enter);
    await session.until("Start ");
    await session.settle(300);
  },
};

/** A branch typed, and the worktree that is ready to work in by the time it appears. */
const add: Shot = {
  name: "add",
  columns: 112,
  // Two rows taller than `list`: the setup's four lines of progress come out
  // of the list's share, and the tree should still be whole underneath them.
  rows: 32,
  title: "grove — a add, and .grove.toml fills the worktree in",
  async drive(session) {
    await session.press("a");
    await session.type("feat/paging");
    await session.press(keys.enter);
    await session.until("bun install");
    await session.settle(400);
  },
};

process.stdout.write("shooting the README:\n");
const fixture = await buildFixture();
try {
  for (const shot of [list, prompt, add]) await shoot(fixture, shot);
} finally {
  await fixture.dispose();
}
process.stdout.write("done.\n");
process.exit(0);
