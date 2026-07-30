import type { WtErrorCode } from "../core/errors.ts";

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
  /** A bug in this tool. Anything that is not a `WtError` ends up here. */
  internal: 1,
  usage: 2,
  notARepo: 3,
  refused: 4,
  rebaseConflict: 5,
  stateConflict: 6,
  gitFailed: 7,
  remote: 8,
  /** Ctrl-C, by the convention that an interrupt reports 128 + SIGINT. */
  interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Total by construction: adding a `WtErrorCode` without deciding what a script
 * should make of it fails the typecheck rather than quietly reporting a bug.
 */
export function errorToExitCode(code: WtErrorCode): ExitCodeValue {
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
    case "git-failed":
      return ExitCode.gitFailed;
    case "remote":
      return ExitCode.remote;
  }
}
