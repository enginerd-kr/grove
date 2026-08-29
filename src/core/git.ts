import { classifyGitError, GroveError, stderrDetails } from "./errors.ts";
import { isDirectory } from "./fs.ts";

/**
 * The only place in this codebase that spawns a process.
 *
 * Keeping it to one function means the environment below is pinned for every
 * git call rather than for the ones somebody remembered, and it gives the SIGINT
 * handler a single set of children to interrupt.
 *
 * `runShell` is the second spawner and lives here for exactly that second
 * reason: it runs a `grove.setup` command somebody configured, which is the
 * one thing this tool executes that it did not write, and it is also the one
 * most likely to take a minute — so it has to be in the set Ctrl-C can reach.
 * What it does *not* share is the pinned environment; see `SHELL_ENV`.
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
 *
 * `grouped` records that the child leads a process group of its own, because
 * for one of the two spawners stopping the child is not the same as stopping
 * the work; see `runShell`.
 */
type RunningChild = {
  readonly pid: number;
  readonly grouped: boolean;
  readonly kill: (signal?: number | NodeJS.Signals) => void;
};

const running = new Set<RunningChild>();

export function killRunningGit(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const child of running) {
    try {
      // A negative pid is the group, which for a grouped child is the whole
      // tree it started rather than just the shell at the top of it.
      if (child.grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already exited between iteration and kill; nothing to stop. The grouped
      // form reaches here the same way, as ESRCH once the last member is gone —
      // which is routine, since the callers below signal in a loop until the
      // promise settles.
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

  traceRun(`git ${[...where, ...args.map(quote)].join(" ")}`, undefined, result, ms);
}

/** The tail every finished-command line shares: where it ran, how it went, how long it took. */
function traceRun(what: string, cwd: string | undefined, result: GitResult, ms: number): void {
  const where = cwd === undefined ? "" : ` in ${quote(cwd)}`;
  const outcome = result.code === 0 ? "ok" : `exit ${result.code}`;

  trace?.(`${what}${where} → ${outcome}, ${Math.round(ms)}ms`);
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

async function spawnProcess(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  { cwd, onStderrLine }: Pick<GitOptions, "cwd" | "onStderrLine">,
  detached = false,
): Promise<GitResult> {
  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn([...argv], {
      cwd,
      env,
      detached,
      // Never inherited: a child that reads stdin would block on a terminal this
      // tool does not require, and `GIT_TERMINAL_PROMPT` only covers git's own
      // prompts, not a credential helper's.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    // A directory that is no longer there fails inside `Bun.spawn`, before the
    // command runs at all — so a caller reading an exit code would instead take
    // an ENOENT, which is how a worktree removed in another terminal reached the
    // screen as a crash rather than as an empty panel. Answering the way the
    // command itself would have keeps that knowledge here, in the one place that
    // spawns anything.
    //
    // A missing *executable* still throws: `runTool` reads that as "not
    // installed", which is an answer only it can give.
    if (cwd !== undefined && !(await isDirectory(cwd))) {
      return {
        code: 128,
        stdout: "",
        stderr: `fatal: cannot change to '${cwd}': No such file or directory\n`,
      };
    }

    throw error;
  }

  const entry: RunningChild = {
    pid: child.pid,
    grouped: detached,
    kill: (signal) => child.kill(signal),
  };
  running.add(entry);

  try {
    const [stdout, stderr, code] = await Promise.all([
      drain(child.stdout as ReadableStream<Uint8Array> | undefined),
      drain(child.stderr as ReadableStream<Uint8Array> | undefined, onStderrLine),
      child.exited,
    ]);

    return { code, stdout, stderr };
  } finally {
    running.delete(entry);
  }
}

/** Runs git and reports what happened. A non-zero exit is a result, not a throw. */
export async function runGit(
  args: readonly string[],
  { cwd, onStderrLine, env }: GitOptions = {},
): Promise<GitResult> {
  const startedAt = performance.now();
  const result = await spawnProcess(
    ["git", ...args],
    { ...process.env, ...PINNED_ENV, ...env },
    { cwd, onStderrLine },
  );

  if (trace) traceCommand(args, cwd, result, performance.now() - startedAt);

  return result;
}

/**
 * What a `grove.setup` command gets on top of the user's own environment.
 *
 * Deliberately not `PINNED_ENV`. `LC_ALL=C` is there so this tool can match
 * git's English stderr, and forcing it on somebody's `bun install` would change
 * the language their own tooling speaks for no benefit to anyone. What does
 * carry over is the prompt: a setup command that shells out to git must fail
 * rather than block on a question nobody is watching, which is the same reason
 * stdin is not inherited.
 */
const SHELL_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Runs another tool by name — today that is `gh`, and only for pull requests.
 *
 * `null` means the tool is not installed, which is an answer and not an error:
 * everything else in grove works without it, so the caller gets to say
 * "install gh" next to the one feature that wants it rather than this throwing
 * something generic. Environment prompting is disabled the same way it is for
 * git — a tool that stops to ask a question nobody is watching has hung.
 */
export async function runTool(
  argv: readonly [string, ...string[]],
  { cwd, env }: Pick<GitOptions, "cwd" | "env"> = {},
): Promise<GitResult | null> {
  const startedAt = performance.now();

  let result: GitResult;
  try {
    result = await spawnProcess(
      argv,
      { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", ...env },
      { cwd },
    );
  } catch (error) {
    // Bun.spawn throws when the executable does not exist on PATH.
    if (error instanceof Error && /[Ee]xecutable not found|ENOENT/.test(error.message)) {
      trace?.(`${argv.join(" ")} → not installed`);

      return null;
    }
    throw error;
  }

  traceRun(argv.map(quote).join(" "), cwd, result, performance.now() - startedAt);

  return result;
}

/**
 * Runs one configured command line, through `sh`, in a worktree.
 *
 * This *is* a shell, deliberately: `grove.setup` was typed into `git config`
 * on purpose, once, by the person whose machine it runs on, and it is written
 * expecting `&&` and `$HOME` to mean what they mean everywhere else. Nothing
 * a keystroke reaches gets here.
 *
 * It is also the only spawner given a process group of its own, and the `&&` is
 * the reason. `sh -c` *execs* a line holding a single command, so the child in
 * the set above is the work itself and killing it is enough. Add a second
 * command — which is what these lines look like in practice, `bun install &&
 * bun run build` — and `sh` stays around as a parent, so the same signal stops
 * the shell and orphans the install. `detached` makes the shell a group leader
 * and `killRunningGit` signals `-pid`, which reaches every descendant however
 * deep the line nests them.
 *
 * The cost is worth stating, because it is not free: `detached` is `setsid()`,
 * so the child leaves this process's terminal behind and the tty's own Ctrl-C
 * no longer reaches it. In the plain CLI that tty signal was a second route to
 * the same end, and it is the one being given up — affordable only because
 * `cli.tsx` installs a SIGINT handler that calls `killRunningGit`, so what
 * remains is the route that now reaches the whole tree rather than the shell
 * alone. Were that handler ever removed, this would be a regression there. In
 * the interactive app there was no second route to lose: Ink's `useInput` puts
 * the terminal in raw mode, so Ctrl-C arrives as a byte and this set is the
 * only thing that ever hears it.
 * Nothing else is given up — stdin is already `"ignore"` and both output
 * streams are pipes, so no part of this was using that terminal anyway.
 *
 * `runGit` and `runTool` stay undetached. They exec a real program directly, so
 * their child *is* the work, and they keep the tty relationship that lets a
 * credential helper's prompt behave.
 */
export async function runShell(
  command: string,
  { cwd, env, onStderrLine }: GitOptions = {},
): Promise<GitResult> {
  const startedAt = performance.now();
  const result = await spawnProcess(
    ["sh", "-c", command],
    { ...process.env, ...SHELL_ENV, ...env },
    { cwd, onStderrLine },
    true,
  );

  traceRun(`sh -c ${quote(command)}`, cwd, result, performance.now() - startedAt);

  return result;
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

  throw new GroveError(
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
 * git emits several phases in sequence ("Counting", "Compressing" and
 * "Receiving" objects, then "Resolving" deltas), each running 0–100, so a bar
 * fed from this restarts a few times during one clone. That is honest — the
 * phases really are separate — and it beats inventing a weighted total that
 * would be wrong for shallow clones.
 *
 * The last phase counts deltas rather than objects, and on a large clone it is
 * the one the user waits through, so it is spelled out rather than folded in.
 */
export function parseGitProgress(line: string): number | undefined {
  const match = /(?:(?:Counting|Compressing|Receiving) objects|Resolving deltas):\s+(\d+)%/.exec(
    line,
  );
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
