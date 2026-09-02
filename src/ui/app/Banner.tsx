import { Box, Text } from "ink";
import { useState } from "react";
import { version } from "../../../package.json";
import { BIN_NAME } from "../../cli/help.ts";
import { plural } from "../../core/text.ts";
import { useInterval } from "../hooks/useInterval.ts";
import { theme } from "../theme.ts";
import { latestChange } from "./changelog.ts";

/**
 * The welcome: a card with the name in its border, a greeting over the art on
 * the left, and a column of tips and news down the right.
 *
 * The left half answers the questions that are expensive to answer any other
 * way — which build this is, and which folder it opened. The app takes the
 * alternate buffer, so the command that started it is no longer on screen to
 * read the `-C` back off. The right half is the part that earns the card its
 * size: a tip for the state of the folder — drawn at random from what that
 * state has to say, and turned over while the screen is up — and what changed
 * in the release you are looking at.
 *
 * It costs rows, so it gives them back when there are none to spare: below a
 * short or narrow terminal the card goes and the same facts are drawn as one
 * line. The list is what the terminal is for, and a banner that squeezed it
 * would be decoration charging rent.
 */

/** A sprout, in half-blocks. Three rows, seven columns, and never wider. */
const ART = ["▗▄▖ ▗▄▖", "▝▜█▄█▛▘", "   ▐▌"] as const;

/** The art's width — the block is centred whole, so its rows stay aligned. */
const ART_WIDTH = 7;

/**
 * Below either of these, the banner is a single line. The card is twelve rows
 * tall, and on a stock 24-row terminal that is half the screen — so the card
 * asks for a terminal with rows to spare, not merely enough to fit in.
 */
const ROOMY_ROWS = 28;
const ROOMY_COLUMNS = 52;

function roomy(columns: number, rows: number): boolean {
  return rows >= ROOMY_ROWS && columns >= ROOMY_COLUMNS;
}

/**
 * Below this many columns, the right-hand column is absent even when the card
 * is drawn — squeezed beside it, the greeting and the path would be the ones
 * paying, and they answer "is this the folder I meant?" while the tips only
 * answer "what could I do next?".
 */
const TIPS_COLUMNS = 84;
/** More than this many bullets is a changelog, and the file is right there. */
const WHATSNEW_BULLETS = 3;
/** What the greeting column holds to when the tips sit beside it. */
const LEFT_WIDTH = 34;
/** What the divider between the columns costs: a margin, the line, a gap. */
const DIVIDER_WIDTH = 4;

/**
 * The card's inside is a fixed eight rows: the left column always draws its
 * greeting, its art, and its two facts with a breath around the art, and the
 * right column is never taller — two rows of tip, and at most a rule, a
 * heading, three bullets and a pointer. A constant beats a calculation here:
 * a card that changed height with the changelog would bounce the list under it
 * from release to release.
 */
const CONTENT_ROWS = 8;

/**
 * How many rows the banner takes at this size: the content, a row of breath
 * above it, the hand-drawn top border, and the bottom one.
 *
 * Exported because the screen slices the list to what is left over, and it can
 * only do that if the number is known before anything is drawn.
 */
export function bannerRows(columns: number, rows: number): number {
  return roomy(columns, rows) ? CONTENT_ROWS + 3 : 1;
}

/**
 * The repo path as a label, not as a path to copy: `~` for home, and the front
 * cut away when it is long, because the tail is the part that identifies it.
 */
function shortenPath(path: string, max: number): string {
  const home = process.env.HOME;
  const short =
    home !== undefined && home.length > 0 && path.startsWith(home)
      ? `~${path.slice(home.length)}`
      : path;

  return short.length <= max ? short : `…${short.slice(short.length - max + 1)}`;
}

/** What the folder holds, and whereabouts in it you are standing. */
function describeFolder(worktrees?: number, here?: string, repos?: number): string {
  // Three different nothings, and the difference is what each screen is for: an
  // empty folder is waiting for a URL, a folder of repositories is waiting for
  // one of them to be picked, and a repository with no worktrees is waiting
  // for `a`.
  if (worktrees === undefined) {
    return repos === undefined ? "no repository here yet" : `${repos} repositories here`;
  }
  if (worktrees === 0) return "no worktrees yet";

  const counted = plural(worktrees, "worktree");

  return here === undefined ? counted : `${counted} · in ${here}`;
}

/** The person at the keyboard, by the name the OS knows them under. */
function greeting(): string {
  const name = process.env.USER ?? process.env.USERNAME ?? "";

  return name.length === 0 ? "Welcome back!" : `Welcome back ${name}!`;
}

/**
 * How long a tip stays before the next one. Standing advice, not a spinner:
 * long enough to read and act on before it turns, and the same cadence the
 * message slot under the list turns its own tips on.
 */
const TIP_ROTATE_MS = 60_000;

/**
 * What the screen with a list on it has to say, one line each and none wider
 * than the column at its narrowest (42 cells at `TIPS_COLUMNS`) — a tip that
 * truncated would be advice with the key cut off the end.
 *
 * Every key and every `/` command here is one the list screen actually has;
 * a tip for a key that does nothing is worse than no tip.
 */
const LIST_TIPS: readonly string[] = [
  "press a to add, s to sync, r to remove",
  "enter copies the path under the cursor",
  "/ holds every command without a key",
  "h shuts a folder, l opens it back up",
  "x discards a dirty row's changes",
  "r on a folder removes everything under it",
  "/ log shows the commits under the list",
  "/ prune clears rows marked merged or gone",
  "/ review checks out an open pull request",
  "q quits and puts the shell back as it was",
];

/**
 * The tips for what the folder is waiting for. The same four states
 * `describeFolder` reads, answered with the key that moves each one along.
 *
 * Three of them have exactly one thing to say — a folder with no repository
 * is waiting for a URL and nothing else — so they say it, every time. The
 * list screen has many keys, and a card that named the same three on every
 * open would be read once and never again, so it draws from `LIST_TIPS`.
 */
function tipsFor(worktrees?: number, repos?: number): readonly string[] {
  if (worktrees === undefined) {
    return repos === undefined
      ? [`run ${BIN_NAME} clone <url> to plant a repository here`]
      : ["press enter to open the one you meant"];
  }
  if (worktrees === 0) return ["press a to plant your first worktree"];

  return LIST_TIPS;
}

/** Where a draw of `pick` (in `[0, 1)`) lands in a pool of `length`. */
function indexOf(pick: number, length: number): number {
  return Math.floor(pick * length);
}

/** A new draw that lands somewhere other than `pick` does in a pool of `length`, or `pick` when there is nowhere else. */
function anotherPick(pick: number, length: number): number {
  if (length < 2) return pick;

  let next = pick;
  while (indexOf(next, length) === indexOf(pick, length)) next = Math.random();
  return next;
}

type Props = {
  /** The folder the app opened — the answer to "is this the one I meant?". */
  readonly repoRoot: string;
  /** Absent when there is no repository here yet, which is a state of its own. */
  readonly worktrees?: number;
  /** The worktree the app was started from, when it was started from one. */
  readonly here?: string;
  /**
   * How many repositories sit in this folder, for the one screen where none of
   * them is open yet. Read only while `worktrees` is absent — once a repository
   * has been picked, what the folder beside it holds stops being the news.
   */
  readonly repos?: number;
  readonly columns: number;
  readonly rows: number;
  /** How often the tip turns to another, in ms. Defaults to `TIP_ROTATE_MS`; tests drive it faster. */
  readonly tipRotateMs?: number;
};

export function Banner({
  repoRoot,
  worktrees,
  here,
  repos,
  columns,
  rows,
  tipRotateMs = TIP_ROTATE_MS,
}: Props) {
  const folder = describeFolder(worktrees, here, repos);
  const release = ` v${version}`;

  // Which tip is up, drawn once at mount rather than on every render — the
  // refresh clock re-renders this card every minute, and a tip that re-rolled
  // with each one would flicker through the pool instead of turning through
  // it. What is held is the draw, a number in `[0, 1)`, not the index it
  // lands on: the pool changes size under the card (the list is empty until
  // the first read lands, and the first `a` turns "no worktrees yet" into a
  // list), and an index drawn against a pool of one is always 0 — which made
  // every open land on the same first tip. A draw is fair in whatever pool is
  // current.
  const tips = tipsFor(worktrees, repos);
  const [pick, setPick] = useState(Math.random);
  const tip = tips[indexOf(pick, tips.length)] ?? "";
  useInterval(
    () => setPick((current) => anotherPick(current, tips.length)),
    tips.length > 1 ? tipRotateMs : null,
  );

  if (!roomy(columns, rows)) {
    // One line, and the path is what yields: the name and the version are short
    // and fixed, and a truncated `7 worktrees` would read as a wrong count.
    const width = Math.max(10, columns - BIN_NAME.length - release.length - folder.length - 6);

    return (
      <Text wrap="truncate">
        <Text bold color={theme.accent}>
          {BIN_NAME}
        </Text>
        <Text dimColor>{`${release} · ${shortenPath(repoRoot, width)} · ${folder}`}</Text>
      </Text>
    );
  }

  const withTips = columns >= TIPS_COLUMNS;
  const news =
    latestChange !== undefined && latestChange.bullets.length > 0 ? latestChange : undefined;
  const leftWidth = withTips ? LEFT_WIDTH : columns - 4;
  const newsWidth = Math.max(10, columns - 4 - LEFT_WIDTH - DIVIDER_WIDTH);
  const title = `${BIN_NAME}${release}`;

  // Muted rather than accented: the accent border is what the add prompt uses to
  // say "this is taking your keys", and a card that borrowed it would blunt the
  // one place that distinction has to be read at a glance. The title is the
  // exception — it sits *in* the border, and the accent is what lifts it out.
  // The version rides along muted, not accented: it is a fact to check, not
  // the name the card is announcing.
  return (
    <Box flexDirection="column" width={columns}>
      {/* The top border, drawn by hand: Ink boxes cannot carry a title, so the
          box below leaves its top off and this line supplies it, corner to
          corner, sized to meet the sides exactly. */}
      <Text wrap="truncate">
        <Text color={theme.muted}>{"╭─ "}</Text>
        <Text bold color={theme.accent}>
          {BIN_NAME}
        </Text>
        <Text color={theme.muted}>{release}</Text>
        <Text
          color={theme.muted}
        >{` ${"─".repeat(Math.max(0, columns - title.length - 5))}╮`}</Text>
      </Text>

      <Box
        width={columns}
        borderStyle="round"
        borderColor={theme.muted}
        borderTop={false}
        paddingX={1}
        paddingTop={1}
      >
        <Box flexDirection="column" alignItems="center" width={leftWidth} flexShrink={0}>
          <Text bold wrap="truncate">
            {greeting()}
          </Text>
          <Box height={1} />
          {/* The block centred whole, not line by line — centring each row
              separately would shear the sprout apart. */}
          <Box flexDirection="column" width={ART_WIDTH}>
            {ART.map((line) => (
              <Text key={line} color={theme.ok}>
                {line}
              </Text>
            ))}
          </Box>
          <Box height={1} />
          <Text dimColor underline wrap="truncate">
            {shortenPath(repoRoot, leftWidth)}
          </Text>
          <Text dimColor wrap="truncate">
            {folder}
          </Text>
        </Box>

        {withTips && (
          <Box
            flexDirection="column"
            // Sized by arithmetic, not left to grow: a Text only truncates
            // against a width its box actually has, and grown-to-content is
            // how a long bullet walks through the border.
            width={newsWidth + 3}
            flexShrink={0}
            marginLeft={1}
            paddingLeft={2}
            borderStyle="single"
            borderColor={theme.muted}
            borderTop={false}
            borderBottom={false}
            borderRight={false}
          >
            <Text bold color={theme.accent} wrap="truncate">
              Tips for getting started
            </Text>
            <Text wrap="truncate">{tip}</Text>
            {news !== undefined && (
              <>
                <Text color={theme.muted} wrap="truncate">
                  {"─".repeat(newsWidth)}
                </Text>
                <Text bold color={theme.accent} wrap="truncate">
                  What's new
                </Text>
                {news.bullets.slice(0, WHATSNEW_BULLETS).map((bullet) => (
                  <Text key={bullet} wrap="truncate">
                    · {bullet}
                  </Text>
                ))}
                <Text dimColor italic wrap="truncate">
                  CHANGELOG.md for more
                </Text>
              </>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
