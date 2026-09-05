import { commandEnvFor } from "../../hooks/index.ts";
import type { Reporter } from "../../report/reporter.ts";
import { GroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { runTool } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { listWorktrees, worktreeDir } from "../worktrees.ts";

/**
 * `grove exec` — one command, run once in every worktree.
 *
 * The thing a repository full of worktrees is: N directories that were the same
 * yesterday and are not today. `bun install` after a lockfile changed, `git
 * status` to find where the uncommitted work went, a codemod that has to land
 * in all of them — every one of those is a `for` loop somebody writes in their
 * shell, gets subtly wrong about quoting, and writes again next week.
 *
 * `sync` is the same shape for the one command grove knows how to run. This is
 * the shape for every other one.
 *
 * The command is an argv and not a shell line, which is the opposite choice
 * from `.grove.toml`'s `run`. The reason is where each of them is written: a
 * `run` line is typed into a file once, by hand, expecting `&&` and `$HOME` to
 * work, and it is read back before it runs. This is typed at a shell that has
 * *already* done the quoting, and passing what it hands over to a second shell
 * is how `grove exec -- grep 'a b' .` becomes two arguments. A line that wants
 * a shell can still ask for one — `grove exec -- sh -c '…'` — which is one word
 * longer and never surprising.
 */

export type ExecOptions = {
  /** The command and its arguments, exactly as the shell handed them over. */
  readonly argv: readonly string[];
  /** Stop at the first worktree the command fails in, rather than running everywhere. */
  readonly failFast: boolean;
};

export type ExecOutcome = {
  readonly path: string;
  readonly dir: string;
  readonly branch?: string;
  /** The command's exit status. Absent when it was not run here. */
  readonly code?: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Why it was not run here, when it was not. */
  readonly skipped?: string;
};

export async function execInWorktrees(
  repo: RepoPaths,
  options: ExecOptions,
  reporter: Reporter,
): Promise<readonly ExecOutcome[]> {
  const [command, ...rest] = options.argv;
  if (command === undefined) {
    throw new GroveError("usage", "exec needs a command to run", {
      hint: "grove exec -- bun install",
    });
  }

  const records = await listWorktrees(repo.gitDir);
  // By directory, so two runs over the same repository print their sections in
  // the same order and a diff between them is about the command. git hands
  // worktrees back in the order they were made, which is an order nobody who
  // reads the output is thinking in.
  const targets = records
    .map((record) => ({ record, dir: worktreeDir(repo.root, record.path) }))
    .toSorted((a, b) => a.dir.localeCompare(b.dir));

  const outcomes: ExecOutcome[] = [];

  for (const { record, dir } of targets) {
    const base = { path: record.path, dir, branch: record.branch };

    // git still lists a worktree whose directory somebody deleted behind its
    // back — `doctor` is where that is reported and fixed. Spawning into it
    // would fail with an ENOENT about a path the user did not name, so it is
    // said plainly and the run carries on to the directories that are there.
    if (!(await pathExists(record.path))) {
      outcomes.push({ ...base, stdout: "", stderr: "", skipped: "the directory is gone" });
      continue;
    }

    const step = reporter.step(`${command} in ${dir}`);
    const result = await runTool([command, ...rest], {
      cwd: record.path,
      env: await commandEnvFor(repo, { path: record.path, branch: record.branch }, []),
    });

    // The same PATH answers for every worktree, so this is a fact about the run
    // and not about this directory: raising here rather than recording it N
    // times is what stops one typo becoming ten identical lines.
    if (result === null) {
      step.fail(`${command} is not installed`);
      throw new GroveError("usage", `${JSON.stringify(command)} is not on PATH`, {
        hint: "grove exec runs a program, not a shell line — `grove exec -- sh -c '…'` for one",
      });
    }

    if (result.code === 0) step.succeed(`${command} in ${dir}`);
    else step.fail(`${command} exited ${result.code} in ${dir}`);

    outcomes.push({ ...base, code: result.code, stdout: result.stdout, stderr: result.stderr });

    if (result.code !== 0 && options.failFast) break;
  }

  return outcomes;
}

/**
 * What the command wrote to stdout here, without the trailing newline the
 * reporter adds back.
 *
 * The split between this and `execNotes` is the rule the whole tool follows,
 * and this command is where it earns its keep: the headings and the command's
 * own stderr go on stderr, and only stdout goes to stdout — so `grove exec --
 * cat version.txt > all.txt` collects versions rather than a transcript, while
 * a person watching still sees which worktree each block came from.
 */
export function formatExec(outcome: ExecOutcome): string {
  return outcome.stdout.replace(/\n$/, "");
}

/**
 * What it said on stderr, as lines, for the reporter to put back on stderr.
 *
 * Kept rather than dropped for a command that worked: plenty of tools report on
 * stderr as a matter of course — `git push`, every installer's progress — and a
 * run that showed those lines only for a failure would be a `for` loop with a
 * `2>/dev/null` nobody asked for.
 */
export function execNotes(outcome: ExecOutcome): readonly string[] {
  return outcome.stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export function describeExec(outcomes: readonly ExecOutcome[]): string {
  const ran = outcomes.filter((outcome) => outcome.code !== undefined);
  const failed = ran.filter((outcome) => outcome.code !== 0);
  const skipped = outcomes.length - ran.length;

  const parts = [`ran in ${ran.length} ${ran.length === 1 ? "worktree" : "worktrees"}`];
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  return parts.join(", ");
}

/**
 * Turns the outcomes into the one exit code the shell sees.
 *
 * Reported after every worktree has had its turn, the way `sync --all` reports
 * its own: with nine worktrees fine and one broken, the news is which one, and
 * throwing at the moment it happened would have hidden the other nine.
 */
export function failureFor(outcomes: readonly ExecOutcome[]): GroveError | undefined {
  const failed = outcomes.filter((outcome) => outcome.code !== undefined && outcome.code !== 0);
  if (failed.length === 0) return undefined;

  return new GroveError(
    "command-failed",
    failed.length === 1 && failed[0]
      ? `the command exited ${failed[0].code} in ${failed[0].dir}`
      : `the command failed in ${failed.length} worktrees`,
    { details: failed.map((outcome) => `${outcome.dir}: exit ${outcome.code}`) },
  );
}
