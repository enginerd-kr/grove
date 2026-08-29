import { Box, Text } from "ink";
import { buildFileTree } from "./tree.ts";

/**
 * The uncommitted files beside the list, for the row the cursor is on.
 *
 * The `state` column says a worktree is dirty and the removal question says how
 * much; neither says *what*, and "what have I got open over there" is the
 * question that sends people to another terminal for a `git status`. This is
 * that answer and only that answer: the paths, with no status letters in front
 * of them — the dot in the list has already said the one thing a letter would
 * add.
 *
 * Drawn as the tree the files are in, the same way the worktrees to its left
 * are: `git status` reports whole paths, and a column of `src/ui/app/…` repeats
 * the prefix on every row of a change that touched one directory. Folded, the
 * shape of the change is the shape of the panel — one directory deep is one
 * heading, and a change scattered across the project looks scattered.
 *
 * It exists only where there is something to say. A clean worktree draws
 * nothing at all rather than a `nothing uncommitted` that would be true of
 * almost every row almost all the time — the same reasoning that took the word
 * `clean` out of the `state` column.
 */

type Props = {
  /** Which row these belong to — the worktree's directory, not the branch. */
  readonly label: string;
  /** The changed paths, already capped by `listWorktreeSummaries`. */
  readonly files: readonly string[];
  /** How many there are in all, which `files` may be only a sample of. */
  readonly total: number;
  /** The panel's height, and its width including the rule down its left edge. */
  readonly rows: number;
  readonly width: number;
};

/**
 * The panel's left edge: a gap off the list, the rule, and a space after it.
 *
 * The gap is part of the panel rather than the list's business, because it is
 * the panel that comes and goes — a list that reserved a margin for it would be
 * reserving one on every screen that never draws one.
 */
const EDGE = "  │ ";

/** What one level of nesting costs, the same as it costs in the list. */
const INDENT = "  ";

/** Truncates to `width`, saying so — `padTo`'s half of the job, without the pad. */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;

  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function Files({ label, files, total, rows, width }: Props) {
  const inner = Math.max(0, width - EDGE.length);
  // The heading is a row of the panel, like the commit panel's own: the files
  // belong to whichever row the cursor is on, and a tree of paths with nothing
  // naming their worktree is a tree of paths.
  const body = Math.max(0, rows - 1);

  const tree = buildFileTree(files);
  // Two ways to be showing less than there is: more rows than the panel is
  // tall, and a status so large that `listWorktreeSummaries` capped the sample
  // before the panel ever saw it. Either way the last row goes to saying so,
  // which is itself what decides how many of the others fit.
  const overflows = tree.length > body || total > files.length;
  const budget = overflows ? Math.max(0, body - 1) : body;

  let shown = tree.slice(0, budget);
  // A directory row is only there to head the rows under it, and a cut that
  // landed just after one would leave it heading nothing — a `src/` with the
  // count of what it holds on the line below it rather than inside it.
  while (shown.length > 0 && shown[shown.length - 1]?.kind === "group") shown = shown.slice(0, -1);

  // Counted in files rather than in rows: the directories are the panel's own
  // doing, and nobody is missing one.
  const hidden = total - shown.filter((row) => row.kind === "leaf").length;

  return (
    <Box width={width} flexShrink={0}>
      {/* One `Text` of stacked rules rather than a rule per row: the pane's
          left edge is one thing, and it runs the full height it is given so
          that the panel beside a worktree with two files open is the same
          shape as the one beside a worktree with twenty. */}
      <Box width={EDGE.length} flexShrink={0}>
        <Text dimColor>{Array.from({ length: rows }, () => EDGE.trimEnd()).join("\n")}</Text>
      </Box>

      {/* Nothing here is wrapped or truncated by Ink: every row is clipped to
          what is left of `inner` after its own indent, which is a width Ink
          has no way to know. */}
      <Box flexDirection="column" flexGrow={1}>
        <Text dimColor>{clip(`uncommitted in ${label}`, inner)}</Text>

        {shown.map((row) => (
          // Directories dimmed and files not, the same way the list dims a
          // folder row: the directory is the address and the file is the thing
          // that changed.
          <Text key={row.key} dimColor={row.kind === "group"}>
            {INDENT.repeat(row.depth)}
            {clip(row.label, inner - row.depth * INDENT.length)}
          </Text>
        ))}

        {hidden > 0 ? <Text dimColor>{clip(`… ${hidden} more`, inner)}</Text> : null}
      </Box>
    </Box>
  );
}
