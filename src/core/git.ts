import { classifyGitError, GardenError, stderrDetails } from "./errors.ts";

/**
 * The only place in this codebase that spawns a process.
 *
 * Keeping it to one function means the environment below is pinned for every
 * git call rather than for the ones somebody remembered, and it gives the SIGINT
 * handler a single set of children to interrupt.
 */

export type GitResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type GitOptions = {
  readonly cwd?: string;
  /**
   * Called for each line git writes to stderr, as it arrives.
   *
   * git reports progress by rewriting one line with `\r`, so the splitter below
   * treats a lone `\r` as a terminator too. Without that, a whole clone arrives
   * as a single unterminated line and the progress bar never moves.
   */
  readonly onStderrLine?: (line: string) => void;
  /** Merged over the pinned environment. Tests use it to isolate git config. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Environment every git child gets, whatever the user's shell looks like.
 *
 * - `GIT_TERMINAL_PROMPT=0` — otherwise an https clone of a private repo blocks
 *   forever on a username prompt that nobody is watching. Failing fast turns a
 *   hang into an auth error we can classify.
 * - `GIT_OPTIONAL_LOCKS=0` — read-only calls (`status`, `worktree list`) stop
 *   taking the index lock, so listing worktrees cannot collide with an editor's
 *   background git.
 * - `LC_ALL=C` — `classifyGitError` matches English stderr. Under a translated
 *   locale every failure would fall through to the generic code.
 */
const PINNED_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

/**
 * Children currently running, so Ctrl-C can interrupt them.
 *
 * A `git clone` killed halfway leaves a partial directory behind; the clone
 * command is what cleans that up. This set exists only to stop the work.
 */
const running = new Set<{ kill: (signal?: number | NodeJS.Signals) => void }>();

export function killRunningGit(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const child of running) {
    try {
      child.kill(signal);
    } catch {
      // Already exited between iteration and kill; nothing to stop.
    }
  }
}

/**
 * Where `--verbose` sends its record of what git was asked to do.
 *
 * A module-level sink rather than an option threaded through every call: this
 * is the same shape as `running` above, and for the same reason — the fact
 * being recorded belongs to the spawn, not to the caller, and a `GitOptions`
 * field would be one more thing each of forty call sites could forget.
 */
let trace: ((line: string) => void) | undefined;

/** Installs the sink, or removes it when given `undefined`. */
export function traceGit(sink: ((line: string) => void) | undefined): void {
  trace = sink;
}

/** Shell quoting, only where a word would otherwise not survive being pasted back. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/**
 * One line per command, written when it finishes rather than when it starts.
 *
 * Finishing is when the interesting half is known — the exit code that
 * `gitSucceeds` quietly branches on, and how long the call took. It also keeps
 * each line self-contained, which start/finish pairs would not be: some of
 * these run concurrently and their pairs would interleave.
 *
 * The `-C` form is deliberate — it is the command you can paste into a shell to
 * see the same thing, modulo the pinned environment above.
 */
function traceCommand(
  args: readonly string[],
  cwd: string | undefined,
  result: GitResult,
  ms: number,
): void {
  const where = cwd === undefined ? [] : ["-C", quote(cwd)];
  const outcome = result.code === 0 ? "ok" : `exit ${result.code}`;

  trace?.(`git ${[...where, ...args.map(quote)].join(" ")} → ${outcome}, ${Math.round(ms)}ms`);
}

async function drain(
  stream: ReadableStream<Uint8Array> | undefined,
  onLine?: (line: string) => void,
): Promise<string> {
  if (!stream) return "";

  const decoder = new TextDecoder();
  let text = "";
  let pending = "";

  const emit = (piece: string) => {
    text += piece;
    if (!onLine) return;

    pending += piece;
    const parts = pending.split(/\r\n|\r|\n/);
    // The last element is whatever follows the final terminator — possibly a
    // half-written line — so it stays buffered until more arrives.
    pending = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  };

  for await (const chunk of stream) {
    // `stream: true` is required rather than tidy: a pipe splits on byte
    // boundaries, so a multi-byte character routinely straddles two chunks and
    // decoding each alone would corrupt it.
    emit(decoder.decode(chunk, { stream: true }));
  }
  emit(decoder.decode());

  if (onLine && pending.length > 0) onLine(pending);

  return text;
}

/** Runs git and reports what happened. A non-zero exit is a result, not a throw. */
export async function runGit(
  args: readonly string[],
  { cwd, onStderrLine, env }: GitOptions = {},
): Promise<GitResult> {
  const startedAt = performance.now();
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...PINNED_ENV, ...env },
    // Never inherited: a child that reads stdin would block on a terminal this
    // tool does not require, and `GIT_TERMINAL_PROMPT` only covers git's own
    // prompts, not a credential helper's.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  running.add(child);

  try {
    const [stdout, stderr, code] = await Promise.all([
      drain(child.stdout as ReadableStream<Uint8Array> | undefined),
      drain(child.stderr as ReadableStream<Uint8Array> | undefined, onStderrLine),
      child.exited,
    ]);

    const result = { code, stdout, stderr };
    if (trace) traceCommand(args, cwd, result, performance.now() - startedAt);

    return result;
  } finally {
    running.delete(child);
  }
}

/**
 * Runs git and returns its stdout, turning a failure into a classified error.
 *
 * Use this wherever a non-zero exit has no meaning worth branching on. Where it
 * does — "does this ref exist?" is a `rev-parse` that fails on purpose — call
 * `runGit` and read the code.
 */
export async function runGitOrThrow(
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  const result = await runGit(args, options);
  if (result.code === 0) return result.stdout;

  throw new GardenError(
    classifyGitError(result.stderr),
    `git ${args.join(" ")} failed (exit ${result.code})`,
    { details: stderrDetails(result.stderr) },
  );
}

/** True when git exited 0. The idiom for "does this ref/branch/state exist?". */
export async function gitSucceeds(
  args: readonly string[],
  options: GitOptions = {},
): Promise<boolean> {
  return (await runGit(args, options)).code === 0;
}

/**
 * The percentage out of a git progress line, if it is one.
 *
 * git emits several phases in sequence ("Counting", "Compressing", "Receiving",
 * "Resolving"), each running 0–100, so a bar fed from this restarts a few times
 * during one clone. That is honest — the phases really are separate — and it
 * beats inventing a weighted total that would be wrong for shallow clones.
 */
export function parseGitProgress(line: string): number | undefined {
  const match = /(?:Counting|Compressing|Receiving|Resolving) objects:\s+(\d+)%/.exec(line);
  if (!match) return undefined;

  const percent = Number(match[1]);

  return Number.isFinite(percent) ? percent : undefined;
}

/** stdout with trailing whitespace removed — git terminates almost everything with a newline. */
export async function gitOutput(
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return (await runGitOrThrow(args, options)).trim();
}
