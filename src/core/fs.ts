import { lstat, readdir, stat } from "node:fs/promises";

/** Small filesystem questions, answered without throwing on "it isn't there". */

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when something is at this path — including a symlink pointing at nothing.
 *
 * `pathExists` follows links, so it calls a dangling one absent, and anything
 * that then tries to create a file there fails with `EEXIST` on a path it was
 * just told was free. `setup` asks this before it writes.
 */
export async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True for a directory itself, and false for a symlink pointing at one.
 *
 * The distinction is the whole safety of `setup`'s directory copy: it descends
 * into a directory to merge the trunk's entries in, and descending through a
 * symlink would write into whatever the link points at — which, in a worktree
 * that also has a `link` line, is the trunk's copy of that directory.
 */
export async function isDirectoryEntry(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when the path is absent or an empty directory.
 *
 * "Absent" counts as empty because the only caller asks whether it may create a
 * repository here, and an absent directory is the ideal answer to that.
 *
 * A file is neither, and neither is a directory nothing may read. `readdir`
 * reports all three by throwing, so only the one that says "nothing is there"
 * — `ENOENT` — is an answer of yes: calling a file empty would send `clone`
 * past the guard that exists to stop it, to fail inside git several steps later
 * over a path it was already holding.
 */
export async function isEmptyOrMissing(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Immediate subdirectory names, or nothing if the path is unreadable. */
export async function childDirectories(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
