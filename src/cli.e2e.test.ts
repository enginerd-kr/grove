import { expect, test } from "bun:test";
import { version } from "../package.json";
import { runCli } from "./ui/e2e-utils.ts";

/**
 * End-to-end: the real `cli.tsx` process, driven the way it is normally used.
 *
 * These cover what unit tests on `parseCliArgs` structurally cannot — the exit
 * code and which stream each thing lands on. Parsing behaviour itself belongs
 * in `cli/args.test.ts`, which needs no subprocess.
 */

// `Bun.spawn` with pipes is portable, but the PTY tests these will grow back
// into are POSIX-only; keeping one guard means the file's skip rule never moves.
const onPosix = test.skipIf(process.platform === "win32");

onPosix(
  "answers --help and --version on stdout, exit 0",
  async () => {
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: wt <command>");
    expect(help.stdout).toContain("clone");
    expect(help.stderr).toBe("");

    const versionRun = await runCli(["--version"]);
    expect(versionRun.exitCode).toBe(0);
    expect(versionRun.stdout.trim()).toBe(version);
  },
  20_000,
);

// The old entry point exited 1 here because Ink needed raw mode. A worktree
// command has no such need, so a pipe is now an ordinary way to run.
onPosix(
  "runs without a terminal instead of refusing",
  async () => {
    const { exitCode, stdout } = await runCli();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  },
  20_000,
);

onPosix(
  "a usage error exits 2 and keeps stdout clean",
  async () => {
    const { exitCode, stdout, stderr } = await runCli(["add"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("branch name");
    // `wt list --json | jq` depends on stdout carrying nothing but results, so
    // even a failure must not write there.
    expect(stdout).toBe("");
  },
  20_000,
);

onPosix(
  "an unknown command exits 2 and lists the real ones",
  async () => {
    const { exitCode, stderr } = await runCli(["wroktree"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown command");
    expect(stderr).toContain("clone");
  },
  20_000,
);

// Pins the contract that an unfinished feature reports as a bug in the tool (1)
// rather than as something the user did wrong.
onPosix(
  "an unimplemented command exits 1, not 2",
  async () => {
    const { exitCode, stderr } = await runCli(["sync"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("not implemented");
  },
  20_000,
);

// Distinct from both of the above: the command exists and the request was
// understood, there is just no repository here.
onPosix(
  "running outside a managed repo exits 3 with somewhere to go next",
  async () => {
    const { exitCode, stdout, stderr } = await runCli(["list"], { cwd: import.meta.dir });

    expect(exitCode).toBe(3);
    expect(stderr).toContain("wt clone");
    expect(stdout).toBe("");
  },
  20_000,
);

onPosix(
  "starts in the directory it is given",
  async () => {
    // Proves the harness plumbs `cwd` through — every command that resolves its
    // target from the invocation directory is built on this.
    const { exitCode } = await runCli(["--version"], { cwd: import.meta.dir });

    expect(exitCode).toBe(0);
  },
  20_000,
);
