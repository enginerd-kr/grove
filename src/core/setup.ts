import { cp, mkdir, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Reporter } from "../report/reporter.ts";
import { defaultBranch } from "./branches.ts";
import { GroveError, isGroveError } from "./errors.ts";
import { entryExists, isDirectoryEntry } from "./fs.ts";
import { openShell, runGit, runShell } from "./git.ts";
import { BARE_DIR, type RepoPaths } from "./layout.ts";
import {
  EMPTY_PLAN,
  isTrusted,
  openTargetFor,
  plannedCount,
  readSetupFile,
  SETUP_FILE,
  type SetupEnv,
  type SetupPlan,
  trust,
  wantsOpen,
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
  // `open` is in here with the rest, because the question is "what would this
  // file run on your machine" and the answer has to be the whole answer. It is
  // the same shell on the same line; that grove stops watching it afterwards
  // makes it more worth listing rather than less.
  const opening = openHere(plan);
  const waiting = opening === "" ? plan.commands : [...plan.commands, opening];
  if (waiting.length === 0 || plan.fingerprint === undefined) return [];

  return (await isTrusted(repo.gitDir, plan.fingerprint)) ? [] : waiting;
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
  /** Everything but `plan`, which this reads for itself once trust is recorded. */
  options: Omit<SetupOptions, "plan"> = {},
): Promise<SetupResult> {
  const plan = await repoSetupPlan(repo, target.path);
  if (plan.fingerprint !== undefined) await trust(repo.gitDir, plan.fingerprint);

  return runSetup(repo, target, options, reporter);
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
  // The word alone: `opened` sits in a line that is already a list of counts,
  // and a whole command line inside it would be longer than everything else
  // put together. The line itself was printed when it started.
  if (result.opened !== undefined) parts.push("opened");
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
 *
 * Takes the failure and not a whole `SetupResult`, so `TeardownResult` — which
 * carries the same `failed` and nothing else this reads — gets the same
 * sentence rather than a second copy of it in `remove`.
 */
export function failureFor(result: { readonly failed?: SetupFailure }): GroveError | undefined {
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
 * `checkedSetupPath` vets the string a config file wrote; this vets what it
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

  // An empty plan falls straight through: nothing to take, no trust to ask
  // about, no commands to run. No file is the common case, and it costs one
  // `stat` and not one line of output — a tool that announced "nothing to set
  // up" after every `add` would have made the screen worse for everybody who
  // never asked for this.
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

  const { ran, failed, untrusted } = await runCommandSection(
    repo,
    target,
    plan,
    plan,
    { noun: "command", tail: "read it, then add with --trust" },
    reporter,
    openHere(plan) === "" ? 0 : 1,
  );

  const opened = await openWhatItAsksFor(
    repo,
    target,
    plan,
    { untrusted, failed, options },
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

/**
 * Starts `[setup] open`, once there is a worktree worth opening.
 *
 * Three things have to be true first, and each is a different kind of no.
 *
 * Trust is the same record the commands answer to — the line is a shell line
 * out of a file that arrived with a pull, and `open = "curl … | sh"` reaches
 * this machine by exactly the road `run` does. Being unwatched afterwards makes
 * it worse than `run`, not better, so it waits for the same `--trust`.
 *
 * A failed command stops it, even though nothing here depends on that command
 * having worked. `run` is what makes the checkout runnable and `open` is what
 * you do with it once it is; opening an editor onto a half-finished install
 * puts the failure two screens up in a scrollback nobody is looking at any
 * more, and the warning `add` prints is easier to read on the terminal it was
 * printed to.
 *
 * No terminal stops it too, and that one is an exception to a rule this tool
 * otherwise keeps — `add` behaves the same in a pipe as under a terminal
 * precisely so it is one tool and not two. What makes it affordable is that
 * `open` is the only key here whose subject is a person rather than a worktree.
 * Every other one leaves something on disk that a script can go and read; this
 * one puts a window in front of whoever is sitting there, and in `grove add |
 * tee` or on CI there is nobody sitting there. So it is skipped, and it says so
 * rather than leaving the silence to be worked out.
 *
 * What is printed is the line about to be started, before it is started, and
 * then the exit code if there was one soon enough to catch — see `openShell`
 * for how long that is and why it is not longer.
 */
/**
 * The `open` line for the platform this is running on, or `""`.
 *
 * The platform is read once, here, so that every question about `open` — what
 * is pending, what the trust gate counts, what actually starts — is answering
 * about the same line. A file that names only `macos` gives a Linux machine
 * nothing, which is "nothing to open" and not an error.
 */
function openHere(plan: SetupPlan, platform: NodeJS.Platform = process.platform): string {
  return plan.open[openTargetFor(platform)];
}

/**
 * Starts `[setup] open`, once there is a worktree worth opening.
 *
 * Four things have to be true first, and each is a different kind of no.
 *
 * Trust is the same record the commands answer to — it is a shell line out of a
 * file that arrived with a pull, and `open = "curl … | sh"` reaches this
 * machine by exactly the road `run` does. Being let go of afterwards makes it
 * worse than `run`, not better, so it waits for the same `--trust`.
 *
 * A failed command stops it, even though nothing here depends on that command
 * having worked. `run` is what makes the checkout runnable and `open` is what
 * you do with it once it is; opening an editor onto a half-finished install
 * puts the failure two screens up in a scrollback nobody is looking at any
 * more, and the warning `add` prints is easier to read where it was printed.
 *
 * No terminal stops it too, and that one is an exception to a rule this tool
 * otherwise keeps — `add` behaves the same in a pipe as under a terminal
 * precisely so it is one tool and not two. What makes it affordable is that
 * `open` is the only key here whose subject is a person rather than a worktree.
 * Every other one leaves something on disk that a script can go and read; this
 * one puts a window in front of whoever is sitting there, and in `grove add |
 * tee` or on CI there is nobody sitting there. So it is skipped, and it says so
 * rather than leaving the silence to be worked out.
 *
 * And a platform the file did not write a line for opens nothing, which is the
 * only one of the four that is not really a refusal.
 */
async function openWhatItAsksFor(
  repo: RepoPaths,
  target: SetupTarget,
  plan: SetupPlan,
  state: {
    readonly untrusted: boolean;
    readonly failed?: SetupFailure;
    readonly options: SetupOptions;
  },
  reporter: Reporter,
): Promise<string | undefined> {
  const { untrusted, failed, options } = state;
  const command = openHere(plan);

  if (command === "") {
    // Said once rather than left as silence: a file that opens an editor for
    // the rest of the team and not for you is a thing to find out from the run
    // that did not open one, not from asking why afterwards.
    if (wantsOpen(plan.open) && !untrusted) {
      reporter.info(`nothing in ${SETUP_FILE} opens on ${openTargetFor(process.platform)}`);
    }

    return undefined;
  }

  if (untrusted) return undefined;

  if (failed !== undefined) {
    reporter.info(`did not open: ${failed.command} failed`);

    return undefined;
  }

  if (options.open === false) {
    reporter.info("did not open: this is not a terminal");

    return undefined;
  }

  reporter.info(`opening ${command}`);

  try {
    const code = await openShell(command, {
      cwd: target.path,
      env: commandEnvFor(repo, target, plan.env),
    });

    // `undefined` is the line still running, which is what opening something
    // looks like. A number means it was over before grove stopped watching, and
    // a non-zero one is the misspelled application this key used to swallow.
    if (code !== undefined && code !== 0) {
      reporter.warn(`could not open: ${command} exited ${code}`);

      return undefined;
    }
  } catch (error) {
    // The spawn itself, which is a worktree that stopped existing between being
    // made and being opened. Warned and not thrown, because the worktree is
    // what `add` was asked for and an editor that would not start is no reason
    // to report that it is missing.
    reporter.warn(`could not open: ${error instanceof Error ? error.message : String(error)}`);

    return undefined;
  }

  return command;
}

/**
 * What a configured line runs with, over whatever grove itself was started in.
 *
 * `env` first and grove's own three last: `GROVE_WORKTREE` is this tool's
 * answer to "where am I", and a file that could overwrite it would be able to
 * lie to the script it is about to run.
 *
 * Not logged, and neither are the values anywhere else — the step line says the
 * command and not its environment, because `env` is where a token ends up and a
 * token belongs in no scrollback.
 */
function commandEnvFor(
  repo: RepoPaths,
  target: SetupTarget,
  env: readonly SetupEnv[],
): Record<string, string> {
  return {
    ...Object.fromEntries(env.map(({ name, value }) => [name, value])),
    GROVE_ROOT: repo.root,
    GROVE_WORKTREE: target.path,
    GROVE_BRANCH: target.branch ?? "",
  };
}

/**
 * The commands one section asks for, run once somebody has read the file.
 *
 * `[setup]` and `[teardown]` differ in which commands they hold and in what the
 * warning says; everything else about running them is the same, and being the
 * same is the point — one `--trust` covers both sections and one edit withdraws
 * both, which only stays true while one piece of code decides it.
 *
 * This is the whole price of a configuration that travels with the project:
 * `copy` and `link` move files already on your disk, and `run` is a command
 * that arrived over the network. So the files land either way and the commands
 * do not, until `--trust` records these exact contents — and they stop again
 * the moment a pull changes them.
 */
async function runCommandSection(
  repo: RepoPaths,
  target: SetupTarget,
  /** The whole file, for the fingerprint that trust is keyed on and the path to name. */
  plan: SetupPlan,
  section: { readonly commands: readonly string[]; readonly env: readonly SetupEnv[] },
  /** How the refusal reads: `2 teardown commands in … — the worktree still goes`. */
  warning: { readonly noun: string; readonly tail: string },
  reporter: Reporter,
  /**
   * How much else this gate answers for without running it — `[setup]`'s `open`.
   *
   * A count and not a list, because `open` is one application however many
   * arguments spell it. The gate is here and not beside the caller that opens,
   * so that the promise this file makes stays literally true: one piece of code
   * decides trust for the whole file. Counted in the warning as well, because
   * "1 command has not been trusted" beside a file asking for two things is the
   * wrong number to read.
   */
  alsoGated = 0,
): Promise<{ ran: readonly string[]; failed?: SetupFailure; untrusted: boolean }> {
  const { commands, env } = section;
  const gated = commands.length + alsoGated;

  const untrusted =
    gated > 0 &&
    plan.fingerprint !== undefined &&
    !(await isTrusted(repo.gitDir, plan.fingerprint));

  if (untrusted) {
    // Named by the file that actually governs, which is the trunk's — pointing
    // at the worktree being set up would send somebody to read a copy that
    // nothing consults, or to a file that is not there at all.
    const where = plan.path === undefined ? SETUP_FILE : relative(repo.root, plan.path);

    reporter.warn(
      `${plural(gated, warning.noun)} in ${where} ${
        gated === 1 ? "has" : "have"
      } not been trusted here — ${warning.tail}`,
    );

    return { ran: [], untrusted };
  }

  const commandEnv = commandEnvFor(repo, target, env);

  const ran: string[] = [];
  let failed: SetupFailure | undefined;

  for (const command of commands) {
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

  return { ran, failed, untrusted };
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
  const { commands } = plan.teardown;

  const { ran, failed, untrusted } = await runCommandSection(
    repo,
    target,
    plan,
    plan.teardown,
    {
      noun: "teardown command",
      tail: "the worktree still goes, but nothing was run in it",
    },
    reporter,
  );

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
