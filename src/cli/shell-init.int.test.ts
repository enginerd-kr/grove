import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addWorktree } from "../core/commands/add.ts";
import { cloneRepo } from "../core/commands/clone.ts";
import { repoPaths } from "../core/layout.ts";
import { withTempRepo } from "../core/test-utils.ts";
import { createPlainReporter } from "../report/reporter.ts";
import { isCompiledMain, shellInit } from "./shell-init.ts";

/**
 * The wrapper, evaluated by a real shell — with nothing installed.
 *
 * A function whose whole job is to move a shell can only be proven by a shell
 * that moved, and the claim worth proving is the bare-checkout one: no
 * `garden` on PATH anywhere, the eval line naming the runtime and the entry
 * script in full, the way somebody working from source would write it. The
 * function calls back by the same spelling, so nothing else is needed.
 *
 * bash rather than zsh because CI has bash, and the zsh script is the same
 * bytes.
 */

const onPosix = test.skipIf(process.platform === "win32");

const silent = () => createPlainReporter({ out: () => {}, err: () => {} });

const CLI = fileURLToPath(new URL("../cli.tsx", import.meta.url));

async function inBash(cwd: string, script: string) {
  const child = Bun.spawn(
    ["bash", "-c", `eval "$("${process.execPath}" "${CLI}" shell-init bash)"\n${script}`],
    { cwd, env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
}

onPosix(
  "`garden cd <branch>` moves the shell into that worktree",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { root: repoRoot } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());
      await addWorktree(
        repoPaths(repoRoot),
        { branch: "feat/login", fetch: true, push: false, setup: false, trust: false },
        silent(),
      );

      const result = await inBash(repoRoot, "garden cd feat/login && pwd");

      // Ink's non-TTY fallback closes with blank lines on stderr; noise, not news.
      expect(result.stderr.trim()).toBe("");
      expect(result.stdout.trim()).toBe(join(repoRoot, "feat/login"));
      expect(result.code).toBe(0);
    });
  },
  30000,
);

onPosix(
  "`garden cd` with nothing goes to the root — where anything can be removed",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { root: repoRoot } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());

      const result = await inBash(join(repoRoot, "main"), "garden cd && pwd");

      expect(result.stdout.trim()).toBe(repoRoot);
    });
  },
  30000,
);

onPosix(
  "a target nobody has stays put and keeps the exit code",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { root: repoRoot } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());

      const result = await inBash(repoRoot, 'garden cd feat/nope; echo "code=$? at=$(pwd)"');

      // `path` failed, so the wrapper returned its code without moving anywhere.
      expect(result.stdout.trim()).toBe(`code=3 at=${repoRoot}`);
      expect(result.stderr).toContain("no worktree matches");
    });
  },
  30000,
);

onPosix(
  "everything that is not `cd` passes through, exit code and all",
  async () => {
    await withTempRepo(async ({ work, originUrl }) => {
      const { root: repoRoot } = await cloneRepo(work, { url: originUrl, dir: "repo" }, silent());

      const list = await inBash(repoRoot, "garden list");
      expect(list.code).toBe(0);
      expect(list.stdout).toContain("main");

      const bad = await inBash(repoRoot, "garden wroktree; echo code=$?");
      expect(bad.stdout.trim()).toBe("code=2");
    });
  },
  30000,
);

// The one thing the emitted function must never contain: the virtual path a
// compiled binary calls its own entry script. It exists for no other process.
test("a compiled binary is recognised by its virtual entry path", () => {
  expect(isCompiledMain("/$bunfs/root/garden")).toBe(true);
  expect(isCompiledMain("B:\\~BUN\\root\\garden.exe")).toBe(true);
  expect(isCompiledMain("/Users/somebody/src/garden/src/cli.tsx")).toBe(false);
});

test("the function reaches back by the spelling that printed it", () => {
  // Not a `garden` it hopes is on PATH: the running runtime, quoted, so a bare
  // checkout with nothing installed still round-trips.
  expect(shellInit("zsh")).toContain(`'${process.execPath}'`);
  expect(shellInit("zsh")).not.toContain("command garden");
  expect(shellInit("zsh")).toBe(shellInit("bash"));
  expect(shellInit("fish")).toContain("function garden");
  // The seam the app writes through, present in every dialect.
  for (const shell of ["zsh", "fish"] as const) {
    expect(shellInit(shell)).toContain("GARDEN_CD_FILE");
  }
});
