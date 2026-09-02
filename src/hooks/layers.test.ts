import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { entryExists } from "../core/fs.ts";
import { pendingCommands } from "./command.ts";
import { HOOKS_FILE, LOCAL_HOOKS_FILE, platformKeyFor } from "./config.ts";
import { runSetup } from "./setup.ts";
import { repoHooks } from "./source.ts";
import { lines, refusalFromRun, setUp, withRepo } from "./test-utils.ts";
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
const HERE = platformKeyFor(process.platform);

describe("layers", () => {
  test("the nearest layer that speaks for a key wins the whole of it", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureGlobal('[setup]\ncopy = [".npmrc"]\n');
      await fixture.configure('[setup]\ncopy = [".env"]\nrun = ["true"]\n');
      await fixture.configureLocal('[setup]\ncopy = ["certs"]\nrun = ["false"]\n');

      const hooks = await repoHooks(fixture.repo);

      // Not the three lists appended: the highest file that says anything about
      // a key is the answer for it, and the ones below are the default it did
      // not need to write.
      expect(hooks.copy).toEqual(["certs"]);
      expect(lines(hooks.commands)).toEqual(["false"]);
      expect(hooks.layers.map((layer) => layer.gated)).toEqual([false, true, false]);
    });
  });

  test("a key nobody above spoke for keeps the one below's answer", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nlink = ["node_modules"]\nrun = ["true"]\n');
      // Says something about `link` and nothing about `run`, which leaves the
      // project's install exactly where it was.
      await fixture.configureLocal("[setup]\nlink = []\n");

      const hooks = await repoHooks(fixture.repo);

      expect(hooks.link).toEqual([]);
      expect(lines(hooks.commands)).toEqual(["true"]);
    });
  });

  test("an empty list is a thing to say, and it is how a line is turned off", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nrun = ["touch theirs.txt"]\n');
      // The line you can read, rather than the comment nobody can see: a `run`
      // commented out in here is a file that said nothing, and the project's
      // still stands.
      await fixture.configureLocal('[setup]\n# run = ["touch theirs.txt"]\n');

      expect(lines((await repoHooks(fixture.repo)).commands)).toEqual(["touch theirs.txt"]);

      await fixture.configureLocal("[setup]\nrun = []\n");

      expect((await repoHooks(fixture.repo)).commands).toEqual([]);
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

  test("a list written for another platform has said nothing here", async () => {
    await withRepo(async (fixture) => {
      const elsewhere = HERE === "macos" ? "linux" : "macos";
      await fixture.configureGlobal(`[setup.copy]\n${HERE} = [".npmrc"]\n`);
      await fixture.configure('[setup]\ncopy = [".env"]\n');
      await fixture.configureLocal(`[setup.copy]\n${elsewhere} = ["certs"]\n`);

      const hooks = await repoHooks(fixture.repo);

      // The top layer wrote its copy for another machine, so it silences
      // nothing here and the project's answer stands — and it is still counted
      // as having asked, so the run does not call the file absent.
      expect(hooks.copy).toEqual([".env"]);
      expect(hooks.elsewhere).toBe(1);
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

describe("which file a command came from", () => {
  test("a run says nothing extra when there is only one file it could be", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureLocal('[setup]\nrun = ["touch mine.txt"]\n');

      await setUp(fixture);

      // One file is every ordinary repository, and there the name would be the
      // answer to a question nobody could ask.
      expect(fixture.log.succeeded).toContain("ran touch mine.txt");
    });
  });

  test("a run names its file once there is more than one", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nrun = ["touch theirs.txt"]\n');
      await fixture.configureLocal('[setup]\nrun = ["touch mine.txt"]\n');

      await setUp(fixture);

      // Which file won is the fact the run would otherwise leave somebody to
      // find by diffing the two.
      expect(fixture.log.succeeded).toContain(`ran touch mine.txt (${LOCAL_HOOKS_FILE})`);
    });
  });

  test("the file is named on the failure too, which is where it is wanted most", async () => {
    await withRepo(async (fixture) => {
      await fixture.configureGlobal('[setup]\nrun = ["true"]\n');
      await fixture.configureLocal('[setup]\nrun = ["exit 3"]\n');

      const result = await setUp(fixture);

      expect(fixture.log.failed.join("\n")).toContain(`exit 3 (${LOCAL_HOOKS_FILE}) exited 3`);
      // What the caller raises stays the command line alone: the sentence it
      // makes is about what failed, and the file is on the step above it.
      expect(result.failed?.command).toBe("exit 3");
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

  test("a run of your own replaces the project's, and the gate goes with it", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nrun = ["touch theirs.txt"]\n');
      await fixture.configureLocal('[setup]\nrun = ["touch mine.txt"]\n');

      const result = await setUp(fixture);

      // Nothing that a pull could have written is left to run, so there is
      // nothing to agree to: the project's line is not held back, it is gone.
      expect(result.untrusted).toBe(false);
      expect(result.ran).toEqual(["touch mine.txt"]);
      expect(await entryExists(join(fixture.worktree, "theirs.txt"))).toBe(false);
      expect(fixture.log.warnings.join("\n")).not.toContain("not been trusted");
    });
  });

  test("a run the project still owns waits, whatever else your file says", async () => {
    await withRepo(async (fixture) => {
      await fixture.configure('[setup]\nrun = ["touch theirs.txt"]\n');
      // Speaks for `copy` and not for `run`, so the project's command is still
      // the one that would run, and still the one to be read first.
      await fixture.configureLocal("[setup]\ncopy = []\n");

      const result = await setUp(fixture);

      expect(result.untrusted).toBe(true);
      expect(result.ran).toEqual([]);
      expect(fixture.log.warnings.join("\n")).toContain(`1 command in main/${HOOKS_FILE}`);
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
      // Both files are gated and both are covered, and the higher one is still
      // the one that says what runs.
      expect(ran.ran).toEqual(["touch mine.txt"]);

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
      // gated, so it is not part of what the record covers — and it is under
      // the project's file, which is why its `run` is the one that gives way.
      await fixture.configureGlobal('[setup]\nrun = ["touch mine.txt"]\n');

      const result = await setUp(fixture);

      expect(result.untrusted).toBe(false);
      expect(result.ran).toEqual(["touch theirs.txt"]);
    });
  });
});
