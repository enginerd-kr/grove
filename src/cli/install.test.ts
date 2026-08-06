import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGroveError } from "../core/errors.ts";
import {
  detectShell,
  hasSeenShellSetup,
  installShellInit,
  markShellSetupSeen,
  rcFileFor,
  shellSetupMarkerPath,
} from "./install.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "grove-install-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("detects zsh, bash, and fish from $SHELL, and nothing it does not know", () => {
  expect(detectShell({ SHELL: "/bin/zsh" })).toBe("zsh");
  expect(detectShell({ SHELL: "/usr/local/bin/bash" })).toBe("bash");
  expect(detectShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe("fish");
  expect(detectShell({ SHELL: "/bin/tcsh" })).toBeUndefined();
  expect(detectShell({})).toBeUndefined();
});

test("zsh and fish each read one place, honouring their relocation variables", async () => {
  expect(await rcFileFor("zsh", {}, home)).toBe(join(home, ".zshrc"));
  expect(await rcFileFor("zsh", { ZDOTDIR: "/elsewhere" }, home)).toBe(
    join("/elsewhere", ".zshrc"),
  );

  expect(await rcFileFor("fish", {}, home)).toBe(join(home, ".config", "fish", "config.fish"));
  expect(await rcFileFor("fish", { XDG_CONFIG_HOME: "/xdg" }, home)).toBe(
    join("/xdg", "fish", "config.fish"),
  );
});

test("bash picks whichever profile already exists, .bashrc first", async () => {
  expect(await rcFileFor("bash", {}, home)).toBe(join(home, ".bashrc"));

  await Bun.write(join(home, ".bash_profile"), "");
  expect(await rcFileFor("bash", {}, home)).toBe(join(home, ".bash_profile"));

  await Bun.write(join(home, ".bashrc"), "");
  expect(await rcFileFor("bash", {}, home)).toBe(join(home, ".bashrc"));
});

test("installs the eval line into a fresh rc file", async () => {
  const result = await installShellInit("zsh", { home, env: {} });

  expect(result).toMatchObject({
    outcome: "installed",
    shell: "zsh",
    rcFile: join(home, ".zshrc"),
  });
  const contents = await readFile(join(home, ".zshrc"), "utf8");
  expect(contents).toContain('eval "$(');
  expect(contents).toContain("shell-init");
  expect(contents).toContain("'zsh'");
});

test("creates fish's config directory, which a fresh machine will not have", async () => {
  const result = await installShellInit("fish", { home, env: {} });

  expect(result.rcFile).toBe(join(home, ".config", "fish", "config.fish"));
  const contents = await readFile(result.rcFile, "utf8");
  expect(contents).toContain("shell-init");
});

test("running twice leaves the second time alone", async () => {
  const first = await installShellInit("bash", { home, env: {} });
  const before = await readFile(first.rcFile, "utf8");

  const second = await installShellInit("bash", { home, env: {} });
  const after = await readFile(first.rcFile, "utf8");

  expect(second.outcome).toBe("already-installed");
  expect(after).toBe(before);
});

test("a hand-written eval line, in the long-checkout spelling, counts as installed", async () => {
  await mkdir(home, { recursive: true });
  await Bun.write(
    join(home, ".zshrc"),
    'eval "$(bun /Users/me/src/grove/src/cli.tsx shell-init zsh)"\n',
  );

  const result = await installShellInit("zsh", { home, env: {} });
  expect(result.outcome).toBe("already-installed");
});

test("appends after existing content rather than overwriting it", async () => {
  await mkdir(home, { recursive: true });
  await Bun.write(join(home, ".zshrc"), "export PATH=/usr/local/bin:$PATH\n");

  await installShellInit("zsh", { home, env: {} });

  const contents = await readFile(join(home, ".zshrc"), "utf8");
  expect(contents).toStartWith("export PATH=/usr/local/bin:$PATH\n");
  expect(contents).toContain("shell-init");
});

test("without $SHELL and no shell named, it says so rather than guessing", async () => {
  try {
    await installShellInit(undefined, { home, env: {} });
    throw new Error("expected installShellInit to throw");
  } catch (error) {
    expect(isGroveError(error)).toBe(true);
    if (isGroveError(error)) {
      expect(error.code).toBe("usage");
      expect(error.hint).toContain("grove install");
    }
  }
});

test("$SHELL alone is enough when no shell is named explicitly", async () => {
  const result = await installShellInit(undefined, { home, env: { SHELL: "/bin/zsh" } });
  expect(result.shell).toBe("zsh");
});

test("the shell-setup marker lives under $XDG_CACHE_HOME, or ~/.cache", () => {
  expect(shellSetupMarkerPath({}, home)).toBe(join(home, ".cache", "grove", "shell-setup-shown"));
  expect(shellSetupMarkerPath({ XDG_CACHE_HOME: "/xdg-cache" }, home)).toBe(
    join("/xdg-cache", "grove", "shell-setup-shown"),
  );
});

test("the shell-setup screen is offered once, and remembers that it was", async () => {
  const marker = join(home, "state", "shell-setup-shown");

  expect(await hasSeenShellSetup(marker)).toBe(false);

  await markShellSetupSeen(marker);
  expect(await hasSeenShellSetup(marker)).toBe(true);

  // Marking it again — a second launch offered the same screen before the
  // first one closed — must not throw over the file already being there.
  await markShellSetupSeen(marker);
  expect(await hasSeenShellSetup(marker)).toBe(true);
});
