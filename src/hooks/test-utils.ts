import { join } from "node:path";
import { cloneRepo } from "../core/commands/clone.ts";
import { type GroveError, isGroveError } from "../core/errors.ts";
import { entryExists } from "../core/fs.ts";
import { type RepoPaths, repoPaths } from "../core/layout.ts";
import { seedGit, type TempRepo, withTempRepo } from "../core/test-utils.ts";
import type { Reporter, Step } from "../report/reporter.ts";
import { HOOKS_FILE } from "./config.ts";
import { runSetup, type SetupOptions, type SetupResult } from "./setup.ts";

/**
 * A repository to run hooks against, shared by every test in this package.
 *
 * Almost everything here is about what lands on disk — what a `copy` line
 * reaches, where a `link` points, which commands a machine has agreed to run —
 * so the fixture is a real repository with two real worktrees rather than a
 * stand-in.
 */

export type Recorder = {
  readonly reporter: Reporter;
  readonly warnings: string[];
  readonly infos: string[];
  readonly succeeded: string[];
  readonly failed: string[];
  readonly reset: () => void;
};

export function recorder(): Recorder {
  const warnings: string[] = [];
  const infos: string[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];

  const reporter: Reporter = {
    step(text): Step {
      let label = text;

      return {
        update: (next) => {
          label = next;
        },
        progress: () => {},
        succeed: (final) => succeeded.push(final ?? label),
        fail: (final) => failed.push(final ?? label),
      };
    },
    info: (text) => infos.push(text),
    warn: (text) => warnings.push(text),
    out: () => {},
    close: async () => {},
  };

  return {
    reporter,
    warnings,
    infos,
    succeeded,
    failed,
    reset: () => {
      warnings.length = 0;
      infos.length = 0;
      succeeded.length = 0;
      failed.length = 0;
    },
  };
}

export type Fixture = {
  readonly temp: TempRepo;
  readonly repo: RepoPaths;
  /** The default branch's worktree — where every copy and link comes from. */
  readonly trunk: string;
  /** A second worktree, the one being set up. */
  readonly worktree: string;
  readonly branch: string;
  readonly log: Recorder;
  /** Writes the trunk's `.grove.toml`, which is the one that governs. */
  readonly configure: (text: string) => Promise<void>;
};

/**
 * A managed repository with two worktrees, built by the real clone command.
 *
 * Going through `cloneRepo` rather than assembling `.bare` by hand is the point:
 * setup reads `origin/HEAD` and `git worktree list` to decide where copies come
 * from, and a hand-built layout would answer those differently than a real one.
 */
export async function withRepo(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withTempRepo(async (temp) => {
    const log = recorder();
    const clone = await cloneRepo(temp.work, { url: temp.originUrl, dir: "repo" }, log.reporter);
    const repo = repoPaths(clone.root);

    const branch = "feat/login";
    const worktree = join(clone.root, "feat", "login");
    await seedGit(repo.gitDir, ["worktree", "add", "-b", branch, worktree, "main"]);

    log.reset();

    await body({
      temp,
      repo,
      trunk: clone.worktree,
      worktree,
      branch,
      log,
      configure: async (text) => {
        await Bun.write(join(clone.worktree, HOOKS_FILE), text);
      },
    });
  });
}

/** Runs setup against the second worktree, which is what `add` does. */
export function setUp(fixture: Fixture, options: SetupOptions = {}): Promise<SetupResult> {
  return runSetup(
    fixture.repo,
    { path: fixture.worktree, branch: fixture.branch },
    options,
    fixture.log.reporter,
  );
}

/**
 * Waits for something an `open` line was going to do, because nothing awaits it.
 *
 * The whole point of `open` is that grove lets go of the process, so a test has
 * no exit code to read and no stream to drain — only the disk, once the child
 * has got there. Polling and not a fixed sleep: on a loaded CI runner a sleep
 * long enough to be safe is long enough to be worth avoiding sixty times over.
 */
export async function waitForEntry(path: string, timeout = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await entryExists(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return false;
}

/** Long enough to catch a launch that should not have happened. */
export const NOT_OPENED = 400;

export function refusalFrom(body: () => unknown): GroveError {
  try {
    body();
  } catch (error) {
    if (isGroveError(error)) return error;
    throw error;
  }

  throw new Error("expected a GroveError, but nothing was thrown");
}

/** The same, for the refusals that only come out once there is a disk to read. */
export async function refusalFromRun(body: () => Promise<unknown>): Promise<GroveError> {
  try {
    await body();
  } catch (error) {
    if (isGroveError(error)) return error;
    throw error;
  }

  throw new Error("expected a GroveError, but nothing was thrown");
}
