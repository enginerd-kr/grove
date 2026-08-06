import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GroveError } from "../core/errors.ts";
import { evalLine, isShell, SHELLS, type Shell } from "./shell-init.ts";

/**
 * `grove install` — the one line from `shell-init` written for you, instead of
 * copied by hand into whichever rc file this shell happens to read.
 *
 * Idempotent by searching for the marker rather than the exact line: someone
 * who already pasted the long-checkout spelling by hand gets left alone
 * rather than getting a second, redundant eval.
 */

// Not "grove shell-init" as a phrase: the invocation is the runtime and entry
// script, not the literal word "grove", so only "shell-init" is guaranteed to
// appear verbatim regardless of how grove was reached when the line was written.
const MARKER = "shell-init";

export type InstallResult =
  | { readonly outcome: "already-installed"; readonly shell: Shell; readonly rcFile: string }
  | {
      readonly outcome: "installed";
      readonly shell: Shell;
      readonly rcFile: string;
      readonly line: string;
    };

/** The basename of `$SHELL`, when it names a shell this knows how to install into. */
export function detectShell(env: NodeJS.ProcessEnv = process.env): Shell | undefined {
  const value = env.SHELL;
  if (value === undefined || value === "") return undefined;

  const name = value.split("/").pop();
  return name !== undefined && isShell(name) ? name : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The rc file `shell` reads, best guess.
 *
 * zsh and fish each read exactly one place, honouring the environment
 * variable that relocates it. bash has no such single answer — whether a
 * session reads `.bashrc`, `.bash_profile`, or `.profile` depends on how it
 * was started, which is not knowable from here — so the file already present
 * wins, and `.bashrc` is where a fresh install lands one.
 */
export async function rcFileFor(
  shell: Shell,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<string> {
  if (shell === "zsh") {
    const zdotdir = env.ZDOTDIR;
    return join(zdotdir !== undefined && zdotdir !== "" ? zdotdir : home, ".zshrc");
  }

  if (shell === "fish") {
    const xdgConfig = env.XDG_CONFIG_HOME;
    const configHome =
      xdgConfig !== undefined && xdgConfig !== "" ? xdgConfig : join(home, ".config");
    return join(configHome, "fish", "config.fish");
  }

  const candidates = [join(home, ".bashrc"), join(home, ".bash_profile"), join(home, ".profile")];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  return join(home, ".bashrc");
}

export type InstallOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
};

/**
 * Appends `shell-init`'s eval line to the rc file `shell` reads, unless it is
 * there already.
 *
 * `shell` is `undefined` for "work it out from `$SHELL`" — kept optional here,
 * rather than defaulted in the caller, so the "could not tell" error carries
 * the one hint that actually resolves it: name the shell explicitly.
 */
export async function installShellInit(
  shell: Shell | undefined,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const { env = process.env, home = homedir() } = options;

  const resolved = shell ?? detectShell(env);
  if (resolved === undefined) {
    throw new GroveError("usage", "could not tell which shell this is from $SHELL", {
      hint: `run \`grove install <shell>\`, naming one of: ${SHELLS.join(", ")}`,
    });
  }

  const rcFile = await rcFileFor(resolved, env, home);
  const existing = await readFile(rcFile, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });

  if (existing.includes(MARKER)) {
    return { outcome: "already-installed", shell: resolved, rcFile };
  }

  const line = evalLine(resolved);
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const block = `${separator}\n# grove: 'grove cd' and enter-to-go in the app\n${line}\n`;

  await mkdir(dirname(rcFile), { recursive: true });
  await appendFile(rcFile, block);

  return { outcome: "installed", shell: resolved, rcFile, line };
}

/**
 * Whether the app has already offered to run `installShellInit` once.
 *
 * A marker file rather than a flag in the rc file itself: the offer is
 * declined as often as accepted, and a decline has to stick without leaving
 * anything behind to explain why the rc file was not touched.
 */
export function shellSetupMarkerPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdgCache = env.XDG_CACHE_HOME;
  const base = xdgCache !== undefined && xdgCache !== "" ? xdgCache : join(home, ".cache");

  return join(base, "grove", "shell-setup-shown");
}

export async function hasSeenShellSetup(path: string = shellSetupMarkerPath()): Promise<boolean> {
  return exists(path);
}

/** Stamped before the screen is even drawn, so a crash mid-screen still counts as offered. */
export async function markShellSetupSeen(path: string = shellSetupMarkerPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, "");
}
