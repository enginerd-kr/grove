import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { RepoPaths } from "../layout.ts";
import { managedRepo, probeGit, seedGit, type TempRepo, withTempRepo } from "../test-utils.ts";

/**
 * A fake forge, for the commands that ask `gh` something.
 *
 * `gh` is the one tool grove runs that is not git, and it is reached by name
 * through `PATH` — so a script called `gh` in a directory only these tests know
 * about is enough to stand in for the whole of GitHub. The fake records the
 * argv it was called with, answers with whatever a test wrote down for it, and
 * exits how it was told to. Everything after that answer is git, and git is
 * real: the "fork" is a second bare repository on disk, a fetch is a fetch,
 * and a push is proved by looking at what the far end has afterwards.
 *
 * The fake's environment goes onto `process.env` for the duration rather than
 * into a child's, because the code under test runs in this process — the same
 * reason `withTempRepo` puts the pinned git identity there. `runTool` spawns
 * `gh` with `process.env`, so this is the same lookup the child would do.
 */

/**
 * The stand-in for `gh`.
 *
 * `PATH` is reset inside so the fake can reach `cat` even when the test narrowed
 * the environment of the process under test down to nothing but git; what is
 * being exercised is grove's lookup, not the script's.
 */
const GH_FAKE = `#!/bin/sh
PATH=/usr/bin:/bin
printf '%s\\n' "$*" >> "$GROVE_GH_LOG"
[ -n "$GROVE_GH_STDERR" ] && printf '%s\\n' "$GROVE_GH_STDERR" >&2
if [ -n "$GROVE_GH_ANSWERS" ] && [ -f "$GROVE_GH_ANSWERS/$1-$2" ]; then
  cat "$GROVE_GH_ANSWERS/$1-$2"
elif [ -n "$GROVE_GH_OUT" ]; then
  cat "$GROVE_GH_OUT"
fi
exit "\${GROVE_GH_EXIT:-0}"
`;

/** What `gh pr view --json` answers, before a test says otherwise. */
export const OPEN_PR: Readonly<Record<string, unknown>> = {
  number: 42,
  title: "Fix the crash",
  url: "https://github.example/acme/widget/pull/42",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "fix/crash",
  isCrossRepository: true,
  headRepository: { name: "widget" },
  headRepositoryOwner: { login: "octocat" },
  author: { login: "octocat" },
};

export type Forge = {
  readonly temp: TempRepo;
  /** The managed clone, whose origin is `acme/widget.git`. */
  readonly repo: RepoPaths;
  /** The bare repository origin points at. */
  readonly base: string;
  /** Somebody else's bare repository, one directory over — the fork. */
  readonly fork: string;
  /** Replaces what the next `gh pr view` answers, over `OPEN_PR`. */
  readonly answer: (over?: Readonly<Record<string, unknown>>) => Promise<void>;
  /**
   * What one kind of call answers — `"pr list"`, `"pr create"` — over what
   * `answer` set for everything. For the command that asks gh two different
   * questions in one run and needs each answered in its own words.
   */
  readonly answerTo: (call: string, text: string) => Promise<void>;
  /** Every argv the fake `gh` has been handed, in order. */
  readonly asked: () => Promise<readonly string[]>;
  /** Commits `text` on `branch` of the fork and pushes it, as its author would. */
  readonly propose: (branch: string, text: string, message: string) => Promise<void>;
  /** Makes `gh` answer the way it does when it is unhappy: a code and its own stderr. */
  readonly fails: (code: string, stderr: string) => void;
  /** Runs `body` with a `PATH` holding git and bun and nothing else. */
  readonly withoutGh: <T>(body: () => Promise<T>) => Promise<T>;
};

/**
 * A repository whose origin sits inside a forge-shaped directory tree.
 *
 * `pr.ts` works out where a head lives by rewriting the last two components of
 * origin's own URL, so the fixture has to have two components to rewrite:
 * `<forge>/acme/widget.git` is the base and `<forge>/octocat/widget.git` is the
 * fork, and grove reaches the second by deriving it rather than being told.
 *
 * The fake's environment goes onto `process.env` for the duration rather than
 * into a child's, because the code under test now runs in this process — the
 * same reason `withTempRepo` puts the pinned git identity there.
 */
export async function withForge(body: (forge: Forge) => Promise<void>): Promise<void> {
  await withTempRepo(async (temp) => {
    const forge = join(temp.root, "forge");
    const base = join(forge, "acme", "widget.git");
    const fork = join(forge, "octocat", "widget.git");

    // Independent of each other, and two git processes is the single biggest
    // thing this fixture costs — so they are paid for at once.
    await Promise.all([
      seedGit(temp.root, ["clone", "--bare", temp.originPath, base]),
      seedGit(temp.root, ["clone", "--bare", temp.originPath, fork]),
    ]);

    /**
     * The fork owner's own checkout, made the first time a test proposes
     * something.
     *
     * Six of the tests below never do — they are about what the base
     * repository holds, or about gh refusing before any of this is reached —
     * and a clone they do not use is a clone they should not pay for.
     */
    let forkWork: string | undefined;
    const workingCopy = async (): Promise<string> => {
      if (forkWork === undefined) {
        const path = join(temp.root, "fork-work");
        await seedGit(temp.root, ["clone", fork, path]);
        forkWork = path;
      }

      return forkWork;
    };

    const bin = join(temp.root, "bin");
    await mkdir(bin, { recursive: true });
    await Bun.write(join(bin, "gh"), GH_FAKE);
    await chmod(join(bin, "gh"), 0o755);

    // git and bun alone, so "gh is not installed" is a fact about the
    // environment rather than a fact about one directory being first.
    const barePath = join(temp.root, "no-gh");
    await mkdir(barePath, { recursive: true });
    await symlink(Bun.which("git") ?? "/usr/bin/git", join(barePath, "git"));
    await symlink(process.execPath, join(barePath, "bun"));

    const log = join(temp.root, "gh.log");
    const out = join(temp.root, "gh.json");
    const answers = join(temp.root, "gh-answers");
    await Bun.write(log, "");
    await mkdir(answers, { recursive: true });

    const repo = await managedRepo(temp, `file://${base}`);

    // Every key is set, including the two a test only sometimes wants, so that
    // all of them are on the restore list below — an exit code left behind
    // would make the next file's tests fail in a way that points nowhere near
    // here.
    const env: Readonly<Record<string, string>> = {
      PATH: `${bin}:${process.env.PATH}`,
      GROVE_GH_LOG: log,
      GROVE_GH_OUT: out,
      GROVE_GH_ANSWERS: answers,
      GROVE_GH_EXIT: "",
      GROVE_GH_STDERR: "",
    };
    const restore = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(env)) {
      restore.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      await body({
        temp,
        repo,
        base,
        fork,
        answer: async (over = {}) => {
          await Bun.write(out, JSON.stringify({ ...OPEN_PR, ...over }));
        },
        answerTo: async (call, text) => {
          await Bun.write(join(answers, call.split(" ").join("-")), text);
        },
        asked: async () =>
          (await Bun.file(log).text()).split("\n").filter((line) => line.length > 0),
        propose: async (branch, text, message) => {
          const work = await workingCopy();
          const known = await probeGit(work, ["rev-parse", "--verify", "--quiet", branch]);
          await seedGit(work, known.code === 0 ? ["checkout", branch] : ["checkout", "-b", branch]);

          await Bun.write(join(work, "crash.txt"), text);
          await seedGit(work, ["add", "-A"]);
          await seedGit(work, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
          await seedGit(work, ["push", "origin", branch]);
        },
        fails: (code, stderr) => {
          process.env.GROVE_GH_EXIT = code;
          process.env.GROVE_GH_STDERR = stderr;
        },
        withoutGh: async (inner) => {
          const path = process.env.PATH;
          process.env.PATH = barePath;

          try {
            return await inner();
          } finally {
            process.env.PATH = path;
          }
        },
      });
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}
