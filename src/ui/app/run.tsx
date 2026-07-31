import { resolve } from "node:path";
import { render } from "ink";
import { useState } from "react";
import { findRepoRoot } from "../../core/discover.ts";
import { isGardenError } from "../../core/errors.ts";
import { isEmptyOrMissing } from "../../core/fs.ts";
import { killRunningGit } from "../../core/git.ts";
import type { RepoPaths } from "../../core/layout.ts";
import { createStoreReporter, LineStore } from "../../report/lines.ts";
import type { Reporter } from "../../report/reporter.ts";
import { App } from "./App.tsx";
import { Setup } from "./Setup.tsx";
import { createSetupService, createWorktreeService } from "./service.ts";

/**
 * Starting the interactive screen, and everything about it that is not React.
 *
 * Discovery still happens *before* the render, but a repository not being there
 * is no longer a reason to refuse: it is the one failure the app can do
 * something about, so it opens on `Setup` and asks for a URL. Every other way
 * discovery can fail — an ambiguous folder with two repositories under it — is a
 * question the screen cannot answer either, and still ends the process the way
 * `garden list` would.
 */

export type AppOptions = {
  readonly cwd: string;
  /** `-C`, honoured here too: `garden -C ~/work/repo` opens that repository. */
  readonly repo?: string;
  /** Installed as the git trace when `--verbose` was passed. */
  readonly onReporter?: (reporter: Reporter) => void;
};

async function discover(cwd: string, repo?: string): Promise<RepoPaths | undefined> {
  try {
    return await findRepoRoot(cwd, repo);
  } catch (error) {
    if (isGardenError(error) && error.code === "not-a-repo") return undefined;

    throw error;
  }
}

type GardenProps = {
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
function Garden({ found, folder, inPlace, cwd, store, reporter }: GardenProps) {
  const [paths, setPaths] = useState(found);

  if (paths === undefined) {
    return (
      <Setup
        service={createSetupService(folder, inPlace, reporter)}
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
      service={createWorktreeService(paths, cwd, reporter)}
      repoRoot={paths.root}
      store={store}
      onCancel={killRunningGit}
    />
  );
}

export async function runApp({ cwd, repo, onReporter }: AppOptions): Promise<void> {
  const found = await discover(cwd, repo);
  // Where discovery looked from, which is where a clone should land. With `-C`
  // that is the directory the user named, not the one they happen to be in.
  const folder = resolve(cwd, repo ?? ".");
  const inPlace = found === undefined && (await isEmptyOrMissing(folder));

  const store = new LineStore();

  // Results have nowhere else to go in an app: there is no pipeline waiting on
  // stdout, so a command's output becomes another progress line.
  const reporter = createStoreReporter(store, (text) => {
    for (const line of text.trimEnd().split("\n")) store.addNote("info", line);
  });
  onReporter?.(reporter);

  const instance = render(
    <Garden
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
