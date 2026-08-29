import { cp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Reporter } from "../report/reporter.ts";
import { defaultBranch } from "./branches.ts";
import { GroveError } from "./errors.ts";
import { entryExists, isDirectoryEntry } from "./fs.ts";
import { runGit, runShell } from "./git.ts";
import { BARE_DIR, type RepoPaths } from "./layout.ts";
import {
  EMPTY_PLAN,
  isTrusted,
  plannedCount,
  readSetupFile,
  SETUP_FILE,
  type SetupPlan,
  trust,
} from "./setup-file.ts";
import { listWorktrees, worktreeDir } from "./worktrees.ts";

export type { SetupPlan };
export { SETUP_FILE };

/**
 * Making a new worktree one you can actually work in.
 *
 * A worktree arrives with everything git tracks and nothing it does not, which
 * is the whole point of it and also why the first thing anybody does in a fresh
 * one is fail to build. `node_modules` is not there, `.env` is not there, and
 * the fix is a `cp` from the worktree next door that nobody remembers the
 * spelling of. That copy is the bookkeeping this tool exists to remove.
 *
 * What to copy, link, and run is read from `.grove.toml` in the worktree —
 * see `setup-file.ts` for why it is a tracked file and what that costs.
 */

/** Which worktree is being set up. `add` has one before git reports it. */
export type SetupTarget = {
  readonly path: string;
  readonly branch?: string;
};

export type SetupOptions = {
  /** A plan already read, for a caller that had to read it before this ran. */
  readonly plan?: SetupPlan;
};

export type SetupFailure = {
  readonly command: string;
  readonly code: number;
  readonly details: readonly string[];
};

export type SetupResult = {
  readonly path: string;
  readonly dir: string;
  /** How many things the configuration asked for. Zero means nothing is configured. */
  readonly planned: number;
  readonly copied: readonly string[];
  readonly linked: readonly string[];
  readonly ran: readonly string[];
  /** Configured, but not in the source worktree — there was nothing to take. */
  readonly missing: readonly string[];
  /** `link` paths already in this worktree, so left exactly as they were. */
  readonly kept: readonly string[];
  /** What `copy` replaced with the trunk's version — entries, not `copy` lines. */
  readonly overwritten: readonly string[];
  /** Set when a command exited non-zero. The ones after it were not run. */
  readonly failed?: SetupFailure;
  /**
   * True when there were commands and this machine has not trusted the file.
   *
   * Not a failure — the copies and links still happened, and what did not is
   * waiting on somebody having read the file rather than on anything going
   * wrong. The caller says so and offers `--trust`.
   */
  readonly untrusted: boolean;
};

/**
 * A configured path, checked rather than rewritten.
 *
 * Checked for a sharp reason: these paths are
 * resolved twice, once against the worktree being filled and once against the
 * one being read from, so a `..` that escaped would let a line in a config file
 * copy `~/.ssh` into a directory somebody is about to commit from.
 */
export function checkedSetupPath(key: "copy" | "link" | string, value: string): string {
  const segments = value.split(/[/\\]/).filter((segment) => segment.length > 0 && segment !== ".");
  const bad =
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    segments.length === 0 ||
    segments.some((segment) => segment === ".." || segment === ".git" || segment === BARE_DIR);

  if (bad) {
    throw new GroveError("usage", `${key}: ${JSON.stringify(value)} is not a usable path`, {
      hint: "a relative path inside the worktree, such as `.env` or `config/local.json`",
    });
  }

  return segments.join("/");
}

/**
 * Reads the repository's `.grove.toml`, with its paths checked.
 *
 * **The trunk's copy, not the worktree being set up.** Both were tenable and
 * this one is uniform: a branch cut last month has no file in it, and reading
 * the local copy would mean the repository was configured for the worktrees
 * made after Tuesday and not the ones made before. It is also where copies come
 * from already, so there is one rule here rather than two.
 *
 * Paths are checked here rather than at the point of use, so a file with an
 * unusable path in it is refused as a whole: a run that copied two of three
 * paths and then explained the third would leave a worktree nobody can reason
 * about.
 */
export async function readSetupPlan(worktree: string): Promise<SetupPlan> {
  const plan = await readSetupFile(worktree);

  return {
    ...plan,
    copy: plan.copy.map((value) => checkedSetupPath("copy", value)),
    link: plan.link.map((value) => checkedSetupPath("link", value)),
  };
}

/**
 * The commands a worktree was just denied, if any.
 *
 * The screen asks this straight after making a worktree, because that is the
 * moment the question means something: the files are in place, the commands are
 * not, and what is being agreed to is on the row in front of you. An empty
 * answer is every ordinary repository, and nothing is drawn for it.
 */
export async function pendingCommands(
  repo: RepoPaths,
  /** Where to read from when the trunk has no worktree yet — `clone`'s case. */
  fallback?: string,
): Promise<readonly string[]> {
  const plan = await repoSetupPlan(repo, fallback);
  if (plan.commands.length === 0 || plan.fingerprint === undefined) return [];

  return (await isTrusted(repo.gitDir, plan.fingerprint)) ? [] : plan.commands;
}

/**
 * Records the file as read, and then does what it says.
 *
 * The only way commands ever run: `--trust` on the command line, or `y` to the
 * screen's question. Both land here, and both record the same fingerprint, so
 * answering in one place answers for the other.
 */
export async function trustAndRun(
  repo: RepoPaths,
  target: SetupTarget,
  reporter: Reporter,
): Promise<SetupResult> {
  const plan = await repoSetupPlan(repo, target.path);
  if (plan.fingerprint !== undefined) await trust(repo.gitDir, plan.fingerprint);

  return runSetup(repo, target, {}, reporter);
}

/**
 * Where copies and links come from: the default branch's worktree.
 *
 * One rule, and a predictable one. "Whichever worktree you happen to be
 * standing in" would mean the `.env` you get depends on where your shell was,
 * and the trunk is the checkout that always exists and that nobody is
 * experimenting in.
 *
 * `self` is the trunk setting itself up, which is not a failure and not worth a
 * word — there is no third worktree to prefer, and the commands still run.
 */
type Source =
  | { readonly kind: "at"; readonly path: string }
  | { readonly kind: "self" }
  | { readonly kind: "none"; readonly trunk?: string };

/** The default branch's worktree, which is what everything here reads from. */
async function trunkWorktree(repo: RepoPaths): Promise<string | undefined> {
  const source = await sourceWorktree(repo, { path: "" });

  return source.kind === "at" ? source.path : undefined;
}

/**
 * The repository's plan: the trunk's file, or the worktree's own as a fallback.
 *
 * The fallback is for the one repository that has no trunk worktree — somebody
 * removed it — where reading nothing at all would be a worse answer than
 * reading what is in front of us.
 */
export async function repoSetupPlan(repo: RepoPaths, fallback?: string): Promise<SetupPlan> {
  const trunk = (await trunkWorktree(repo)) ?? fallback;

  return trunk === undefined ? EMPTY_PLAN : readSetupPlan(trunk);
}

async function sourceWorktree(repo: RepoPaths, target: SetupTarget): Promise<Source> {
  let trunk: string;
  try {
    trunk = await defaultBranch(repo.gitDir);
  } catch {
    // A repository whose remote advertises no HEAD. Everything else here still
    // works, and failing the `add` this is running inside of would be a poor
    // trade for a `.env` we could not find a source for anyway.
    return { kind: "none" };
  }

  const worktrees = await listWorktrees(repo.gitDir);
  const record = worktrees.find((entry) => entry.branch === trunk);

  if (!record) return { kind: "none", trunk };
  if (record.path === target.path) return { kind: "self" };

  return { kind: "at", path: record.path };
}

/** In words, for the line a command prints when it is done. */
export function describeSetup(result: SetupResult): string {
  const parts: string[] = [];

  if (result.copied.length > 0) parts.push(`${result.copied.length} copied`);
  if (result.overwritten.length > 0) parts.push(`${result.overwritten.length} overwritten`);
  if (result.linked.length > 0) parts.push(`${result.linked.length} linked`);
  if (result.ran.length > 0) parts.push(`${result.ran.length} run`);
  if (result.kept.length > 0) parts.push(`${result.kept.length} kept`);
  if (result.untrusted) parts.push("commands not trusted");
  if (parts.length === 0) return result.planned === 0 ? `no ${SETUP_FILE}` : "nothing to do";

  return parts.join(", ");
}

/**
 * The error a failed command becomes, or nothing.
 *
 * Handed back rather than thrown from `runSetup` itself, so a caller can report
 * what did land before it raises what did not — the same shape `sync` uses, and
 * for the same reason: three files copied and then a failed install is two
 * facts, and swallowing the first one helps nobody debug the second.
 *
 * No hint. It used to name `grove setup <worktree>`, which is not a command
 * this tool has, and advice that sends somebody to a help page is worse than
 * none — what they need is on `details`, which is what the command itself said.
 */
export function failureFor(result: SetupResult): GroveError | undefined {
  if (!result.failed) return undefined;

  return new GroveError(
    "setup-failed",
    `${JSON.stringify(result.failed.command)} exited ${result.failed.code}`,
    { details: result.failed.details },
  );
}

/**
 * Whether git would report these paths as changes.
 *
 * Worth a line of its own because of what else is in this tool: a copied `.env`
 * that nothing ignores makes a brand new worktree open dirty, and `x` in the
 * app — `grove reset --clean` — deletes exactly the untracked files this just
 * put there. Saying so once, at the point the file arrives, is cheaper than
 * finding out the other way.
 */
async function unignored(worktree: string, paths: readonly string[]): Promise<readonly string[]> {
  const answers = await Promise.all(
    paths.map(async (path) => {
      const ignored = await runGit(["check-ignore", "--quiet", "--", path], { cwd: worktree });

      return ignored.code === 0 ? undefined : path;
    }),
  );

  return answers.filter((path): path is string => path !== undefined);
}

type FileOutcome = "copied" | "linked" | "missing" | "kept";

/**
 * A copy that takes the trunk's version, what is already there included.
 *
 * The trunk wins: `copy` names the files the trunk's worktree maintains — the
 * real `.env`, the current certs — and a worktree holding an older copy is
 * exactly the worktree this exists to fix. So a file already at the destination
 * is replaced rather than kept, and re-running setup refreshes a stale copy
 * instead of explaining that it was left alone. What is replaced is said out
 * loud, in `overwritten`, so the run reports what it took over.
 *
 * A directory is not replaced wholesale. Deleting it would take the worktree's
 * own files with it — the build output inside `config/`, the tracked files the
 * branch checked out — so two real directories are merged entry by entry
 * instead: the trunk's entries land, overwriting where both have one, and an
 * entry only the destination has stays. The same rule, one level further down.
 *
 * Real directories, by `lstat`. A symlink at either end is the link it is, not
 * the thing it points at: one at the destination is removed and replaced rather
 * than descended into or written through — writing through it would land in
 * whatever it points at, which for a worktree that also has a `link` line is
 * the trunk's copy — and one at the source is copied as a link.
 */
async function copyEntry(
  from: string,
  to: string,
  /** The path as configured, and then as descended — collected in `written`. */
  path: string,
  /** Every path this put where nothing was, for the ignore check below. */
  written: string[],
  /** Every path this replaced, so the report can say what was overwritten. */
  overwritten: string[],
): Promise<"copied" | "kept"> {
  if (await entryExists(to)) {
    if ((await isDirectoryEntry(from)) && (await isDirectoryEntry(to))) {
      const outcomes = [];
      for (const name of await readdir(from)) {
        outcomes.push(
          await copyEntry(
            join(from, name),
            join(to, name),
            `${path}/${name}`,
            written,
            overwritten,
          ),
        );
      }

      return outcomes.includes("copied") ? "copied" : "kept";
    }

    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    overwritten.push(path);

    return "copied";
  }

  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
  written.push(path);

  return "copied";
}

/**
 * One path, taken — or, for `link`, left exactly as it was.
 *
 * `copy` is `copyEntry` above, directories and overwriting included. `link` is
 * one symlink and still never overwrites: a link is the whole path or none of
 * it, and replacing a real directory with a link into the trunk would silently
 * share what the worktree thought was its own — so what is already there is
 * kept, and `kept` is the answer that says so.
 */
async function takeOne(
  kind: "copy" | "link",
  path: string,
  source: string,
  destination: string,
  written: string[],
  overwritten: string[],
): Promise<FileOutcome> {
  const from = join(source, path);
  const to = join(destination, path);

  if (!(await entryExists(from))) return "missing";
  if (kind === "copy") return copyEntry(from, to, path, written, overwritten);
  if (await entryExists(to)) return "kept";

  await mkdir(dirname(to), { recursive: true });

  // Relative, for the same reason `.git` holds `gitdir: ./.bare`: the repository
  // folder is one thing somebody may well move, and an absolute link would
  // survive that as a link into the place it used to be.
  await symlink(relative(dirname(to), from), to);
  written.push(path);

  return "linked";
}

/**
 * Fills in a worktree, and runs what was configured to run in it.
 *
 * Never throws for a command that failed — that is in the result, because the
 * files it copied first are worth reporting either way and because the two
 * callers want different things from it. `add` warns: it was asked for a
 * worktree and there is one. The screen's configure question raises: it was
 * asked for this.
 */
export async function runSetup(
  repo: RepoPaths,
  target: SetupTarget,
  options: SetupOptions,
  reporter: Reporter,
): Promise<SetupResult> {
  const dir = worktreeDir(repo.root, target.path);
  const plan = options.plan ?? (await repoSetupPlan(repo, target.path));
  const planned = plannedCount(plan);

  const copied: string[] = [];
  const linked: string[] = [];
  /**
   * What landed where nothing was, to the precision git needs to be asked
   * about it.
   *
   * Not the same list as `copied`: a `copy` of a directory the branch already
   * had writes the entries that were missing from it, and warning about the
   * directory — tracked, and staying — would be a warning about the wrong path.
   * Overwrites are not in here either: a path that existed before this ran was
   * already the worktree's problem, and the warning below is about the files
   * that only just appeared.
   */
  const written: string[] = [];
  /** What `copy` replaced, so the run says which files stopped being theirs. */
  const overwritten: string[] = [];
  const missing: string[] = [];
  const kept: string[] = [];
  const ran: string[] = [];
  let failed: SetupFailure | undefined;

  // No file is the common case, and it costs one `stat` and not one line of
  // output. A tool that announced "nothing to set up" after every `add` would
  // have made the screen worse for everybody who never asked for this.
  if (planned === 0) {
    return {
      path: target.path,
      dir,
      planned,
      copied,
      linked,
      ran,
      missing,
      kept,
      overwritten,
      untrusted: false,
    };
  }

  const wanted = [
    ...plan.copy.map((path) => ({ kind: "copy" as const, path })),
    ...plan.link.map((path) => ({ kind: "link" as const, path })),
  ];

  if (wanted.length > 0) {
    const source = await sourceWorktree(repo, target);

    if (source.kind === "none") {
      reporter.warn(
        `no worktree for ${source.trunk ?? "the default branch"}, so there is nothing to take ` +
          `${plural(wanted.length, "path")} from`,
      );
    } else if (source.kind === "at") {
      const buckets: Record<FileOutcome, string[]> = { copied, linked, missing, kept };
      const step = reporter.step(`filling in ${dir}`);
      try {
        for (const { kind, path } of wanted) {
          const outcome = await takeOne(kind, path, source.path, target.path, written, overwritten);
          buckets[outcome].push(path);
        }
      } catch (error) {
        step.fail(`could not fill in ${dir}`);
        throw new GroveError("setup-failed", `could not set up ${dir}`, {
          details: [error instanceof Error ? error.message : String(error)],
          cause: error,
        });
      }

      const took = [...copied, ...linked];
      step.succeed(took.length === 0 ? `nothing to take for ${dir}` : `took ${took.join(", ")}`);

      if (missing.length > 0) {
        reporter.info(`not in ${worktreeDir(repo.root, source.path)}: ${missing.join(", ")}`);
      }
      if (overwritten.length > 0) {
        reporter.info(`already in ${dir}, overwritten: ${overwritten.join(", ")}`);
      }
      if (kept.length > 0) {
        reporter.info(`already in ${dir}, left alone: ${kept.join(", ")}`);
      }

      const exposed = await unignored(target.path, written);
      if (exposed.length > 0) {
        const one = exposed.length === 1;
        reporter.warn(
          `not ignored here: ${exposed.join(", ")} — ${one ? "it shows" : "they show"} as ` +
            `${one ? "an untracked change" : "untracked changes"}, and a discard would delete ` +
            `${one ? "it" : "them"}`,
        );
      }
    }
  }

  /**
   * The commands wait on somebody having read the file.
   *
   * This is the whole price of a configuration that travels with the project:
   * `copy` and `link` move files already on your disk, and `run` is a command
   * that arrived over the network. So the files land either way and the
   * commands do not, until `grove trust` records these exact contents — and
   * they stop again the moment a pull changes them.
   */
  const untrusted =
    plan.commands.length > 0 &&
    plan.fingerprint !== undefined &&
    !(await isTrusted(repo.gitDir, plan.fingerprint));

  if (untrusted) {
    // Named by the file that actually governs, which is the trunk's — pointing
    // at the worktree being set up would send somebody to read a copy that
    // nothing consults, or to a file that is not there at all.
    const where = plan.path === undefined ? SETUP_FILE : relative(repo.root, plan.path);

    reporter.warn(
      `${plural(plan.commands.length, "command")} in ${where} ${
        plan.commands.length === 1 ? "has" : "have"
      } not been trusted here — read it, then add with --trust`,
    );
  }

  /**
   * What the commands run with, over whatever grove itself was started in.
   *
   * `env` first and grove's own three last: `GROVE_WORKTREE` is this tool's
   * answer to "where am I", and a file that could overwrite it would be able to
   * lie to the script it is about to run.
   *
   * Not logged, and neither are the values anywhere else — the step line says
   * the command and not its environment, because `env` is where a token ends up
   * and a token belongs in no scrollback.
   */
  const commandEnv = {
    ...Object.fromEntries(plan.env.map(({ name, value }) => [name, value])),
    GROVE_ROOT: repo.root,
    GROVE_WORKTREE: target.path,
    GROVE_BRANCH: target.branch ?? "",
  };

  for (const command of untrusted ? [] : plan.commands) {
    const step = reporter.step(`running ${command}`);
    const result = await runShell(command, { cwd: target.path, env: commandEnv });

    if (result.code !== 0) {
      step.fail(`${command} exited ${result.code}`);
      // The rest do not run. They were written as a sequence — an install and
      // then a build over what it installed — so carrying on past a failure
      // would be running the second half against the first half's absence.
      failed = { command, code: result.code, details: tail(result.stderr, result.stdout) };
      break;
    }

    step.succeed(`ran ${command}`);
    ran.push(command);
  }

  return {
    path: target.path,
    dir,
    planned,
    copied,
    linked,
    ran,
    missing,
    kept,
    overwritten,
    failed,
    untrusted,
  };
}

export type TeardownResult = {
  readonly dir: string;
  /** How many commands `[teardown]` asked for. Zero is every ordinary repository. */
  readonly planned: number;
  readonly ran: readonly string[];
  /** Set when a command exited non-zero. The ones after it were not run. */
  readonly failed?: SetupFailure;
  /** True when there were commands and this machine has not trusted the file. */
  readonly untrusted: boolean;
};

/**
 * Runs `[teardown]` in a worktree that is about to be removed.
 *
 * Never throws, and never stops the removal — which is the decision worth
 * writing down. A `docker compose down` that fails because Docker is not
 * running would otherwise leave somebody unable to delete a directory they have
 * finished with, on account of a cleanup for a thing that is already not
 * running. So a failure is loud and the removal carries on, and `--no-teardown`
 * is there for the repository whose cleanup is broken enough to want skipping
 * outright.
 *
 * Trust is the same record `[setup]`'s commands answer to, because it is the
 * same file: one `--trust` covers both, and one edit withdraws both.
 */
export async function runTeardown(
  repo: RepoPaths,
  target: SetupTarget,
  reporter: Reporter,
): Promise<TeardownResult> {
  const dir = worktreeDir(repo.root, target.path);
  const plan = await repoSetupPlan(repo, target.path);
  const { commands, env } = plan.teardown;

  if (commands.length === 0) {
    return { dir, planned: 0, ran: [], untrusted: false };
  }

  const untrusted =
    plan.fingerprint !== undefined && !(await isTrusted(repo.gitDir, plan.fingerprint));

  if (untrusted) {
    const where = plan.path === undefined ? SETUP_FILE : relative(repo.root, plan.path);
    reporter.warn(
      `${plural(commands.length, "teardown command")} in ${where} ${
        commands.length === 1 ? "has" : "have"
      } not been trusted here — the worktree still goes, but nothing was run in it`,
    );

    return { dir, planned: commands.length, ran: [], untrusted };
  }

  const commandEnv = {
    ...Object.fromEntries(env.map(({ name, value }) => [name, value])),
    GROVE_ROOT: repo.root,
    GROVE_WORKTREE: target.path,
    GROVE_BRANCH: target.branch ?? "",
  };

  const ran: string[] = [];
  let failed: SetupFailure | undefined;

  for (const command of commands) {
    const step = reporter.step(`running ${command}`);
    const result = await runShell(command, { cwd: target.path, env: commandEnv });

    if (result.code !== 0) {
      step.fail(`${command} exited ${result.code}`);
      // The rest do not run, for the same reason `[setup]`'s do not: they were
      // written as a sequence, and the second half of a teardown usually
      // assumes the first half happened.
      failed = { command, code: result.code, details: tail(result.stderr, result.stdout) };
      break;
    }

    step.succeed(`ran ${command}`);
    ran.push(command);
  }

  return { dir, planned: commands.length, ran, failed, untrusted };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The last few lines a failed command said, on whichever stream it said them. */
function tail(stderr: string, stdout: string, max = 5): readonly string[] {
  return [stderr, stdout]
    .join("\n")
    .split(/\r?\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-max);
}
