import { Box, Text } from "ink";
import { theme } from "../theme.ts";
import { windowOf } from "./window.ts";

/**
 * The commands that have no key of their own, as a list to type at.
 *
 * The key bar is a fixed cost paid by every screen: it is drawn on every frame,
 * it takes rows the list would otherwise have, and it packs onto a second line
 * the moment it outgrows the terminal's width. So it cannot be where every new
 * command lands — a bar that grows with the feature list ends up either
 * truncated or eating the thing it sits under.
 *
 * `/` is the overflow, and the split it makes is the one the cursor makes.
 * A key stays on the bar when it acts on the row under the cursor and is
 * reached often enough to be muscle memory — move, `enter`, `a`, `r`, `s`, and
 * `x` on the rows that have something to discard. A command comes here when it
 * is aimed at the repository rather than at a row (`sync-all`, `prune`, `review`), when
 * it is a preference set once and then left (`log`, `refresh`), or when it does
 * act on the row and is still reached rarely — `open`, which is a thing you do
 * to a worktree on the day you come back to it. Those are the ones a letter
 * buys the least for: you reach for them rarely enough that you would have had
 * to read the bar anyway.
 *
 * A moved command loses its letter rather than keeping it quietly. The bar is
 * the whole of what this screen advertises, and a key that works but is not on
 * it is one you have to already know about — which is the state `/` exists to
 * get out of, not one to leave four keys in.
 */

/**
 * Every command the menu holds, as a type rather than as strings.
 *
 * So that the dispatcher in `App` is exhaustive: a command added here without
 * a branch to run it is a type error rather than a row that does nothing when
 * you press enter on it.
 */
export type CommandName =
  | "open"
  | "setup"
  | "rebase"
  | "sync-all"
  | "prune"
  | "review"
  | "upstream"
  | "refresh"
  | "log";

export type MenuCommand = {
  /** Without the slash; it is drawn with one and typed without. */
  readonly name: CommandName;
  readonly summary: string;
};

/**
 * The menu's contents, which depend on the screen only where a command toggles.
 *
 * `log` says what it will do next rather than what it did, the same way the
 * key bar's hints do — a menu that reads `hide the commits` while there are no
 * commits on screen is describing the last press, not the next one.
 */
export function commandsFor(logOn: boolean): readonly MenuCommand[] {
  return [
    {
      name: "open",
      summary: "open the row under the cursor with what .grove.toml's `open` says",
    },
    {
      name: "setup",
      summary: "fill the row under the cursor in from .grove.toml again",
    },
    // Aimed at the row like the two above, and behind the slash for the
    // reason `open` is: `s` is the sync you do every morning, and choosing a
    // base by hand is the one you do the day the branch has to sit somewhere
    // else for a while.
    {
      name: "rebase",
      summary: "rebase the row under the cursor onto a base you pick, changes carried",
    },
    { name: "sync-all", summary: "sync every worktree, not just the row under the cursor" },
    { name: "prune", summary: "remove every worktree marked merged or gone, after asking" },
    { name: "review", summary: "pick one of the open pull requests and check it out" },
    { name: "upstream", summary: "follow another repository's trunk — this is a fork of it" },
    { name: "refresh", summary: "re-read the worktrees now, without waiting for the clock" },
    {
      name: "log",
      summary: logOn ? "hide the commits under the list" : "show the commits under the list",
    },
  ];
}

/**
 * The commands `query` narrows to, in the order they were declared.
 *
 * `includes` rather than a prefix, so `all` finds `sync-all` — the part of a
 * name you remember is not reliably its first syllable. Declaration order is
 * kept rather than ranked by where the match landed: the list is short enough
 * to see whole, and rows that reshuffle as you type are rows you cannot aim at.
 */
export function matching(commands: readonly MenuCommand[], query: string): readonly MenuCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return commands;

  return commands.filter((command) => command.name.includes(needle));
}

/**
 * How many rows the popup takes at this size. The layout has to know before it
 * draws — the same question `pullRequestRows` answers for the other popup.
 *
 * Two for the border, one for the prompt, and one per command it can show. At
 * least one body row whatever the query matched: the "no command" line has to
 * live somewhere, and a popup that collapsed to its border would look like the
 * menu had closed rather than like the query had found nothing.
 */
export function menuRows(count: number, rows: number): number {
  return 2 + 1 + Math.max(1, Math.min(Math.max(0, rows), count));
}

/** Between the name and what it does — the breath the other popup gives its columns. */
const GAP = "  ";

type Props = {
  /** Already narrowed by `matching`; the cursor and `enter` both index into this. */
  readonly commands: readonly MenuCommand[];
  readonly index: number;
  /** What has been typed, without the slash that opened the menu. */
  readonly query: string;
  /** How many there are before the query narrowed them, for the count. */
  readonly total: number;
  /** How many command rows there is room for. The prompt sits above these. */
  readonly rows: number;
};

export function Menu({ commands, index, query, total, rows }: Props) {
  const room = Math.max(0, rows);
  const start = windowOf(commands.length, index, room);
  const shown = commands.slice(start, start + room);

  const nameWidth = Math.max(0, ...shown.map((command) => command.name.length));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      {/* The prompt is the heading. A menu you type into has to show what it
          heard, and a separate title row above it would spend one of the few
          rows the popup has saying the word "commands" to someone who has just
          pressed the key that opens the commands. */}
      <Text wrap="truncate">
        <Text color={theme.accent}>{`/${query}`}</Text>
        {/* The caret is the block the next character lands on, drawn the way
            `add`'s is — always at the end here, because a filter is retyped
            rather than repaired in the middle. */}
        <Text inverse> </Text>
        {commands.length < total ? (
          <Text dimColor>{`   ${commands.length} of ${total}`}</Text>
        ) : null}
      </Text>

      {shown.length === 0 ? (
        // Indented to where the names are, so the popup does not change shape
        // under the prompt as the query stops matching and starts again.
        <Text dimColor wrap="truncate">
          {"  no command matches — backspace to widen it"}
        </Text>
      ) : (
        shown.map((command, offset) => {
          const selected = start + offset === index;

          return (
            <Text key={command.name} wrap="truncate">
              <Text color={theme.accent}>{selected ? "▸ " : "  "}</Text>
              <Text color={selected ? theme.accent : undefined} dimColor={!selected}>
                {`/${command.name}`.padEnd(nameWidth + 1)}
              </Text>
              {GAP}
              {/* Last, and the only part allowed to run out of room: the name
                  is what you aim at, and the summary is what tells you which
                  name you wanted the first time. */}
              <Text dimColor>{command.summary}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
