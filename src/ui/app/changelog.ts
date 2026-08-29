import raw from "../../../CHANGELOG.md" with { type: "text" };

/**
 * The changelog, read at compile time.
 *
 * The banner's "What's new" column has to work in the compiled binary, on a
 * machine that has never seen this repository — so the text travels the same
 * way the version does: bundled in, not read from disk. The file itself stays
 * ordinary markdown so the release workflow can ship the same section as the
 * release notes; only two shapes in it mean anything here.
 */

export type ChangelogEntry = {
  readonly version: string;
  readonly bullets: readonly string[];
};

/** `## 1.2.3` opens an entry — whatever follows the version (a date) is not read. */
const HEADING = /^## (\d+\.\d+\.\d+)\b/;
/** Only top-level `- ` lines count; prose, sub-bullets and `###` are commentary. */
const BULLET = /^- (.+)$/;

/** Entries in file order, newest first. An entry with nothing to say is dropped. */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: { version: string; bullets: string[] }[] = [];

  // Split on CRLF too: a checkout with `core.autocrlf` on ends every line with
  // a `\r`, which `.` refuses to match — left on, it empties every entry's
  // bullets and the banner silently shows nothing.
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading?.[1] !== undefined) {
      entries.push({ version: heading[1], bullets: [] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const open = entries[entries.length - 1];
    if (bullet?.[1] !== undefined && open !== undefined) open.bullets.push(bullet[1]);
  }

  return entries.filter((entry) => entry.bullets.length > 0);
}

/** What the banner shows. Its version is the changelog's word, not package.json's. */
export const latestChange: ChangelogEntry | undefined = parseChangelog(raw)[0];
