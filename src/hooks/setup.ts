import { cp, mkdir, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GroveError, isGroveError } from "../core/errors.ts";
import { entryExists, isDirectoryEntry } from "../core/fs.ts";
import { runGit } from "../core/git.ts";
import type { RepoPaths } from "../core/layout.ts";
import { plural } from "../core/text.ts";
import { worktreeDir } from "../core/worktrees.ts";
import type { Reporter } from "../report/reporter.ts";
import { type HookFailure, type HookTarget, runCommands, setupGate } from "./command.ts";
import { configuredFiles, HOOKS_FILE, type Hooks, plannedCount, platformKeyFor } from "./config.ts";
import { openWhatItAsksFor } from "./open.ts";
import { repoHooks, sourceWorktree } from "./source.ts";
import { trust } from "./trust.ts";

/**
 * `[setup]` — making a new worktree one you can actually work in.
 *
 * A worktree arrives with everything git tracks and nothing it does not, which
 * is the whole point of it and also why the first thing anybody does in a fresh
 * one is fail to build. `node_modules` is not there, `.env` is not there, and
 * the fix is a `cp` from the worktree next door that nobody remembers the
 * spelling of. That copy is the bookkeeping this tool exists to remove.
 *
 * What to copy, link, and run is read from `.grove.toml` — see `config.ts` for
 * why it is a tracked file and what that costs, and `open.ts` for the one key
 * this hook finishes with rather than performs.
 */

export type SetupOptions = {
  /** A file already read, for a caller that had to read it before this ran. */
  readonly hooks?: Hooks;
  /**
   * Whether `open` may run. `false` is "there is no terminal to open into".
   *
   * Passed in rather than worked out here, because working it out means reading
   * `process.stdout`, and the rule for this directory is that it knows about a
   * `Reporter` and not about the process it is running in. The command line
   * decides it once, in `cli/run.ts`; the screen is a terminal by definition and
   * says so.
   */
  readonly open?: boolean;
  /**
   * Whether this run finishes by opening the worktree at all.
   *
   * A different question from `open` above, which asks whether there is a
   * terminal to open into. This one asks whether opening is part of what was
   * asked for — false for `grove setup`, which fills in worktrees that were
   * opened weeks ago, and where `--all` would otherwise put an editor window on
   * the screen for every one of them.
   *
   * The difference shows in what is said. A worktree that could not be opened
   * says so, because something was refused; a run that was never going to open
   * anything says nothing, because nothing was.
   */
  readonly opens?: boolean;
};

export type SetupResult = {
  readonly path: string;
  readonly dir: string;
  /** How many things the configuration asked for. Zero means nothing is configured. */
  readonly planned: number;
  readonly copied: readonly string[];
  readonly linked: readonly string[];
  readonly ran: readonly string[];
  /**
   * The application that was started, if one was — which is all that can be
   * known.
   *
   * "Started" and not "opened": nothing is awaited, so an application this
   * machine does not have is reported here exactly like one that worked.
   */
  readonly opened?: string;
  /** Configured, but not in the source worktree — there was nothing to take. */
  readonly missing: readonly string[];
  /** `link` paths already in this worktree, so left exactly as they were. */
  readonly kept: readonly string[];
  /** What `copy` replaced with the trunk's version — entries, not `copy` lines. */
  readonly overwritten: readonly string[];
  /** Set when a command exited non-zero. The ones after it were not run. */
  readonly failed?: HookFailure;
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
 * Records the file as read, and then does what it says.
 *
 * The only way commands ever run: `--trust` on the command line, or `y` to the
 * screen's question. Both land here, and both record the same fingerprint, so
 * answering in one place answers for the other.
 */
export async function trustAndRun(
  repo: RepoPaths,
  target: HookTarget,
  reporter: Reporter,
  /** Everything but `hooks`, which this reads for itself once trust is recorded. */
  options: Omit<SetupOptions, "hooks"> = {},
): Promise<SetupResult> {
  const hooks = await repoHooks(repo, target.path);
  if (hooks.fingerprint !== undefined) await trust(repo.gitDir, hooks.fingerprint);

  return runSetup(repo, target, options, reporter);
}

/** In words, for the line a command prints when it is done. */
export function describeSetup(result: SetupResult): string {
  const parts: string[] = [];

  if (result.copied.length > 0) parts.push(`${result.copied.length} copied`);
  if (result.overwritten.length > 0) parts.push(`${result.overwritten.length} overwritten`);
  if (result.linked.length > 0) parts.push(`${result.linked.length} linked`);
  if (result.ran.length > 0) parts.push(`${result.ran.length} run`);
  // The word alone: `opened` sits in a line that is already a list of counts,
  // and a whole command line inside it would be longer than everything else
  // put together. The line itself was printed when it started.
  if (result.opened !== undefined) parts.push("opened");
  if (result.kept.length > 0) parts.push(`${result.kept.length} kept`);
  if (result.untrusted) parts.push("commands not trusted");
  if (parts.length === 0) return result.planned === 0 ? `no ${HOOKS_FILE}` : "nothing to do";

  return parts.join(", ");
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

/** True when a resolved path is the root itself or something under it. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);

  // `..` alone and `../x` climb out; `..env` is a file whose name begins that
  // way, and a prefix test alone would refuse it.
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Where a path leads, for a link that leads nowhere as well as one that does.
 *
 * `realpath` refuses the whole path when the last component points at something
 * absent, which would leave a dangling link answered by an `ENOENT` nobody
 * asked about. A link pointing at nothing still points somewhere, and where is
 * the only question here — so the parent, which does exist, is resolved and the
 * link read by hand.
 */
async function leadsTo(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = await realpath(dirname(path)).catch(() => resolve(dirname(path)));
    const target = await readlink(path).catch(() => undefined);

    return target === undefined ? join(parent, basename(path)) : resolve(parent, target);
  }
}

/**
 * A source path checked against the disk, not against its spelling.
 *
 * `checkedPath` vets the string a config file wrote; this vets what it
 * reaches. A repository can commit `certs -> /Users/you/.ssh` and then ask for
 * `certs/id_rsa` in a value with no `..` anywhere in it — and `copy` and `link`
 * apply on sight, without `--trust`, so a `git pull` would be the whole of it,
 * with the key landing as an untracked change in a worktree somebody is about
 * to commit from. Both halves are needed: the string check catches the value
 * nobody meant, this one catches the value somebody meant.
 *
 * A real path is what an escape is, so a real path is what gets compared —
 * which also settles a link partway along, and a `..` that only appears once
 * the links on the path have been followed.
 *
 * A link staying inside the worktree is left alone: pointing `config/local.json`
 * at `config/dev.json` is an ordinary thing for a repository to do, and the
 * question here is where the target sits, not whether there is a link at all.
 *
 * A directory is asked about its contents too, because `cp` takes them without
 * this seeing them — a link two levels down leads out just as surely as one at
 * the top. Files are skipped: only a directory or a link has anywhere to lead.
 */
async function checkedSource(
  kind: "copy" | "link",
  path: string,
  root: string,
  from: string,
): Promise<void> {
  const target = await leadsTo(from);

  if (!within(root, target)) {
    throw new GroveError("usage", `${kind}: ${JSON.stringify(path)} leads out of the worktree`, {
      hint: "a path that stays inside the worktree once the links on it are followed",
      details: [`${path} → ${target}`],
    });
  }

  if (!(await isDirectoryEntry(from))) return;

  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile()) continue;
    await checkedSource(kind, `${path}/${entry.name}`, root, join(from, entry.name));
  }
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

  // Before anything is read: `link` points at the source as much as `copy` reads
  // it, so a source that leads out of the worktree is refused for both.
  await checkedSource(kind, path, await realpath(source), from);

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
  target: HookTarget,
  options: SetupOptions,
  reporter: Reporter,
): Promise<SetupResult> {
  const dir = worktreeDir(repo.root, target.path);
  const hooks = options.hooks ?? (await repoHooks(repo, target.path));
  const planned = plannedCount(hooks);

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

  // A file that asks for nothing falls straight through: nothing to take, no trust to ask
  // about, no commands to run. No file is the common case, and it costs one
  // `stat` and not one line of output — a tool that announced "nothing to set
  // up" after every `add` would have made the screen worse for everybody who
  // never asked for this.
  const wanted = [
    ...hooks.copy.map((path) => ({ kind: "copy" as const, path })),
    ...hooks.link.map((path) => ({ kind: "link" as const, path })),
  ];

  // The one exception to that silence: a file that asks for nothing here and
  // something on another kind of machine. Said once, for the reason `open.ts`
  // gives — a `[setup.copy]` written for the rest of the team is a thing to
  // find out from the run that took nothing, not from asking why afterwards.
  // `open` is not part of this question; it has its own sentence there.
  if (wanted.length === 0 && hooks.commands.length === 0 && hooks.elsewhere > 0) {
    reporter.info(
      `nothing in ${configuredFiles(hooks).join(" and ")} is for ${platformKeyFor(process.platform)}`,
    );
  }

  if (wanted.length > 0) {
    const source = await sourceWorktree(repo, target.path);

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
        // A refusal already says which line was refused and what to do about
        // it; wrapping it would bury both under "could not set up", one level
        // down, and report a path this tool declined as a path it fumbled.
        if (isGroveError(error)) throw error;
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

  const { ran, failed, untrusted } = await runCommands(
    repo,
    target,
    hooks,
    hooks,
    { noun: "command", tail: "read it, then add with --trust" },
    reporter,
    setupGate(hooks),
  );

  const opened =
    options.opens === false
      ? undefined
      : await openWhatItAsksFor(
          repo,
          target,
          hooks,
          { untrusted, failed, allowed: options.open !== false },
          reporter,
        );

  return {
    path: target.path,
    dir,
    planned,
    copied,
    linked,
    ran,
    opened,
    missing,
    kept,
    overwritten,
    failed,
    untrusted,
  };
}
