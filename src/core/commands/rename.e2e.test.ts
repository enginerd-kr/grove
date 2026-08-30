import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { pathExists } from "../fs.ts";
import { managedRepo, seedWorktree, withTempRepo } from "../test-utils.ts";

/**
 * `grove rename` through the real binary.
 *
 * Everything `renameWorktree` decides is asserted in `rename.test.ts`, by
 * calling it. What is left here is what only a process can be asked for: the
 * `cd "$(grove path …)"` sentence composed for somebody standing in the
 * directory that moved, the relative path `display()` renders it against, the
 * `--json` document a `jq` reader is written against, the rule that stdout
 * carries the row while stderr carries everything said to a person, and the
 * exit code a wrapper script branches on. None of those live in `rename.ts` —
 * they are composed in `cli/run.ts` and reported by `cli.tsx` — so a direct
 * call cannot see them at all.
 *
 * The repository is still built in-process: only the act under test needs to be
 * a subprocess, and arranging one through `grove clone` and `grove add` would
 * cost two processes to observe one.
 */

/** The half of `RenameResult` the `--json` tests read back off stdout. */
type RenameJson = {
  readonly from: string;
  readonly to: string;
  readonly path: string;
  readonly dir: string;
  readonly moved: boolean;
  readonly pushed: boolean;
  readonly upstreamNote?: string;
  readonly standingInOldPath: boolean;
};

describe("grove rename", () => {
  test("the upstream note reaches the person on stderr, and never stdout", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedWorktree(repo, "feat/logn", { push: true });

      // The note itself is `renameWorktree`'s, and asserted in `rename.test.ts`.
      // What costs a process to pin is that the CLI says it at all, and says it
      // where a caller reading stdout for the row will not trip over it.
      const renamedCli = await runCli(["rename", "feat/logn", "signin"], { cwd: repo.root });

      expect(renamedCli.exitCode).toBe(ExitCode.ok);
      expect(renamedCli.stderr).toContain("still tracking origin/feat/logn");
      expect(renamedCli.stdout).toBe("signin\tsignin\n");
    });
  });

  test("a refusal reaches the shell as the exit code a script branches on", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // `rename.test.ts` holds each `GroveError` and composes its exit code with
      // `errorToExitCode`. This is the one that lets nothing compose: the
      // binary really does exit 4 on a refusal, and 4 is what a wrapper script
      // reads instead of grepping the sentence beside it.
      const trunk = await runCli(["rename", "main", "trunk"], { cwd: repo.root });

      expect(trunk.exitCode).toBe(ExitCode.refused);
      expect(trunk.stderr).toContain("everything else syncs onto");
      // A failure prints nothing a pipe would mistake for a result.
      expect(trunk.stdout).toBe("");
    });
  });

  test("renaming the directory you are standing in says where it went", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "solo");

      // The shell follows the directory by inode, so nothing breaks and `pwd`
      // quietly starts naming a path that no longer exists. The sentence that
      // says so is composed in `cli/run.ts` out of `standingInOldPath`, and has
      // a shell command inside it — so only the binary can be asked for it.
      const renamedCli = await runCli(["rename", "solo", "elsewhere"], {
        cwd: join(root, "solo"),
      });

      expect(renamedCli.exitCode).toBe(ExitCode.ok);
      expect(renamedCli.stderr).toContain('cd "$(grove path elsewhere)"');
      // Printed relative to where the shell is, which is no longer inside it.
      expect(renamedCli.stdout.trim()).toBe("../elsewhere\telsewhere");
      expect(await pathExists(join(root, "elsewhere"))).toBe(true);
    });
  });

  test("--json reports standing in the old path as a fact, not as the sentence", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await seedWorktree(repo, "solo");

      const inside = await runCli(["rename", "solo", "elsewhere", "--json"], {
        cwd: join(root, "solo"),
      });
      expect(inside.exitCode).toBe(ExitCode.ok);

      const parsed = JSON.parse(inside.stdout) as RenameJson;
      expect(parsed.standingInOldPath).toBe(true);
      // Every field the result carries survives the trip out as JSON, which is
      // the contract `grove rename --json | jq` is written against.
      expect(parsed).toEqual({
        from: "solo",
        to: "elsewhere",
        path: join(root, "elsewhere"),
        dir: "elsewhere",
        moved: true,
        pushed: false,
        standingInOldPath: true,
      });
      // The document is for programs: the `cd` line still goes to the person on
      // stderr, and the shell command it contains is nowhere inside the JSON.
      expect(inside.stdout).not.toContain("grove path");
      expect(inside.stderr).toContain('cd "$(grove path elsewhere)"');

      // Present and false from anywhere else, rather than an absent field —
      // "you are not standing in it" is an answer worth being able to read.
      const outside = await runCli(["rename", "elsewhere", "back", "--json"], { cwd: root });
      expect(outside.exitCode).toBe(ExitCode.ok);
      expect((JSON.parse(outside.stdout) as RenameJson).standingInOldPath).toBe(false);
      expect(outside.stderr).not.toContain("still standing");
    });
  });
});
