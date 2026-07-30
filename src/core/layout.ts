import { basename, join } from "node:path";
import { WtError } from "./errors.ts";

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
 * A branch name as a directory name: `feat/login` becomes `feat-login`.
 *
 * Case is preserved deliberately. Lowercasing would map `Feat/Login` and
 * `feat/login` onto one directory and invent a collision between two branches
 * git considers distinct.
 *
 * The result can be empty — a branch of nothing but slashes and dots has no
 * usable name — so callers go through `worktreeDirName`, which turns that into
 * an error naming `--dir`.
 */
export function slugify(branch: string): string {
  return branch
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
}

/**
 * The directory a branch's worktree gets, or an explicit `--dir` override.
 *
 * An override still has to be a single safe path segment: `--dir ../elsewhere`
 * would put a worktree outside the repo folder, where nothing else would find
 * it again.
 */
export function worktreeDirName(branch: string, override?: string): string {
  if (override !== undefined) {
    if (override.includes("/") || override.includes("\\") || RESERVED.has(override)) {
      throw new WtError(
        "usage",
        `--dir must be a single directory name, got ${JSON.stringify(override)}`,
      );
    }

    return override;
  }

  const slug = slugify(branch);
  if (RESERVED.has(slug)) {
    throw new WtError(
      "usage",
      `cannot derive a directory name from branch ${JSON.stringify(branch)}`,
      { hint: "pass --dir <name> to choose one" },
    );
  }

  return slug;
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
    throw new WtError("usage", `cannot derive a directory name from ${JSON.stringify(url)}`, {
      hint: "pass a directory explicitly: wt clone <url> <dir>",
    });
  }

  return name;
}
