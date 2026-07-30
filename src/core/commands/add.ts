import { basename, join } from "node:path";
import type { Reporter } from "../../report/reporter.ts";
import { defaultBranch, localBranchExists, remoteBranchExists } from "../branches.ts";
import { WtError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { runGit, runGitOrThrow } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { worktreeDirName } from "../layout.ts";
import { listWorktrees, type WorktreeRecord } from "../worktrees.ts";

/** `wt add` — give a branch a worktree, creating the branch if it does not exist. */

export type AddOptions = {
  readonly branch: string;
  /** Base for a branch that does not exist yet. Defaults to the remote's default. */
  readonly from?: string;
  readonly dir?: string;
  /** Fetch before deciding the branch is missing. On by default. */
  readonly fetch: boolean;
  readonly push: boolean;
};

export type AddResult = {
  readonly path: string;
  readonly branch: string;
  /** How the branch was obtained, which is the part worth reporting back. */
  readonly source: "existing" | "remote" | "new";
  readonly upstream?: string;
  /** True when the worktree was already there and nothing was done. */
  readonly alreadyPresent: boolean;
};

const REMOTE = "origin";

export async function addWorktree(
  repo: RepoPaths,
  options: AddOptions,
  reporter: Reporter,
): Promise<AddResult> {
  const path = join(repo.root, worktreeDirName(options.branch, options.dir));
  const worktrees = await listWorktrees(repo.bare);

  const existing = await checkAlreadyThere(options.branch, path, worktrees);
  if (existing) return existing;

  refuseNameCollision(path, worktrees);

  if (await pathExists(path)) {
    throw new WtError("state-conflict", `${path} already exists`, {
      hint: "pass --dir <name> to use a different directory",
    });
  }

  const source = await resolveSource(repo.bare, options, reporter);

  const step = reporter.step(`adding ${options.branch}`);
  try {
    await runGitOrThrow(argsFor(source, options, path), { cwd: repo.bare });
    step.succeed(`added ${basename(path)}`);
  } catch (error) {
    step.fail(`could not add ${options.branch}`);
    throw error;
  }

  if (options.push) await pushBranch(path, options.branch, reporter);

  return {
    path,
    branch: options.branch,
    source: source.kind,
    upstream: source.kind === "new" && !options.push ? undefined : `${REMOTE}/${options.branch}`,
    alreadyPresent: false,
  };
}

/**
 * Asking for a worktree that is already there is not an error.
 *
 * Someone re-running `wt add feat/login` wants to end up with that worktree, and
 * they have. Reporting success keeps the command idempotent, which is what makes
 * it safe to put in a script.
 */
async function checkAlreadyThere(
  branch: string,
  path: string,
  worktrees: readonly WorktreeRecord[],
): Promise<AddResult | undefined> {
  const holder = worktrees.find((record) => record.branch === branch);
  if (!holder) return undefined;

  if (holder.path === path) {
    return { path, branch, source: "existing", alreadyPresent: true };
  }

  // Same branch, different directory. git would refuse this anyway, but its
  // message does not say which of your directories is the one holding it.
  throw new WtError(
    "state-conflict",
    `${JSON.stringify(branch)} is already checked out at ${holder.path}`,
    { hint: `use that worktree, or remove it first: wt rm ${basename(holder.path)}` },
  );
}

/**
 * Refuses a directory name that differs from an existing one only by case.
 *
 * macOS and Windows filesystems fold case, so `Feat-Login` and `feat-login`
 * would be the same directory there and a different one on Linux. Refusing is
 * better than a repository that only works on the machine it was made on.
 */
function refuseNameCollision(path: string, worktrees: readonly WorktreeRecord[]): void {
  const wanted = basename(path).toLowerCase();
  const clash = worktrees.find(
    (record) => record.path !== path && basename(record.path).toLowerCase() === wanted,
  );

  if (clash) {
    throw new WtError("state-conflict", `${basename(clash.path)} already exists here`, {
      hint: "directory names that differ only by case collide on macOS and Windows; pass --dir",
    });
  }
}

type Source =
  | { readonly kind: "existing" }
  | { readonly kind: "remote" }
  | { readonly kind: "new"; readonly base: string };

/**
 * Decides where the branch comes from: already local, on the remote, or new.
 *
 * The fetch sits between "not on the remote yet" and "not on the remote as far
 * as we last looked", which are very different answers — the second creates a
 * branch that then collides on push.
 */
async function resolveSource(
  bare: string,
  options: AddOptions,
  reporter: Reporter,
): Promise<Source> {
  if (await localBranchExists(bare, options.branch)) return { kind: "existing" };
  if (await remoteBranchExists(bare, options.branch)) return { kind: "remote" };

  if (options.fetch) {
    const step = reporter.step("fetching");
    await runGitOrThrow(["fetch", REMOTE, "--prune"], { cwd: bare });
    step.succeed("fetched");

    if (await remoteBranchExists(bare, options.branch)) return { kind: "remote" };
  }

  const base = options.from ?? `${REMOTE}/${await defaultBranch(bare)}`;
  const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
    cwd: bare,
  });

  if (resolved.code !== 0) {
    throw new WtError("usage", `cannot start a branch from ${JSON.stringify(base)}`, {
      hint: options.from ? "--from takes a branch, tag, or commit that exists" : undefined,
    });
  }

  return { kind: "new", base };
}

function argsFor(source: Source, options: AddOptions, path: string): readonly string[] {
  switch (source.kind) {
    case "existing":
      return ["worktree", "add", path, options.branch];
    // `--track -b` in one step is reachable only when no local ref exists for
    // this branch — the check above proved that — so there is nothing to collide
    // with and the upstream is set correctly from the start.
    case "remote":
      return [
        "worktree",
        "add",
        "--track",
        "-b",
        options.branch,
        path,
        `${REMOTE}/${options.branch}`,
      ];
    case "new":
      return ["worktree", "add", "-b", options.branch, path, source.base];
  }
}

async function pushBranch(path: string, branch: string, reporter: Reporter): Promise<void> {
  const step = reporter.step(`pushing ${branch}`);
  try {
    await runGitOrThrow(["push", "-u", REMOTE, "HEAD"], { cwd: path });
    step.succeed(`pushed ${branch}`);
  } catch (error) {
    // The worktree exists and is usable; only the push failed. Say so rather
    // than letting the error imply nothing happened.
    step.fail(`created the worktree, but pushing ${branch} failed`);
    throw error;
  }
}
