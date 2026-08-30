import { describe, expect, test } from "bun:test";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import { managedRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove list` through the real binary.
 *
 * Everything about *what* a summary says is in `list.test.ts`, which holds the
 * `WorktreeSummary[]` itself. What is left here is the one thing a direct call
 * cannot be asked about: which of the two streams each half of the output lands
 * on. `--json` exists to be piped into `jq`, and the guarantee that makes that
 * work — the document alone on stdout, every word of progress on stderr, even
 * with `--verbose` turned all the way up — is composed in `cli/run.ts` out of a
 * reporter that a function call never goes near.
 */

type Summary = {
  readonly dir: string;
  readonly branch?: string;
  readonly dirty: boolean;
  readonly isDefault: boolean;
  readonly upstream?: string;
};

describe("--json", () => {
  test("goes to stdout while the progress goes to stderr", async () => {
    await withTempRepo(async (temp) => {
      const repo = await managedRepo(temp);

      // `--verbose` is the loudest this gets: every git command, its exit code
      // and its timing. None of it may reach the stream `jq` is reading.
      const result = await runCli(["list", "--json", "--verbose"], { cwd: repo.root });

      expect(result.exitCode).toBe(ExitCode.ok);
      expect(result.stderr).toContain("git ");
      expect(result.stderr).toContain("rev-parse");
      expect(result.stdout).not.toContain("rev-parse");

      const parsed = JSON.parse(result.stdout) as readonly Summary[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        dir: "main",
        branch: "main",
        dirty: false,
        isDefault: true,
        upstream: "origin/main",
      });
    });
  }, 60_000);
});
