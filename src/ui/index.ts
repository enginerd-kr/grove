/**
 * The presentational pieces the CLI's progress reporter draws with.
 *
 * What used to be a tabbed demo app is gone; these components survived because
 * a long `git clone` still needs a spinner and a percentage. Nothing here holds
 * application state — the reporter owns that.
 */
export { App } from "./app/App.tsx";
export { runApp } from "./app/run.tsx";
export type { WorktreeService } from "./app/service.ts";
export { ProgressBar } from "./components/ProgressBar.tsx";
export { Spinner } from "./components/Spinner.tsx";
export type { Hint } from "./components/StatusBar.tsx";
export { StatusBar } from "./components/StatusBar.tsx";
export { StepRow } from "./components/StepRow.tsx";
export { useInterval } from "./hooks/useInterval.ts";
export { theme } from "./theme.ts";
