import { expect, test } from "bun:test";
import { version } from "../../../package.json";
import { latestChange, parseChangelog } from "./changelog.ts";

const FIXTURE = `# Changelog

Prose up here explains the file and is not an entry.

## 2.1.0 — 2026-08-05

- The newest thing
- The second newest thing

### A subsection heading is commentary

## 2.0.0

Some prose inside an entry.

- The older thing
  - an indented sub-bullet, not read

## 1.9.0 — 2026-01-01
`;

test("entries come out in file order with only their top-level bullets", () => {
  expect(parseChangelog(FIXTURE)).toEqual([
    { version: "2.1.0", bullets: ["The newest thing", "The second newest thing"] },
    { version: "2.0.0", bullets: ["The older thing"] },
  ]);
});

test("a date after the version is not part of the version", () => {
  expect(parseChangelog("## 3.0.0 — 2026-08-05\n- a\n")[0]?.version).toBe("3.0.0");
});

test("an entry with nothing to say is dropped — 1.9.0 has no bullets", () => {
  expect(parseChangelog(FIXTURE).map((entry) => entry.version)).not.toContain("1.9.0");
});

test("bullets before any heading belong to nobody", () => {
  expect(parseChangelog("- stray\n## 1.0.0\n- kept\n")).toEqual([
    { version: "1.0.0", bullets: ["kept"] },
  ]);
});

test("empty input parses to nothing", () => {
  expect(parseChangelog("")).toEqual([]);
});

// The one lock that matters: a version bump without a changelog entry fails here,
// before the release workflow's guard ever sees a tag.
test("CHANGELOG.md leads with the version package.json claims", () => {
  expect(latestChange?.version).toBe(version);
});
