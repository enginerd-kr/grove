import { Box, Text } from "ink";
import { version } from "../../../package.json";
import { BIN_NAME } from "../../cli/help.ts";
import { theme } from "../theme.ts";
import { type ChangelogEntry, latestChange } from "./changelog.ts";

/**
 * The welcome: what this is, which build it is, and which folder it opened.
 *
 * Those are the three things someone wants in the first second of a full-screen
 * app they did not hand a path to, and all three are expensive to check any
 * other way — the app takes the alternate buffer, so the command that started
 * it is no longer on screen to read the `-C` back off.
 *
 * It costs rows, so it gives them back when there are none to spare: below a
 * short or narrow terminal the art and the border go and the same facts are
 * drawn as one line. The list is what the terminal is for, and a banner that
 * squeezed it would be decoration charging rent.
 */

/** A sprout, in half-blocks. Three rows, seven columns, and never wider. */
const ART = ["▗▄▖ ▗▄▖", "▝▜█▄█▛▘", "   ▐▌"] as const;

/** The art's width, plus the gap that separates it from the text beside it. */
const ART_WIDTH = 7;
const ART_GAP = 2;

/** Below either of these, the banner is a single line. */
const ROOMY_ROWS = 22;
const ROOMY_COLUMNS = 52;

function roomy(columns: number, rows: number): boolean {
  return rows >= ROOMY_ROWS && columns >= ROOMY_COLUMNS;
}

/**
 * Below this many columns, the "What's new" column is absent even when the
 * banner is roomy — squeezed under it, the info column's path and count would
 * be the ones paying, and they answer "is this the folder I meant?" while the
 * news only answers "what changed?".
 */
const WHATSNEW_COLUMNS = 84;
/** More than this many bullets is a changelog, and the file is right there. */
const WHATSNEW_BULLETS = 3;
/** What the info column narrows to when the news sits beside it. */
const INFO_WIDTH = 32;

/** Rows the "What's new" column wants: a heading and its bullets, or none. */
function whatsNewLines(columns: number, rows: number, entry = latestChange): number {
  if (!roomy(columns, rows) || columns < WHATSNEW_COLUMNS) return 0;
  if (entry === undefined || entry.bullets.length === 0) return 0;

  return 1 + Math.min(WHATSNEW_BULLETS, entry.bullets.length);
}

/**
 * How many rows the banner takes at this size.
 *
 * Exported because the screen slices the list to what is left over, and it can
 * only do that if the number is known before anything is drawn.
 */
export function bannerRows(columns: number, rows: number, entry = latestChange): number {
  if (!roomy(columns, rows)) return 1;

  return Math.max(ART.length, whatsNewLines(columns, rows, entry)) + 2;
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
function describeFolder(worktrees?: number, here?: string): string {
  // Two different nothings, and the difference is what the screen is for: an
  // empty folder is waiting for a URL, a repository with no worktrees is waiting
  // for `a`.
  if (worktrees === undefined) return "no repository here yet";
  if (worktrees === 0) return "no worktrees yet";

  const counted = `${worktrees} worktree${worktrees === 1 ? "" : "s"}`;

  return here === undefined ? counted : `${counted} · in ${here}`;
}

type Props = {
  /** The folder the app opened — the answer to "is this the one I meant?". */
  readonly repoRoot: string;
  /** Absent when there is no repository here yet, which is a state of its own. */
  readonly worktrees?: number;
  /** The worktree the app was started from, when it was started from one. */
  readonly here?: string;
  readonly columns: number;
  readonly rows: number;
  /** The latest changelog entry. A prop only so tests can hold it still. */
  readonly whatsNew?: ChangelogEntry;
};

export function Banner({
  repoRoot,
  worktrees,
  here,
  columns,
  rows,
  whatsNew = latestChange,
}: Props) {
  const folder = describeFolder(worktrees, here);
  const release = ` v${version}`;
  const news = whatsNewLines(columns, rows, whatsNew) > 0 ? whatsNew : undefined;

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

  // Muted rather than accented: the accent border is what the add prompt uses to
  // say "this is taking your keys", and a banner that borrowed it would blunt
  // the one place that distinction has to be read at a glance.
  return (
    <Box borderStyle="round" borderColor={theme.muted} paddingX={1}>
      <Box flexDirection="column" width={ART_WIDTH} flexShrink={0} marginRight={ART_GAP}>
        {ART.map((line) => (
          <Text key={line} color={theme.ok}>
            {line}
          </Text>
        ))}
      </Box>

      <Box
        flexDirection="column"
        flexShrink={0}
        width={news === undefined ? undefined : INFO_WIDTH}
      >
        <Text wrap="truncate">
          <Text bold color={theme.accent}>
            {BIN_NAME}
          </Text>
          <Text dimColor>{release}</Text>
        </Text>
        <Text dimColor wrap="truncate">
          {shortenPath(
            repoRoot,
            news === undefined ? Math.max(10, columns - ART_WIDTH - ART_GAP - 5) : INFO_WIDTH,
          )}
        </Text>
        <Text dimColor wrap="truncate">
          {folder}
        </Text>
      </Box>

      {news !== undefined && (
        <Box
          flexDirection="column"
          marginLeft={ART_GAP}
          width={columns - 4 - ART_WIDTH - ART_GAP - INFO_WIDTH - ART_GAP}
        >
          <Text wrap="truncate">
            <Text bold>What's new</Text>
            <Text dimColor> v{news.version}</Text>
          </Text>
          {news.bullets.slice(0, WHATSNEW_BULLETS).map((bullet) => (
            <Text key={bullet} dimColor wrap="truncate">
              · {bullet}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
