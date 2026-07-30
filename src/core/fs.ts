import { readdir, stat } from "node:fs/promises";

/** Small filesystem questions, answered without throwing on "it isn't there". */

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
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
 * True when the path is absent or an empty directory.
 *
 * "Absent" counts as empty because the only caller asks whether it may create a
 * repository here, and an absent directory is the ideal answer to that.
 */
export async function isEmptyOrMissing(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return true;
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
