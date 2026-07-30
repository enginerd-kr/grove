import { render } from "ink";
import { findRepoRoot } from "../../core/discover.ts";
import { killRunningGit } from "../../core/git.ts";
import { createStoreReporter, LineStore } from "../../report/lines.ts";
import type { Reporter } from "../../report/reporter.ts";
import { App } from "./App.tsx";
import { createWorktreeService } from "./service.ts";

/**
 * Starting the interactive screen, and everything about it that is not React.
 *
 * Discovery happens *before* the render so a `wt` typed outside a managed
 * repository fails the way `wt list` does — the same message, the same exit
 * code 3 — rather than opening an app with nothing in it.
 */

export type AppOptions = {
  readonly cwd: string;
  /** `-C`, honoured here too: `wt -C ~/work/repo` opens that repository. */
  readonly repo?: string;
  /** Installed as the git trace when `--verbose` was passed. */
  readonly onReporter?: (reporter: Reporter) => void;
};

export async function runApp({ cwd, repo, onReporter }: AppOptions): Promise<void> {
  const paths = await findRepoRoot(cwd, repo);
  const store = new LineStore();

  // Results have nowhere else to go in an app: there is no pipeline waiting on
  // stdout, so a command's output becomes another progress line.
  const reporter = createStoreReporter(store, (text) => {
    for (const line of text.trimEnd().split("\n")) store.addNote("info", line);
  });
  onReporter?.(reporter);

  const instance = render(
    <App
      service={createWorktreeService(paths, cwd, reporter)}
      repoRoot={paths.root}
      store={store}
      onCancel={killRunningGit}
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
