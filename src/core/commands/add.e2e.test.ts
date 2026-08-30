import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { entryExists } from "../fs.ts";
import { managedRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove add` through the real binary.
 *
 * Everything about what `add` decides is in `add.test.ts`, which calls
 * `addWorktree` directly and holds the `AddResult` and the `GroveError` that a
 * process throws away. What is left here is the three things only a process
 * has: the `--json` document as a program actually receives it, the sentence
 * `cli/run.ts` composes about a `--take` that emptied somebody's directory, the
 * number the shell is left holding when the command refuses, and what `[setup]
 * open` decides when nobody is watching the run.
 *
 * None of the four could move in-process, because none of them exists there:
 * the document is `JSON.stringify` in `run.ts`, the sentence is built in
 * `run.ts` out of `took.stash`, an exit code is what `cli.tsx` makes of a
 * `GroveError` on its way out — and whether there is a terminal to open into is
 * a fact about a process's own stdout, which `run.ts` reads and hands down. A
 * test that called `runSetup` would be choosing the answer rather than finding
 * it out. The repository these run against is still built
 * in-process — `managedRepo` rather than `grove clone` — because a fixture is
 * never what a test is about.
 */

type AddJson = {
  readonly path: string;
  readonly dir: string;
  readonly branch: string;
  readonly source: "existing" | "remote" | "new";
  readonly upstream?: string;
  readonly alreadyPresent: boolean;
};

describe("grove add", () => {
  test("--json names the directory the way the list does", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      const added = await runCli(["add", "feat/login", "--json"], { cwd: root });
      expect([added.exitCode, added.stderr]).toEqual([ExitCode.ok, added.stderr]);

      // The whole of stdout is the document: `grove add --json | jq` has to
      // work while the steps are being narrated beside it.
      const nested = JSON.parse(added.stdout) as AddJson;
      // Repo-root-relative and `/`-separated whatever the platform's separator
      // is — the spelling `path`, `reset` and `rename` already answer with, so
      // a `--json` reader can line this row up with `grove list` without
      // re-deriving it from the absolute path beside it.
      expect(nested.dir).toBe("feat/login");
      expect(nested.path).toBe(join(root, "feat", "login"));
      expect([nested.source, nested.upstream]).toEqual(["remote", "origin/feat/login"]);
      expect(nested.alreadyPresent).toBe(false);
      // The narration happened — it just happened on the other stream.
      expect(added.stderr).toContain("added feat/login");

      // The command's other way out: a worktree that was already there answers
      // with the same fields rather than dropping them.
      const again = await runCli(["add", "feat/login", "--json"], { cwd: root });
      expect(again.exitCode).toBe(ExitCode.ok);

      const repeated = JSON.parse(again.stdout) as AddJson;
      expect([repeated.alreadyPresent, repeated.dir]).toEqual([true, "feat/login"]);
      expect(again.stderr).toContain("feat/login already has a worktree");
    });
  }, 60_000);

  test("--take says out loud which sha puts the changes back", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const main = join(repo.root, "main");

      await Bun.write(join(main, "app.txt"), "two\n");

      const result = await runCli(["add", "wip", "--take"], { cwd: main });

      expect(result.exitCode).toBe(ExitCode.ok);
      // `add.test.ts` holds the sha as `took.stash`; the sentence around it is
      // composed here, in `run.ts`, and has a shell command inside it — which
      // is why it is on stderr and not in the result a program reads.
      expect(result.stderr).toContain("git stash apply");
      expect(result.stdout).toBe("../wip\twip\n");
      expect(await Bun.file(join(repo.root, "wip", "app.txt")).text()).toBe("two\n");
    });
  }, 60_000);

  test("a refusal reaches the shell as the exit code a script branches on", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;
      await mkdir(join(root, "occupied"), { recursive: true });

      // `add.test.ts` holds each of these as a `GroveError` and composes its
      // number with `errorToExitCode`. This is the one that lets nothing
      // compose: the binary really does exit 6 on a state conflict and 2 on a
      // usage error, and those are what a wrapper script reads instead of
      // grepping the sentence beside them.
      const occupied = await runCli(["add", "occupied"], { cwd: root });

      expect(occupied.exitCode).toBe(ExitCode.stateConflict);
      expect(occupied.stderr).toContain("occupied already exists");
      // A failure prints nothing a pipe would mistake for a result.
      expect(occupied.stdout).toBe("");

      const nowhere = await runCli(["add", "other", "--from", "nowhere"], { cwd: root });

      expect(nowhere.exitCode).toBe(ExitCode.usage);
      expect(nowhere.stderr).toContain('cannot start a branch from "nowhere"');
      expect(nowhere.stdout).toBe("");
    });
  }, 60_000);

  test("runs the commands but opens nothing when nobody is watching", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      await Bun.write(
        join(root, "main", ".grove.toml"),
        '[setup]\nrun = ["touch ran.txt"]\nopen = "touch opened.txt"\n',
      );

      // `runCli` gives the child pipes, which is the whole point: this is
      // `grove add | tee` and CI, and it is the one place the tool is allowed
      // to behave differently under a terminal.
      const added = await runCli(["add", "feat/login", "--trust"], { cwd: root });

      expect([added.exitCode, added.stderr]).toEqual([ExitCode.ok, added.stderr]);

      const worktree = join(root, "feat", "login");
      // `run` is unaffected. Only the key whose subject is a person is skipped,
      // and it says so rather than leaving the silence to be worked out.
      expect(await entryExists(join(worktree, "ran.txt"))).toBe(true);
      expect(await entryExists(join(worktree, "opened.txt"))).toBe(false);
      expect(added.stderr).toContain("did not open: this is not a terminal");
    });
  }, 60_000);
});
