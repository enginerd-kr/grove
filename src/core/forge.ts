import { GroveError, stderrDetails } from "./errors.ts";
import { runTool } from "./git.ts";

/**
 * `gh` — the one tool besides git that grove runs, and how its answers are read.
 *
 * Three commands reach for it, and each asks only what git cannot answer:
 * `pr` asks which repository a pull request's head lives in, `prune --closed`
 * asks whether a pull request was closed without merging, and `propose` asks
 * the forge to open one. Everything after the answer is git, run by us. Kept
 * in one file so that "gh is not installed" and "gh answered with something
 * that is not JSON" are one refusal each, wherever they arrive from.
 */

/** `gh pr view` — the first two words of the call, which is how the errors name it. */
export function ghLabel(argv: readonly string[]): string {
  return ["gh", ...argv.slice(0, 2)].join(" ");
}

/**
 * The one place a `gh` failure becomes a `GroveError`.
 *
 * `gh` missing is its own answer rather than a crash: everything else in grove
 * works without it, so the commands that need it get to say "install gh" and
 * point at where. Anything else is gh's own stderr, which is the useful half —
 * "no pull requests found", "not a GitHub repository".
 */
export async function runGh(argv: readonly string[], cwd: string): Promise<string> {
  const result = await runTool(["gh", ...argv] as [string, ...string[]], { cwd });

  if (result === null) {
    throw new GroveError("gh", "this needs `gh`, which is not installed", {
      hint: "https://cli.github.com — only `grove pr`, `grove propose` and `grove prune --closed` use it",
    });
  }

  if (result.code !== 0) {
    throw new GroveError("gh", `${ghLabel(argv)} failed (exit ${result.code})`, {
      details: stderrDetails(result.stderr),
      hint: /GitHub host|default remote|not a git repository/i.test(result.stderr)
        ? "gh could not tell which GitHub repository this is; try `gh repo set-default`"
        : undefined,
    });
  }

  return result.stdout;
}

/**
 * gh's stdout, parsed — the same reasoning as `runGh`, one step further out.
 *
 * What gh prints is as much somebody else's output as the exit code it prints
 * it with: a broken extension, a paginator, an auth notice on stdout. So an
 * answer we cannot read is gh disappointing us rather than a bug in this tool,
 * and it exits 10 with gh's own words instead of 1 with a `SyntaxError`.
 */
export async function ghJson(argv: readonly string[], cwd: string): Promise<unknown> {
  const output = await runGh(argv, cwd);

  try {
    return JSON.parse(output);
  } catch {
    throw new GroveError("gh", `${ghLabel(argv)} answered with something that is not JSON`, {
      details: stderrDetails(output),
    });
  }
}

/** gh's JSON, read defensively: a missing field is a shape we do not recognise. */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
