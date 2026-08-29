import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childDirectories,
  entryExists,
  isDirectory,
  isDirectoryEntry,
  isEmptyOrMissing,
  pathExists,
} from "./fs.ts";

/**
 * A scratch directory holding one of everything these functions must tell apart.
 *
 * Canonicalised for the same reason `withTempRepo` does it: on macOS `tmpdir()`
 * is a symlink, and a test about symlinks should not have one in its root path
 * by accident.
 */
type Fixture = {
  readonly dir: string;
  readonly file: string;
  readonly subdir: string;
  readonly emptyDir: string;
  readonly linkToDir: string;
  readonly linkToFile: string;
  readonly dangling: string;
  readonly missing: string;
};

async function withFixture(body: (paths: Fixture) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "grove-fs-")));

  try {
    const paths: Fixture = {
      dir,
      file: join(dir, "a file.txt"),
      subdir: join(dir, "subdir"),
      emptyDir: join(dir, "empty"),
      linkToDir: join(dir, "link-to-dir"),
      linkToFile: join(dir, "link-to-file"),
      dangling: join(dir, "dangling"),
      missing: join(dir, "nothing-here"),
    };

    await writeFile(paths.file, "content\n");
    await mkdir(paths.subdir);
    await writeFile(join(paths.subdir, "inner.txt"), "inner\n");
    await mkdir(paths.emptyDir);
    await symlink(paths.subdir, paths.linkToDir);
    await symlink(paths.file, paths.linkToFile);
    await symlink(join(dir, "gone"), paths.dangling);

    await body(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("pathExists", () => {
  test("follows links, so a dangling one counts as absent", async () => {
    await withFixture(async (paths) => {
      expect(await pathExists(paths.dir)).toBe(true);
      expect(await pathExists(paths.file)).toBe(true);
      expect(await pathExists(paths.linkToDir)).toBe(true);
      expect(await pathExists(paths.linkToFile)).toBe(true);
      expect(await pathExists(paths.dangling)).toBe(false);
      expect(await pathExists(paths.missing)).toBe(false);
    });
  });
});

describe("entryExists", () => {
  test("sees the link itself, dangling or not", async () => {
    await withFixture(async (paths) => {
      expect(await entryExists(paths.file)).toBe(true);
      expect(await entryExists(paths.subdir)).toBe(true);
      expect(await entryExists(paths.linkToFile)).toBe(true);
      // The distinction that stops `setup` writing to a path it was told was free.
      expect(await entryExists(paths.dangling)).toBe(true);
      expect(await pathExists(paths.dangling)).toBe(false);
      expect(await entryExists(paths.missing)).toBe(false);
    });
  });
});

describe("isDirectory", () => {
  test("a link to a directory is a directory", async () => {
    await withFixture(async (paths) => {
      expect(await isDirectory(paths.dir)).toBe(true);
      expect(await isDirectory(paths.subdir)).toBe(true);
      expect(await isDirectory(paths.linkToDir)).toBe(true);
      expect(await isDirectory(paths.file)).toBe(false);
      expect(await isDirectory(paths.linkToFile)).toBe(false);
      expect(await isDirectory(paths.dangling)).toBe(false);
      expect(await isDirectory(paths.missing)).toBe(false);
    });
  });
});

describe("isDirectoryEntry", () => {
  test("a link to a directory is not a directory entry", async () => {
    await withFixture(async (paths) => {
      expect(await isDirectoryEntry(paths.subdir)).toBe(true);
      // The pair that keeps `setup`'s copy from descending through a link.
      expect(await isDirectoryEntry(paths.linkToDir)).toBe(false);
      expect(await isDirectory(paths.linkToDir)).toBe(true);
      expect(await isDirectoryEntry(paths.file)).toBe(false);
      expect(await isDirectoryEntry(paths.linkToFile)).toBe(false);
      expect(await isDirectoryEntry(paths.dangling)).toBe(false);
      expect(await isDirectoryEntry(paths.missing)).toBe(false);
    });
  });
});

describe("isEmptyOrMissing", () => {
  test("an empty directory and an absent path are both fine to build in", async () => {
    await withFixture(async (paths) => {
      expect(await isEmptyOrMissing(paths.emptyDir)).toBe(true);
      expect(await isEmptyOrMissing(paths.missing)).toBe(true);
    });
  });

  test("anything inside counts, including a lone dotfile", async () => {
    await withFixture(async (paths) => {
      expect(await isEmptyOrMissing(paths.dir)).toBe(false);
      expect(await isEmptyOrMissing(paths.subdir)).toBe(false);

      await writeFile(join(paths.emptyDir, ".hidden"), "");
      expect(await isEmptyOrMissing(paths.emptyDir)).toBe(false);
    });
  });

  test("a directory holding only a dangling symlink is not empty", async () => {
    await withFixture(async (paths) => {
      await symlink(join(paths.emptyDir, "gone"), join(paths.emptyDir, "link"));

      expect(await isEmptyOrMissing(paths.emptyDir)).toBe(false);
    });
  });

  // The distinction `grove clone` guards on: a file at the target path is
  // something, so the clone is refused there rather than failing inside git.
  test("a regular file is neither absent nor an empty directory", async () => {
    await withFixture(async (paths) => {
      expect(await isEmptyOrMissing(paths.file)).toBe(false);
    });
  });
});

describe("childDirectories", () => {
  test("lists immediate subdirectories only", async () => {
    await withFixture(async (paths) => {
      expect([...(await childDirectories(paths.dir))].sort()).toEqual(["empty", "subdir"]);
    });
  });

  test("a link to a directory is not one of them", async () => {
    await withFixture(async (paths) => {
      expect(await childDirectories(paths.dir)).not.toContain("link-to-dir");
    });
  });

  test("an unreadable path is nothing rather than a throw", async () => {
    await withFixture(async (paths) => {
      expect(await childDirectories(paths.emptyDir)).toEqual([]);
      expect(await childDirectories(paths.missing)).toEqual([]);
      expect(await childDirectories(paths.file)).toEqual([]);
      expect(await childDirectories(paths.dangling)).toEqual([]);
    });
  });
});
