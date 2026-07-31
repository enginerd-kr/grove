import { cp, mkdir, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Reporter } from "../report/reporter.ts";
import { defaultBranch } from "./branches.ts";
import { GardenError } from "./errors.ts";
import { entryExists } from "./fs.ts";
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
 * What to copy, link, and run is read from `.garden.toml` in the worktree —
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
  /** Already in this worktree, so left exactly as they were. */
  readonly kept: readonly string[];
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
 * The same rule `--dir` follows and for a sharper reason: these paths are
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
    throw new GardenError("usage", `${key}: ${JSON.stringify(value)} is not a usable path`, {
      hint: "a relative path inside the worktree, such as `.env` or `config/local.json`",
    });
  }

  return segments.join("/");
}

/**
 * Reads the repository's `.garden.toml`, with its paths checked.
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

  return (await isTrusted(repo.bare, plan.fingerprint)) ? [] : plan.commands;
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
  if (plan.fingerprint !== undefined) await trust(repo.bare, plan.fingerprint);

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
    trunk = await defaultBranch(repo.bare);
  } catch {
    // A repository whose remote advertises no HEAD. Everything else here still
    // works, and failing the `add` this is running inside of would be a poor
    // trade for a `.env` we could not find a source for anyway.
    return { kind: "none" };
  }

  const worktrees = await listWorktrees(repo.bare);
  const record = worktrees.find((entry) => entry.branch === trunk);

  if (!record) return { kind: "none", trunk };
  if (record.path === target.path) return { kind: "self" };

  return { kind: "at", path: record.path };
}

/** In words, for the line a command prints when it is done. */
export function describeSetup(result: SetupResult): string {
  const parts: string[] = [];

  if (result.copied.length > 0) parts.push(`${result.copied.length} copied`);
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
 */
export function failureFor(result: SetupResult): GardenError | undefined {
  if (!result.failed) return undefined;

  return new GardenError(
    "setup-failed",
    `${JSON.stringify(result.failed.command)} exited ${result.failed.code}`,
    {
      details: result.failed.details,
      hint: `fix it and run \`garden setup ${result.dir}\` again`,
    },
  );
}

/**
 * Whether git would report these paths as changes.
 *
 * Worth a line of its own because of what else is in this tool: a copied `.env`
 * that nothing ignores makes a brand new worktree open dirty, and `x` in the
 * app — `garden reset --clean` — deletes exactly the untracked files this just
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
 * One path, taken — or left exactly as it was.
 *
 * A path already in the worktree is never overwritten and there is no flag that
 * would: it is what the branch checked out, and replacing it with another
 * branch's copy is how a colleague's experimental `.env` becomes the one your
 * tests run against. Refreshing one is a `cp`, and typing that is a smaller
 * thing than a flag nobody would be sure of.
 */
async function takeOne(
  kind: "copy" | "link",
  path: string,
  source: string,
  destination: string,
): Promise<FileOutcome> {
  const from = join(source, path);
  const to = join(destination, path);

  if (!(await entryExists(from))) return "missing";
  if (await entryExists(to)) return "kept";

  await mkdir(dirname(to), { recursive: true });

  if (kind === "copy") {
    await cp(from, to, { recursive: true });

    return "copied";
  }

  // Relative, for the same reason `.git` holds `gitdir: ./.bare`: the repository
  // folder is one thing somebody may well move, and an absolute link would
  // survive that as a link into the place it used to be.
  await symlink(relative(dirname(to), from), to);

  return "linked";
}

/**
 * Fills in a worktree, and runs what was configured to run in it.
 *
 * Never throws for a command that failed — that is in the result, because the
 * files it copied first are worth reporting either way and because the two
 * callers want different things from it. `add` warns: it was asked for a
 * worktree and there is one. `garden setup` raises: it was asked for this.
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
          const outcome = await takeOne(kind, path, source.path, target.path);
          buckets[outcome].push(path);
        }
      } catch (error) {
        step.fail(`could not fill in ${dir}`);
        throw new GardenError("setup-failed", `could not set up ${dir}`, {
          details: [error instanceof Error ? error.message : String(error)],
          cause: error,
        });
      }

      const took = [...copied, ...linked];
      step.succeed(took.length === 0 ? `nothing to take for ${dir}` : `took ${took.join(", ")}`);

      if (missing.length > 0) {
        reporter.info(`not in ${worktreeDir(repo.root, source.path)}: ${missing.join(", ")}`);
      }
      if (kept.length > 0) {
        reporter.info(`already in ${dir}, left alone: ${kept.join(", ")}`);
      }

      const exposed = await unignored(target.path, took);
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
   * commands do not, until `garden trust` records these exact contents — and
   * they stop again the moment a pull changes them.
   */
  const untrusted =
    plan.commands.length > 0 &&
    plan.fingerprint !== undefined &&
    !(await isTrusted(repo.bare, plan.fingerprint));

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

  for (const command of untrusted ? [] : plan.commands) {
    const step = reporter.step(`running ${command}`);
    const result = await runShell(command, {
      cwd: target.path,
      env: {
        GARDEN_ROOT: repo.root,
        GARDEN_WORKTREE: target.path,
        GARDEN_BRANCH: target.branch ?? "",
      },
    });

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

  return { path: target.path, dir, planned, copied, linked, ran, missing, kept, failed, untrusted };
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
