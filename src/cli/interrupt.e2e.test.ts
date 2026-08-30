import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../core/fs.ts";
import { SETUP_FILE } from "../core/setup.ts";
import { managedRepo, type TempRepo, withTempRepo } from "../core/test-utils.ts";
import { ExitCode } from "./exit-codes.ts";
import { type LiveCli, runCli, startCli } from "./test-cli.ts";

/**
 * Ctrl-C, delivered to a real process while real work is in flight.
 *
 * Every part of the interrupt path is a function somewhere else, and every one
 * of them is already tested by calling it: `cli.tsx` installs a SIGINT handler
 * that calls `killRunningGit`, `git.ts` keeps the set of children that handler
 * signals, `runShell` puts a `grove.setup` command in a process group of its
 * own so the signal reaches the whole tree, and `clone.ts` rolls a partial
 * `.bare` back because discovery would otherwise find it and every later
 * command would trip over it.
 *
 * None of those calls says the signal *arrives*. A handler registered on a
 * process nothing ever signals is a closure; a set emptied by calling the
 * function that empties it proves the loop, not the delivery; and a rollback in
 * a `catch` is only reached if the interrupt lets the `catch` run — which, it
 * turns out, it does not. So this is the layer where the question can be asked
 * at all, and the last test below is what asking it found.
 *
 * The whole difficulty is landing the signal in the window where something is
 * genuinely running. Three things do that here, and none of them is a timer:
 *
 *   - **A transport that never answers.** `GIT_SSH_COMMAND` points git at the
 *     script `transport()` writes, so a clone of the fixture — normally over in
 *     under a second — waits forever instead. The window is not short, it is
 *     unbounded.
 *   - **The child says when it is up.** That script, and the `grove.setup`
 *     command in the second test, write their pids to a file the moment they
 *     start. The test waits for the file, so it signals strictly after the
 *     process it is asserting about exists, and it has that process's pid to
 *     check afterwards rather than the exit code's word for it.
 *   - **The pid is checked before the disk.** git removes its own half-written
 *     clone when it is signalled, and it does that on the way out — so "is the
 *     directory gone" is only a stable question once the pid is.
 *
 * `--headless` throughout: the plain reporter's one line per step is a stable
 * thing to wait for, where the drawn one repaints a frame.
 */

/** How long a pid gets to disappear before we call it an orphan. */
const REAPING = 5_000;

/**
 * Whether a pid is still there.
 *
 * The same reading as `test-utils.ts`'s: EPERM is a live process this user may
 * not signal, which is alive.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits for a pid to go, and says whose it was when it will not.
 *
 * The deadline is not the timer this file warns about: nothing waits on it when
 * the assertion holds — the loop leaves the moment the process is gone — and
 * when it does not hold, an orphaned process is exactly the failure being
 * reported. Polling rather than waiting on the parent, because the parent is
 * `bun`, and `bun` exits from inside the signal handler without waiting for the
 * child it just signalled.
 */
async function gone(what: string, pid: number): Promise<void> {
  const until = Date.now() + REAPING;

  while (isRunning(pid)) {
    if (Date.now() > until) {
      throw new Error(`${what} (pid ${pid}) was still running ${REAPING}ms after the interrupt`);
    }
    await Bun.sleep(10);
  }
}

/** What a pid is actually running, so a test can prove it is watching the right one. */
function commandOf(pid: number): string {
  return Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)])
    .stdout.toString()
    .trim();
}

/**
 * The pids a started child wrote down, once it has written them.
 *
 * Polls a file rather than sleeping, and gives up the moment the CLI exits: a
 * command that finished before the test could interrupt it is the race that
 * makes an interrupt test pass while asserting nothing, and it has to be a loud
 * failure rather than a signal sent into thin air.
 */
async function pidsFrom(path: string, live: LiveCli, waitingFor: string): Promise<number[]> {
  let over: { readonly exitCode: number; readonly stderr: string } | undefined;
  void live.finished.then((result) => {
    over = result;
  });

  for (;;) {
    const written = (
      await Bun.file(path)
        .text()
        .catch(() => "")
    ).trim();
    if (written.length > 0) return written.split(/\s+/).map(Number);

    if (over) {
      throw new Error(`the CLI exited ${over.exitCode} before ${waitingFor}:\n${over.stderr}`);
    }
    await Bun.sleep(10);
  }
}

type TransportOptions = {
  /** Where the hanging connection writes the pid of the git process above it. */
  readonly marker: string;
  /** How many connections to serve for real before hanging. */
  readonly serve: number;
};

/**
 * An ssh that git can talk through, and that stops talking on cue.
 *
 * `GIT_SSH_COMMAND` is how git is told what to run instead of `ssh`, and
 * `GIT_SSH_VARIANT=simple` pins the calling convention to the two arguments
 * this reads: a host, and the command to run there. The host is a fiction — the
 * repository is a path on this machine, and `sh -c "$2"` runs the
 * `git-upload-pack` git asked for against it — so a served connection is an
 * ordinary clone of the ordinary fixture, doing everything a clone does.
 *
 * A connection past `serve` writes down the pid of the git process that started
 * it and then reads its input forever, so git sits waiting for an answer that
 * will not come. Waiting forever rather than sleeping for a plausible while,
 * because a sleep is a timer wearing a disguise; and `cat` rather than `sleep`,
 * because when git dies the pipe closes, `cat` reads EOF and leaves — a fixture
 * that stops itself instead of leaving a process behind for whoever runs the
 * suite next.
 *
 * The `cat` is a child of this script and not an `exec` of it, and that is
 * load-bearing. This script's own stdout *is* the pipe git reads the server's
 * answer from, so an `exec cat > /dev/null` would hand the only copy of that
 * write end to a `cat` that immediately points it at `/dev/null` — git reads
 * EOF, calls it "the remote end hung up unexpectedly", and exits 7 before the
 * test has signalled anything. Leaving the shell in place keeps the pipe open
 * and silent, which is what "hanging" has to mean here.
 *
 * `$PPID` and not a search of the process table: git spawns the transport
 * itself, so the parent it names is the `git clone` or `git fetch` that
 * `killRunningGit` has to reach. The tests check `commandOf` on it and say so,
 * rather than trusting that quietly.
 */
async function transport(
  temp: TempRepo,
  { marker, serve }: TransportOptions,
): Promise<Record<string, string>> {
  const path = join(temp.root, "transport");
  const counter = join(temp.root, "connections");

  await Bun.write(
    path,
    `#!/bin/sh
# Written by interrupt.e2e.test.ts. "$1" is the host, "$2" the command to run there.
served=$(cat ${counter} 2>/dev/null || echo 0)
echo $((served + 1)) > ${counter}
if [ "$served" -lt ${serve} ]; then exec sh -c "$2"; fi
echo "$PPID" > ${marker}
cat > /dev/null
`,
  );
  await chmod(path, 0o755);

  return { GIT_SSH_COMMAND: path, GIT_SSH_VARIANT: "simple" };
}

/** The fixture's own origin, reached over the transport above instead of `file://`. */
function overTransport(temp: TempRepo): string {
  return `ssh://localhost${temp.originPath}`;
}

describe("an interrupt, through a real signal", () => {
  test("stops the clone, kills git, and leaves the ground it found", async () => {
    await withTempRepo(async (temp) => {
      const marker = join(temp.root, "git.pid");
      const env = await transport(temp, { marker, serve: 0 });

      const live = startCli(["clone", overTransport(temp), "app", "--headless"], {
        cwd: temp.work,
        env,
      });

      const [git] = await pidsFrom(marker, live, "git opened a connection");
      // Named, rather than assumed: if git ever stops spawning its transport
      // itself, this is a pid belonging to something in between, and the point
      // of the next assertion is that a *git* process died.
      expect(commandOf(git ?? 0)).toContain("clone --bare");

      live.proc.kill("SIGINT");
      const finished = await live.finished;

      // 130 is the whole promise to a wrapper script — not 0, which would mean
      // the clone had quietly finished before the signal and this test had
      // asserted nothing, and not 1, which is this tool crashing.
      expect(finished.exitCode).toBe(ExitCode.interrupted);
      expect(finished.stderr).toContain("cloning");
      expect(finished.stderr).not.toContain("is ready");

      // The exit code is what the parent did; this is what happened to the
      // work. Killing `bun` and killing the git it started are different
      // events, and only the second one stops a clone writing to a disk.
      await gone("the git clone", git ?? 0);

      // Only now, and in this order: git deletes its own half-written clone
      // when it is signalled, and it finishes doing that before it exits.
      expect(await pathExists(join(temp.work, "app", ".bare"))).toBe(false);

      // The assertion that matters, in the form that cannot be satisfied by a
      // tidy-looking directory: the next command behaves as it would on ground
      // nothing had ever touched. A partial `.bare` would fail this twice over
      // — discovery would find it, and clone would refuse a directory that is
      // no longer empty.
      const again = await runCli(["clone", temp.originUrl, "app"], { cwd: temp.work });
      expect([again.exitCode, again.stderr]).toEqual([ExitCode.ok, again.stderr]);
      expect(again.stdout).toBe("app/main\tmain\n");
    });
  }, 30_000);

  test("reaches the whole tree a setup command started, not just the shell", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const pids = join(temp.root, "setup.pids");

      // Two commands' worth of shape in one line: `sh` stays alive as a parent
      // — that is what `wait` is for — and the work is a grandchild of it, the
      // way `bun install && bun run build` leaves the install a grandchild.
      // Signalling the shell alone would stop the shell and orphan the sleep,
      // which is precisely the failure `runShell`'s `detached` prevents and
      // the reason this asserts on the sleep's pid rather than the shell's.
      //
      // A TOML literal string, so the quoting in it is the shell's and not
      // TOML's, and `$$`/`$!` are the shell's own answer to "what are we".
      await Bun.write(
        join(repo.root, "main", SETUP_FILE),
        `[setup]\nrun = ['sleep 300 & printf "%s %s" "$$" "$!" > ${pids}; wait']\n`,
      );

      const live = startCli(["add", "feat/login", "--trust", "--headless"], { cwd: repo.root });

      // The worktree is made first and the commands run on top of it, so this
      // line is also the proof that what gets interrupted below is the setup
      // command and not the `git worktree add` before it.
      await live.waitForStderr(/running sleep/);

      const [shell, sleeper] = await pidsFrom(pids, live, "the setup command started");
      expect(isRunning(sleeper ?? 0)).toBe(true);

      live.proc.kill("SIGINT");
      const finished = await live.finished;

      expect(finished.exitCode).toBe(ExitCode.interrupted);
      expect(finished.stderr).toContain("added feat/login");

      await gone("the setup shell", shell ?? 0);
      // The one that proves the process group: `sleep` is not the child in
      // `killRunningGit`'s set, it is that child's child, and it is reachable
      // only because the shell was made a group leader and the signal was sent
      // to `-pid`. Without that, this is the `bun install` still running in a
      // directory whose command was cancelled a minute ago.
      await gone("the sleep the setup command started", sleeper ?? 0);
    });
  }, 30_000);

  /**
   * THIS TEST DESCRIBES A DEFECT, AND IS MARKED FAILING BECAUSE IT IS PRESENT.
   *
   * `clone.ts`'s rollback never runs on an interrupt. `cli.tsx`'s SIGINT
   * handler kills the children and then calls `process.exit(130)` as soon as
   * the reporter has closed — which for the plain reporter is a microtask — so
   * the `catch` in `cloneRepo` that removes a partial `.bare` is not merely
   * racing the exit, it never gets a turn.
   *
   * The test above passes only because git covers for it: interrupted while
   * `git clone --bare` is still running, git removes its own half-written
   * directory on the way out. That cover ends the moment the bare clone
   * returns, and `cloneRepo` has four more steps to go — the refspec, the
   * fetch, the `.git` file, the first worktree. An interrupt anywhere in there
   * leaves exactly what the rollback exists to prevent, and this test lands the
   * signal in the first of those windows: the transport serves the clone and
   * then goes silent, so the interrupt arrives during `git fetch`.
   *
   * What it leaves, verbatim, from a run of this file:
   *
   *     app/.bare/          config objects HEAD info description hooks refs
   *                         packed-refs FETCH_HEAD
   *     grove list in app   exit 7: "cannot tell which branch origin considers
   *                         default"
   *     grove clone … app   exit 6: "… /work/app already exists and is not empty"
   *
   * — discovery finds it, every later command fails obscurely, and re-running
   * clone refuses. Word for word the three consequences the comment above that
   * `rm` names.
   *
   * The fix belongs in `cli.tsx`, not here: the handler has to let the command
   * unwind before the process goes. When it does, this test passes and `bun
   * test` reports *that* as a failure — remove the `.failing` then, and this
   * becomes the regression test for it.
   */
  test("rolls back a `.bare` the clone had already finished writing", async () => {
    await withTempRepo(async (temp) => {
      const marker = join(temp.root, "git.pid");
      const env = await transport(temp, { marker, serve: 1 });

      const live = startCli(["clone", overTransport(temp), "app", "--headless"], {
        cwd: temp.work,
        env,
      });

      // The window this test is about opens here: the bare clone is done, so
      // there is a whole `.bare` on disk and git has no junk of its own left to
      // remove. From here only grove can clean up after itself.
      await live.waitForStderr(/✓ cloned/);

      const [git] = await pidsFrom(marker, live, "git opened a second connection");
      expect(commandOf(git ?? 0)).toContain("fetch");

      live.proc.kill("SIGINT");
      const finished = await live.finished;

      expect(finished.exitCode).toBe(ExitCode.interrupted);
      await gone("the git fetch", git ?? 0);

      // The rollback itself, which is the whole point of the window above: by
      // here `cloneRepo` has written a `.bare` that git will not clean up, so
      // the only thing that can is grove's own `catch` — and it only runs if
      // the interrupt lets the throw travel instead of exiting under it.
      expect(await pathExists(join(temp.work, "app", ".bare"))).toBe(false);

      const again = await runCli(["clone", temp.originUrl, "app"], { cwd: temp.work });
      expect([again.exitCode, again.stderr]).toEqual([ExitCode.ok, again.stderr]);
    });
  }, 30_000);
});
