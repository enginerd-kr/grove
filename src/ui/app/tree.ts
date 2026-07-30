import type { WorktreeSummary } from "../../core/commands/list.ts";

/**
 * The worktree list as the tree it already is on disk.
 *
 * `wt` nests worktrees to match the branch — `feat/login` lives in `feat/login`
 * — so a flat list repeats the prefix on every row and hides the grouping the
 * slashes were there to express. This turns the paths back into the shape the
 * directory has, which is also the shape the eye is looking for with thirty
 * branches: `feat/`, `fix/`, `chore/`.
 *
 * Pure, and separate from the screen, because the ordering rules below are the
 * part worth testing and none of them need a terminal.
 */

export type TreeRow =
  | {
      readonly kind: "group";
      /** Stable across renders; React keys and nothing else. */
      readonly key: string;
      /** The directory segment, with its trailing slash: `feat/`. */
      readonly label: string;
      readonly depth: number;
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
function emit(node: Node, depth: number, path: string, into: TreeRow[]): void {
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
    into.push({ kind: "group", key, label: `${name}/`, depth });
    emit(group, depth + 1, key, into);
  }
}

export function buildTree(summaries: readonly WorktreeSummary[]): readonly TreeRow[] {
  const root = emptyNode();
  for (const summary of summaries) insert(root, summary);

  const rows: TreeRow[] = [];
  emit(root, 0, "", rows);

  return rows;
}

export type TreeLeaf = Extract<TreeRow, { kind: "leaf" }>;

export function leavesOf(rows: readonly TreeRow[]): readonly TreeLeaf[] {
  return rows.filter((row): row is TreeLeaf => row.kind === "leaf");
}

/**
 * The worktrees a folder row stands for — everything nested beneath it.
 *
 * Read off the emitted rows rather than the tree it came from: the rows are
 * what the cursor is sitting in, so "under this one" means the run that follows
 * it, up to the first row back at its own depth.
 */
export function leavesUnder(rows: readonly TreeRow[], group: TreeRow): readonly TreeLeaf[] {
  const start = rows.indexOf(group);
  if (start < 0) return [];

  const under: TreeLeaf[] = [];
  for (const row of rows.slice(start + 1)) {
    if (row.depth <= group.depth) break;
    if (row.kind === "leaf") under.push(row);
  }

  return under;
}
