import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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

/**
 * `"managed"` is a repository this tool laid out itself — `.bare` plus a `.git`
 * pointer file. `"plain"` is an ordinary `git clone`/`git init`, recognised as-is
 * rather than converted: its git dir is `<root>/.git`, and the root itself is a
 * worktree (the one nothing ever removes).
 */
export type RepoKind = "managed" | "plain";

export type RepoPaths = {
  /** The directory every worktree is found relative to. For `plain`, also a worktree itself. */
  readonly root: string;
  /** The git common dir — `<root>/.bare` or `<root>/.git` — cwd for repo-level git calls. */
  readonly gitDir: string;
  /** `<root>/.git`: a pointer file in `managed`, the same directory as `gitDir` in `plain`. */
  readonly gitFile: string;
  readonly kind: RepoKind;
};

export function repoPaths(root: string): RepoPaths {
  return { root, gitDir: join(root, BARE_DIR), gitFile: join(root, ".git"), kind: "managed" };
}

/** A repository this tool did not create — an ordinary `.git`-based clone or checkout. */
export function plainRepoPaths(root: string): RepoPaths {
  const gitDir = join(root, ".git");

  return { root, gitDir, gitFile: gitDir, kind: "plain" };
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
 * usable name — which `worktreeRelPath` turns into an error asking for a
 * different branch name.
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
export function worktreeRelPath(branch: string): string {
  const segments = branch
    .split("/")
    .map(slugifySegment)
    .filter((s) => s.length > 0);

  if (segments.length === 0 || segments.some((s) => RESERVED.has(s))) {
    throw new GroveError(
      "usage",
      `cannot derive a directory from branch ${JSON.stringify(branch)}`,
      {
        hint: "pick a branch name with letters or digits in it",
      },
    );
  }

  return segments.join("/");
}

/**
 * Where a branch's worktree goes: inside the root for a managed repository,
 * beside it for a plain one.
 *
 * A plain repository's root is itself the main checkout, so there is no spare
 * folder to nest a worktree inside — `git worktree add ../thing` is the
 * convention its users already have, and this follows it. Its name is prefixed
 * with the repository's own (`myapp-feat-login` beside `myapp`) so a shared
 * parent directory does not fill with bare branch names that collide with
 * whatever else lives there.
 *
 * One function rather than one per command, because `add` and `rename` have to
 * agree about it exactly: the whole of `rename` is moving a directory from the
 * name one branch would have been given to the name another one would, and two
 * spellings of that rule would be a rename that lands somewhere `add` would
 * never have put it.
 */
export function worktreePathFor(repo: RepoPaths, branch: string): string {
  const rel = worktreeRelPath(branch);

  if (repo.kind === "plain") {
    return join(dirname(repo.root), `${basename(repo.root)}-${rel.replaceAll("/", "-")}`);
  }

  return join(repo.root, rel);
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
