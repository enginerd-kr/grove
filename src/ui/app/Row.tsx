import { Text } from "ink";
import { Fragment } from "react";
import type { Drift } from "../../core/branches.ts";
import {
  describeRemote,
  describeTouched,
  describeTrunk,
  noteParts,
  STALE_SETUP,
  type WorktreeSummary,
} from "../../core/commands/list.ts";
import { theme } from "../theme.ts";
import { clip } from "./Files.tsx";
import { GAP, type Widths } from "./layout.ts";
import type { TreeRow } from "./tree.ts";

/** Pads or truncates to exactly `width`, so columns stay columns. */
export function padTo(text: string, width: number): string {
  return clip(text, width).padEnd(width);
}

/**
 * One drift column, with the two directions coloured apart.
 *
 * They are not the same news. `↑` is work that exists only here — yours to push
 * or to merge, and yours to lose with the laptop, which is why it reads as
 * something you have rather than something wrong. `↓` is work you have not got,
 * and it is the half that bites: against the remote it is what makes "it worked
 * on my machine" true and useless, and against the trunk it is what `sync`
 * exists to close. Colouring them the same would make the row a number to
 * decode rather than a thing to glance at.
 *
 * A zero is dimmed whichever side it is on and whichever column it is in. Green
 * `↑0` down a whole column would be decoration competing with the rows that have
 * actually moved.
 *
 * Both columns are drawn by this, deliberately: `↑2 ↓1` means the same shape of
 * thing under `origin` and under `main`, so it is one convention to learn rather
 * than two.
 */
function DriftCell({
  drift,
  text,
  width,
  selected,
}: {
  readonly drift: Drift | undefined;
  /** What to draw; `drift` is what to colour it by. */
  readonly text: string;
  readonly width: number;
  readonly selected: boolean;
}) {
  // Nothing to point at, and nothing the arrows could honestly say about it —
  // `no upstream`, or the trunk's own blank row.
  if (drift === undefined || text.length > width) {
    return <Text dimColor={!selected}>{padTo(text, width)}</Text>;
  }

  return (
    <>
      <Text color={drift.ahead > 0 ? theme.ok : undefined} dimColor={drift.ahead === 0}>
        {`↑${drift.ahead}`}
      </Text>{" "}
      <Text color={drift.behind > 0 ? theme.warn : undefined} dimColor={drift.behind === 0}>
        {`↓${drift.behind}`}
      </Text>
      {" ".repeat(width - text.length)}
    </>
  );
}

/**
 * The working tree as one glyph, and only the unusual states as words.
 *
 * `clean` was a word the eye had to read on every row to learn nothing — it is
 * true of almost every worktree almost all the time, and the one row that is
 * dirty was the same shape and length as the rest. A filled dot has weight and a
 * hollow one does not, so the row that has changes is now the row that looks
 * different from across the terminal.
 *
 * Shape as well as colour, deliberately. Green-versus-yellow is invisible to a
 * good number of people and to anyone whose terminal theme has opinions, and a
 * status column nobody can read is worse than the word it replaced.
 */
function StateCell({
  summary,
  width,
  selected,
}: {
  readonly summary: WorktreeSummary;
  readonly width: number;
  readonly selected: boolean;
}) {
  const parts = noteParts(summary);
  const notes = parts.length === 0 ? "" : ` ${parts.join(", ")}`;
  const room = Math.max(0, width - 1);

  const dot = (
    <Text color={summary.dirty ? theme.warn : undefined} dimColor={!summary.dirty}>
      {summary.dirty ? "●" : "○"}
    </Text>
  );

  // One padded run when it does not fit, so the ellipsis lands where `padTo`
  // would have put it. A cell being truncated has bigger problems than colour.
  if (notes.length > room) {
    return (
      <>
        {dot}
        <Text dimColor={!selected}>{padTo(notes, room)}</Text>
      </>
    );
  }

  return (
    <>
      {dot}
      {parts.map((part, at) => (
        <Fragment key={part}>
          <Text dimColor={!selected}>{at === 0 ? " " : ", "}</Text>
          {/* Two words in this column are coloured, for opposite reasons.
              `merged` and `gone` are an invitation: the work landed and the
              directory is free to go, which is news of the same kind as a
              green `↑`. `setup stale` is a thing to do — the project's file
              moved on and this worktree did not — and it takes the amber a
              `↓` takes, since both say something here is behind. Everything
              beside them stays the colour of an aside. */}
          <Text
            color={
              part === summary.finished ? theme.ok : part === STALE_SETUP ? theme.warn : undefined
            }
            dimColor={part !== summary.finished && part !== STALE_SETUP && !selected}
          >
            {part}
          </Text>
        </Fragment>
      ))}
      <Text>{" ".repeat(room - notes.length)}</Text>
    </>
  );
}

export function Row({
  row,
  selected,
  widths,
  now,
}: {
  readonly row: TreeRow;
  readonly selected: boolean;
  readonly widths: Widths;
  /**
   * The moment the ages are measured from — the same one `columnWidths` sized
   * the column with, handed down rather than read again here. A second
   * `Date.now()` is how the label and the column it sits in came to disagree.
   */
  readonly now: number;
}) {
  const indent = "  ".repeat(row.depth);

  // A folder has no state of its own, and never the `*`: you cannot be standing
  // in a folder, only in one of the worktrees under it.
  if (row.kind === "group") {
    return (
      <Text color={selected ? theme.accent : undefined} dimColor={!selected} wrap="truncate">
        {`${selected ? "▸" : " "}   `}
        {indent}
        {row.label}
        {/* The whole fold indicator, and only when shut. A chevron beside it
            would be saying the same thing twice: a folder with its worktrees
            indented underneath is visibly open, and one with a count and
            nothing under it is visibly not. The count is also what the folded
            rows were telling you, which a chevron is not. */}
        {row.collapsed ? `  ${row.leaves.length}` : ""}
      </Text>
    );
  }

  return (
    <Text color={selected ? theme.accent : undefined} wrap="truncate">
      {`${selected ? "▸" : " "} ${row.summary.current ? "*" : " "} `}
      {padTo(`${indent}${row.label}`, widths.tree)}
      {GAP}
      {widths.remote > 0 ? (
        <>
          <DriftCell
            drift={
              row.summary.upstream === undefined
                ? undefined
                : { ahead: row.summary.ahead, behind: row.summary.behind }
            }
            text={describeRemote(row.summary)}
            width={widths.remote}
            selected={selected}
          />
          {GAP}
        </>
      ) : null}
      {widths.trunk > 0 ? (
        <>
          <DriftCell
            drift={row.summary.trunk}
            text={describeTrunk(row.summary)}
            width={widths.trunk}
            selected={selected}
          />
          {GAP}
        </>
      ) : null}
      <StateCell summary={row.summary} width={widths.state} selected={selected} />
      {/* Right beside the state, without a heading of its own: "when was I
          last here" is an aside about the row, not a column the eye scans
          down — and the state column is content-sized so this sits next to
          the dot rather than at the far edge of the screen. */}
      {widths.touched > 0 ? (
        <>
          {GAP}
          <Text dimColor={!selected}>
            {padTo(describeTouched(row.summary, now), widths.touched)}
          </Text>
        </>
      ) : null}
    </Text>
  );
}
