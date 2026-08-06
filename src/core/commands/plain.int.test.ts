import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createPlainReporter } from "../../report/reporter.ts";
import { findRepoRoot } from "../discover.ts";
import type { GroveError } from "../errors.ts";
import { pathExists } from "../fs.ts";
import { runGit } from "../git.ts";
import type { RepoPaths } from "../layout.ts";
import { withTempRepo } from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { cloneRepo } from "./clone.ts";
import { listWorktreeSummaries } from "./list.ts";
import { worktreePath } from "./path.ts";
import { removeWorktree } from "./remove.ts";
import { syncWorktrees } from "./sync.ts";

/**
 * `grove` standing in an ordinary `git clone`, recognised as-is rather than
 * converted — the bug report this whole feature answers: running the tool
 * inside a worktree it did not lay out used to answer `not-a-repo` and, in the
 * app, open a screen asking for a clone URL instead of showing what was
 * already there.
 */

const onPosix = test.skipIf(process.platform === "win32");

const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

async function expectError(promise: Promise<unknown>): Promise<GroveError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(caught).toBeDefined();

  return caught as GroveError;
}

/** An ordinary `git clone` of the fixture, named `plain` inside `work`. */
async function withPlainRepo(
  body: (context: { repo: RepoPaths; work: string; plain: string }) => Promise<void>,
): Promise<void> {
  await withTempRepo(async ({ work, originUrl }) => {
    const plain = join(work, "plain");
    await runGit(["clone", originUrl, plain], { cwd: work });

    const repo = await findRepoRoot(plain);
    expect(repo.kind).toBe("plain");

    await body({ repo, work, plain });
  });
}

onPosix(
  "discovery recognises a plain clone from a nested directory and from a hand-made worktree",
  async () => {
    await withPlainRepo(async ({ repo, work, plain }) => {
      const nested = join(plain, "src", "deep");
      await mkdir(nested, { recursive: true });
      const fromNested = await findRepoRoot(nested);
      expect(fromNested.kind).toBe("plain");
      expect(fromNested.root).toBe(plain);

      // A worktree made by hand — not through `grove add` — is still `plain`'s,
      // and standing inside it resolves back to the same root.
      const handMade = join(work, "plain-by-hand");
      await runGit(["worktree", "add", "-b", "by-hand", handMade], { cwd: plain });

      const fromHandMade = await findRepoRoot(handMade);
      expect(fromHandMade.kind).toBe("plain");
      expect(fromHandMade.root).toBe(plain);
      expect(fromHandMade.root).toBe(repo.root);
    });
  },
  30_000,
);

onPosix(
  "a plain clone beside a managed repo never confuses rule 4's child scan",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      await runGit(["clone", originUrl, join(work, "plain")], { cwd: work });
      await cloneRepo(work, { url: originUrl, dir: "managed" }, silent());

      // Rule 4 only ever sees `.bare`-marked children, so exactly one managed
      // repo below `work` is still unambiguous even with a plain clone beside it.
      const found = await findRepoRoot(work);
      expect(found.kind).toBe("managed");
      expect(found.root).toBe(join(work, "managed"));
    });
  },
  30_000,
);

onPosix(
  "list shows the main checkout as '.' and a hand-made sibling as ../name",
  async () => {
    await withPlainRepo(async ({ repo, work, plain }) => {
      const sibling = join(work, "plain-feat-login");
      await runGit(
        ["worktree", "add", "--track", "-b", "feat/login", sibling, "origin/feat/login"],
        {
          cwd: plain,
        },
      );

      const summaries = await listWorktreeSummaries(repo, plain);
      const main = summaries.find((s) => s.branch === "main");
      const feat = summaries.find((s) => s.branch === "feat/login");

      expect(main).toMatchObject({ dir: ".", isDefault: true, current: true });
      expect(feat).toMatchObject({ dir: "../plain-feat-login", isDefault: false, current: false });
    });
  },
  30_000,
);

onPosix(
  "add creates a sibling named after the repo, and stays idempotent",
  async () => {
    await withPlainRepo(async ({ repo, work }) => {
      const result = await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false, setup: false, trust: false },
        silent(),
      );

      expect(result.path).toBe(join(work, "plain-feat-login"));
      expect(result.alreadyPresent).toBe(false);
      expect(await pathExists(join(result.path, "login.txt"))).toBe(true);

      const again = await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false, setup: false, trust: false },
        silent(),
      );
      expect(again.alreadyPresent).toBe(true);
      expect(again.path).toBe(result.path);
    });
  },
  30_000,
);

onPosix(
  "remove refuses the repository root even with force",
  async () => {
    await withPlainRepo(async ({ repo, work, plain }) => {
      // A second worktree, so "the only worktree" refusal is not what fires —
      // the point of this test is the root-specific guard underneath it.
      await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false, setup: false, trust: false },
        silent(),
      );

      const error = await expectError(
        removeWorktree(repo, work, { target: ".", force: true, deleteBranch: false }, silent()),
      );
      expect(error.code).toBe("refused");
      expect(await pathExists(plain)).toBe(true);
    });
  },
  30_000,
);

onPosix(
  "remove takes a hand-made sibling worktree like any other",
  async () => {
    await withPlainRepo(async ({ repo, work, plain }) => {
      const sibling = join(work, "plain-feat-login");
      await runGit(
        ["worktree", "add", "--track", "-b", "feat/login", sibling, "origin/feat/login"],
        {
          cwd: plain,
        },
      );

      const result = await removeWorktree(
        repo,
        work,
        { target: "feat/login", force: false, deleteBranch: false },
        silent(),
      );

      expect(result.path).toBe(sibling);
      expect(await pathExists(sibling)).toBe(false);
    });
  },
  30_000,
);

onPosix(
  "sync fast-forwards the main checkout in place",
  async () => {
    await withPlainRepo(async ({ repo, plain }) => {
      const outcomes = await syncWorktrees(
        repo,
        plain,
        { all: false, abortOnConflict: true, push: true },
        silent(),
      );

      expect(outcomes).toHaveLength(1);
      const [outcome] = outcomes;
      expect(outcome).toMatchObject({ dir: ".", branch: "main" });
      expect(["up-to-date", "fast-forwarded"]).toContain(outcome?.kind ?? "");
    });
  },
  30_000,
);

onPosix(
  "path answers the root for no target, and a sibling for a branch",
  async () => {
    await withPlainRepo(async ({ repo, work, plain }) => {
      const root = await worktreePath(repo, plain);
      expect(root).toEqual({ path: plain, dir: "." });

      await addWorktree(
        repo,
        { branch: "feat/login", fetch: true, push: false, setup: false, trust: false },
        silent(),
      );

      const feat = await worktreePath(repo, plain, "feat/login");
      expect(feat.path).toBe(join(work, "plain-feat-login"));
      expect(feat.dir).toBe("../plain-feat-login");
    });
  },
  30_000,
);
