import { setSystemTime } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprintOf, trust } from "../../src/hooks/trust.ts";
import { buildFixture, type Fixture } from "./fixture.ts";

/**
 * The README's demo, recorded rather than kept.
 *
 * The GIF at the top of the README is the first thing anybody sees, and until
 * this script it was the one picture nothing could re-make: the SVGs beside it
 * are re-shot by `bun run screenshots` and compared byte for byte in CI, while
 * the demo was a binary somebody had produced once, from a tape that lived in a
 * scratch directory and was thrown away with it. It went stale the way that
 * kind of thing does — five releases later it still showed v0.4.2, a column
 * that has since been renamed, and a card the app no longer draws.
 *
 * So the tape is here, in the repository, next to the fixture it drives.
 *
 * Not in CI, and that is deliberate: `vhs` needs a headless Chrome and `ttyd`
 * to record at all, and the encoder does not write the same bytes twice — an
 * x264 stream depends on how many threads the machine gave it — so the
 * byte-for-byte check that keeps the SVGs honest has nothing to compare here.
 * What this buys instead is that re-making it is one command on a release day
 * rather than an afternoon of reconstructing how it was made.
 */

/** Where `vhs` writes, which is where the README points. */
const OUT = join(import.meta.dir, "..", "..", "docs", "screens");
/** The CLI the recorded shell runs — this checkout's, not whatever is installed. */
const CLI = join(import.meta.dir, "..", "..", "src", "cli.tsx");

/**
 * The tape, with the paths of a fixture that exists only for this run.
 *
 * Written out rather than committed as a `.tape` beside this file, because half
 * of it is a temp directory whose name is different every time. The half worth
 * reading — the keys, the waits, the pauses — is the second half, and it is
 * written the way a person would drive the screen: slowly enough to follow.
 */
function tape(fixture: Fixture): string {
  // Everything the recorded shell needs, typed off-camera in one line. `HOME`
  // is what makes the banner's path read `~/work/acme`; the two spellings of
  // the user name are emptied because the banner greets whoever is there, and
  // that should not be whoever re-recorded this.
  const setup = [
    `export HOME=${fixture.root}`,
    `export USER=""`,
    `export USERNAME=""`,
    `cd ${fixture.cwd}`,
    `alias grove="bun ${CLI}"`,
    "clear",
  ].join("; ");

  // Quoted, because `vhs` lexes a bare word a path at a time and reads the
  // leading `/` of an absolute one as the start of a command it does not have.
  return `Output "${join(OUT, "demo.mp4")}"
Output "${join(OUT, "demo.gif")}"

Set Shell "bash"
Set Theme "OneDark"
Set FontSize 20
Set Width 1400
Set Height 800
Set Padding 24
Set TypingSpeed 50ms

Hide
Type \`${setup}\`
Enter
Sleep 2s
Show

Sleep 500ms
Type "grove"
Sleep 500ms
Enter
Wait+Screen@30s /2h ago/
Sleep 2.5s

Type "j"
Sleep 400ms
Type "j"
Sleep 400ms
Type "j"
Sleep 400ms
Type "j"
Sleep 2s

Type "a"
Sleep 1.2s
Type "feat/paging"
Sleep 800ms
Enter
Wait+Screen@60s /ran bun install/
Sleep 3s

Type "s"
Sleep 1.5s
Type "y"
Wait+Screen@60s /rebased/
Sleep 3.5s
`;
}

process.stdout.write("recording the README's demo:\n");

// `fixture.ts` pulls in `clock.ts`, which pins `Date` so the SVGs come out the
// same twice. The demo wants the opposite: the app runs in a shell of its own,
// on the real clock, and reads the `last` column against it — so the ages have
// to be genuinely recent or the row the tape waits for never says `2h ago`.
setSystemTime();

const fixture = await buildFixture({ now: Date.now() });
try {
  // The `a` in the recording runs `.grove.toml`'s commands without stopping to
  // ask, because the agreement is already on file. Recording the question
  // instead would be a fair demo of a different thing — the gate is `--trust`'s
  // and the screen's story, and this eighteen seconds is about what a worktree
  // arrives with.
  const toml = await Bun.file(join(fixture.cwd, ".grove.toml")).text();
  await trust(fixture.repo.gitDir, fingerprintOf(toml));

  const path = join(fixture.root, "demo.tape");
  await writeFile(path, tape(fixture));

  const vhs = Bun.spawn(["vhs", path], { stdout: "inherit", stderr: "inherit" });
  const code = await vhs.exited;
  if (code !== 0) throw new Error(`vhs exited ${code} — is it installed? (brew install vhs)`);
} finally {
  await fixture.dispose();
}

process.stdout.write("done.\n");
