import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { failureFor, pendingCommands } from "./command.ts";
import { HOOKS_FILE, openTargetFor, repoHooks } from "./config.ts";
import { pendingOpen } from "./open.ts";
import { describeSetup, runSetup, trustAndRun } from "./setup.ts";
import { NOT_OPENED, setUp, waitForEntry, withRepo } from "./test-utils.ts";
import { trust } from "./trust.ts";

/**
 * `[setup] open`, which is the one key here grove starts and then forgets.
 *
 * Every test below reads the disk rather than a result, because that is all
 * there is to read: nothing is awaited and no stream is kept, so "it opened"
 * can only ever mean "the thing it opened got as far as touching a file".
 */
describe("open", () => {
  /**
   * `touch` stands in for an editor: it is a real program on PATH, it takes
   * the same shape a configured line takes, and it leaves the only evidence
   * there is to leave — a file, which for a line grove let go of is all a
   * test can look at.
   */
  const OPENS = '[setup]\nopen = "touch opened.txt"\n';

  test("runs the line in the worktree, and says it before it does", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure(
        '[setup]\nenv = { GREETING = "hello" }\n' +
          `open = 'printf "%s|%s|%s" "$GREETING" "$(pwd)" "$GROVE_BRANCH" > opened.txt'\n`,
      );

      const result = await trustAndRun(
        fixture.repo,
        { path: fixture.worktree, branch: fixture.branch },
        fixture.log.reporter,
      );

      const opened = join(fixture.worktree, "opened.txt");
      expect(await waitForEntry(opened)).toBe(true);
      // `.` in a configured line means the worktree because the cwd does,
      // which is what lets the line be written the way it would be typed
      // there. `$(pwd)` is that promise, checked.
      expect(await Bun.file(opened).text()).toBe(
        ["hello", await realpath(fixture.worktree), fixture.branch].join("|"),
      );
      expect(result.opened).toContain("printf");
      expect(describeSetup(result)).toBe("opened");
      expect(fixture.log.warnings.join("\n")).not.toContain("could not open");
    });
  });

  test("a line that fails fast is said out loud, not swallowed", async () => {
    await withRepo(async (fixture) => {
      // The shape of a misspelled editor: `open -a "Visual Stuio Code"` exits
      // 1 well inside the watching window. Saying nothing here is what made a
      // typo look exactly like an editor that opened.
      await fixture.configure('[setup]\nopen = "exit 4"\n');

      const result = await trustAndRun(
        fixture.repo,
        { path: fixture.worktree },
        fixture.log.reporter,
      );

      expect(result.opened).toBeUndefined();
      // Still not a failure of the add: the worktree is what was asked for.
      expect(failureFor(result)).toBeUndefined();
      expect(fixture.log.warnings.join("\n")).toContain("could not open: exit 4 exited 4");
    });
  });

  test("a line that keeps running is what opening looks like, and is let go", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nopen = "sleep 30"\n');

      const startedAt = Date.now();
      const result = await trustAndRun(
        fixture.repo,
        { path: fixture.worktree },
        fixture.log.reporter,
      );

      // The editor nobody has quit. Watched only long enough to know it did
      // not fall over, then released — `grove add` must not stand behind it.
      expect(result.opened).toBe("sleep 30");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(fixture.log.warnings.join("\n")).not.toContain("could not open");
    });
  });

  test("waits for the same trust the commands wait for", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure(OPENS);

      const result = await setUp(fixture);

      // No `run` in this file at all: the gate has to be counting `open`, or
      // an editor would launch out of a file nobody had read.
      expect(result.untrusted).toBe(true);
      expect(result.opened).toBeUndefined();
      expect(await waitForEntry(join(fixture.worktree, "opened.txt"), NOT_OPENED)).toBe(false);
      expect(fixture.log.warnings.join("\n")).toContain("1 command in");
      expect(fixture.log.warnings.join("\n")).toContain("--trust");
    });
  });

  /**
   * The same gate, asked rather than enforced — which is what a screen needs.
   *
   * `pendingCommands` covers the file's whole ask, at the moment `add` has just
   * made a worktree. This is the one line, for the key that is aimed at one
   * worktree on a day nothing was added: the screen has to be able to put the
   * command in front of somebody before it runs, because reading it is the
   * whole of what trust ever wanted.
   */
  test("the line waiting to be read is offered on its own, for a screen to show", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure(OPENS);

      const waiting = await pendingOpen(fixture.repo, { path: fixture.worktree });

      expect(waiting?.command).toBe("touch opened.txt");
      // Where to go and read it: the trunk's copy, which is the one that
      // governs — there is a copy of that name in every worktree.
      expect(waiting?.files).toEqual([`main/${HOOKS_FILE}`]);

      const hooks = await repoHooks(fixture.repo);
      await trust(fixture.repo.gitDir, hooks.fingerprint ?? "");

      // Read here now, so there is nothing left to put a question in front of.
      expect(await pendingOpen(fixture.repo, { path: fixture.worktree })).toBeUndefined();
    });
  });

  test("a line out of your own file is not a thing to be asked about", async () => {
    await withRepo(async (fixture) => {
      // `.grove.local.toml` is untracked, so no pull could have written it and
      // the gate is not in the way — asking here would be asking somebody to
      // agree to what they typed themselves.
      await fixture.configureLocal(OPENS);

      expect(await pendingOpen(fixture.repo, { path: fixture.worktree })).toBeUndefined();
    });
  });

  test("is offered with the commands, so the file's whole ask is on the screen", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nrun = ["bun install"]\nopen = "code ."\n');

      expect(await pendingCommands(fixture.repo)).toEqual(["bun install", "code ."]);
    });
  });

  test("does not open onto a worktree whose setup failed", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nrun = ["exit 3"]\nopen = "touch opened.txt"\n');

      const result = await trustAndRun(
        fixture.repo,
        { path: fixture.worktree },
        fixture.log.reporter,
      );

      expect(result.failed?.code).toBe(3);
      expect(result.opened).toBeUndefined();
      expect(await waitForEntry(join(fixture.worktree, "opened.txt"), NOT_OPENED)).toBe(false);
      expect(fixture.log.infos.join("\n")).toContain("did not open: exit 3 failed");
    });
  });

  test("says so rather than opening nothing quietly when there is no terminal", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure(OPENS);
      const hooks = await repoHooks(fixture.repo);
      await trust(fixture.repo.gitDir, hooks.fingerprint ?? "");

      const result = await setUp(fixture, { open: false });

      expect(result.opened).toBeUndefined();
      expect(await waitForEntry(join(fixture.worktree, "opened.txt"), NOT_OPENED)).toBe(false);
      expect(fixture.log.infos.join("\n")).toContain("did not open: this is not a terminal");
    });
  });

  test("a worktree that vanished is a warning, not a failed add", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure(OPENS);
      const hooks = await repoHooks(fixture.repo);
      await trust(fixture.repo.gitDir, hooks.fingerprint ?? "");

      // The failure that happens before the line runs at all: there is no
      // directory to run it in.
      const result = await runSetup(
        fixture.repo,
        { path: join(fixture.worktree, "gone") },
        {},
        fixture.log.reporter,
      );

      expect(result.opened).toBeUndefined();
      expect(failureFor(result)).toBeUndefined();
      expect(fixture.log.warnings.join("\n")).toContain("could not open");
    });
  });

  test("a file that names other platforms opens nothing here, and says which", async () => {
    await withRepo(async (fixture) => {
      // Whichever platform this is not. The point is a real team file: the
      // Mac users wrote their line, and nobody added the Linux one.
      const elsewhere = process.platform === "win32" ? "macos" : "windows";
      await fixture.configure(`[setup.open]\n${elsewhere} = "touch opened.txt"\n`);

      const result = await trustAndRun(
        fixture.repo,
        { path: fixture.worktree },
        fixture.log.reporter,
      );

      expect(result.opened).toBeUndefined();
      expect(await waitForEntry(join(fixture.worktree, "opened.txt"), NOT_OPENED)).toBe(false);
      // Not silence: finding out from the run beats finding out from asking
      // why everyone else's editor opened and yours did not.
      expect(fixture.log.infos.join("\n")).toContain(
        `nothing in ${HOOKS_FILE} opens on ${openTargetFor(process.platform)}`,
      );
    });
  });

  test("the platform's own line is the one that is offered and the one that runs", async () => {
    await withRepo(async (fixture) => {
      const here = openTargetFor(process.platform);
      const elsewhere = here === "macos" ? "linux" : "macos";
      await fixture.configure(
        `[setup.open]\n${here} = "touch mine.txt"\n${elsewhere} = "touch theirs.txt"\n`,
      );

      // One line read once: what is offered for trust is what will start.
      expect(await pendingCommands(fixture.repo)).toEqual(["touch mine.txt"]);

      const result = await trustAndRun(
        fixture.repo,
        { path: fixture.worktree },
        fixture.log.reporter,
      );

      expect(result.opened).toBe("touch mine.txt");
      expect(await waitForEntry(join(fixture.worktree, "mine.txt"))).toBe(true);
      expect(await waitForEntry(join(fixture.worktree, "theirs.txt"), NOT_OPENED)).toBe(false);
    });
  });
});
