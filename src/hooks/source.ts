import { defaultBranch } from "../core/branches.ts";
import { runGit, runGitOrThrow } from "../core/git.ts";
import type { RepoPaths } from "../core/layout.ts";
import { listWorktrees } from "../core/worktrees.ts";
import { globalHooks, type Hooks, type HooksOptions, readHooks } from "./config.ts";

/**
 * Which worktree a repository's configuration is read out of.
 *
 * `config.ts` is about what the files say; this is about which checkout gets
 * to say it. The two questions come apart on purpose: parsing a file needs no
 * repository at all, and deciding that the trunk's copy governs needs git and
 * nothing about TOML.
 */

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
export type Source =
  | { readonly kind: "at"; readonly path: string }
  | { readonly kind: "self" }
  | { readonly kind: "none"; readonly trunk?: string };

/** The default branch's worktree, which is what everything here reads from. */
async function trunkWorktree(repo: RepoPaths): Promise<string | undefined> {
  const source = await sourceWorktree(repo, "");

  return source.kind === "at" ? source.path : undefined;
}

/**
 * The recipe selected for this branch, defaulting to the trunk's configuration.
 *
 * The fallback is for the one repository that has no trunk worktree — somebody
 * removed it — where reading nothing at all would be a worse answer than
 * reading what is in front of us.
 */
export async function repoHooks(
  repo: RepoPaths,
  fallback?: string,
  options: HooksOptions = {},
): Promise<Hooks> {
  if (fallback !== undefined) {
    const branch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: fallback });
    if (branch.code === 0) {
      const source = await runGit(
        ["config", "--get", `branch.${branch.stdout.trim()}.grovehooksource`],
        { cwd: repo.gitDir },
      );
      if (source.stdout.trim() === "worktree") return readHooks(fallback, options);
    }
  }
  const trunk = (await trunkWorktree(repo)) ?? fallback;
  // No worktree to read a project's file out of still leaves the machine's own,
  // which is about you and not about this repository — so it applies to the
  // repository that has lost its trunk exactly as it does to every other one.
  if (trunk === undefined) return globalHooks(options);

  return readHooks(trunk, options);
}

export async function sourceWorktree(
  repo: RepoPaths,
  /** The worktree being filled, so the trunk can recognise itself in it. */
  worktree: string,
): Promise<Source> {
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
  if (record.path === worktree) return { kind: "self" };

  return { kind: "at", path: record.path };
}

export type ConfigSource = "trunk" | "worktree";

export async function setConfigSource(
  repo: RepoPaths,
  branch: string,
  source: ConfigSource,
): Promise<void> {
  await runGitOrThrow(["config", "--replace-all", `branch.${branch}.grovehooksource`, source], {
    cwd: repo.gitDir,
  });
}
