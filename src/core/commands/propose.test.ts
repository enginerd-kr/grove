import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExitCode, errorToExitCode } from "../../cli/exit-codes.ts";
import {
  type Attempt,
  attempt,
  probeGit,
  recorder,
  refused,
  seedGit,
  succeeded,
} from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { type Forge, withForge } from "./forge-test-utils.ts";
import {
  type ProposeOptions,
  type ProposeResult,
  proposalFor,
  proposePullRequest,
  proposeStack,
} from "./propose.ts";

/**
 * `grove propose` against a real origin and a fake forge.
 *
 * The forge is the same fake `gh` that `pr.test.ts` drives, answering `pr
 * list` and `pr create` in whatever words a test writes down for it. What is
 * real is everything before the forge is asked: the base is read off the
 * stack, the branch is pushed to a bare repository on disk, and what that
 * repository holds afterwards is what proves the push. The argv handed to
 * `gh` is asserted whole, because the `--base` on it is the entire point.
 */

/** POSIX only — the fake is a shell script. */
const POSIX = process.platform !== "win32";

const CREATED = "https://github.example/acme/widget/pull/57\n";

/** A worktree of this repository, cut from the trunk or stacked `--on` another. */
async function branch(forge: Forge, name: string, on?: string): Promise<string> {
  const result = await addWorktree(
    forge.repo,
    forge.repo.root,
    { branch: name, on, fetch: false, push: false, setup: false, trust: false, take: false },
    recorder().reporter,
  );

  return result.path;
}

/**
 * Commits `text` to `file` in `worktree`, so the branch has something of its own.
 *
 * The fixture's origin already has `feat/login` with `login.txt` reading
 * `login`, so a test that writes that same line there has changed nothing and
 * git refuses the commit: what goes on `feat/login` here has to differ from
 * what the fixture put there.
 */
async function commit(worktree: string, file: string, text: string): Promise<void> {
  await Bun.write(join(worktree, file), text);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", `Add ${file}`]);
}

function attemptPropose(
  forge: Forge,
  options: Partial<ProposeOptions> & { readonly target?: string },
): Promise<Attempt<ProposeResult>> {
  return attempt((reporter) =>
    proposePullRequest(
      forge.repo,
      forge.repo.root,
      { draft: false, web: false, ...options },
      reporter,
    ),
  );
}

/** The tip of `branch` on the base repository, or nothing when it is not there. */
async function onOrigin(forge: Forge, branch: string): Promise<string | undefined> {
  const result = await probeGit(forge.base, ["rev-parse", "--verify", "--quiet", branch]);

  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function headOf(worktree: string): Promise<string> {
  return (await probeGit(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

describe.skipIf(!POSIX)("where the pull request goes", () => {
  test("a stacked branch is proposed onto its parent, and the trunk is what the rest get", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");
      await forge.answerTo("pr create", CREATED);

      const login = await branch(forge, "feat/login");
      await commit(login, "login.txt", "login, again\n");
      const api = await branch(forge, "feat/login-api", "feat/login");
      await commit(api, "api.txt", "api\n");

      const outcome = await attemptPropose(forge, { target: "feat/login-api" });
      const result = succeeded(outcome);

      // The whole result: the base is the parent the stack recorded, the
      // branch was published on the way, and the number came out of gh's URL.
      expect(result).toEqual({
        path: api,
        dir: "feat/login-api",
        branch: "feat/login-api",
        base: "feat/login",
        parent: "feat/login",
        pushed: "published",
        number: 57,
        url: "https://github.example/acme/widget/pull/57",
        created: true,
        web: false,
      });

      // The push is real: origin has the branch at the worktree's commit, and
      // the branch now tracks it — the same first push `sync --publish` makes.
      expect(await onOrigin(forge, "feat/login-api")).toBe(await headOf(api));
      expect(
        (await probeGit(api, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("origin/feat/login-api");

      // What gh was asked, whole: the existence question first, then the
      // creation with `--base` on it and the title filled in from the commits.
      expect(await forge.asked()).toEqual([
        "pr list --head feat/login-api --state open --limit 1 --json number,url,baseRefName",
        "pr create --base feat/login --fill",
      ]);
      const narrated = outcome.log.err.join("");
      expect(narrated).toContain("✓ published feat/login-api to origin/feat/login-api");
      expect(narrated).toContain("✓ pull request 57 — feat/login-api onto feat/login");
      expect(outcome.log.out).toEqual([]);

      // An unstacked branch goes onto the trunk, with no parent to report.
      const unstacked = succeeded(await attemptPropose(forge, { target: "feat/login" }));
      expect([unstacked.base, unstacked.parent]).toEqual(["main", undefined]);
      expect((await forge.asked()).at(-1)).toBe("pr create --base main --fill");
    });
  }, 90_000);

  test("--base overrides the stack, and --draft, --title and --body reach gh as typed", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");
      await forge.answerTo("pr create", CREATED);

      const login = await branch(forge, "feat/login");
      await commit(login, "login.txt", "login, again\n");
      const api = await branch(forge, "feat/login-api", "feat/login");
      await commit(api, "api.txt", "api\n");

      const result = succeeded(
        await attemptPropose(forge, {
          target: "feat/login-api",
          base: "develop",
          draft: true,
          title: "Add the API",
          body: "Sits on feat/login.",
        }),
      );

      // The record is still reported, so a `--json` reader can see what the
      // flag overrode.
      expect([result.base, result.parent]).toEqual(["develop", "feat/login"]);
      expect((await forge.asked()).at(-1)).toBe(
        "pr create --base develop --draft --title Add the API --body Sits on feat/login.",
      );

      // A title alone is a title and an empty body — gh insists on both.
      await branch(forge, "feat/other");
      await commit(join(forge.repo.root, "feat", "other"), "other.txt", "other\n");
      succeeded(await attemptPropose(forge, { target: "feat/other", title: "Other" }));
      expect((await forge.asked()).at(-1)).toBe("pr create --base main --title Other --body ");
    });
  }, 90_000);

  test("--web pushes, opens the browser, and reports no number", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");
      await forge.answerTo(
        "pr create",
        "Opening https://github.example/compare in your browser.\n",
      );

      const spike = await branch(forge, "spike");
      await commit(spike, "spike.txt", "spike\n");

      const outcome = await attemptPropose(forge, { target: "spike", web: true });
      const result = succeeded(outcome);

      expect(result).toMatchObject({
        base: "main",
        pushed: "published",
        created: false,
        web: true,
      });
      // No number and no URL: the browser has the form, and nothing exists yet.
      expect([result.number, result.url]).toEqual([undefined, undefined]);
      expect(await onOrigin(forge, "spike")).toBe(await headOf(spike));
      expect((await forge.asked()).at(-1)).toBe("pr create --base main --web");
      expect(outcome.log.err.join("")).toContain("✓ browser opened for spike onto main");
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("--stack", () => {
  test("proposes the branches under the target first, each onto the one below it", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");
      await forge.answerTo("pr create", CREATED);

      const login = await branch(forge, "feat/login");
      await commit(login, "login.txt", "login, again\n");
      const api = await branch(forge, "feat/login-api", "feat/login");
      await commit(api, "api.txt", "api\n");
      const ui = await branch(forge, "feat/login-ui", "feat/login-api");
      await commit(ui, "ui.txt", "ui\n");

      const outcome = await attempt((reporter) =>
        proposeStack(
          forge.repo,
          forge.repo.root,
          { target: "feat/login-ui", draft: true, web: false, stack: true },
          reporter,
        ),
      );
      const results = succeeded(outcome);

      // Bottom-up, and one result per branch in the order they were opened.
      // `feat/login` is the fixture's own branch and already tracks origin, so
      // its commit is pushed; the two cut here are published on the way.
      expect(results.map((result) => [result.branch, result.base, result.pushed])).toEqual([
        ["feat/login", "main", "pushed"],
        ["feat/login-api", "feat/login", "published"],
        ["feat/login-ui", "feat/login-api", "published"],
      ]);
      // Every push is real.
      for (const [name, path] of [
        ["feat/login", login],
        ["feat/login-api", api],
        ["feat/login-ui", ui],
      ] as const) {
        expect(await onOrigin(forge, name)).toBe(await headOf(path));
      }

      // The forge was asked about each in turn: does one exist, then open it
      // onto the branch below — `--draft` reaching every one of them.
      expect((await forge.asked()).filter((call) => call.startsWith("pr create"))).toEqual([
        "pr create --base main --draft --fill",
        "pr create --base feat/login --draft --fill",
        "pr create --base feat/login-api --draft --fill",
      ]);
      expect(outcome.log.err.join("")).toContain(
        "proposing 3 pull requests: feat/login → feat/login-api → feat/login-ui",
      );
    });
  }, 90_000);

  test("a pull request already open in the chain is reported and the rest are still opened", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr create", CREATED);

      const login = await branch(forge, "feat/login");
      await commit(login, "login.txt", "login, again\n");
      const api = await branch(forge, "feat/login-api", "feat/login");
      await commit(api, "api.txt", "api\n");

      // The forge answers the existence question the same way for every
      // branch, so both read as already proposed onto main; what matters is
      // that neither is refused and the second is still reached.
      await forge.answerTo(
        "pr list",
        JSON.stringify([
          { number: 9, url: "https://github.example/acme/widget/pull/9", baseRefName: "main" },
        ]),
      );

      const results = succeeded(
        await attempt((reporter) =>
          proposeStack(
            forge.repo,
            forge.repo.root,
            { target: "feat/login-api", draft: false, web: false, stack: true },
            reporter,
          ),
        ),
      );

      expect(results.map((result) => [result.branch, result.created, result.number])).toEqual([
        ["feat/login", false, 9],
        ["feat/login-api", false, 9],
      ]);
      expect((await forge.asked()).some((call) => call.startsWith("pr create"))).toBe(false);
    });
  }, 90_000);

  test("a branch in the chain with no worktree is refused before anything is pushed", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");

      const login = await branch(forge, "feat/login");
      await commit(login, "login.txt", "login, again\n");
      const api = await branch(forge, "feat/login-api", "feat/login");
      await commit(api, "api.txt", "api\n");
      await seedGit(forge.repo.root, ["worktree", "remove", login]);

      const error = refused(
        await attempt((reporter) =>
          proposeStack(
            forge.repo,
            forge.repo.root,
            { target: "feat/login-api", draft: false, web: false, stack: true },
            reporter,
          ),
        ),
      );

      expect(error.message).toBe("feat/login is in the stack and has no worktree here");
      expect(error.hint).toContain("grove add feat/login");
      expect(await onOrigin(forge, "feat/login-api")).toBeUndefined();
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("what is pushed first", () => {
  test("a branch that is ahead is pushed plainly, and one that is level sends nothing", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");
      await forge.answerTo("pr create", CREATED);

      const spike = await branch(forge, "spike");
      await commit(spike, "one.txt", "one\n");
      await seedGit(spike, ["push", "-u", "origin", "spike"]);
      await commit(spike, "two.txt", "two\n");

      const ahead = succeeded(await attemptPropose(forge, { target: "spike" }));
      expect(ahead.pushed).toBe("pushed");
      expect(await onOrigin(forge, "spike")).toBe(await headOf(spike));

      // Nothing to send: origin already has exactly this.
      await forge.answerTo("pr list", "[]");
      const level = succeeded(await attemptPropose(forge, { target: "spike" }));
      expect(level.pushed).toBe("up-to-date");
    });
  }, 90_000);

  test("a branch behind its remote is refused before anything is pushed or asked", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");

      const spike = await branch(forge, "spike");
      await commit(spike, "one.txt", "one\n");
      await seedGit(spike, ["push", "-u", "origin", "spike"]);
      // The remote moves on, from a clone standing in for somebody else's laptop.
      const scratch = join(forge.temp.root, "scratch");
      await seedGit(forge.temp.root, ["clone", forge.base, scratch]);
      await seedGit(scratch, ["checkout", "spike"]);
      await commit(scratch, "theirs.txt", "theirs\n");
      await seedGit(scratch, ["push", "origin", "spike"]);
      await seedGit(forge.repo.gitDir, ["fetch", "origin"]);

      const error = refused(await attemptPropose(forge, { target: "spike" }));

      expect(error.code).toBe("refused");
      expect(errorToExitCode(error.code)).toBe(ExitCode.refused);
      expect(error.message).toBe("spike is 1 commit behind origin/spike");
      expect(error.hint).toBe("bring it up to date first: grove sync spike");
      // The existence question was asked — it comes before the push — and
      // nothing else was.
      expect(await forge.asked()).toEqual([
        "pr list --head spike --state open --limit 1 --json number,url,baseRefName",
      ]);
    });
  }, 90_000);

  test("uncommitted changes are warned about, not refused, and are not in the pull request", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");
      await forge.answerTo("pr create", CREATED);

      const spike = await branch(forge, "spike");
      await commit(spike, "one.txt", "one\n");
      await Bun.write(join(spike, "one.txt"), "half-edited\n");

      const outcome = await attemptPropose(forge, { target: "spike" });
      succeeded(outcome);

      expect(outcome.log.err).toContain(
        "! spike has 1 uncommitted change, which the pull request will not have\n",
      );
      expect(await onOrigin(forge, "spike")).toBe(await headOf(spike));
      expect(await Bun.file(join(spike, "one.txt")).text()).toBe("half-edited\n");
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("a pull request that already exists", () => {
  test("is reported rather than opened twice, and a base the stack disagrees with is said", async () => {
    await withForge(async (forge) => {
      const login = await branch(forge, "feat/login");
      await commit(login, "login.txt", "login, again\n");
      const api = await branch(forge, "feat/login-api", "feat/login");
      await commit(api, "api.txt", "api\n");

      await forge.answerTo(
        "pr list",
        JSON.stringify([
          { number: 12, url: "https://github.example/acme/widget/pull/12", baseRefName: "main" },
        ]),
      );

      const outcome = await attemptPropose(forge, { target: "feat/login-api" });
      const result = succeeded(outcome);

      expect(result).toMatchObject({
        base: "main",
        parent: "feat/login",
        number: 12,
        url: "https://github.example/acme/widget/pull/12",
        created: false,
        pushed: "up-to-date",
      });
      // Nothing was pushed and nothing was created: the branch is still on
      // no remote, and gh was asked one question.
      expect(await onOrigin(forge, "feat/login-api")).toBeUndefined();
      expect(await forge.asked()).toHaveLength(1);

      const narrated = outcome.log.err;
      expect(narrated).toContain("· pull request 12 already proposes feat/login-api onto main\n");
      // The one thing this command knows better than the forge, with the
      // command that acts on it — printed, not run.
      expect(narrated).toContain(
        "! it goes onto main, and feat/login-api sits on feat/login: gh pr edit 12 --base feat/login moves it\n",
      );
    });
  }, 90_000);

  test("the screen's question reads the same proposal, before anything is pushed", async () => {
    await withForge(async (forge) => {
      await forge.answerTo("pr list", "[]");

      const login = await branch(forge, "feat/login");
      await commit(login, "login.txt", "login, again\n");
      await branch(forge, "feat/login-api", "feat/login");

      const proposal = await proposalFor(forge.repo, forge.repo.root, {
        target: "feat/login-api",
      });

      expect([proposal.base, proposal.parent, proposal.remote, proposal.existing]).toEqual([
        "feat/login",
        "feat/login",
        "origin",
        undefined,
      ]);
      expect(proposal.status.upstream).toBeUndefined();
      expect(await onOrigin(forge, "feat/login-api")).toBeUndefined();
    });
  }, 90_000);
});

describe.skipIf(!POSIX)("what is refused outright", () => {
  test("the trunk, a review worktree, and a worktree nobody is standing in", async () => {
    await withForge(async (forge) => {
      const trunk = refused(await attemptPropose(forge, { target: "main" }));
      expect(trunk.code).toBe("refused");
      expect(trunk.message).toBe("main is the branch pull requests go onto");

      // A `pr/<n>` branch is somebody else's proposal: pushing there updates
      // it, and a second pull request for it would be one for a pull request.
      await seedGit(forge.repo.gitDir, ["branch", "pr/9", "main"]);
      await branch(forge, "pr/9");
      const review = refused(await attemptPropose(forge, { target: "pr/9" }));
      expect(review.code).toBe("refused");
      expect(review.message).toBe("pr/9 is a pull request already");

      // No target and not inside a worktree — the root is never one.
      const nowhere = refused(await attemptPropose(forge, {}));
      expect(nowhere.code).toBe("usage");
      expect(nowhere.message).toBe("not inside a worktree, so there is nothing to propose");

      // None of the three reached the forge.
      expect(await forge.asked()).toEqual([]);
    });
  }, 90_000);

  test("gh missing is its own answer, and gh refusing carries gh's own words", async () => {
    await withForge(async (forge) => {
      const spike = await branch(forge, "spike");
      await commit(spike, "one.txt", "one\n");

      const missing = refused(
        await forge.withoutGh(() => attemptPropose(forge, { target: "spike" })),
      );
      expect(missing.code).toBe("gh");
      expect(errorToExitCode(missing.code)).toBe(ExitCode.gh);
      expect(missing.message).toBe("this needs `gh`, which is not installed");

      await forge.answerTo("pr list", "[]");
      forge.fails("1", "pull request create failed: GraphQL: Validation Failed");
      const outcome = await attemptPropose(forge, { target: "spike" });
      const failing = refused(outcome);

      expect(failing.code).toBe("gh");
      // `pr list` fails first with the same exit code, which is the honest
      // shape of a forge that is down: the first question is the one refused.
      expect(failing.message).toBe("gh pr list failed (exit 1)");
      expect(failing.details.join("\n")).toContain("Validation Failed");
      // Refused before the push: the branch is still on no remote.
      expect(await onOrigin(forge, "spike")).toBeUndefined();
    });
  }, 90_000);
});
