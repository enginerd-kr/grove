import { runGit } from "./git.ts";

/**
 * Which branch a branch was cut from, when it was cut from another one.
 *
 * Everything else in this tool measures a branch against the trunk, and for
 * most branches that is the whole truth: `feat/login` came off `main`, it goes
 * back onto `main`, and `sync` rebases it there. A stack is the case where that
 * is false. `feat/login-api` sits on `feat/login` because the API is what the
 * screen calls, the two are reviewed as two pull requests, and rebasing the
 * second onto the trunk would replay it over the absence of the first — a
 * conflict against work that is sitting in the next directory along.
 *
 * git has nowhere to record that. `branch.<name>.merge` is the remote the
 * branch tracks, which is a different question and one the second branch
 * answers `origin/feat/login-api` to; the base it was cut from is not written
 * down anywhere once the cut is made. So this writes it down, in the bare
 * repository's own config, beside the upstream that git keeps there:
 *
 * ```
 * [branch "feat/login-api"]
 *   groveparent = feat/login
 * ```
 *
 * In `branch.<name>` and not a section of grove's own, because that is where
 * the rest of what is known about a branch lives — `git config --remove-section
 * branch.feat/login-api` takes this with it, and so does `git branch -m`, which
 * moves the whole section. A key git does not know is ignored by git, which is
 * what makes the section safe to write into.
 *
 * The parent is a **local branch name**, never a remote-tracking ref. A stack
 * is rebased bottom-up in one pass — see `sync` — so by the time a child is
 * moved its parent is already where it is going to be, and that position is
 * local. `origin/feat/login` would be the parent as the remote last saw it,
 * which is the position the child was just rebased off.
 */

/** The variable name, under `branch.<name>`. git lowercases it, so it is written lowercased. */
const KEY = "groveparent";

/** Every recorded parent: the branch, and the branch it was cut from. */
export type Stack = ReadonlyMap<string, string>;

export const NO_STACK: Stack = new Map();

function keyFor(branch: string): string {
  return `branch.${branch}.${KEY}`;
}

/**
 * Every parent the repository has recorded, in one call.
 *
 * One `--get-regexp` rather than a lookup per branch, for the same reason
 * `driftFrom` reads the whole ref set at once: this is read by `list`, which
 * redraws on a timer, and a config process per worktree is a cost that grows
 * with the repository.
 *
 * A key is `branch.<name>.groveparent`, and `<name>` may contain dots —
 * `feat/v1.2` is an ordinary branch. That is not a problem to solve here: the
 * prefix and the suffix are both fixed, so the name is what is between them,
 * however many dots it has.
 *
 * Exit 1 is "nothing matched", which is every repository that has never stacked
 * anything, so it answers with an empty map rather than failing. A branch
 * recorded as its own parent is dropped on sight — the config is a text file
 * somebody can edit, and a self-parent would be a loop that every walk below
 * would have to keep re-discovering.
 */
export async function readStack(bare: string): Promise<Stack> {
  const result = await runGit(["config", "--get-regexp", `^branch\\..*\\.${KEY}$`], { cwd: bare });

  const stack = new Map<string, string>();
  if (result.code !== 0) return stack;

  for (const line of result.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue;

    const key = line.slice(0, space);
    const parent = line.slice(space + 1).trim();
    const branch = key.slice("branch.".length, key.length - KEY.length - 1);

    if (branch.length === 0 || parent.length === 0 || branch === parent) continue;
    stack.set(branch, parent);
  }

  return stack;
}

export async function setParent(bare: string, branch: string, parent: string): Promise<void> {
  await runGit(["config", keyFor(branch), parent], { cwd: bare });
}

/**
 * Forgets one branch's parent.
 *
 * Answers rather than throws, and exit 5 — "the key was not there" — is the
 * ordinary case: every caller here clears records it is not certain exist, and
 * a branch that never had a parent is exactly the state this was asked to
 * produce.
 */
export async function clearParent(bare: string, branch: string): Promise<void> {
  await runGit(["config", "--unset", keyFor(branch)], { cwd: bare });
}

/**
 * The parents of `branch`, nearest first, stopping before it comes back around.
 *
 * The `seen` set is not defensive programming about a bug in this file: the
 * records are in a config file, and two commands that each wrote a sensible
 * parent can leave a loop between them — `a` on `b` written in one repository,
 * `b` on `a` after a rename in another. `addParent` refuses to make one, and
 * every walk here survives one that arrived some other way.
 */
export function ancestry(stack: Stack, branch: string): readonly string[] {
  const chain: string[] = [];
  const seen = new Set([branch]);

  let current = stack.get(branch);
  while (current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = stack.get(current);
  }

  return chain;
}

/** The branches recorded as sitting directly on `branch`. */
export function childrenOf(stack: Stack, branch: string): readonly string[] {
  return [...stack]
    .filter(([, parent]) => parent === branch)
    .map(([child]) => child)
    .sort();
}

/**
 * Whether recording `parent` for `branch` would close a loop.
 *
 * Asked before writing rather than worked around afterwards: a cycle is a
 * repository state no later command can do anything sensible with, and the
 * moment it can be refused is the moment somebody typed the flag that would
 * create it.
 */
export function wouldCycle(stack: Stack, branch: string, parent: string): boolean {
  return parent === branch || ancestry(stack, parent).includes(branch);
}

/**
 * The same items, ordered so a parent always comes before its children.
 *
 * By depth in the recorded stack, which is a total order and needs no graph
 * walk: a parent's chain is a suffix of its child's, so its depth is always
 * smaller, and two branches at the same depth have nothing to say about each
 * other. `toSorted` is stable, so everything that was not stacked comes back in
 * the order it arrived in — which for `sync` is git's own worktree order, and
 * for a repository with no stacks at all means this changes nothing.
 *
 * Depth is measured against the whole recorded stack and not against the items
 * being ordered. A child whose parent has no worktree is still a child, and
 * putting it after the branches at depth zero is still right.
 */
export function stackOrder<T>(
  items: readonly T[],
  stack: Stack,
  branchOf: (item: T) => string | undefined,
): readonly T[] {
  if (stack.size === 0) return items;

  const depth = (item: T): number => {
    const branch = branchOf(item);

    return branch === undefined ? 0 : ancestry(stack, branch).length;
  };

  return items.toSorted((a, b) => depth(a) - depth(b));
}

/**
 * Takes a branch out of the stack, and hands its children to its own parent.
 *
 * The alternative is leaving the records pointing at a branch that is gone,
 * which reads as a stack right up until `sync` tries to rebase onto it. Handing
 * the children up rather than clearing them keeps what the stack was for: three
 * branches in a row, the bottom one merged and cleared away, and the remaining
 * two are still a stack of two — now sitting on whatever the first one sat on.
 *
 * Called where a branch actually stops existing — `remove --delete-branch`,
 * `prune --delete-branch` — and not where a worktree goes. A branch without a
 * worktree is still a branch, and still a base its children can be rebased on.
 *
 * Called **before** the deletion, too: `git branch -d` takes the whole
 * `branch.<name>` section with it, this record included, so a call afterwards
 * would find no parent to hand the children and would clear them instead of
 * moving them up.
 *
 * Answers with the children it moved, so the command that called it can say so.
 */
export async function forgetBranch(
  bare: string,
  branch: string,
): Promise<readonly { readonly child: string; readonly parent?: string }[]> {
  const stack = await readStack(bare);
  const grandparent = stack.get(branch);
  const children = childrenOf(stack, branch);

  for (const child of children) {
    if (grandparent === undefined) await clearParent(bare, child);
    else await setParent(bare, child, grandparent);
  }

  if (stack.has(branch)) await clearParent(bare, branch);

  return children.map((child) => ({ child, parent: grandparent }));
}

/**
 * Follows a rename through the records: the branch's own, and its children's.
 *
 * `git branch -m` moves the whole `branch.<name>` section, so the parent this
 * branch had travels with it and is not this function's problem. What git
 * cannot know is that the *other* sections name it: every child holds the old
 * spelling, and after a rename that spelling is a branch the repository does
 * not have.
 */
export async function renameInStack(bare: string, from: string, to: string): Promise<void> {
  const stack = await readStack(bare);

  for (const child of childrenOf(stack, from)) {
    await setParent(bare, child, to);
  }
}
