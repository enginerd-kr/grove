import { runGit, runGitOrThrow } from "../core/git.ts";

/**
 * Having read the file, and the record that says so.
 *
 * This is the whole of the safety story for `run`, and it is one idea: a hook
 * that arrived over the network runs once somebody on this machine has read the
 * exact text it arrived as. The record is a fingerprint of the file's contents,
 * so a `git pull` that changes a command changes the fingerprint, and the
 * commands stop running until they have been read again.
 *
 * Kept apart from `config.ts` because it is the one thing here that is not the
 * file: a tracked file cannot vouch for itself, so the record of having read it
 * belongs somewhere the repository cannot write to. That is git config in the
 * bare repository — local, per-repository, and never pushed.
 */

/**
 * What `trust` records: the file's contents, not its name or its date.
 *
 * Contents, so that editing the file withdraws the trust it was given. That is
 * the whole mechanism — a `git pull` that changes the commands changes this,
 * and the commands stop running until somebody has read them again.
 */
export function fingerprintOf(text: string): string {
  return Bun.SHA256.hash(text, "hex");
}

const TRUST_KEY = "grove.trusted";

/**
 * Whether these exact contents have been trusted on this machine.
 *
 * The one thing here that stays in git config, and it has to: a tracked file
 * cannot vouch for itself, so the record of having read it belongs somewhere
 * the repository cannot write to. `.bare/config` is local, per-repository, and
 * never pushed.
 */
export async function isTrusted(bare: string, fingerprint: string): Promise<boolean> {
  const result = await runGit(["config", "--get-all", "--null", TRUST_KEY], { cwd: bare });
  if (result.code !== 0) return false;

  return result.stdout.split("\0").some((value) => value.trim() === fingerprint);
}

/**
 * Whether gated lines here are still waiting on somebody having read them.
 *
 * The three-part question every caller used to spell out for itself: is
 * anything gated at all, is there a tracked layer to have read (a file of your
 * own has no fingerprint — nothing pulls it), and have these exact contents
 * been recorded as read. One spelling is what keeps `command.ts`'s promise —
 * one piece of code decides trust for the whole file — literally true.
 */
export async function awaitingTrust(
  bare: string,
  gated: boolean,
  fingerprint: string | undefined,
): Promise<boolean> {
  return gated && fingerprint !== undefined && !(await isTrusted(bare, fingerprint));
}

/** Records these contents as read and agreed to. Replaces any earlier answer. */
export async function trust(bare: string, fingerprint: string): Promise<void> {
  await runGitOrThrow(["config", "--replace-all", TRUST_KEY, fingerprint], { cwd: bare });
}
