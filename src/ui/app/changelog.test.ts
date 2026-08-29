import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { latestChange, parseChangelog } from "./changelog.ts";

/**
 * What the banner's "What's new" column is allowed to read out of a markdown file.
 *
 * Two shapes mean anything — `## <version>` and a top-level `- ` — and the point
 * of the tests below is the everything else: prose, sub-bullets, `###`
 * headings and the file's own preamble are commentary, and a parser that let
 * any of it through would put a sentence about the release process on the
 * welcome screen.
 */

/** The real file, read at test time rather than at compile time like the module. */
const CHANGELOG = join(import.meta.dir, "../../../CHANGELOG.md");

const BODY = [
  "# Changelog",
  "",
  "The newest entry is what the banner shows. Entries begin `## <version>`.",
  "",
  "- a bullet before any heading belongs to nothing",
  "",
  "## 1.2.0 — 2026-08-29",
  "",
  "Some prose under the heading, which is commentary.",
  "",
  "- the newest thing",
  "- the other newest thing",
  "",
  "### A sub-heading",
  "",
  "  - an indented sub-bullet",
  "* a starred bullet",
  "-not a bullet either",
  "",
  "## 1.1.0",
  "",
  "- the older thing",
  "",
  "## 1.0.1 — 2026-01-01",
  "",
  "Nothing worth listing happened.",
  "",
  "## 1.0.0",
  "",
  "- the first thing",
  "",
].join("\n");

describe("parseChangelog", () => {
  test("reads a realistic body: versions in file order, bullets under each", () => {
    expect(parseChangelog(BODY)).toEqual([
      { version: "1.2.0", bullets: ["the newest thing", "the other newest thing"] },
      { version: "1.1.0", bullets: ["the older thing"] },
      { version: "1.0.0", bullets: ["the first thing"] },
    ]);
  });

  test("a section with nothing to say is dropped rather than shown empty", () => {
    expect(parseChangelog(BODY).map((entry) => entry.version)).not.toContain("1.0.1");
  });

  test("what follows the version — a date, an em dash — is not read", () => {
    const entries = parseChangelog("## 9.9.9 — 2026-08-29 (security)\n\n- something\n");

    expect(entries).toEqual([{ version: "9.9.9", bullets: ["something"] }]);
  });

  test("a pre-release is read as the version it is built on", () => {
    // `\b` ends the match at the dash, so `1.2.3-rc.1` is recorded as `1.2.3`.
    // Worth pinning: the banner would otherwise show a suffix the release
    // workflow never intended to publish.
    expect(parseChangelog("## 1.2.3-rc.1\n\n- a candidate\n")).toEqual([
      { version: "1.2.3", bullets: ["a candidate"] },
    ]);
  });

  test("a heading that is not three numbers opens nothing", () => {
    expect(parseChangelog("## Unreleased\n\n- something\n")).toEqual([]);
    expect(parseChangelog("## 1.2\n\n- something\n")).toEqual([]);
    expect(parseChangelog("# 1.2.3\n\n- something\n")).toEqual([]);
  });

  test("bullets before the first heading belong to nothing and are dropped", () => {
    expect(parseChangelog("- orphaned\n\n## 1.0.0\n\n- kept\n")).toEqual([
      { version: "1.0.0", bullets: ["kept"] },
    ]);
  });

  test("only a top-level `- ` with something after it counts", () => {
    const entries = parseChangelog(
      ["## 1.0.0", "- kept", "  - indented", "* starred", "-nospace", "- ", "-", ""].join("\n"),
    );

    expect(entries).toEqual([{ version: "1.0.0", bullets: ["kept"] }]);
  });

  test("an empty file is no entries, and so is one with no bullets at all", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("\n\n")).toEqual([]);
    expect(parseChangelog("# Changelog\n\njust prose\n")).toEqual([]);
  });

  // A CRLF checkout — `core.autocrlf` on Windows — reads the same: `.` does not
  // match a `\r`, so a line ending left on would cost every entry its bullets
  // and the banner would silently show nothing.
  test("a CRLF checkout is read like any other", () => {
    expect(parseChangelog("## 1.0.0\r\n\r\n- a bullet\r\n")).toEqual([
      { version: "1.0.0", bullets: ["a bullet"] },
    ]);
  });
});

describe("latestChange", () => {
  test("is the newest entry of the real CHANGELOG.md, as this parser reads it", async () => {
    // Compared against the file rather than a version literal: the module reads
    // it at compile time, and a hard-coded number would be wrong by the next
    // release rather than at the moment the parser broke.
    const entries = parseChangelog(await Bun.file(CHANGELOG).text());

    expect(latestChange).toEqual(entries[0]);
  });

  test("has a version and at least one bullet, which is what the banner draws", () => {
    expect(latestChange?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(latestChange?.bullets.length ?? 0).toBeGreaterThan(0);
  });

  test("the real file's entries are ordered newest first", async () => {
    const entries = parseChangelog(await Bun.file(CHANGELOG).text());
    const rank = (version: string) =>
      version.split(".").reduce((total, part) => total * 1000 + Number(part), 0);

    expect(entries.length).toBeGreaterThan(1);
    for (const [index, entry] of entries.slice(1).entries()) {
      const newer = entries[index];
      expect(newer === undefined || rank(newer.version) > rank(entry.version)).toBe(true);
    }
  });
});
