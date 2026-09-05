import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import { buildTree, firstChildOf, parentOf } from "./tree.ts";

/** Keep the cursor and folds anchored to paths when a background read changes the rows. */
export function useWorktreeSelection(rows: readonly WorktreeSummary[]) {
  const [cursorKey, setCursorKey] = useState<string>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => buildTree(rows, collapsed), [rows, collapsed]);
  const lastIndex = useRef(0);
  const anchored = tree.findIndex((row) => row.key === cursorKey);
  const index =
    tree.length === 0 ? 0 : anchored >= 0 ? anchored : Math.min(lastIndex.current, tree.length - 1);
  const current = tree[index];

  useEffect(() => {
    lastIndex.current = index;
  }, [index]);

  const move = useCallback(
    (delta: number) => {
      // Several keys can arrive before React commits the next frame.
      setCursorKey((previous) => {
        const last = Math.max(0, tree.length - 1);
        const at = tree.findIndex((row) => row.key === previous);
        const from = at >= 0 ? at : Math.min(lastIndex.current, last);
        return tree[Math.min(last, Math.max(0, from + delta))]?.key;
      });
    },
    [tree],
  );

  const traverse = useCallback(
    (direction: -1 | 1) => {
      if (current?.kind === "group" && current.collapsed === (direction === 1)) {
        setCollapsed((previous) => {
          const next = new Set(previous);
          if (direction === 1) next.delete(current.key);
          else next.add(current.key);
          return next;
        });
        return;
      }
      const next =
        current === undefined
          ? undefined
          : direction === 1
            ? firstChildOf(tree, current)
            : parentOf(tree, current);
      if (next === undefined) move(direction);
      else setCursorKey(next.key);
    },
    [tree, current, move],
  );

  return {
    tree,
    index,
    current,
    move,
    traverse,
    selected: current?.kind === "leaf" ? current.summary : undefined,
    under: current?.kind === "group" ? current.leaves : [],
  };
}
