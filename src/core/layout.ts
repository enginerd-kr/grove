import { basename, isAbsolute, join, relative, sep } from "node:path";
import { GroveError } from "./errors.ts";

/**
 * Where things go, as pure functions.
 *
 * Nothing here touches the filesystem, which is what lets the naming rules —
 * the part users notice and complain about — be pinned down by a table of
 * examples instead of a temp directory.
 */

/** The bare clone, kept inside the repo directory so one folder holds everything. */
export const BARE_DIR = ".bare";

export type RepoPaths = {
  /** The directory holding `.bare` and every worktree. */
  readonly root: string;
  readonly bare: string;
  /** `<root>/.git`, a file pointing at `.bare` so git works from the root too. */
  readonly gitFile: string;
};

export function repoPaths(root: string): RepoPaths {
  return { root, bare: join(root, BARE_DIR), gitFile: join(root, ".git") };
}

/** The contents of `<root>/.git`. Relative so the repo folder can be moved. */
export const GIT_FILE_CONTENTS = `gitdir: ./${BARE_DIR}\n`;

/**
 * Directory names we must never hand back, whatever the branch was called.
 *
 * `.bare` and `.git` would collide with the repository's own plumbing; `.` and
 * `..` would resolve outside the folder entirely.
 */
const RESERVED = new Set(["", ".", "..", BARE_DIR, ".git"]);

/**
 * One path segment, made safe to put on a filesystem.
 *
 * Case is preserved deliberately. Lowercasing would map `Feat` and `feat` onto
 * one directory and invent a collision between two branches git considers
 * distinct.
 *
 * The result can be empty — a segment of nothing but dots and dashes has no
 * usable name — which `worktreeRelPath` turns into an error naming `--dir`.
 */
export function slugifySegment(segment: string): string {
  return segment
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
}

/**
 * A branch's worktree directory, relative to the repo root.
 *
 * The branch's own shape is kept: `feat/test` becomes `feat/test`, a directory
 * inside `feat/`. Flattening it to `feat-test` would throw away the grouping
 * the slashes were there to express — with thirty branches, `feat/`, `fix/`,
 * and `chore/` are how you find anything — and it is also what git does with
 * refs, so the tree on disk mirrors the tree in `refs/heads`.
 *
 * Note this makes `feat` and `feat/test` mutually exclusive as branches, since
 * one would have to be both a directory and a worktree. git already forbids
 * exactly that pair as a ref D/F conflict, so the filesystem agrees with it.
 */
export function worktreeRelPath(branch: string, override?: string): string {
  if (override !== undefined) return checkedOverride(override);

  const segments = branch
    .split("/")
    .map(slugifySegment)
    .filter((s) => s.length > 0);

  if (segments.length === 0 || segments.some((s) => RESERVED.has(s))) {
    throw new GroveError(
      "usage",
      `cannot derive a directory from branch ${JSON.stringify(branch)}`,
      {
        hint: "pass --dir <path> to choose one",
      },
    );
  }

  return segments.join("/");
}

/**
 * Validates `--dir` rather than rewriting it.
 *
 * Someone naming a directory explicitly means it, so a silently slugified
 * result would be worse than a refusal. Nesting is allowed — the default is
 * nested now — but the path must stay inside the repo folder, or the worktree
 * lands somewhere discovery will never find it again.
 */
function checkedOverride(override: string): string {
  const segments = override.split(/[/\\]/);
  const bad =
    override.startsWith("/") ||
    override.startsWith("\\") ||
    /^[A-Za-z]:/.test(override) ||
    segments.length === 0 ||
    segments.some((segment) => RESERVED.has(segment));

  if (bad) {
    throw new GroveError(
      "usage",
      `--dir must be a path inside the repo, got ${JSON.stringify(override)}`,
      {
        hint: "a relative path such as `feat/login`; no leading slash, no `..`",
      },
    );
  }

  return segments.join("/");
}

/**
 * True when `cwd` is inside `path` — the worktree you are standing in.
 *
 * A string prefix would call `/a/bc` a child of `/a/b`, which is how a command
 * ends up refusing, or acting on, the wrong directory.
 */
export function contains(path: string, cwd: string): boolean {
  if (cwd === path) return true;

  const rel = relative(path, cwd);

  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Does this look like something git could clone?
 *
 * A shape check, not a reachability check — the point is to fail on an obvious
 * typo before spawning a clone that would take a while to say the same thing.
 */
export function looksLikeRepoUrl(url: string): boolean {
  if (url.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return true;
  // scp-style, the form `git@github.com:org/repo.git` takes.
  if (/^[^/\s]+@[^/\s]+:/.test(url)) return true;

  return (
    url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || url.startsWith("~")
  );
}

/**
 * The directory name a clone gets when the user does not supply one.
 *
 * Mirrors what `git clone` itself would pick, minus the `.git` suffix that a
 * bare remote usually carries and that nobody wants in a working directory.
 */
export function repoNameFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  const tail =
    trimmed.includes(":") && !trimmed.includes("/")
      ? (trimmed.split(":").pop() ?? trimmed)
      : basename(trimmed);
  const name = tail.replace(/\.git$/i, "");

  if (RESERVED.has(name)) {
    throw new GroveError("usage", `cannot derive a directory name from ${JSON.stringify(url)}`, {
      hint: "pass a directory explicitly: grove clone <url> <dir>",
    });
  }

  return name;
}
