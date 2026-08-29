import { resolve } from "node:path";
import { render } from "ink";
import { useMemo, useState } from "react";
import { version } from "../../../package.json";
import { hasSeenShellSetup, markShellSetupSeen } from "../../cli/install.ts";
import { findRepoRoot } from "../../core/discover.ts";
import { isGroveError } from "../../core/errors.ts";
import { isEmptyOrMissing } from "../../core/fs.ts";
import { killRunningGit } from "../../core/git.ts";
import type { RepoPaths } from "../../core/layout.ts";
import { checkForUpdate } from "../../core/update-check.ts";
import { createStoreReporter, LineStore } from "../../report/lines.ts";
import type { Reporter } from "../../report/reporter.ts";
import { App } from "./App.tsx";
import { Setup } from "./Setup.tsx";
import { ShellSetup } from "./ShellSetup.tsx";
import { createSetupService, createWorktreeService } from "./service.ts";

/**
 * Starting the interactive screen, and everything about it that is not React.
 *
 * Discovery still happens *before* the render, but a repository not being there
 * is no longer a reason to refuse: it is the one failure the app can do
 * something about, so it opens on `Setup` and asks for a URL. Every other way
 * discovery can fail — an ambiguous folder with two repositories under it — is a
 * question the screen cannot answer either, and still ends the process the way
 * `grove list` would.
 */

export type AppOptions = {
  readonly cwd: string;
  /** `-C`, honoured here too: `grove -C ~/work/repo` opens that repository. */
  readonly repo?: string;
  /** Installed as the git trace when `--verbose` was passed. */
  readonly onReporter?: (reporter: Reporter) => void;
};

/**
 * Whether this launch should ask GitHub about a newer release.
 *
 * Only the compiled binary has an upgrade to be told about — a source tree is
 * usually *ahead* of the latest release, and would be nagged to "upgrade" to a
 * version older than itself. `GROVE_RELEASE` is baked in by the compile script;
 * `GROVE_UPDATE_CHECK` overrides in both directions, `0` to opt out of the
 * check entirely and `1` to exercise it from source.
 */
function updateCheckEnabled(): boolean {
  if (process.env.GROVE_UPDATE_CHECK === "0") return false;
  if (process.env.GROVE_UPDATE_CHECK === "1") return true;

  return process.env.GROVE_RELEASE === "true";
}

/**
 * Whether a fresh `grove` may open on `ShellSetup` instead of going straight
 * to the app.
 *
 * Gated the same way as the update check, and for the same reason: a source
 * checkout is a developer's, not the audience this onboards, and it is also
 * every test in this repository — without the gate, whichever machine ran the
 * test suite first would decide, from real state under its real `$HOME`,
 * whether every run after it saw the screen.
 */
function shellSetupEnabled(): boolean {
  if (process.env.GROVE_SHELL_SETUP === "0") return false;
  if (process.env.GROVE_SHELL_SETUP === "1") return true;

  return process.env.GROVE_RELEASE === "true";
}

async function discover(cwd: string, repo?: string): Promise<RepoPaths | undefined> {
  try {
    return await findRepoRoot(cwd, repo);
  } catch (error) {
    if (isGroveError(error) && error.code === "not-a-repo") return undefined;

    throw error;
  }
}

type GroveProps = {
  readonly found: RepoPaths | undefined;
  readonly folder: string;
  readonly inPlace: boolean;
  readonly cwd: string;
  readonly store: LineStore;
  readonly reporter: Reporter;
};

/**
 * Which of the two screens is up, and the one transition between them.
 *
 * The services are built here rather than passed in because neither can exist
 * before its screen is due: `createWorktreeService` needs the repository that
 * `Setup` is in the middle of making.
 */
function Grove({ found, folder, inPlace, cwd, store, reporter }: GroveProps) {
  const [paths, setPaths] = useState(found);

  // Memoised, and not as a micro-optimisation: `App` starts a fetch when its
  // service changes, so a new object on every render would be a `git fetch` on
  // every render.
  const setup = useMemo(
    () => createSetupService(folder, inPlace, reporter),
    [folder, inPlace, reporter],
  );
  const worktrees = useMemo(
    () => (paths === undefined ? undefined : createWorktreeService(paths, cwd, reporter)),
    [paths, cwd, reporter],
  );
  // Memoised like the services and for the same reason: `App`'s startup effect
  // depends on it, so a new function every render would be a check every render.
  const checkUpdate = useMemo(
    () => (updateCheckEnabled() ? () => checkForUpdate({ currentVersion: version }) : undefined),
    [],
  );

  if (paths === undefined || worktrees === undefined) {
    return (
      <Setup
        service={setup}
        folder={folder}
        inPlace={inPlace}
        store={store}
        onReady={setPaths}
        onCancel={killRunningGit}
      />
    );
  }

  return (
    <App
      service={worktrees}
      repoRoot={paths.root}
      store={store}
      onCancel={killRunningGit}
      checkUpdate={checkUpdate}
    />
  );
}

/**
 * `ShellSetup`, ahead of everything else, when this launch earned it.
 *
 * A local `seen` rather than folding the flag into `GroveProps`: `Grove`
 * itself has nothing to say about shell setup, and threading a prop through
 * it just to gate what wraps it would make it lie about what it depends on.
 */
function Root({
  showShellSetup,
  ...groveProps
}: GroveProps & { readonly showShellSetup: boolean }) {
  const [seen, setSeen] = useState(!showShellSetup);

  if (!seen) {
    return <ShellSetup folder={groveProps.folder} onDone={() => setSeen(true)} />;
  }

  return <Grove {...groveProps} />;
}

export async function runApp({ cwd, repo, onReporter }: AppOptions): Promise<void> {
  const found = await discover(cwd, repo);
  // Where discovery looked from, which is where a clone should land. With `-C`
  // that is the directory the user named, not the one they happen to be in.
  const folder = resolve(cwd, repo ?? ".");
  const inPlace = found === undefined && (await isEmptyOrMissing(folder));

  const store = new LineStore();

  // Whether the wrapper `shell-init` installs is what started this. It hands
  // every run a temp file through `GROVE_CD_FILE` — nothing here writes to it
  // any more, but its presence is still the only signal that says the function
  // is in this shell's rc file, which is what decides whether `grove cd` works.
  const shellWrapped = (process.env.GROVE_CD_FILE ?? "").length > 0;

  // Stamped before the screen is even rendered, the same way `installShellInit`
  // stamps a decline: a launch that opens the screen has been offered it,
  // whatever happens next.
  const showShellSetup = shellSetupEnabled() && !shellWrapped && !(await hasSeenShellSetup());
  if (showShellSetup) await markShellSetupSeen();

  // Results have nowhere else to go in an app: there is no pipeline waiting on
  // stdout, so a command's output becomes another progress line.
  const reporter = createStoreReporter(store, (text) => {
    for (const line of text.trimEnd().split("\n")) store.addNote("info", line);
  });
  onReporter?.(reporter);

  const instance = render(
    <Root
      showShellSetup={showShellSetup}
      found={found}
      folder={folder}
      inPlace={inPlace}
      cwd={cwd}
      store={store}
      reporter={reporter}
    />,
    {
      // A screen, not a scroll: the app takes the alternate buffer, so quitting
      // hands back the terminal exactly as it was found — the shell history
      // behind it is not buried under a repaint log.
      alternateScreen: true,
      // Ctrl-C is handled inside the app, which also has to stop whatever git
      // child is running before the screen goes away.
      exitOnCtrlC: false,
    },
  );

  await instance.waitUntilExit();
}
