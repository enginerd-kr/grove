import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { keys, plain, waitFor } from "../test-utils.ts";
import { ShellSetup } from "./ShellSetup.tsx";

/**
 * The one-time offer to wire up `grove cd` and enter-to-go.
 *
 * `detectShell` reads `$SHELL` live, so pinning it around each test is enough
 * to drive it — but `installShellInit` defaults to `os.homedir()`, which Bun
 * resolves once at process start rather than from `process.env.HOME`, so the
 * screen takes `home` as a prop the way `App` takes `columns`/`rows`: absent
 * everywhere but here.
 */

let home: string;
let restoreShell: string | undefined;
let restoreZdotdir: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "grove-shellsetup-"));
  restoreShell = process.env.SHELL;
  restoreZdotdir = process.env.ZDOTDIR;
  process.env.SHELL = "/bin/zsh";
  delete process.env.ZDOTDIR;
});

afterEach(async () => {
  if (restoreShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = restoreShell;
  if (restoreZdotdir === undefined) delete process.env.ZDOTDIR;
  else process.env.ZDOTDIR = restoreZdotdir;
  await rm(home, { recursive: true, force: true });
});

function mount() {
  const done: true[] = [];
  const instance = render(
    <ShellSetup folder="/work/repo" home={home} onDone={() => done.push(true)} />,
  );

  return { ...instance, done, frame: () => plain(instance.lastFrame()) };
}

/** `waitFor` reads a frame; this waits on `onDone` instead by polling the same way. */
function waitUntilDone(done: readonly unknown[]): Promise<void> {
  return waitFor(
    () => (done.length > 0 ? "done" : ""),
    (marker) => marker === "done",
  ).then(() => undefined);
}

test("opens asking about the detected shell", async () => {
  const ui = mount();

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("rc file"));

  expect(frame).toContain("Add it to zsh's rc file now?");
  expect(frame).toContain("y install");
  expect(frame).toContain("n skip");
});

test("y writes the eval line and waits for a key before handing off", async () => {
  const ui = mount();
  await waitFor(ui.lastFrame, (f) => f.includes("rc file now?"));

  ui.stdin.write("y");
  const frame = await waitFor(ui.lastFrame, (f) => f.includes("added to"));

  expect(frame).toContain(join(home, ".zshrc"));
  expect(frame).toContain("any key");
  expect(ui.done).toEqual([]);

  const written = await readFile(join(home, ".zshrc"), "utf8");
  expect(written).toContain("shell-init");

  ui.stdin.write(" ");
  await waitUntilDone(ui.done);
});

test("n declines without touching the rc file, and hands off right away", async () => {
  const ui = mount();
  await waitFor(ui.lastFrame, (f) => f.includes("rc file now?"));

  ui.stdin.write("n");
  await waitUntilDone(ui.done);

  await expect(readFile(join(home, ".zshrc"), "utf8")).rejects.toThrow();
});

test("esc declines the same way n does", async () => {
  const ui = mount();
  await waitFor(ui.lastFrame, (f) => f.includes("rc file now?"));

  ui.stdin.write(keys.esc);
  await waitUntilDone(ui.done);
});

test("running again reports already installed", async () => {
  const first = mount();
  await waitFor(first.lastFrame, (f) => f.includes("rc file now?"));
  first.stdin.write("y");
  await waitFor(first.lastFrame, (f) => f.includes("added to"));

  const second = mount();
  await waitFor(second.lastFrame, (f) => f.includes("rc file now?"));
  second.stdin.write("y");
  const frame = await waitFor(second.lastFrame, (f) => f.includes("already installed"));

  expect(frame).toContain(join(home, ".zshrc"));
});

test("an undetected shell skips the question and explains why", async () => {
  process.env.SHELL = "/bin/tcsh";
  const ui = mount();

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("could not tell"));

  expect(frame).not.toContain("rc file now?");
  expect(frame).toContain("grove install <shell>");
  expect(ui.done).toEqual([]);

  ui.stdin.write(" ");
  await waitUntilDone(ui.done);
});
