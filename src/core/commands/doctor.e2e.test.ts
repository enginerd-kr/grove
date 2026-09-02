import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { managedRepo, seedGit, withTempRepo } from "../test-utils.ts";

/**
 * `grove doctor` through the real binary.
 *
 * `doctor` is meant to be put in CI, and the two tests here are the two
 * promises that makes to whatever is running it. The first is the severity
 * rule: an error exits 6 and a warning exits 0, so a repository that is merely
 * untidy does not fail somebody's pipeline. `doctor.test.ts` asserts that rule
 * where it is decided — `failureFor` returns an error or it does not — but the
 * decision only matters because of the number at the end of it, and the chain
 * from finding to number runs through `cli/run.ts`, which prints the report and
 * *then* throws. That ordering is the second promise, and a direct call cannot
 * see it: the findings are what was asked for, so they reach stdout even on the
 * run that fails.
 *
 * The `--json` document is here for the same reason it is in every other e2e
 * file. It is also how these tests used to be written — the old `diagnose()`
 * helper in `doctor.test.ts` was `runCli(["doctor", "--json"])` and a
 * `JSON.parse` — so this is the one place that still checks the round trip the
 * rest of them have stopped paying for.
 */

type Finding = {
  readonly check: string;
  readonly severity: "error" | "warning";
  readonly summary: string;
  readonly details: readonly string[];
  readonly fix: readonly string[];
};

type Diagnosis = {
  readonly root: string;
  readonly gitDir: string;
  readonly kind: string;
  readonly grove: string;
  readonly git: string;
  readonly checked: number;
  readonly findings: readonly Finding[];
};

describe("what the shell is left with", () => {
  test("a clean repository exits 0 and prints the report on stdout", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      const result = await runCli(["doctor"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stdout).toContain(`${repo.root}  (managed)`);
      expect(result.stdout).toContain("nothing to report — 7 checks, all clean");
    });
  }, 60_000);

  test("an error exits 6 and a warning exits 0, with the report on stdout either way", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      const root = repo.root;

      // What `git worktree prune` leaves: untidy, and nothing a pipeline should
      // fall over. A command that failed CI over one would not be left in CI.
      await mkdir(join(root, "stray"), { recursive: true });
      await Bun.write(join(root, "stray", ".git"), "gitdir: ../.bare/worktrees/stray\n");

      const warned = await runCli(["doctor"], { cwd: root });

      expect(warned.exitCode).toBe(ExitCode.ok);
      expect(warned.stdout).toContain("! 1 directory left behind by a pruned worktree");
      // Exit 0 and a finding at once, which is the whole of the severity rule.
      expect(warned.stdout).toContain("1 warning, out of 10 checks");

      // Now an error beside it: `git fetch` exiting 0 having updated nothing.
      await seedGit(repo.gitDir, ["config", "--unset", "remote.origin.fetch"]);

      const failed = await runCli(["doctor"], { cwd: root });

      expect(failed.exitCode).toBe(ExitCode.stateConflict);
      // Printed first, then thrown: the findings are what was asked for, so
      // they are on stdout even on the run that fails — a `doctor || true` in a
      // build script still gets the report it went there for.
      expect(failed.stdout).toContain("✗ origin has no fetch refspec");
      expect(failed.stdout).toContain(`    → git -C ${repo.gitDir} config remote.origin.fetch`);
      expect(failed.stdout).toContain("1 problem and 1 warning, out of 10 checks");
      // And the sentence for the person is on the other stream, so nothing a
      // `jq` or a `grep` reads on stdout is the failure rather than a finding.
      expect(failed.stderr).toContain("the repository has 1 problem");
      expect(failed.stdout).not.toContain("the repository has 1 problem");
    });
  }, 60_000);

  test("--json is the whole diagnosis, on stdout, and still exits 6", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);
      await seedGit(repo.gitDir, ["config", "--unset", "remote.origin.fetch"]);

      const result = await runCli(["doctor", "--json"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.stateConflict);

      const diagnosis = JSON.parse(result.stdout) as Diagnosis;

      // Every field of the `Diagnosis` survives the trip out, findings and all
      // — including the two versions the header exists for, since a report
      // pasted into an issue is the reason this document has them.
      expect(diagnosis).toMatchObject({
        root: repo.root,
        gitDir: repo.gitDir,
        kind: "managed",
        checked: 7,
      });
      expect(diagnosis.grove).toMatch(/^\d+\./);
      expect(diagnosis.git).toMatch(/^\d+\.\d+/);
      expect(diagnosis.findings).toHaveLength(1);
      expect(diagnosis.findings[0]).toMatchObject({
        check: "fetch-refspec",
        severity: "error",
      });
      // The rendered report is for eyes and has no business on the stream a
      // program is parsing.
      expect(result.stdout).not.toContain("✗");
    });
  }, 60_000);
});
