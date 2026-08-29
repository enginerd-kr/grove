import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdCommand, copyToClipboard } from "./clipboard.ts";

/**
 * The clipboard carries a shell command, which makes quoting the whole of the
 * safety here: a worktree directory is named after a branch, and a branch name
 * is not a thing this tool gets to vet.
 *
 * Nothing below touches the real clipboard. `copyToClipboard` is exercised in a
 * child process whose `PATH` holds only what the test put there, because
 * `Bun.spawn` resolves an executable against the environment the process was
 * started with — mutating `process.env.PATH` in-process would not hide `pbcopy`,
 * it would just copy something to the developer's clipboard.
 */

const POSIX = process.platform !== "win32";
/** The first candidate for this platform, which is the one a fake stands in for. */
const CLIPBOARD_TOOL = process.platform === "darwin" ? "pbcopy" : "wl-copy";

async function withScratch(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "grove-clip-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs one line through a real `sh`, which is the shell the command is pasted into. */
async function sh(command: string, cwd?: string): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

  return { code, stdout };
}

/** The path as the command spells it — what a shell has to read back unchanged. */
function quotedPart(command: string): string {
  return command.slice("cd ".length);
}

/**
 * Loads `clipboard.ts` in a child with the `PATH` a test chose.
 *
 * Its answer is printed rather than returned, so an unexpected throw shows up
 * as a non-zero exit and stderr rather than as a quiet `false`.
 */
async function copyInChild(
  path: string,
  text: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const source = join(import.meta.dir, "clipboard.ts");
  const script =
    `const { copyToClipboard } = await import(${JSON.stringify(source)});` +
    `console.log(await copyToClipboard(${JSON.stringify(text)}));`;

  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: path, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, stdout: stdout.trim(), stderr };
}

describe("cdCommand", () => {
  test("leaves an ordinary path bare", () => {
    expect(cdCommand("/Users/me/code/repo/main", "darwin")).toBe("cd /Users/me/code/repo/main");
    expect(cdCommand("/Users/me/code/repo/feat/log-in", "linux")).toBe(
      "cd /Users/me/code/repo/feat/log-in",
    );
    expect(cdCommand("C:\\Users\\me\\repo\\main", "win32")).toBe("cd C:\\Users\\me\\repo\\main");
  });

  test("leaves every character a shell would not read as punctuation bare", () => {
    const path = "/tmp/a_b-c.d@e%f+g=h:i,j/k";

    expect(cdCommand(path, "darwin")).toBe(`cd ${path}`);
  });

  test("quotes a space", () => {
    expect(cdCommand("/Users/me/my repo/main", "darwin")).toBe("cd '/Users/me/my repo/main'");
    expect(cdCommand("/Users/me/my repo/main", "linux")).toBe("cd '/Users/me/my repo/main'");
    expect(cdCommand("C:\\Users\\me\\my repo", "win32")).toBe('cd "C:\\Users\\me\\my repo"');
  });

  test("spells a single quote the only way POSIX allows", () => {
    // Nothing is special inside single quotes, including a backslash — so the
    // quote is closed, spelled outside, and reopened.
    expect(cdCommand("/tmp/it's here", "darwin")).toBe(`cd '/tmp/it'\\''s here'`);
  });

  test("quotes the characters a shell would otherwise act on", () => {
    for (const hostile of ["$(id)", "`id`", "; rm -rf /", "&& id", "| id", "*", "~", "\n", "#"]) {
      const path = `/tmp/repo/${hostile}`;

      expect(cdCommand(path, "darwin")).toBe(`cd '${path}'`);
      expect(cdCommand(path, "win32")).toBe(`cd "${path}"`);
    }
  });

  test("defaults to the platform it is running on", () => {
    expect(cdCommand("/tmp/my repo")).toBe(cdCommand("/tmp/my repo", process.platform));
  });

  test.skipIf(!POSIX)("a real shell reads back exactly the path, whatever is in it", async () => {
    const hostile = [
      "/tmp/repo/my worktree",
      "/tmp/repo/it's mine",
      "/tmp/repo/$(id)",
      "/tmp/repo/`id`",
      "/tmp/repo/a;id",
      "/tmp/repo/a&&id",
      "/tmp/repo/a|id",
      "/tmp/repo/*",
      '/tmp/repo/a"b',
      "/tmp/repo/a\nb",
      "/tmp/repo/~me",
      "/tmp/repo/a b'c\"d$e`f",
    ];

    for (const path of hostile) {
      const echoed = await sh(`printf %s ${quotedPart(cdCommand(path, process.platform))}`);

      expect(echoed.code).toBe(0);
      expect(echoed.stdout).toBe(path);
    }
  });

  // `\` is bare only on Windows, where it is the path separator: left bare on
  // POSIX the shell eats it as an escape. Out of reach of a branch name, which
  // is slugged, but not of a directory a user named themselves.
  test.skipIf(!POSIX)("a backslash in a POSIX path survives being pasted", async () => {
    const path = "/tmp/repo/a\\b";
    const echoed = await sh(`printf %s ${quotedPart(cdCommand(path, "darwin"))}`);

    expect(echoed.stdout).toBe(path);
    // Worse at the end of a path, where the shell reads a line continuation and
    // silently swallows whatever is pasted after it.
    expect(cdCommand("/tmp/repo/a\\", "darwin")).toBe(`cd '/tmp/repo/a\\'`);
  });

  test.skipIf(!POSIX)("the command actually lands in the directory it names", async () => {
    await withScratch(async (dir) => {
      // The name a branch called `feat/it's $(a) "b"` would slug down to is
      // tamer than this, but the directory is not always one grove made.
      const worktree = join(dir, `it's $(id) "b" c&d`);
      await mkdir(worktree, { recursive: true });

      const landed = await sh(`${cdCommand(worktree, process.platform)} && pwd`, dir);

      expect(landed.code).toBe(0);
      expect(landed.stdout.trim()).toBe(worktree);
    });
  });
});

describe("copyToClipboard", () => {
  test.skipIf(!POSIX)(
    "answers false where no clipboard tool exists, rather than throwing",
    async () => {
      await withScratch(async (dir) => {
        const empty = join(dir, "bin");
        await mkdir(empty, { recursive: true });

        const result = await copyInChild(empty, "cd /tmp/repo/main", {});

        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(result.stdout).toBe("false");
      });
    },
  );

  test.skipIf(!POSIX)("hands the text to the tool it found", async () => {
    await withScratch(async (dir) => {
      const bin = join(dir, "bin");
      const received = join(dir, "received.txt");
      await mkdir(bin, { recursive: true });

      // `PATH` is reset inside so the fake can reach `cat`; what is being tested
      // is the lookup the parent does, not the one the script does.
      await Bun.write(
        join(bin, CLIPBOARD_TOOL),
        `#!/bin/sh\nPATH=/usr/bin:/bin\ncat > "$GROVE_TEST_CLIPBOARD"\n`,
      );
      await chmod(join(bin, CLIPBOARD_TOOL), 0o755);

      const result = await copyInChild(bin, "cd /tmp/repo/main", {
        GROVE_TEST_CLIPBOARD: received,
      });

      expect(result.stdout).toBe("true");
      expect(await Bun.file(received).text()).toBe("cd /tmp/repo/main");
    });
  });

  test.skipIf(!POSIX)("answers false when the tool it found fails", async () => {
    await withScratch(async (dir) => {
      const bin = join(dir, "bin");
      await mkdir(bin, { recursive: true });

      await Bun.write(join(bin, CLIPBOARD_TOOL), "#!/bin/sh\nexit 1\n");
      await chmod(join(bin, CLIPBOARD_TOOL), 0o755);

      const result = await copyInChild(bin, "cd /tmp/repo/main", {});

      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("false");
    });
  });

  test("is exported as an async answer, never a throw", () => {
    // Called for its shape only: invoking it here would spawn the real tool and
    // take over the clipboard of whoever is running the tests.
    expect(copyToClipboard).toBeInstanceOf(Function);
    expect(copyToClipboard.constructor.name).toBe("AsyncFunction");
  });
});
