import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode } from "../../cli/exit-codes.ts";
import { runCli } from "../../cli/test-cli.ts";
import type { RepoPaths } from "../layout.ts";
import { managedRepo, probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * `grove pr` through the real binary.
 *
 * Everything `checkoutPullRequest` decides — how a head is found, what the
 * remote is spelled as, every way `gh` can disappoint — is in `pr.test.ts`,
 * which calls it directly and keeps the `PrResult` and the `GroveError`. Three
 * things could not come with it, because none of them exists inside that call:
 *
 *   - the `--json` document, which is `JSON.stringify` in `cli/run.ts`;
 *   - the two sentences `run.ts` composes about a worktree that was already
 *     there — "caught up with pull request N" and "already has a worktree" —
 *     which are the only report of what a second run did;
 *   - the exit code, which is what `cli.tsx` makes of a `GroveError` on the way
 *     out, and what a wrapper script reads instead of grepping stderr.
 *
 * The fixture is deliberately smaller than `pr.test.ts`'s. There is no fork
 * here: a cross-repository head is about where `pr.ts` looks, which is proved
 * in-process, so these pull requests are proposed from a branch of the base
 * repository and the fake `gh` only has to answer — it neither records its argv
 * nor pretends to fail, which are also questions for the other file.
 */

/** POSIX only — the fake is a shell script. */
const POSIX = process.platform !== "win32";

/** The stand-in for `gh`: it says whatever the test last wrote, and exits 0. */
const GH_FAKE = `#!/bin/sh
PATH=/usr/bin:/bin
cat "$GROVE_GH_OUT"
`;

/** A pull request proposed from `acme/widget`'s own `main`. */
const OPEN_PR: Readonly<Record<string, unknown>> = {
  number: 7,
  title: "Fix the crash",
  url: "https://github.example/acme/widget/pull/7",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "main",
  isCrossRepository: false,
  headRepository: { name: "widget" },
  headRepositoryOwner: { login: "acme" },
  author: { login: "acme" },
};

type PrJson = {
  readonly path: string;
  readonly dir: string;
  readonly branch: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly head: string;
  readonly remote?: string;
  readonly upstream?: string;
  readonly pushable: boolean;
  readonly updated: string;
  readonly alreadyPresent: boolean;
  /** Present and empty in these fixtures, and asserted on in `pr.test.ts`. */
  readonly setup?: unknown;
};

type Forge = {
  readonly temp: TempRepo;
  readonly repo: RepoPaths;
  /** The bare repository origin points at, inside a forge-shaped tree. */
  readonly base: string;
  /** What the binary is run with, so it finds the fake `gh` and its answer. */
  readonly env: Readonly<Record<string, string>>;
  /** A `PATH` holding git and bun and nothing else, for proving `gh` absent. */
  readonly barePath: string;
  readonly answer: (over?: Readonly<Record<string, unknown>>) => Promise<void>;
};

async function withForge(body: (forge: Forge) => Promise<void>): Promise<void> {
  await withTempRepo(async (temp) => {
    // Two components for `pr.ts` to rewrite, the same shape as `pr.test.ts`'s —
    // without the second repository, since nothing here is proposed from a fork.
    const base = join(temp.root, "forge", "acme", "widget.git");
    await seedGit(temp.root, ["clone", "--bare", temp.originPath, base]);

    const bin = join(temp.root, "bin");
    await mkdir(bin, { recursive: true });
    await Bun.write(join(bin, "gh"), GH_FAKE);
    await chmod(join(bin, "gh"), 0o755);

    const barePath = join(temp.root, "no-gh");
    await mkdir(barePath, { recursive: true });
    await symlink(Bun.which("git") ?? "/usr/bin/git", join(barePath, "git"));
    await symlink(process.execPath, join(barePath, "bun"));

    const out = join(temp.root, "gh.json");
    // The repository is built in-process: a fixture is never what a test is
    // about, and `grove clone` is not what these three tests are checking.
    const repo = await managedRepo(temp, `file://${base}`);

    await body({
      temp,
      repo,
      base,
      barePath,
      env: { PATH: `${bin}:${process.env.PATH}`, GROVE_GH_OUT: out },
      answer: async (over = {}) => {
        await Bun.write(out, JSON.stringify({ ...OPEN_PR, ...over }));
      },
    });
  });
}

describe.skipIf(!POSIX)("grove pr", () => {
  test("--json is the whole of stdout, and a second run says what it did on stderr", async () => {
    await withForge(async (forge) => {
      await forge.answer();
      const root = forge.repo.root;

      const created = await runCli(["pr", "7", "--json"], { cwd: root, env: forge.env });
      expect([created.exitCode, created.stderr]).toEqual([ExitCode.ok, created.stderr]);

      // Every field the result carries survives the trip out as JSON, which is
      // the contract `grove pr --json | jq` is written against. `setup` is the
      // one exception: it is `add`'s record, and `pr.test.ts` asserts it.
      const { setup, ...document } = JSON.parse(created.stdout) as PrJson;
      expect(document).toEqual({
        path: join(root, "pr", "7"),
        dir: "pr/7",
        branch: "pr/7",
        number: 7,
        title: "Fix the crash",
        url: "https://github.example/acme/widget/pull/7",
        state: "OPEN",
        head: "acme:main",
        remote: "pr-7",
        upstream: "pr-7/main",
        pushable: true,
        updated: "created",
        alreadyPresent: false,
      });
      expect(setup).toBeDefined();
      // The narration happened — it just happened on the other stream, and the
      // document has none of it.
      expect(created.stderr).toContain("pull request 7 — Fix the crash");
      expect(created.stdout).not.toContain("pull request 7 —");

      // Nothing moved, so the row is the same and the sentence is the one that
      // says so. Only the CLI composes it: `alreadyPresent` and `updated` are
      // two fields, and this is the line a person reads instead of them.
      const again = await runCli(["pr", "7"], { cwd: root, env: forge.env });
      expect(again.exitCode).toBe(ExitCode.ok);
      expect(again.stdout).toBe("pr/7\tpr/7\n");
      expect(again.stderr).toContain("pr/7 already has a worktree");
      expect(again.stderr).not.toContain("caught up");

      // The pull request moves on: `feat/login` is `main` plus a commit, so
      // pointing the head there is the fast-forward a reviewer comes back to.
      const ahead = (await probeGit(forge.base, ["rev-parse", "feat/login"])).stdout.trim();
      await seedGit(forge.base, ["update-ref", "refs/heads/main", ahead]);

      const caught = await runCli(["pr", "7"], { cwd: root, env: forge.env });
      expect(caught.exitCode).toBe(ExitCode.ok);
      // The other half of the same line, and the whole reason it is composed
      // rather than reported: "already there" and "already there, and moved"
      // are different news.
      expect(caught.stderr).toContain("pr/7 caught up with pull request 7");
      expect(caught.stderr).not.toContain("already has a worktree");
      expect(await Bun.file(join(root, "pr", "7", "login.txt")).text()).toBe("login\n");
    });
  }, 120_000);

  test("a refusal reaches the shell as the exit code a script branches on", async () => {
    await withForge(async (forge) => {
      const root = forge.repo.root;

      // Nothing on `PATH` but git and bun, so this is "gh is not installed"
      // rather than "the fake was shadowed" — and 10 is the code nothing else
      // in grove reports, because `gh` is the one tool nothing else needs.
      const missing = await runCli(["pr", "7"], { cwd: root, env: { PATH: forge.barePath } });

      expect(missing.exitCode).toBe(ExitCode.gh);
      expect(missing.stderr).toContain("needs `gh`, which is not installed");
      // Not a crash, and nothing a pipe would mistake for a result.
      expect(missing.stderr).not.toContain("at <parse>");
      expect(missing.stdout).toBe("");

      // Somebody's own branch that happens to be called `pr/9`: refused, and
      // refused with the number a wrapper script branches on.
      await seedGit(forge.repo.gitDir, ["branch", "pr/9", "refs/remotes/origin/feat/login"]);
      await forge.answer({ number: 9, url: "https://github.example/acme/widget/pull/9" });

      const clash = await runCli(["pr", "9"], { cwd: root, env: forge.env });

      expect(clash.exitCode).toBe(ExitCode.refused);
      expect(clash.stderr).toContain("it is not pull request 9");
      expect(clash.stdout).toBe("");
    });
  }, 120_000);
});
