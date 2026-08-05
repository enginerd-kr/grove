import { expect, test } from "bun:test";
import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createPlainReporter } from "../../report/reporter.ts";
import type { GardenError } from "../errors.ts";
import { gitOutput, runGit } from "../git.ts";
import { type RepoPaths, repoPaths } from "../layout.ts";
import { seedGit, withTempRepo } from "../test-utils.ts";
import { addWorktree } from "./add.ts";
import { cloneRepo } from "./clone.ts";
import { createPr, prPreview } from "./pr.ts";

/**
 * `p` against real git and a stand-in `gh`.
 *
 * The git half — what to propose, when to publish — runs against the real
 * thing. The forge half cannot: `gh` would need a network and an account, so
 * the tests put an executable named `gh` first on PATH that records its
 * arguments and answers with a URL, which is exactly the seam the code uses.
 * Real subprocess, fake forge.
 */

const onPosix = test.skipIf(process.platform === "win32");

const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

async function expectError(promise: Promise<unknown>): Promise<GardenError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(caught).toBeDefined();

  return caught as GardenError;
}

/**
 * Installs a fake `gh` at the front of PATH for the duration.
 *
 * `runTool` resolves through `process.env` at call time, which is the same
 * property `withTempRepo` already leans on for the git identity.
 */
async function withFakeGh(
  root: string,
  script: string,
  body: (argsFile: string) => Promise<void>,
): Promise<void> {
  const bin = join(root, "fake-bin");
  const argsFile = join(bin, "gh-args.txt");
  await mkdir(bin, { recursive: true });
  await Bun.write(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\n${script}\n`);
  await chmod(join(bin, "gh"), 0o755);

  const restore = process.env.PATH;
  process.env.PATH = `${bin}:${restore ?? ""}`;
  try {
    await body(argsFile);
  } finally {
    process.env.PATH = restore;
  }
}

async function withRepo(body: (repo: RepoPaths, worktree: string) => Promise<void>): Promise<void> {
  await withTempRepo(async ({ work, originUrl }) => {
    const { root } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());
    const repo = repoPaths(root);
    await addWorktree(
      repo,
      { branch: "feat/new-thing", fetch: true, push: false, setup: false, trust: false },
      silent(),
    );

    await body(repo, join(root, "feat/new-thing"));
  });
}

async function commitIn(worktree: string, name: string, message: string): Promise<void> {
  await Bun.write(join(worktree, name), `${name}\n`);
  await seedGit(worktree, ["add", "-A"]);
  await seedGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-qm", message]);
}

onPosix("one commit speaks for itself: its body becomes the body", async () => {
  await withRepo(async (repo, worktree) => {
    await Bun.write(join(worktree, "a.txt"), "a\n");
    await seedGit(worktree, ["add", "-A"]);
    await seedGit(worktree, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Add the thing\n\nBecause it was missing.",
    ]);

    const preview = await prPreview(repo, repo.root, "feat/new-thing");

    expect(preview.subjects).toEqual(["Add the thing"]);
    expect(preview.body).toBe("Because it was missing.");
    expect(preview.base).toBe("main");
    expect(preview.commits).toBe(1);
  });
});

onPosix("several commits: the subjects sum it up, oldest first", async () => {
  await withRepo(async (repo, worktree) => {
    await commitIn(worktree, "a.txt", "First step");
    await commitIn(worktree, "b.txt", "Second step");

    const preview = await prPreview(repo, repo.root, "feat/new-thing");

    expect(preview.subjects).toEqual(["First step", "Second step"]);
    expect(preview.body).toBe("- First step\n- Second step");
  });
});

onPosix("a branch with nothing the trunk does not have is refused", async () => {
  await withRepo(async (repo) => {
    const error = await expectError(prPreview(repo, repo.root, "feat/new-thing"));

    expect(error.code).toBe("refused");
    expect(error.message).toContain("nothing");
  });
});

onPosix("the trunk itself is refused: it is what PRs merge into", async () => {
  await withRepo(async (repo) => {
    const error = await expectError(prPreview(repo, repo.root, "main"));

    expect(error.code).toBe("refused");
    expect(error.message).toContain("merge into");
  });
});

onPosix("an unpublished branch is pushed with -u, then gh is asked", async () => {
  await withRepo(async (repo, worktree) => {
    await commitIn(worktree, "a.txt", "First step");

    await withFakeGh(repo.root, 'echo "https://example.com/pr/7"', async (argsFile) => {
      const result = await createPr(
        repo,
        repo.root,
        { target: "feat/new-thing", title: "A title somebody edited", body: "- First step" },
        silent(),
      );

      expect(result.url).toBe("https://example.com/pr/7");
      expect(result.published).toBe(true);

      // What actually crossed the seam: the edited title, the shown body.
      const args = (await Bun.file(argsFile).text()).split("\n");
      expect(args).toContain("A title somebody edited");
      expect(args).toContain("- First step");

      // The branch really is published, with the upstream a later sync needs.
      const upstream = await gitOutput(["rev-parse", "--abbrev-ref", "@{upstream}"], {
        cwd: worktree,
      });
      expect(upstream).toBe("origin/feat/new-thing");
    });
  });
});

onPosix("a published branch is pushed plainly before asking", async () => {
  await withRepo(async (repo, worktree) => {
    await commitIn(worktree, "a.txt", "First step");
    await seedGit(worktree, ["push", "-q", "-u", "origin", "HEAD"]);
    await commitIn(worktree, "b.txt", "Second step");

    await withFakeGh(repo.root, 'echo "https://example.com/pr/8"', async () => {
      const result = await createPr(
        repo,
        repo.root,
        { target: "feat/new-thing", title: "t", body: "" },
        silent(),
      );

      expect(result.published).toBe(false);
      // The unpushed commit made it to the remote before gh was asked.
      const remote = await runGit(["rev-parse", "origin/feat/new-thing"], { cwd: worktree });
      const local = await runGit(["rev-parse", "HEAD"], { cwd: worktree });
      expect(remote.stdout).toBe(local.stdout);
    });
  });
});

onPosix("gh saying no is reported in gh's words, with our exit code", async () => {
  await withRepo(async (repo, worktree) => {
    await commitIn(worktree, "a.txt", "First step");

    await withFakeGh(
      repo.root,
      'echo "a pull request for branch feat/new-thing already exists" >&2; exit 1',
      async () => {
        const error = await expectError(
          createPr(repo, repo.root, { target: "feat/new-thing", title: "t", body: "" }, silent()),
        );

        expect(error.code).toBe("gh");
        expect(error.details.join("\n")).toContain("already exists");
      },
    );
  });
});

onPosix("gh missing entirely is its own answer, not a stack trace", async () => {
  await withRepo(async (repo, worktree) => {
    await commitIn(worktree, "a.txt", "First step");

    // A PATH that provably lacks gh. "/usr/bin:/bin" was the first try and it
    // failed on exactly the machine this test exists for: GitHub's runners
    // ship gh at /usr/bin/gh. So the PATH is one fresh directory holding a
    // symlink to the real git — enough for the push, and provably nothing else.
    const gitOnly = join(repo.root, "git-only-bin");
    await mkdir(gitOnly, { recursive: true });
    const git = Bun.which("git");
    if (git === null) throw new Error("no git on PATH");
    await symlink(git, join(gitOnly, "git"));

    const restore = process.env.PATH;
    process.env.PATH = gitOnly;
    try {
      const error = await expectError(
        createPr(repo, repo.root, { target: "feat/new-thing", title: "t", body: "" }, silent()),
      );

      expect(error.code).toBe("gh");
      expect(error.message).toContain("not installed");
    } finally {
      process.env.PATH = restore;
    }
  });
});

onPosix("an empty title is refused before anything is pushed", async () => {
  await withRepo(async (repo, worktree) => {
    await commitIn(worktree, "a.txt", "First step");

    const error = await expectError(
      createPr(repo, repo.root, { target: "feat/new-thing", title: "  ", body: "" }, silent()),
    );

    expect(error.code).toBe("usage");
    // Still unpublished: the refusal came first.
    const upstream = await runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: worktree });
    expect(upstream.code).not.toBe(0);
  });
});
