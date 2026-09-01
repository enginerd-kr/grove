import { join } from "node:path";
import type { WorktreeSummary } from "../../core/commands/list.ts";

/**
 * Paths as the tree they already are on disk — the worktree list, and the
 * changed files beside it.
 *
 * `grove` nests worktrees to match the branch — `feat/login` lives in `feat/login`
 * — so a flat list repeats the prefix on every row and hides the grouping the
 * slashes were there to express. This turns the paths back into the shape the
 * directory has, which is also the shape the eye is looking for with thirty
 * branches: `feat/`, `fix/`, `chore/`.
 *
 * The panel to the right of that list has the same problem one level down: a
 * column of `src/ui/app/App.tsx` repeats the prefix on every row of a change
 * that touched one directory. `buildFileTree` at the bottom of this file is the
 * same fold, over one worktree's changed paths, and it sorts by the same rule —
 * two trees on one screen that ordered themselves differently would be two
 * conventions to learn for one idea.
 *
 * Pure, and separate from the screen, because the ordering rules below are the
 * part worth testing and none of them need a terminal.
 */

export type TreeRow =
  | {
      readonly kind: "group";
      /** Stable across renders; React keys, and what "is this one folded?" is keyed on. */
      readonly key: string;
      /** The directory segment, with its trailing slash: `feat/`. */
      readonly label: string;
      readonly depth: number;
      /** True when its contents are folded away and no rows follow it here. */
      readonly collapsed: boolean;
      /**
       * Every worktree beneath it, at any depth — carried on the row rather than
       * read back off the rows that follow it.
       *
       * A folded folder has no rows following it, and `r` there still has to
       * remove the same worktrees it would have removed unfolded. Reading the
       * emitted rows would quietly make folding change what a key does.
       */
      readonly leaves: readonly WorktreeSummary[];
    }
  | {
      readonly kind: "leaf";
      readonly key: string;
      /** The last segment only — the prefix is on the group row above. */
      readonly label: string;
      readonly depth: number;
      readonly summary: WorktreeSummary;
    };

type Node = {
  readonly leaves: { readonly label: string; readonly summary: WorktreeSummary }[];
  readonly groups: Map<string, Node>;
};

function emptyNode(): Node {
  return { leaves: [], groups: new Map() };
}

function insert(root: Node, summary: WorktreeSummary): void {
  const segments = summary.dir.split("/").filter((segment) => segment.length > 0);
  const label = segments.pop();

  // A worktree with no path under the repo root has nowhere to sit in a tree;
  // it cannot happen through `add`, and dropping it would hide it entirely.
  if (label === undefined) {
    root.leaves.push({ label: summary.dir, summary });

    return;
  }

  let node = root;
  for (const segment of segments) {
    let next = node.groups.get(segment);
    if (next === undefined) {
      next = emptyNode();
      node.groups.set(segment, next);
    }
    node = next;
  }

  node.leaves.push({ label, summary });
}

/**
 * Worktrees before folders at every level, and the default branch before its
 * siblings.
 *
 * Reading order, not alphabetical order: `main` is the row people look for, and
 * a folder is a heading — headings after the plain rows keeps the top of each
 * level scannable rather than making you step over `chore/` to reach it.
 */
/** Every worktree beneath a node, at any depth, in no particular order. */
function allLeaves(node: Node): readonly WorktreeSummary[] {
  return [
    ...node.leaves.map((leaf) => leaf.summary),
    ...[...node.groups.values()].flatMap(allLeaves),
  ];
}

function emit(
  node: Node,
  depth: number,
  path: string,
  collapsed: ReadonlySet<string>,
  into: TreeRow[],
): void {
  const leaves = node.leaves.toSorted((a, b) => {
    if (a.summary.isDefault !== b.summary.isDefault) return a.summary.isDefault ? -1 : 1;

    return a.label.localeCompare(b.label);
  });

  for (const leaf of leaves) {
    into.push({
      kind: "leaf",
      key: leaf.summary.path,
      label: leaf.label,
      depth,
      summary: leaf.summary,
    });
  }

  for (const name of [...node.groups.keys()].toSorted((a, b) => a.localeCompare(b))) {
    const group = node.groups.get(name);
    if (group === undefined) continue;

    const key = `${path}${name}/`;
    const folded = collapsed.has(key);

    into.push({
      kind: "group",
      key,
      label: `${name}/`,
      depth,
      collapsed: folded,
      leaves: allLeaves(group),
    });

    // Folded folders below a folded one are still folded when it opens again:
    // recursion stops here, so nothing under it is emitted and nothing about it
    // is forgotten either.
    if (!folded) emit(group, depth + 1, key, collapsed, into);
  }
}

/** `collapsed` holds the keys of the folders whose contents are folded away. */
export function buildTree(
  summaries: readonly WorktreeSummary[],
  collapsed: ReadonlySet<string> = new Set(),
): readonly TreeRow[] {
  const root = emptyNode();
  for (const summary of summaries) insert(root, summary);

  const rows: TreeRow[] = [];
  emit(root, 0, "", collapsed, rows);

  return rows;
}

export type TreeLeaf = Extract<TreeRow, { kind: "leaf" }>;

/** The worktrees on screen — what the columns are sized against. */
export function leavesOf(rows: readonly TreeRow[]): readonly TreeLeaf[] {
  return rows.filter((row): row is TreeLeaf => row.kind === "leaf");
}

/**
 * The first row nested directly under `row`, when there is one on screen.
 *
 * The mirror of `parentOf`, and read off the emitted rows for the same reason:
 * a folded folder has nothing under it here, and `→` should treat that as the
 * dead end it looks like rather than the one it would find in the tree.
 */
export function firstChildOf(rows: readonly TreeRow[], row: TreeRow): TreeRow | undefined {
  const next = rows[rows.indexOf(row) + 1];

  return next !== undefined && next.depth > row.depth ? next : undefined;
}

/**
 * The folder a row belongs to, or nothing at the top level.
 *
 * The nearest row above it that sits one level out — which is what `←` walks
 * towards, from a worktree or from a folder already folded shut.
 */
export function parentOf(rows: readonly TreeRow[], row: TreeRow): TreeRow | undefined {
  const start = rows.indexOf(row);
  if (start < 0 || row.depth === 0) return undefined;

  for (let i = start - 1; i >= 0; i -= 1) {
    const candidate = rows[i];
    if (candidate !== undefined && candidate.depth < row.depth) return candidate;
  }

  return undefined;
}

/**
 * The directory a row stands for, as an absolute path.
 *
 * A folder is a real directory on disk, so it answers too. Group keys carry
 * their trailing slash (it is how they are drawn); a path handed around as a
 * location should not.
 */
export function pathOf(row: TreeRow, repoRoot: string): string {
  return row.kind === "group" ? join(repoRoot, row.key.replace(/\/+$/, "")) : row.summary.path;
}

/**
 * One drawn row of a worktree's changed files.
 *
 * Deliberately thinner than `TreeRow` above: nothing here is selected, folded
 * or acted on, so a row is a label at a depth. The `group` rows are directories
 * the fold produced; the `leaf` rows are the paths `git status` actually named.
 */
export type FileRow = {
  readonly kind: "group" | "leaf";
  /** The whole path from the worktree root — unique, so it is the React key. */
  readonly key: string;
  /** The one segment this row draws; a directory keeps its trailing slash. */
  readonly label: string;
  readonly depth: number;
};

type FileNode = {
  readonly leaves: { readonly label: string; readonly path: string }[];
  readonly dirs: Map<string, FileNode>;
};

function emptyFileNode(): FileNode {
  return { leaves: [], dirs: new Map() };
}

function emitFiles(node: FileNode, depth: number, prefix: string, into: FileRow[]): void {
  // Files before directories at each level, then alphabetically — the rule
  // `emit` uses on the list above, for the reason it uses it there: a directory
  // is a heading, and headings after the plain rows keep the top of each level
  // scannable instead of making you step over `src/` to reach `README.md`.
  for (const leaf of node.leaves.toSorted((a, b) => a.label.localeCompare(b.label))) {
    into.push({ kind: "leaf", key: leaf.path, label: leaf.label, depth });
  }

  for (const name of [...node.dirs.keys()].toSorted((a, b) => a.localeCompare(b))) {
    const dir = node.dirs.get(name);
    if (dir === undefined) continue;

    const key = `${prefix}${name}/`;
    into.push({ kind: "group", key, label: `${name}/`, depth });
    emitFiles(dir, depth + 1, key, into);
  }
}

/**
 * A worktree's changed paths, folded back into the directories they sit in.
 *
 * The paths arrive as `git status` reports them, relative to the worktree root
 * and separated by `/` on every platform — including the trailing slash git
 * puts on an untracked directory it did not walk into. That slash is kept: it
 * is the difference between one file and everything under a folder, and it is
 * the whole of what the row is saying. It is still a leaf, because it is still
 * one entry of the status output and one of the numbers `changed` counted.
 */
export function buildFileTree(paths: readonly string[]): readonly FileRow[] {
  const root = emptyFileNode();

  for (const path of paths) {
    const directory = path.endsWith("/");
    const segments = path.split("/").filter((segment) => segment.length > 0);
    const name = segments.pop();
    if (name === undefined) continue;

    let node = root;
    for (const segment of segments) {
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = emptyFileNode();
        node.dirs.set(segment, next);
      }
      node = next;
    }

    node.leaves.push({ label: directory ? `${name}/` : name, path });
  }

  const rows: FileRow[] = [];
  emitFiles(root, 0, "", rows);

  return rows;
}
