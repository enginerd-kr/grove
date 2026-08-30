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
    env: env ? { ...process.env, ...env } : undefined,
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
