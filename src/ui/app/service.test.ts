import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { addWorktree } from "../../core/commands/add.ts";
import { isGroveError } from "../../core/errors.ts";
import { pathExists } from "../../core/fs.ts";
import type { RepoPaths } from "../../core/layout.ts";
import {
  managedRepo,
  probeGit,
  seedGit,
  seedWorktree,
  type TempRepo,
  withTempRepo,
} from "../../core/test-utils.ts";
import { waitForEntry } from "../../hooks/test-utils.ts";
import type { Reporter, Step } from "../../report/reporter.ts";
import { createSetupService, createWorktreeService, type WorktreeService } from "./service.ts";

/**
 * The layer between the keys and `core/commands`, driven against a real repository.
 *
 * In-process rather than through a terminal, which is the whole point of the
 * service existing: what the screen depends on is the *string* each action
 * answers with and the *shape* `list` hands back, and both are ordinary values
 * once the component is out of the way. A refusal is asserted as the
 * `GroveError` it arrives as — carrying a sentence and a hint the screen can
 * draw — rather than as a crash, because that is the difference between a red
 * line and a dead session.
 *
 * Every test builds its own throwaway origin, so they are parallel-safe and
 * nothing here touches the network.
 *
 * The arrangement is in-process for the same reason: a fixture is a repository
 * in a particular state, not a demonstration that the binary can produce one,
 * so `managedRepo` and `addWorktree` build them by calling the same functions
 * the command line calls. That is a git process rather than a `bun` one — the
 * expensive half of `grove clone` was never git.
 */

/** A clone, a couple of git processes and a shell command: seconds, not milliseconds. */
const SLOW = 60_000;

type Recorder = {
  readonly reporter: Reporter;
  readonly steps: string[];
  readonly succeeded: string[];
  readonly failed: string[];
  readonly infos: string[];
  readonly warnings: string[];
};

/** A reporter that keeps what it was told, standing in for the activity area. */
function recorder(): Recorder {
  const steps: string[] = [];
  const succeeded: string[] = [];
  const failed: string[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];

  const reporter: Reporter = {
    step(text): Step {
      let label = text;
      steps.push(text);

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

  return { reporter, steps, succeeded, failed, infos, warnings };
}

/** The service as `run.tsx` builds it: the repo it found, and the cwd it started in. */
function serviceAt(
  paths: RepoPaths,
  cwd = paths.root,
): {
  service: WorktreeService;
  log: Recorder;
} {
  const log = recorder();

  return { service: createWorktreeService(paths, cwd, log.reporter), log };
}

let scratchCount = 0;

/** Somebody else's commit, pushed from outside the repository under test. */
async function commitOnOrigin(temp: TempRepo, branch: string, file: string): Promise<void> {
  scratchCount += 1;
  const scratch = join(temp.root, `elsewhere-${scratchCount}`);

  await seedGit(temp.root, ["clone", "--branch", branch, temp.originPath, scratch]);
  await Bun.write(join(scratch, file), `${file}\n`);
  await seedGit(scratch, ["add", "-A"]);
  await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
  await seedGit(scratch, ["push", "origin", `HEAD:${branch}`]);
  await rm(scratch, { recursive: true, force: true });
}

/** The error an action refused with, having asserted that it refused at all. */
async function refusalFrom(action: Promise<unknown>): Promise<{
  code: string;
  message: string;
  hint: string | undefined;
  details: readonly string[];
}> {
  try {
    await action;
  } catch (error) {
    if (!isGroveError(error)) throw error;

    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      details: error.details,
    };
  }

  throw new Error("expected the service to refuse, and it did not");
}

describe("createWorktreeService", () => {
  test(
    "list hands over the summaries the tree is built from, and re-reads what changed underneath it",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths, join(root, "main"));

        const first = await service.list();

        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
          path: join(root, "main"),
          dir: "main",
          branch: "main",
          detached: false,
          dirty: false,
          changed: 0,
          untracked: 0,
          files: [],
          publishRemote: "origin",
          isDefault: true,
          // `cwd` is what tells the screen which row is the one you are standing in.
          current: true,
        });

        // A worktree made without the service knowing: a refresh is a re-read,
        // not a cache that has to be told about it.
        await seedWorktree(paths, "feat/login");
        await Bun.write(join(root, "main", "scratch.txt"), "half-finished\n");

        const second = await service.list();

        expect(second.map((entry) => entry.dir).toSorted()).toEqual(["feat/login", "main"]);
        expect(second.find((entry) => entry.dir === "main")).toMatchObject({
          dirty: true,
          changed: 1,
          untracked: 1,
          files: ["scratch.txt"],
        });
      });
    },
    SLOW,
  );

  test(
    "add says which way it got the branch, and says so again when there was nothing to do",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        // The suffix depends on whether this machine has a clipboard tool, so
        // only the sentence in front of it is the service's own answer.
        //
        // `from` is ignored here rather than obeyed: the branch is on the
        // remote, so it is checked out rather than created, and the answer says
        // "(remote)" instead of naming a base that had nothing to do with it.
        expect(await service.add("feat/login", "main")).toStartWith("added feat/login (remote)");
        expect(await pathExists(join(root, "feat", "login"))).toBe(true);

        expect(await service.add("feat/login")).toStartWith("feat/login already has a worktree");

        // A branch nobody has: made, and the base is said back because there
        // was one.
        expect(await service.add("spike", "main")).toStartWith("added spike from main");
        expect(await service.add("solo")).toStartWith("added solo (new)");

        expect((await service.list()).map((entry) => entry.dir).toSorted()).toEqual([
          "feat/login",
          "main",
          "solo",
          "spike",
        ]);
      });
    },
    SLOW,
  );

  test(
    "add refuses what the command line refuses, as an error with a sentence and a hint",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const { service, log } = serviceAt(paths);

        // A name with no usable directory in it — refused before anything is made.
        const unusable = await refusalFrom(service.add("..."));

        expect(unusable.code).toBe("usage");
        expect(unusable.message.length).toBeGreaterThan(0);
        // "Before anything is made", asserted rather than assumed: the screen
        // draws a step the moment one is opened, so a refusal that had already
        // started narrating would leave a half-finished line under a red one.
        expect(log.steps).toEqual([]);
        expect(log.failed).toEqual([]);

        await service.add("feat/login");
        // `feat` would have to become a file where a directory already is.
        const nested = await refusalFrom(service.add("feat"));

        expect(nested.code).toBe("state-conflict");
        expect(nested.hint).toBeDefined();

        // The refusal left the repository as it was.
        expect((await service.list()).map((entry) => entry.dir).toSorted()).toEqual([
          "feat/login",
          "main",
        ]);
      });
    },
    SLOW,
  );

  test(
    "remove answers with the line to show, and refuses the trunk and a name it cannot resolve",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");

        expect(await service.remove("feat/login")).toBe("removed feat/login");
        expect(await pathExists(join(root, "feat", "login"))).toBe(false);
        // The emptied folder goes with it, so the tree does not keep a heading
        // with nothing under it.
        expect(await pathExists(join(root, "feat"))).toBe(false);

        const trunk = await refusalFrom(service.remove("main"));

        expect(trunk.code).toBe("refused");
        expect(trunk.message).toContain("main");

        const missing = await refusalFrom(service.remove("no-such-branch"));

        expect(missing.code).toBe("not-a-repo");
        // The details are what the screen draws under the sentence, so a name
        // that matched nothing shows what there was to match.
        expect(missing.details.join("\n")).toContain("main");
      });
    },
    SLOW,
  );

  test(
    "a dirty worktree is refused until the confirmation says it was asked about",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");
        await Bun.write(join(root, "feat", "login", "scratch.txt"), "half-finished\n");

        const refusal = await refusalFrom(service.remove("feat/login"));

        expect(refusal.code).toBe("refused");
        expect(await pathExists(join(root, "feat", "login"))).toBe(true);

        // `y` was pressed against a confirmation that counted the changes.
        expect(await service.remove("feat/login", true)).toBe("removed feat/login");
        expect(await pathExists(join(root, "feat", "login"))).toBe(false);
      });
    },
    SLOW,
  );

  test(
    "removeMany counts what went, keeps going past a refusal, and raises when nothing went",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");
        await service.add("feat/search");
        await Bun.write(join(root, "feat", "search", "scratch.txt"), "half-finished\n");

        // One clean, one dirty: the clean one still goes.
        expect(await service.removeMany(["feat/login", "feat/search"])).toBe(
          "removed 1 worktree, 1 refused",
        );
        expect(await pathExists(join(root, "feat", "login"))).toBe(false);
        expect(await pathExists(join(root, "feat", "search"))).toBe(true);

        // Nothing removed means the refusal is the outcome, not a count of zero.
        const refusal = await refusalFrom(service.removeMany(["feat/search"]));

        expect(refusal.code).toBe("refused");

        expect(await service.removeMany(["feat/search"], true)).toBe("removed 1 worktree");
        expect(await service.removeMany([])).toBe("removed 0 worktrees");
      });
    },
    SLOW,
  );

  test(
    "reset takes the tracked changes and the untracked files, and says what went",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");
        const dir = join(root, "feat", "login");

        // One of each kind, because the answer counts them apart: a tracked
        // file the reset rewinds, and one git has never seen, which survives
        // `reset --hard` and only `clean -fd` takes.
        await Bun.write(join(dir, "README.md"), "changed\n");
        await Bun.write(join(dir, "scratch.txt"), "half-finished\n");

        expect(await service.reset("feat/login")).toBe(
          "discarded 1 change and 1 untracked file in feat/login",
        );
        expect(await pathExists(join(dir, "scratch.txt"))).toBe(false);
        // The worktree itself stays — this is not a removal wearing another key.
        expect(await pathExists(dir)).toBe(true);

        // Nothing left to take, said rather than reported as a discard of
        // nothing: the screen draws this line where it drew the last one.
        expect(await service.reset("feat/login")).toBe("feat/login had nothing to discard");
      });
    },
    SLOW,
  );

  test(
    "sync fast-forwards a worktree the origin moved ahead of, one target or all of them",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");
        await commitOnOrigin(temp, "main", "newer.txt");

        expect(await service.sync("main")).toBe("main fast-forwarded");
        expect(await pathExists(join(root, "main", "newer.txt"))).toBe(true);

        await commitOnOrigin(temp, "feat/login", "later.txt");

        // "rebased" and not "fast-forwarded", even though nothing local had to
        // move: only the trunk is fast-forwarded, and every other branch goes
        // through the rebase that keeps it on top of its own remote.
        expect(await service.sync("feat/login")).toBe("feat/login rebased");
        expect(await pathExists(join(root, "feat", "login", "later.txt"))).toBe(true);

        // Every worktree, which is what `S` does — counted by outcome once
        // there is more than one to count.
        expect(await service.sync()).toBe("2 up-to-date");
      });
    },
    SLOW,
  );

  test(
    "prune answers with what it would remove, and removes it when asked",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const { service } = serviceAt(paths);

        // What a merged pull request with the delete box ticked leaves behind:
        // the branch is gone from the origin, and the worktree is still here.
        await service.add("feat/login");
        await seedGit(temp.originPath, ["branch", "-D", "feat/login"]);

        const pending = await service.pendingPrune();
        expect(pending.dryRun).toBe(true);
        expect(pending.entries.map((entry) => [entry.dir, entry.reason, entry.skipped])).toEqual([
          ["feat/login", "gone", undefined],
        ]);
        expect(await pathExists(join(paths.root, "feat", "login"))).toBe(true);

        expect(await service.prune()).toBe("removed 1");
        expect(await pathExists(join(paths.root, "feat", "login"))).toBe(false);
        // The branch stays, the way `r` leaves it.
        expect((await probeGit(paths.gitDir, ["rev-parse", "--verify", "feat/login"])).code).toBe(
          0,
        );

        expect(await service.prune()).toBe("nothing is finished with");
      });
    },
    SLOW,
  );

  test(
    "a branch on no remote is said on the line rather than raised, and published when asked",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const { service } = serviceAt(paths);

        // `a` never pushes, so this branch is on no remote.
        await service.add("feat/local");
        await commitOnOrigin(temp, "main", "newer.txt");
        expect(await service.sync("main")).toBe("main fast-forwarded");

        // The command line exits 4 here; the screen says so on the line and
        // stays open, because `s` over the row is the question that fixes it.
        expect(await service.sync("feat/local")).toBe("feat/local rebased, on no remote yet");
        expect(await service.sync()).toBe("2 up-to-date — feat/local is on no remote yet");

        // `y` on that question.
        expect(await service.sync("feat/local", { publish: true })).toBe("feat/local up-to-date");
        const onOrigin = await probeGit(temp.originPath, ["rev-parse", "--verify", "feat/local"]);
        expect(onOrigin.code).toBe(0);
        expect(await service.sync()).toBe("2 up-to-date");
      });
    },
    SLOW,
  );

  test(
    "a worktree sync could not touch is reported on the same line, not raised",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");
        await Bun.write(join(root, "feat", "login", "scratch.txt"), "half-finished\n");
        await commitOnOrigin(temp, "feat/login", "later.txt");

        // Worth pinning as it is: `grove sync` on the command line turns a skip
        // into exit 4 through `failureFor`, and the service deliberately does
        // not — the screen reports outcomes and stays open. A conflict is the
        // one the screen does raise, because `rebased` and `conflicted` in the
        // same colour is the screen calling a failure a success; a skip already
        // says what happened on the line it returns.
        expect(await service.sync("feat/login")).toBe("feat/login skipped");
        expect(await pathExists(join(root, "feat", "login", "later.txt"))).toBe(false);
      });
    },
    SLOW,
  );

  test(
    "a rebase that conflicted is a refusal, and the worktree is left as it was",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");

        // The same path written two different ways on the two branches, which
        // is the one thing a rebase cannot decide for itself.
        const worktree = join(root, "feat", "login");
        await Bun.write(join(worktree, "clash.txt"), "mine\n");
        await seedGit(worktree, ["add", "-A"]);
        await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Add clash.txt"]);
        await commitOnOrigin(temp, "main", "clash.txt");

        // The defect this pins: the outcome used to come back as the line
        // `feat/login conflicted`, drawn in the same accent colour as
        // `feat/login rebased`, while `grove sync` exited 5 for the very same
        // outcome. The whole point of the `SyncOutcome` union is the difference
        // between those two words, and the screen was discarding it.
        const refusal = await refusalFrom(service.sync("feat/login"));

        expect(refusal.code).toBe("rebase-conflict");
        expect(refusal.message).toBe("feat/login conflicted");
        expect(refusal.hint).toBe("resolve them by hand, or sync after committing");
        expect(refusal.details.join("\n")).toContain("rolled back");
        expect(refusal.details.join("\n")).toContain("clash.txt");

        // Rolled back rather than left mid-rebase: `abortOnConflict` is what
        // makes the refusal safe to raise at all — there is nothing for the
        // person reading it to finish or abandon.
        const after = (await service.list()).find((summary) => summary.dir === "feat/login");
        expect(after?.rebasing).toBe(false);
        expect(await Bun.file(join(worktree, "clash.txt")).text()).toBe("mine\n");
      });
    },
    SLOW,
  );

  test(
    "sync with nothing to say still says something",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const { service } = serviceAt(paths);

        expect(await service.sync()).toBe("main up-to-date");
      });
    },
    SLOW,
  );

  test(
    "fetch answers rather than throws, so a laptop on a train is not an error",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const { service, log } = serviceAt(paths);

        expect(await service.fetch()).toBe(true);

        // The origin is gone — which is every offline refresh tick, and is not
        // something to interrupt anybody about.
        await rm(temp.originPath, { recursive: true, force: true });

        expect(await service.fetch()).toBe(false);
        expect(log.warnings).toEqual([]);
      });
    },
    SLOW,
  );

  test(
    "log answers with commits, and with nothing rather than a failure",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);
        const main = join(root, "main");

        const commits = await service.log(main, 5);

        expect(commits.length).toBeGreaterThan(0);
        expect(commits[0]).toMatchObject({ subject: "Add app.txt" });
        expect(commits[0]?.sha).toMatch(/^[0-9a-f]{7,}$/);
        expect(commits[0]?.when).toBeGreaterThan(0);
        // Newest first, which is the order the panel draws.
        expect(commits.at(-1)?.subject).toBe("Add a readme");

        expect(await service.log(main, 1)).toHaveLength(1);
        expect(await service.log(main, 0)).toEqual([]);
      });
    },
    SLOW,
  );

  // `recentCommits` documents "a directory that is no longer there" as one of
  // the ways it answers "nothing to show". The tolerance is real rather than
  // the caller's: `spawnProcess` turns the missing cwd into the failure git
  // would have reported, and the `code !== 0` guard already there takes it.
  test(
    "log on a directory that has gone is an empty panel, not a rejection",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        expect(await service.log(join(root, "not-a-worktree"), 5)).toEqual([]);
      });
    },
    SLOW,
  );

  test(
    "copyPath either says what it copied or refuses in a way the screen can draw",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);
        const main = join(root, "main");

        // Which of the two happens is a property of the machine — a headless
        // Linux runner has no clipboard tool — and both are contracts the
        // screen relies on, so both are spelled out here.
        try {
          expect(await service.copyPath(main)).toBe(`copied ${main}`);
        } catch (error) {
          if (!isGroveError(error)) throw error;

          expect(error.code).toBe("refused");
          expect(error.hint).toBe("install wl-copy, xclip, or xsel");
        }
      });
    },
    SLOW,
  );

  test(
    "the commands a new worktree was denied are offered, and running them trusts the file for good",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service, log } = serviceAt(paths);

        // The trunk's copy is the one that governs, so that is where it goes.
        await Bun.write(
          join(root, "main", ".grove.toml"),
          '[setup]\nrun = ["echo ran > ran.txt"]\n',
        );

        // Making the worktree does not run it: `add` passes `trust: false`,
        // exactly like the command line without `--trust`.
        expect(await service.add("feat/login")).toStartWith("added feat/login (remote)");
        expect(await pathExists(join(root, "feat", "login", "ran.txt"))).toBe(false);
        expect(log.warnings.join("\n")).toContain("not been trusted");

        // What the app asks straight afterwards, and what it puts the question on.
        expect(await service.pendingCommands()).toEqual(["echo ran > ran.txt"]);

        // Using the screen is the consent, so `y` runs them — reported as a
        // step while it runs, and answered with what was done and where.
        expect(await service.trustAndRun("feat/login")).toBe("1 run in feat/login");
        expect(log.steps).toContain("running echo ran > ran.txt");
        expect(log.succeeded).toContain("ran echo ran > ran.txt");
        expect(await pathExists(join(root, "feat", "login", "ran.txt"))).toBe(true);

        // Trusted now, so nothing is left to ask about.
        expect(await service.pendingCommands()).toEqual([]);

        // The same record `--trust` writes: the command line stops asking too,
        // and a worktree it makes runs the commands without being told again.
        // `addWorktree` with these options *is* `grove add chore/tidy` — the
        // trust is in a file on disk, so it does not matter which of the two
        // entry points reads it, only that both read the same one.
        await addWorktree(
          paths,
          root,
          {
            branch: "chore/tidy",
            from: undefined,
            fetch: true,
            push: false,
            setup: true,
            trust: false,
            take: false,
          },
          recorder().reporter,
        );

        expect(await pathExists(join(root, "chore", "tidy", "ran.txt"))).toBe(true);
      });
    },
    SLOW,
  );

  test(
    "an edit to the file withdraws the trust, and a command that fails is raised with what it said",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);
        const file = join(root, "main", ".grove.toml");

        await Bun.write(file, '[setup]\nrun = ["echo ran > ran.txt"]\n');
        await service.add("feat/login");
        await service.trustAndRun("feat/login");

        // Trust is of the contents, so a pull that changes them asks again.
        await Bun.write(file, '[setup]\nrun = ["echo ran > ran.txt", "exit 3"]\n');

        expect(await service.pendingCommands()).toEqual(["echo ran > ran.txt", "exit 3"]);

        const failure = await refusalFrom(service.trustAndRun("feat/login"));

        expect(failure.code).toBe("setup-failed");
        expect(failure.message).toBe('"exit 3" exited 3');
        // The command before it still ran; the ones after it did not.
        expect(await pathExists(join(root, "feat", "login", "ran.txt"))).toBe(true);
      });
    },
    SLOW,
  );

  test(
    "an ordinary repository has nothing pending and nothing to run",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const { service } = serviceAt(paths);

        expect(await service.pendingCommands()).toEqual([]);

        await service.add("feat/login");

        expect(await service.pendingCommands()).toEqual([]);
        expect(await service.trustAndRun("feat/login")).toBe("no .grove.toml in feat/login");
      });
    },
    SLOW,
  );

  test(
    "the open line waits for the same answer, and the screen is where it is given",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        // `touch` stands in for an editor: grove lets go of the line it starts,
        // so a file turning up is all there is to look at.
        await Bun.write(join(root, "main", ".grove.toml"), '[setup]\nopen = "touch opened.txt"\n');
        await service.add("feat/login");

        // What `/open` reads before it decides whether to ask: the exact line,
        // and the file to go and read it in.
        expect(await service.pendingOpen("feat/login")).toEqual({
          command: "touch opened.txt",
          files: ["main/.grove.toml"],
        });

        // Unanswered, it is the refusal the command line gives.
        expect(await service.open("feat/login")).toBe(
          "feat/login has an open line nobody has read here",
        );
        expect(await pathExists(join(root, "feat", "login", "opened.txt"))).toBe(false);

        // `y`, which is `--trust`: the line runs.
        expect(await service.open("feat/login", true)).toBe(
          "opened feat/login with touch opened.txt",
        );
        expect(await waitForEntry(join(root, "feat", "login", "opened.txt"))).toBe(true);

        // One record for the whole file, so nothing is left to ask about — from
        // this key or from the one that runs the setup commands.
        expect(await service.pendingOpen("feat/login")).toBeUndefined();
        expect(await service.pendingCommands()).toEqual([]);
      });
    },
    SLOW,
  );

  test(
    "the pull request keys refuse with a URL when `gh` is not installed",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const { service } = serviceAt(paths);

        // The one read here that leaves the machine. A PATH holding nothing but
        // git is what makes this hermetic — git is still needed, because
        // `checkoutPr` prunes remotes before it asks the forge anything — and
        // the missing-tool refusal is the answer the screen has to be able to
        // draw anyway.
        const bin = join(temp.root, "only-git");
        await mkdir(bin, { recursive: true });
        const git = Bun.which("git");
        if (git === null) throw new Error("these tests need git on PATH");
        await symlink(git, join(bin, "git"));

        const path = process.env.PATH;
        process.env.PATH = bin;

        try {
          const listed = await refusalFrom(service.pullRequests());

          expect(listed.code).toBe("gh");
          expect(listed.hint).toContain("https://cli.github.com");

          const checkout = await refusalFrom(service.checkoutPr(7));

          expect(checkout.code).toBe("gh");
        } finally {
          process.env.PATH = path;
        }
      });
    },
    SLOW,
  );
});

describe("createSetupService", () => {
  test(
    "clone turns a URL into the repository the app then talks to",
    async () => {
      await withTempRepo(async (temp) => {
        const log = recorder();
        const setup = createSetupService(temp.work, false, log.reporter);

        const { paths, branch } = await setup.clone(temp.originUrl);
        const root = join(temp.work, "origin");

        // The paths are what `run.tsx` hands to `createWorktreeService`, so
        // every field of them is load-bearing.
        expect(paths).toEqual({
          root,
          gitDir: join(root, ".bare"),
          gitFile: join(root, ".git"),
          kind: "managed",
        });
        expect(branch).toBe("main");
        expect(await pathExists(paths.gitDir)).toBe(true);
        expect(await pathExists(join(root, "main"))).toBe(true);

        // The steps are the screen's activity area while it waits.
        expect(log.succeeded).toEqual(["cloned", "fetched refs"]);

        // And the repository it produced is one the worktree service can read.
        const { service } = serviceAt(paths);

        expect((await service.list()).map((entry) => entry.dir)).toEqual(["main"]);
      });
    },
    SLOW,
  );

  test(
    "in place, the folder becomes the repository instead of gaining one",
    async () => {
      await withTempRepo(async (temp) => {
        const log = recorder();
        const here = join(temp.work, "here");
        await mkdir(here, { recursive: true });

        const { paths } = await createSetupService(here, true, log.reporter).clone(temp.originUrl);

        expect(paths.root).toBe(here);
        expect(await pathExists(join(here, ".bare"))).toBe(true);
        expect(await pathExists(join(here, "origin"))).toBe(false);
      });
    },
    SLOW,
  );

  test(
    "a URL that is not one, and a folder that is not empty, are refused before anything is made",
    async () => {
      await withTempRepo(async (temp) => {
        const log = recorder();
        const setup = createSetupService(temp.work, false, log.reporter);

        const bad = await refusalFrom(setup.clone("not a url"));

        expect(bad.code).toBe("usage");
        // Nothing was started for it either, which is the difference between a
        // setup screen that says "that is not a URL" and one that says it after
        // appearing to begin.
        expect(log.steps).toEqual([]);

        await mkdir(join(temp.work, "origin"), { recursive: true });
        await Bun.write(join(temp.work, "origin", "mine.txt"), "already here\n");

        const occupied = await refusalFrom(setup.clone(temp.originUrl));

        expect(occupied.code).toBe("state-conflict");
        expect(occupied.hint).toBeDefined();
        expect(await pathExists(join(temp.work, "origin", "mine.txt"))).toBe(true);
      });
    },
    SLOW,
  );

  test(
    "a clone whose file wants to run something says so and runs none of it",
    async () => {
      await withTempRepo(async (temp) => {
        scratchCount += 1;
        const scratch = join(temp.root, `seeded-${scratchCount}`);
        await seedGit(temp.root, ["clone", "--branch", "main", temp.originPath, scratch]);
        await Bun.write(join(scratch, ".grove.toml"), '[setup]\nrun = ["echo ran > ran.txt"]\n');
        await seedGit(scratch, ["add", "-A"]);
        await seedGit(scratch, ["-c", "commit.gpgsign=false", "commit", "-m", "Add .grove.toml"]);
        await seedGit(scratch, ["push", "origin", "HEAD:main"]);
        await rm(scratch, { recursive: true, force: true });

        const log = recorder();
        const { paths } = await createSetupService(temp.work, false, log.reporter).clone(
          temp.originUrl,
        );

        // The worst moment there has ever been to run a command is ten seconds
        // after downloading it, so the clone names it and leaves it.
        expect(log.warnings.join("\n")).toContain("wants to run");
        expect(await pathExists(join(paths.root, "main", "ran.txt"))).toBe(false);

        // It is waiting on the screen instead, which is where the question gets
        // asked with the file in front of you.
        const { service } = serviceAt(paths);

        expect(await service.pendingCommands()).toEqual(["echo ran > ran.txt"]);
      });
    },
    SLOW,
  );
});

/**
 * `/rebase`, against a real repository: the rows the popup lists, the line the
 * rebase answers with, and the refusal a conflict arrives as.
 */
describe("the rebase the screen's /rebase runs", () => {
  test(
    "lists the bases, rebases onto the one picked, and says when the changes came back",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");
        const worktree = join(root, "feat", "login");

        // The branch tracks the origin's copy, and the fixture has no other
        // worktree to offer — so the two role rows, and nothing else.
        const choices = await service.rebaseChoices(worktree);
        expect(choices.map((choice) => `${choice.label} ${choice.ref}`)).toEqual([
          "upstream origin/feat/login",
          "trunk origin/main",
        ]);

        await commitOnOrigin(temp, "main", "newer.txt");
        expect(await service.rebase(worktree, { kind: "trunk" })).toBe(
          "feat/login rebased onto origin/main",
        );
        expect(await pathExists(join(worktree, "newer.txt"))).toBe(true);
        expect(await service.rebase(worktree, { kind: "trunk" })).toBe(
          "feat/login already on origin/main",
        );

        // Dirty, and rebased anyway: the edit is back afterwards, and the line
        // says so, because that is the part somebody would otherwise check.
        await commitOnOrigin(temp, "main", "later.txt");
        await Bun.write(join(worktree, "login.txt"), "half-finished\n");
        expect(await service.rebase(worktree, { kind: "trunk" })).toBe(
          "feat/login rebased onto origin/main, 1 change carried",
        );
        expect(await Bun.file(join(worktree, "login.txt")).text()).toBe("half-finished\n");
        expect(await pathExists(join(worktree, "later.txt"))).toBe(true);
      });
    },
    SLOW,
  );

  test(
    "a rebase that conflicted is a refusal, and the worktree is left as it was",
    async () => {
      await withTempRepo(async (temp) => {
        const paths = await managedRepo(temp);
        const root = paths.root;
        const { service } = serviceAt(paths);

        await service.add("feat/login");
        const worktree = join(root, "feat", "login");
        await Bun.write(join(worktree, "clash.txt"), "mine\n");
        await seedGit(worktree, ["add", "-A"]);
        await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", "Add clash.txt"]);
        await commitOnOrigin(temp, "main", "clash.txt");

        const refusal = await refusalFrom(service.rebase(worktree, { kind: "trunk" }));

        expect(refusal.code).toBe("rebase-conflict");
        expect(refusal.message).toBe("feat/login conflicted");
        expect(refusal.details.join("\n")).toContain("rolled back");
        expect(refusal.details.join("\n")).toContain("clash.txt");

        const after = (await service.list()).find((summary) => summary.dir === "feat/login");
        expect(after?.rebasing).toBe(false);
        expect(await Bun.file(join(worktree, "clash.txt")).text()).toBe("mine\n");
      });
    },
    SLOW,
  );
});
