/**
 * Runs the real `cli.tsx` binary with pipes instead of a PTY.
 *
 * Lives beside the CLI it drives rather than under `src/ui`, because it is not
 * a UI concern: sixteen of the seventeen files that reach for it never touch
 * the PTY driver next door, and eleven of them are `src/core`'s, which has no
 * other reason to know `src/ui` exists.
 *
 * This is the normal way the CLI runs — piped, scripted, in CI — so it covers
 * exit codes, the flags that must answer without a terminal, and the rule that
 * stdout carries data while stderr carries progress. The PTY half of that
 * story is `src/ui/e2e-utils.ts`, which is where a test goes when what it
 * needs is a terminal.
 */

const ENTRY = `${import.meta.dir}/../cli.tsx`;

/**
 * The child's environment.
 *
 * `process.env` is spread rather than left to `Bun.spawn`'s default, and that
 * is the whole of the isolation these tests claim. `withTempRepo` installs the
 * pinned git identity and `GIT_CONFIG_GLOBAL=/dev/null` on `process.env` for
 * the duration of a test, but Bun's default inherits the environment the
 * runner started with, so a child spawned without this saw none of it and read
 * whoever's `~/.gitconfig` was there instead.
 *
 * It passed on a laptop for exactly the reason it had to fail on a runner: a
 * developer's global config supplies `user.email`, so a rebase inside `sync`
 * committed happily; on a machine with no global config git cannot auto-detect
 * an identity and the rebase dies with `Committer identity unknown`, which
 * `sync` can only report as a conflict.
 */
function childEnv(env: RunCliOptions["env"]): Record<string, string | undefined> {
  return { ...process.env, ...env };
}

type RunCliOptions = {
  /**
   * Where the child starts.
   *
   * Not a convenience: every worktree command resolves its target from the
   * directory it was invoked in, so without this there is no way to point the
   * binary at a throwaway repo and the whole layer is untestable.
   */
  readonly cwd?: string;
  /** Merged over `process.env`; set a key to `undefined` to unset it. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export async function runCli(
  args: readonly string[] = [],
  { cwd, env }: RunCliOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd,
    env: childEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

/** The same child as `runCli`'s, handed over while it is still running. */
export type LiveCli = {
  /** The child itself — its pid, and the only way to send it a signal. */
  readonly proc: Bun.Subprocess;
  /**
   * Resolves once stderr has carried something matching, and rejects if the
   * child exits without it ever doing so.
   *
   * Rejecting rather than waiting on is the important half: a command that
   * finished before the test got to it is exactly the race being guarded
   * against, and the alternative is a promise that hangs until the suite's
   * timeout and reports "timed out" about a command that worked perfectly.
   *
   * Matched against everything stderr has said so far rather than line by
   * line, so a caller may wait for a pattern that has already gone past. Pass a
   * pattern without `g`: a global one carries `lastIndex` between calls and
   * would start reading from wherever the previous match left off.
   */
  readonly waitForStderr: (pattern: RegExp) => Promise<void>;
  /** What `runCli` would have returned, once it is over. */
  readonly finished: Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

/**
 * The same run, but still going, for a test whose subject is the interruption.
 *
 * `runCli` buffers to completion and hands back what a finished command said,
 * which is the right shape for every question about the binary except the one
 * it cannot ask: what a *running* command does when a signal arrives. That
 * needs three things `runCli` throws away — a pid to signal, a way to know the
 * work has genuinely started, and the streams afterwards — so they are here
 * instead of folded into it: none of its seventeen callers wants any of them,
 * and a second return field on all of them is a worse trade than a second
 * function.
 *
 * `waitForStderr` is the "genuinely started" half, and it works because both
 * reporters narrate each step to stderr as it begins. The failure that
 * prevents: signalling on a `setTimeout` instead, which is a delay long enough
 * to be safe on a loaded CI box and therefore long enough to land after a fast
 * machine has finished the command — and a test that interrupted nothing still
 * passes, green and asserting nothing. Pair it with `--headless`, whose plain
 * lines are a stable thing to match against; the drawn reporter repaints its
 * frame, and matching that is matching a rendering.
 *
 * Note what a pipe cannot give you: with `stdin: "ignore"` and no PTY the child
 * has no controlling terminal, so there is no Ctrl-C to type. The signal is
 * sent explicitly, with `proc.kill("SIGINT")`.
 */
export function startCli(args: readonly string[] = [], { cwd, env }: RunCliOptions = {}): LiveCli {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd,
    env: childEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  type Waiter = { readonly pattern: RegExp; readonly settle: (error?: Error) => void };
  const waiting = new Set<Waiter>();
  let stderr = "";

  const check = () => {
    for (const waiter of waiting) {
      if (!waiter.pattern.test(stderr)) continue;
      waiting.delete(waiter);
      waiter.settle();
    }
  };

  // Started here and not on demand: both pipes are drained from the moment the
  // child exists, because a caller that waits on a marker before reading a
  // stream would be waiting on a child blocked writing into a full one.
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      // `stream: true` for the same reason `git.ts` decodes this way: a pipe
      // splits on byte boundaries, and a multi-byte character straddling two
      // chunks decodes to nonsense if each is taken alone.
      stderr += decoder.decode(chunk, { stream: true });
      check();
    }
    stderr += decoder.decode();
    check();

    return stderr;
  })();

  const finished = (async () => {
    const [exitCode, stdout, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      drained,
    ]);

    for (const waiter of waiting) {
      waiter.settle(
        new Error(
          `the CLI exited ${exitCode} before ${waiter.pattern} reached stderr; it said:\n${err}`,
        ),
      );
    }
    waiting.clear();

    return { exitCode, stdout, stderr: err };
  })();

  return {
    proc,
    finished,
    waitForStderr: (pattern) =>
      new Promise((resolve, reject) => {
        if (pattern.test(stderr)) {
          resolve();
          return;
        }

        waiting.add({ pattern, settle: (error) => (error ? reject(error) : resolve()) });
      }),
  };
}
