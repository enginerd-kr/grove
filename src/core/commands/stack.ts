import { defaultBranch, localBranches } from "../branches.ts";
import { GroveError } from "../errors.ts";
import { runGit } from "../git.ts";
import { contains, type RepoPaths } from "../layout.ts";
import { ancestry, childrenOf, readStack, type Stack } from "../stack.ts";
import { listWorktrees, resolveTarget, type WorktreeRecord, worktreeDir } from "../worktrees.ts";

/**
 * `grove stack` — the branches stacked on one another, drawn as the tree
 * they are.
 *
 * `add --on` writes down that a branch sits on another, `sync` rebases through
 * that record and `propose` opens the pull request onto it, and until now the
 * only way to see the record was one row at a time: `on feat/login` in the
 * state column, or the screen indenting a child under its parent when the two
 * share a folder. A stack is the one shape in this tool that is not a list,
 * and the question it raises — what is above this, what is below it, and is
 * any of it out of date — is answered by drawing it whole.
 *
 * The trunk is the top of every picture. A branch with no record sits on the
 * trunk in every way that matters here — it is measured against it, cut from
 * it, and rebased onto it — so it is drawn there, and a stack whose bottom was
 * recorded on an ordinary branch hangs from that branch, which hangs from the
 * trunk. Every edge carries how far the child has drifted from its parent,
 * which is the number `sync` would close.
 *
 * Reads git and nothing else. Whether a branch has a pull request is the
 * forge's word, and the screen's `pr` column is where that is drawn.
 */

export type StackOptions = {
  /** Which worktree's stack. Omitted means the one you are standing in. */
  readonly target?: string;
  /** `--all`: every stack in the repository, whatever you are standing in. */
  readonly all: boolean;
};

export type StackRow = {
  readonly branch: string;
  /** The branch it sits on. Absent on the trunk's own row, which sits on nothing. */
  readonly parent?: string;
  /** How far under the trunk: the trunk is 0, a branch on it is 1. */
  readonly depth: number;
  /** The worktree's directory under the root, when the branch has one. */
  readonly dir?: string;
  readonly path?: string;
  /** Commits here the parent lacks. Absent where either side is gone. */
  readonly ahead?: number;
  /** Commits on the parent this branch lacks — what `sync` would rebase over. */
  readonly behind?: number;
  /** False for a branch the records name and the repository no longer has. */
  readonly exists: boolean;
  /** True for the worktree the command was run from. */
  readonly current: boolean;
};

export type StackResult = {
  readonly trunk: string;
  /** Top to bottom, parents before children — the order the picture is drawn in. */
  readonly rows: readonly StackRow[];
};

/**
 * The worktree named, or the one being stood in — `propose`'s rule, and its
 * refusal for the empty case, with `--all` named as the way out.
 */
function chooseTarget(
  worktrees: readonly WorktreeRecord[],
  root: string,
  cwd: string,
  target: string | undefined,
): WorktreeRecord {
  const chosen =
    target === undefined
      ? worktrees.find((record) => contains(record.path, cwd))
      : resolveTarget(target, worktrees, { root, cwd });

  if (!chosen) {
    throw new GroveError("usage", "not inside a worktree, so there is no stack to show", {
      hint: "name one — grove stack <branch> — or grove stack --all for every stack",
    });
  }

  return chosen;
}

/**
 * The branch at the top of `branch`'s stack: the last recorded parent, or the
 * branch itself when nothing was recorded.
 *
 * The trunk is never it. Nothing records a parent of the trunk — `add --on`
 * refuses to — but a record can name it as one, and a stack whose top is the
 * trunk is every stack in the repository, which is `--all`'s answer and not
 * this one's.
 */
function topOf(stack: Stack, branch: string, trunk: string): string {
  const chain = ancestry(stack, branch).filter((parent) => parent !== trunk);

  return chain[chain.length - 1] ?? branch;
}

/**
 * How far `branch` has moved away from `parent`, both ways, in one call.
 *
 * `rev-list --left-right --count` over `parent...branch`: what is only on the
 * left is what the branch has not got, and what is only on the right is what
 * it adds. Local refs on both sides — the parent a stack is rebased onto is
 * the local branch, see `core/stack.ts` — and the trunk's local branch too,
 * since that is the one the worktree next door is on.
 */
async function driftBetween(
  bare: string,
  parent: string,
  branch: string,
): Promise<{ readonly ahead: number; readonly behind: number } | undefined> {
  const result = await runGit(["rev-list", "--left-right", "--count", `${parent}...${branch}`], {
    cwd: bare,
  });
  if (result.code !== 0) return undefined;

  const match = /^(\d+)\s+(\d+)/.exec(result.stdout.trim());
  if (!match) return undefined;

  return { behind: Number(match[1]), ahead: Number(match[2]) };
}

export async function stackOf(
  repo: RepoPaths,
  cwd: string,
  options: StackOptions,
): Promise<StackResult> {
  const [worktrees, trunk, stack, branches] = await Promise.all([
    listWorktrees(repo.gitDir),
    defaultBranch(repo.gitDir),
    readStack(repo.gitDir),
    localBranches(repo.gitDir),
  ]);
  const exists = new Set(branches);
  const byBranch = new Map(
    worktrees
      .filter((record) => record.branch !== undefined)
      .map((record) => [record.branch, record] as const),
  );

  /**
   * The branches directly under `branch` in the picture.
   *
   * Under the trunk: every top — a recorded parent that has no parent of its
   * own, which is where each stack starts, plus the target itself when it is
   * stacked on nothing. Under anything else: what the records say.
   */
  let tops: readonly string[];
  if (options.all) {
    const named = new Set([...stack.keys(), ...stack.values()]);
    tops = [...named].filter((branch) => branch !== trunk && !stack.has(branch)).toSorted();
  } else {
    const record = chooseTarget(worktrees, repo.root, cwd, options.target);
    if (record.branch === undefined) {
      throw new GroveError(
        "refused",
        `${worktreeDir(repo.root, record.path)} is on a detached HEAD, so it is in no stack`,
        { hint: "check a branch out there first" },
      );
    }

    tops = record.branch === trunk ? [] : [topOf(stack, record.branch, trunk)];
  }

  const rows: StackRow[] = [
    {
      branch: trunk,
      depth: 0,
      dir: dirOf(byBranch.get(trunk)),
      path: byBranch.get(trunk)?.path,
      exists: exists.has(trunk),
      current: isCurrent(byBranch.get(trunk), cwd),
    },
  ];

  // Walked with the loop guard `ancestry` keeps, for the reason it keeps it:
  // the records are a config file, and a loop that arrived in one is drawn
  // once rather than forever.
  const seen = new Set<string>([trunk]);
  const walk = async (branch: string, parent: string, depth: number): Promise<void> => {
    if (seen.has(branch)) return;
    seen.add(branch);

    const record = byBranch.get(branch);
    const here = exists.has(branch);
    const drift =
      here && exists.has(parent) ? await driftBetween(repo.gitDir, parent, branch) : undefined;

    rows.push({
      branch,
      parent,
      depth,
      dir: dirOf(record),
      path: record?.path,
      ahead: drift?.ahead,
      behind: drift?.behind,
      exists: here,
      current: isCurrent(record, cwd),
    });

    for (const child of childrenOf(stack, branch)) await walk(child, branch, depth + 1);
  };

  for (const top of tops) await walk(top, trunk, 1);

  return { trunk, rows };

  function dirOf(record: WorktreeRecord | undefined): string | undefined {
    return record === undefined ? undefined : worktreeDir(repo.root, record.path);
  }
}

function isCurrent(record: WorktreeRecord | undefined, cwd: string): boolean {
  return record !== undefined && contains(record.path, cwd);
}

/**
 * The picture, as text.
 *
 * ```
 * main
 * ├─ feat/login *       feat/login      ↑2 ↓0
 * │  └─ feat/login-api  feat/login-api  ↑1 ↓1
 * └─ fix/crash          no worktree     ↑1 ↓0
 * ```
 *
 * The guides are `tree`'s, because that is the shape everybody already reads.
 * `*` marks where you are, the way `list` marks it. The drift is against the
 * row's parent — the branch above it in the picture — which is the number
 * `sync` would close, and not the one against the trunk that `list` shows.
 * A branch the records name and the repository has lost reads `gone`; one
 * without a worktree reads so, since `grove add <branch>` is what gives it one.
 */
export function formatStack({ rows }: StackResult): string {
  const guides = guidesFor(rows);
  const lines = rows.map((row, index) => ({
    head: `${guides[index] ?? ""}${row.branch}${row.current ? " *" : ""}`,
    place: row.depth === 0 ? "" : row.exists ? (row.dir ?? "no worktree") : "gone",
    drift:
      row.ahead === undefined || row.behind === undefined ? "" : `↑${row.ahead} ↓${row.behind}`,
  }));

  const headWidth = Math.max(0, ...lines.map((line) => line.head.length));
  const placeWidth = Math.max(0, ...lines.map((line) => line.place.length));

  return lines
    .map((line) =>
      `${line.head.padEnd(headWidth)}  ${line.place.padEnd(placeWidth)}  ${line.drift}`.trimEnd(),
    )
    .join("\n");
}

/**
 * The guide in front of every row: a `│` for each ancestor with a sibling
 * still to come under it, and `├─` or `└─` for the row itself.
 *
 * Read off the flat rows rather than carried on them, so the rows stay what
 * `--json` prints — the guides are drawing, and a script reading `depth` and
 * `parent` has no use for them. Shared with the screen's panel, so the two
 * pictures are one picture. A row is the last under its parent when no later
 * row shares its depth before one shallower than it.
 */
export function guidesFor(rows: readonly StackRow[]): readonly string[] {
  return rows.map((_, index) => guideFor(rows, index));
}

function guideFor(rows: readonly StackRow[], index: number): string {
  const row = rows[index];
  if (row === undefined || row.depth === 0) return "";

  const lastAt = (at: number): boolean => {
    const depth = rows[at]?.depth ?? 0;
    for (let next = at + 1; next < rows.length; next += 1) {
      const other = rows[next]?.depth ?? 0;
      if (other < depth) return true;
      if (other === depth) return false;
    }

    return true;
  };

  // Each ancestor is the nearest earlier row one level shallower, walking up.
  const ancestors: number[] = [];
  let depth = row.depth - 1;
  for (let at = index - 1; at >= 0 && depth >= 1; at -= 1) {
    if ((rows[at]?.depth ?? 0) === depth) {
      ancestors.unshift(at);
      depth -= 1;
    }
  }

  const trunkGuides = ancestors.map((at) => (lastAt(at) ? "   " : "│  ")).join("");

  return `${trunkGuides}${lastAt(index) ? "└─ " : "├─ "}`;
}
