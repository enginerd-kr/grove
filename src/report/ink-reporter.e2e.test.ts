import { afterEach, expect, test } from "bun:test";
import { withTempRepo } from "../core/test-utils.ts";
import { startUi, type UiSession } from "../ui/e2e-utils.ts";

/**
 * The one thing only a real terminal can prove.
 *
 * Whether the Ink reporter is chosen at all depends on `process.stderr.isTTY`,
 * which `ink-testing-library` fakes and a pipe never sets. So this runs the real
 * binary against a real pseudo-terminal, doing real work, and checks that the
 * drawing happens *and* that the command still ends correctly underneath it.
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
  "draws progress on a terminal and still finishes the clone",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const ui = start({ args: ["clone", originUrl, "repo"], cwd: work });

      expect(await ui.exited).toBe(0);

      const frame = ui.frame();
      // The steps the command reports, drawn rather than logged.
      expect(frame).toContain("cloned");
      expect(frame).toContain("fetched refs");
      // Held back until the UI is torn down, but it does arrive.
      expect(frame).toContain("repo/main");
    });
  },
  40_000,
);

// The failure this catches: a reporter that leaves Ink mounted, or one that
// writes results into a frame the render loop is about to erase.
onPosix(
  "unmounts cleanly and reports failures with the right exit code",
  async () => {
    await withTempRepo(async ({ work }) => {
      const ui = start({ args: ["list"], cwd: work });

      expect(await ui.exited).toBe(3);
      expect(ui.frame()).toContain("wt clone");
    });
  },
  40_000,
);
