import type { GroveErrorCode } from "../core/errors.ts";

/**
 * What the shell sees.
 *
 * These are part of the interface: a script wrapping this tool should be able to
 * tell "the worktree was dirty" from "the remote was unreachable" without
 * grepping stderr, which is why the failures are spread across distinct codes
 * instead of all landing on 1.
 */
export const ExitCode = {
  ok: 0,
  /** A bug in this tool. Anything that is not a `GroveError` ends up here. */
  internal: 1,
  usage: 2,
  notARepo: 3,
  refused: 4,
  rebaseConflict: 5,
  stateConflict: 6,
  gitFailed: 7,
  remote: 8,
  /**
   * A `grove.setup` command failed.
   *
   * Distinct from `gitFailed` because the worktree is there and correct — what
   * did not happen is the install on top of it, which is a script's cue to
   * retry that rather than to conclude it has no worktree.
   */
  setupFailed: 9,
  /** `gh` was missing or refused; only `pr`, `propose` and `prune --closed` report this. */
  gh: 10,
  /**
   * A command handed to `grove exec` exited non-zero in at least one worktree.
   *
   * Its own code rather than passing the command's through, because with a
   * worktree apiece there is no single code to pass: two of them can fail with
   * two different ones, and picking either would be inventing a result. What
   * each of them said is on stdout, per worktree, which is where a script that
   * cares about the difference has to look anyway.
   */
  commandFailed: 11,
  /** Ctrl-C, by the convention that an interrupt reports 128 + SIGINT. */
  interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Total by construction: adding a `GroveErrorCode` without deciding what a script
 * should make of it fails the typecheck rather than quietly reporting a bug.
 */
export function errorToExitCode(code: GroveErrorCode): ExitCodeValue {
  switch (code) {
    case "usage":
      return ExitCode.usage;
    case "not-a-repo":
      return ExitCode.notARepo;
    case "refused":
      return ExitCode.refused;
    case "rebase-conflict":
      return ExitCode.rebaseConflict;
    case "state-conflict":
      return ExitCode.stateConflict;
    case "setup-failed":
      return ExitCode.setupFailed;
    case "command-failed":
      return ExitCode.commandFailed;
    case "gh":
      return ExitCode.gh;
    case "git-failed":
      return ExitCode.gitFailed;
    case "remote":
      return ExitCode.remote;
  }
}
