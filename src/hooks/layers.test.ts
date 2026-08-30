import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { entryExists } from "../core/fs.ts";
import { pendingCommands } from "./command.ts";
import { HOOKS_FILE, LOCAL_HOOKS_FILE, openTargetFor, repoHooks } from "./config.ts";
import { runSetup } from "./setup.ts";
import { refusalFromRun, setUp, withRepo } from "./test-utils.ts";
import { fingerprintOf, trust } from "./trust.ts";

/**
 * The three files, and what stacking them means.
 *
 * `config.test.ts` is about one file's contents; this is about which file a
 * line came from and what follows from that. Two things follow, and they are
 * the whole subject here: what the merged answer is, and which half of it the
 * trust gate is holding.
 */

/** The `open` key for the machine this is running on — the only one that runs. */
const HERE = openTargetFor(process.platform);

describe("layers", () => {
  test("each layer adds to the ones under it", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureGlobal('[setup]\ncopy = [".npmrc"]\n');
      await fixture.configure('[setup]\ncopy = [".env"]\nrun = ["true"]\n');
      await fixture.configureLocal('[setup]\ncopy = ["certs"]\nrun = ["false"]\n');

      const hooks = await repoHooks(fixture.repo);

      // Lowest first, which is also the order the commands run in: the
      // project's install, and then the step you put on top of it.
      expect(hooks.copy).toEqual([".npmrc", ".env", "certs"]);
      expect(hooks.commands).toEqual(["true", "false"]);
      expect(hooks.layers.map((layer) => layer.gated)).toEqual([false, true, false]);
    });
  });

  test("a path named twice is one path", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nlink = ["node_modules"]\n');
      await fixture.configureLocal('[setup]\nlink = ["node_modules"]\n');

      expect((await repoHooks(fixture.repo)).link).toEqual(["node_modules"]);
    });
  });

  test("the nearest layer wins for a name, because there is only one value", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureGlobal('[setup]\nenv = { PORT = "3000", EDITOR = "vi" }\n');
      await fixture.configure('[setup]\nenv = { PORT = "4000" }\n');
      await fixture.configureLocal('[setup]\nenv = { PORT = "5173" }\n');

      const hooks = await repoHooks(fixture.repo);

      expect(hooks.env).toEqual([
        { name: "EDITOR", value: "vi" },
        { name: "PORT", value: "5173" },
      ]);
    });
  });

  test("`open` is decided per platform, so a layer may name only its own", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureGlobal('[setup]\nopen = "code ."\n');
      await fixture.configureLocal(`[setup.open]\n${HERE} = "nvim ."\n`);

      const hooks = await repoHooks(fixture.repo);

      expect(hooks.open[HERE]).toBe("nvim .");
      // The platforms the higher layer said nothing about keep the lower one's.
      for (const target of ["macos", "linux", "windows"] as const) {
        if (target !== HERE) expect(hooks.open[target]).toBe("code .");
      }
    });
  });

  test("a refusal names the file that has to be edited", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureLocal("[setup]\nrun = 42\n");

      const error = await refusalFromRun(() => repoHooks(fixture.repo));

      expect(error.message).toContain(LOCAL_HOOKS_FILE);
      expect(error.message).not.toContain(`${HOOKS_FILE}:`);
    });
  });
});

describe("the gate the layers answer to", () => {
  test("a file of your own runs without being agreed to", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureLocal('[setup]\nrun = ["touch mine.txt"]\n');

      const result = await setUp(fixture);

      expect(result.untrusted).toBe(false);
      expect(result.ran).toEqual(["touch mine.txt"]);
      expect(await entryExists(join(fixture.worktree, "mine.txt"))).toBe(true);
      // Nothing to be shown and asked about, so the screen asks nothing.
      expect(await pendingCommands(fixture.repo)).toEqual([]);
    });
  });

  test("a project file that runs nothing does not gate the one that does", async () => {
    await withRepo(async (fixture) => {
      // The committed file exists and is untrusted; it just has no commands in
      // it, so there is nothing for trust to be about.
      await fixture.configure('[setup]\ncopy = [".env"]\n');
      await Bun.write(join(fixture.trunk, ".env"), "SECRET=1\n");
      await fixture.configureLocal('[setup]\nrun = ["touch mine.txt"]\n');

      const result = await setUp(fixture);

      expect(result.untrusted).toBe(false);
      expect(result.copied).toEqual([".env"]);
      expect(result.ran).toEqual(["touch mine.txt"]);
    });
  });

  test("your commands wait with the project's, and the run says they are waiting", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nrun = ["touch theirs.txt"]\n');
      await fixture.configureLocal('[setup]\nrun = ["touch mine.txt"]\n');

      const result = await setUp(fixture);

      expect(result.untrusted).toBe(true);
      expect(result.ran).toEqual([]);
      expect(await entryExists(join(fixture.worktree, "mine.txt"))).toBe(false);
      // The count is the gated one — one command, in one file, to go and read.
      expect(fixture.log.warnings.join("\n")).toContain(`1 command in main/${HOOKS_FILE}`);
      expect(fixture.log.infos.join("\n")).toContain("1 command of your own waited");
    });
  });

  test("a committed local file is gated like any other file git could hand you", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureLocal('[setup]\nrun = ["touch mine.txt"]\n');
      await fixture.commitTrunk();

      const result = await setUp(fixture);

      expect(result.untrusted).toBe(true);
      expect(fixture.log.warnings.join("\n")).toContain(`1 command in main/${LOCAL_HOOKS_FILE}`);
    });
  });

  test("one trust covers both gated files, and an edit to either withdraws it", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nrun = ["touch theirs.txt"]\n');
      await fixture.configureLocal('[setup]\nrun = ["touch mine.txt"]\n');
      await fixture.commitTrunk();

      const hooks = await repoHooks(fixture.repo);
      await trust(fixture.repo.gitDir, hooks.fingerprint ?? "");

      const ran = await setUp(fixture);
      expect(ran.ran).toEqual(["touch theirs.txt", "touch mine.txt"]);

      // What a `git pull` does to the second file rather than the first.
      await fixture.configureLocal('[setup]\nrun = ["touch surprise.txt"]\n');
      const again = await runSetup(
        fixture.repo,
        { path: fixture.worktree },
        {},
        fixture.log.reporter,
      );

      expect(again.untrusted).toBe(true);
      expect(await entryExists(join(fixture.worktree, "surprise.txt"))).toBe(false);
    });
  });

  test("one gated file still fingerprints its own text, so an old record stands", async () => {
    await withRepo(async (fixture) => {
      const text = '[setup]\nrun = ["touch theirs.txt"]\n';
      await fixture.configure(text);
      // Written before layers existed, and about the committed file alone.
      await trust(fixture.repo.gitDir, fingerprintOf(text));

      // The machine's own layer joins in without disturbing that: it is not
      // gated, so it is not part of what the record covers.
      await fixture.configureGlobal('[setup]\nrun = ["touch mine.txt"]\n');

      const result = await setUp(fixture);

      expect(result.untrusted).toBe(false);
      expect(result.ran).toEqual(["touch mine.txt", "touch theirs.txt"]);
    });
  });
});
