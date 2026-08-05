import { join } from "node:path";
import { GroveError } from "./errors.ts";
import { gitSucceeds, runGit, runGitOrThrow } from "./git.ts";
import { BARE_DIR } from "./layout.ts";

/**
 * `.grove.toml` — how a repository says what its worktrees need.
 *
 * It is a tracked file in the worktree, and that is the point. "This project
 * copies `.env` and runs `bun install`" is a property of the project and not of
 * the laptop it is checked out on, so putting it anywhere machine-local means
 * every person on the team works it out again by hand. It travels, it is
 * reviewed in a pull request like anything else, and a new clone is set up
 * correctly before anybody has been told how.
 *
 * ```toml
 * [setup]
 * copy = [".env", "local.properties"]
 * link = ["node_modules"]
 * run  = ["bun install"]
 * ```
 *
 * The cost of travelling is `run`: a `git pull` can now hand you a command that
 * executes on your machine. So `copy` and `link` apply on sight — they move
 * files that are already on your disk, inside a directory you asked to be
 * created — and `run` does not, until `grove trust` says so. See `trust.ts`.
 *
 * TOML because Bun parses it with no dependency, and because a file people are
 * expected to read and review deserves comments. It is read out of the worktree
 * being set up rather than out of the trunk: the file arrives with the branch,
 * so a branch that adds a build step brings the step with it.
 */

export const SETUP_FILE = ".grove.toml";

export type SetupPlan = {
  readonly copy: readonly string[];
  readonly link: readonly string[];
  /** Command lines, run in the order the file lists them. */
  readonly commands: readonly string[];
  /** Absent when the worktree has no `.grove.toml`. */
  readonly path?: string;
  /** The file's contents, hashed — what `trust` records and compares. */
  readonly fingerprint?: string;
};

export const EMPTY_PLAN: SetupPlan = { copy: [], link: [], commands: [] };

/** How much of the file asked for something. Zero means there is nothing to do. */
export function plannedCount(plan: SetupPlan): number {
  return plan.copy.length + plan.link.length + plan.commands.length;
}

/**
 * One key, which may be written as a list or as the single thing it usually is.
 *
 * `copy = ".env"` is what people write the first time, and refusing it would be
 * pedantry about a shape that has exactly one sensible reading.
 */
function stringsAt(table: Record<string, unknown>, key: string): readonly string[] {
  const value = table[key];
  if (value === undefined) return [];
  if (typeof value === "string") return [value];

  if (!Array.isArray(value) || value.some((each) => typeof each !== "string")) {
    throw new GroveError("usage", `${SETUP_FILE}: setup.${key} must be a list of strings`, {
      hint: `for example: ${key} = [${JSON.stringify(key === "run" ? "bun install" : ".env")}]`,
    });
  }

  return value as readonly string[];
}

const KNOWN = new Set(["copy", "link", "run"]);

/**
 * Parses the file, refusing what it cannot act on.
 *
 * An unknown key is an error rather than something ignored. `cpoy = [".env"]`
 * that quietly does nothing is the exact failure this file exists to prevent —
 * somebody would find out weeks later, from a worktree that would not build.
 */
export function parseSetupFile(text: string): SetupPlan {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new GroveError("usage", `${SETUP_FILE} is not valid TOML`, {
      details: [error instanceof Error ? error.message : String(error)],
      cause: error,
    });
  }

  const root = (parsed ?? {}) as Record<string, unknown>;
  const section = root.setup;
  if (section === undefined) return EMPTY_PLAN;

  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new GroveError("usage", `${SETUP_FILE}: [setup] must be a table`);
  }

  const table = section as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    if (KNOWN.has(key)) continue;

    throw new GroveError(
      "usage",
      `${SETUP_FILE}: [setup] has no key named ${JSON.stringify(key)}`,
      {
        hint: `the keys are ${[...KNOWN].join(", ")}`,
      },
    );
  }

  return {
    copy: stringsAt(table, "copy"),
    link: stringsAt(table, "link"),
    commands: stringsAt(table, "run"),
  };
}

/**
 * Reads the file out of one worktree.
 *
 * A worktree without one is not an error and not a warning: most repositories
 * need none of this, and the ones that do should be the ones that say so.
 */
export async function readSetupFile(worktree: string): Promise<SetupPlan> {
  const path = join(worktree, SETUP_FILE);
  const file = Bun.file(path);
  if (!(await file.exists())) return EMPTY_PLAN;

  const text = await file.text();
  const plan = parseSetupFile(text);

  return { ...plan, path, fingerprint: fingerprintOf(text) };
}

/**
 * What `trust` records: the file's contents, not its name or its date.
 *
 * Contents, so that editing the file withdraws the trust it was given. That is
 * the whole mechanism — a `git pull` that changes the commands changes this,
 * and the commands stop running until somebody has read them again.
 */
export function fingerprintOf(text: string): string {
  return Bun.SHA256.hash(text, "hex");
}

const TRUST_KEY = "grove.trusted";

/**
 * Whether these exact contents have been trusted on this machine.
 *
 * The one thing here that stays in git config, and it has to: a tracked file
 * cannot vouch for itself, so the record of having read it belongs somewhere
 * the repository cannot write to. `.bare/config` is local, per-repository, and
 * never pushed.
 */
export async function isTrusted(bare: string, fingerprint: string): Promise<boolean> {
  const result = await runGit(["config", "--get-all", "--null", TRUST_KEY], { cwd: bare });
  if (result.code !== 0) return false;

  return result.stdout.split("\0").some((value) => value.trim() === fingerprint);
}

/** Records these contents as read and agreed to. Replaces any earlier answer. */
export async function trust(bare: string, fingerprint: string): Promise<void> {
  await runGitOrThrow(["config", "--replace-all", TRUST_KEY, fingerprint], { cwd: bare });
}

/** Forgets every answer, so the next run asks again. */
export async function revokeTrust(bare: string): Promise<boolean> {
  return gitSucceeds(["config", "--unset-all", TRUST_KEY], { cwd: bare });
}

/**
 * The file `--detect` proposes, as text somebody can read before it exists.
 *
 * Directories arrive commented out rather than left out. `link` shares one copy
 * between every worktree, which is right for a dependency cache and wrong for
 * anything a build writes into — so the line is written, and uncommenting it is
 * where the decision goes.
 */
export function renderSetupFile(files: readonly string[], directories: readonly string[]): string {
  const list = (values: readonly string[]) =>
    `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

  const lines = ["[setup]"];

  if (files.length > 0) lines.push(`copy = ${list(files)}`);
  if (directories.length > 0) {
    lines.push("");
    lines.push("# A directory is a decision. `link` shares one copy between every worktree,");
    lines.push("# which suits a dependency cache and not a build output; a `run` command");
    lines.push("# rebuilds it in each instead. Uncomment whichever is true here.");
    lines.push(`# link = ${list(directories)}`);
    lines.push(`# run = ["bun install"]`);
  }

  return `${lines.join("\n")}\n`;
}

/** Where the file goes, and the `.bare` guard nothing else would catch. */
export function setupFilePath(worktree: string): string {
  if (worktree.endsWith(BARE_DIR)) {
    throw new GroveError("usage", `${SETUP_FILE} belongs in a worktree, not in ${BARE_DIR}`);
  }

  return join(worktree, SETUP_FILE);
}
