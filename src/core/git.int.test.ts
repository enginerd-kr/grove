import { expect, test } from "bun:test";
import { join } from "node:path";
import { GroveError } from "./errors.ts";
import { gitOutput, gitSucceeds, runGit, runGitOrThrow, traceGit } from "./git.ts";
import { withTempRepo } from "./test-utils.ts";

// The fixture builds a real repository on disk; `Bun.spawn` and `file://` remotes
// are POSIX-only territory here.
const onPosix = test.skipIf(process.platform === "win32");

onPosix(
  "reports a failure instead of throwing",
  async () => {
    await withTempRepo(async ({ work }) => {
      const result = await runGit(["rev-parse", "--git-dir"], { cwd: work });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("not a git repository");
      expect(result.stdout).toBe("");
    });
  },
  20_000,
);

onPosix(
  "runGitOrThrow turns a failure into a classified GroveError",
  async () => {
    await withTempRepo(async ({ work }) => {
      const promise = runGitOrThrow(["clone", "--bare", "file:///definitely/not/here.git"], {
        cwd: work,
      });

      // `.rejects` alone would pass on any throw; the code is the part every
      // caller branches on, so assert it explicitly.
      const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(GroveError);
      expect((error as GroveError).code).toBe("remote");
      expect((error as GroveError).details.length).toBeGreaterThan(0);
    });
  },
  20_000,
);

onPosix(
  "streams stderr line by line while the command runs",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const lines: string[] = [];

      await runGitOrThrow(["clone", "--bare", "--progress", originUrl, join(work, "bare.git")], {
        cwd: work,
        onStderrLine: (line) => lines.push(line),
      });

      // git separates progress updates with `\r`, not `\n`. If the splitter only
      // honoured `\n` this would arrive as one enormous line and a progress bar
      // fed from it would never move.
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.some((line) => line.includes("Receiving objects"))).toBe(true);
      expect(lines.every((line) => !line.includes("\r"))).toBe(true);
    });
  },
  20_000,
);

// What `--verbose` is for: the calls nobody prints otherwise, including the
// ones that fail on purpose and are never reported anywhere else.
onPosix(
  "tracing records every command, its exit code, and how long it took",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const lines: string[] = [];
      const bare = join(work, "bare.git");

      traceGit((line) => lines.push(line));
      try {
        await runGitOrThrow(["clone", "--bare", originUrl, bare], { cwd: work });
        await gitSucceeds(["rev-parse", "--verify", "--quiet", "refs/heads/nope"], { cwd: bare });
      } finally {
        // A module-level sink outlives the test that installed it, and a stray
        // one would push this file's lines into the next file's array.
        traceGit(undefined);
      }

      expect(lines).toHaveLength(2);
      // Pasteable: `-C <dir>` is how you re-run it by hand from anywhere.
      expect(lines[0]).toContain(`git -C ${work} clone --bare`);
      expect(lines[0]).toMatch(/→ ok, \d+ms$/);
      // A failure that is not an error — the branch `gitSucceeds` hides.
      expect(lines[1]).toContain("rev-parse --verify --quiet refs/heads/nope");
      expect(lines[1]).toMatch(/→ exit \d+, \d+ms$/);

      // And nothing is recorded once the sink is gone.
      await gitSucceeds(["rev-parse", "--git-dir"], { cwd: bare });
      expect(lines).toHaveLength(2);
    });
  },
  20_000,
);

onPosix(
  "gitSucceeds answers ref questions without treating absence as an error",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const bare = join(work, "bare.git");
      await runGitOrThrow(["clone", "--bare", originUrl, bare], { cwd: work });

      expect(
        await gitSucceeds(["rev-parse", "--verify", "--quiet", "refs/heads/main"], {
          cwd: bare,
        }),
      ).toBe(true);
      expect(
        await gitSucceeds(["rev-parse", "--verify", "--quiet", "refs/heads/nope"], {
          cwd: bare,
        }),
      ).toBe(false);
    });
  },
  20_000,
);

// This is the whole reason the clone command cannot stop at `clone --bare`.
onPosix(
  "a bare clone has no fetch refspec until one is set",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const bare = join(work, "bare.git");
      await runGitOrThrow(["clone", "--bare", originUrl, bare], { cwd: work });

      const before = await runGit(["config", "--get", "remote.origin.fetch"], { cwd: bare });
      expect(before.code).not.toBe(0);

      // Fetching now "succeeds" while populating nothing, which is exactly how
      // this bites: no error, no remote-tracking refs, and `sync` later has
      // nothing to rebase onto.
      await runGitOrThrow(["fetch", "origin"], { cwd: bare });
      expect(await gitOutput(["for-each-ref", "refs/remotes/"], { cwd: bare })).toBe("");

      await runGitOrThrow(
        ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
        { cwd: bare },
      );
      await runGitOrThrow(["fetch", "origin", "--prune"], { cwd: bare });

      const refs = await gitOutput(["for-each-ref", "--format=%(refname)", "refs/remotes/"], {
        cwd: bare,
      });
      expect(refs).toContain("refs/remotes/origin/main");
      expect(refs).toContain("refs/remotes/origin/feat/login");
    });
  },
  20_000,
);

onPosix(
  "the fixture seeds both branches and leaves the work directory empty",
  async () => {
    await withTempRepo(async ({ work, originPath }) => {
      const branches = await gitOutput(["for-each-ref", "--format=%(refname)", "refs/heads/"], {
        cwd: originPath,
      });

      expect(branches).toContain("refs/heads/main");
      expect(branches).toContain("refs/heads/feat/login");
      expect(
        await Array.fromAsync(new Bun.Glob("*").scan({ cwd: work, onlyFiles: false })),
      ).toEqual([]);
    });
  },
  20_000,
);
