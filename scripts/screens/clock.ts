import { setSystemTime } from "bun:test";

/**
 * A clock that does not move, so a re-shot README differs where the UI changed
 * and nowhere else.
 *
 * The pictures are committed, and CI re-shoots them to check they still match
 * the program. That check is only worth having if the script writes the same
 * bytes twice, and a running clock breaks it three ways at once. The fixture
 * dates its commits relative to now, so every sha in the log panel is different
 * on every run. The commit panel prints an absolute date for anything older
 * than a week, so those rows move with the calendar. And the `last` column and
 * the panel's ages are measured against `Date.now()` at render time, so pinning
 * the commit dates alone would only trade one drift for another.
 *
 * Frozen rather than injected because the app reads the clock in three places
 * of its own — `App.tsx`, `Log.tsx`, `PullRequests.tsx` — and a moment threaded
 * through all of them would be a seam that exists for the screenshots and for
 * nothing else. This is the whole of the trick, in the one script that needs it.
 *
 * Only `Date` is frozen; timers still run on the real clock, which is what lets
 * a shot wait for anything at all.
 */

// Set before the first date is formatted. The `import` above is hoisted over
// it, which is fine — nothing reads the zone at import — but nothing else may
// be added here that would.
process.env.TZ = "UTC";

/**
 * The moment every picture is taken at.
 *
 * A literal, because it is the one thing here that must not be derived from the
 * machine. It reads UTC because the commit panel prints a *local* date for
 * anything older than a week, and the same commit would otherwise be
 * `2026-08-07 17:00` in a picture shot in London and `2026-08-08 02:00` in one
 * shot in Seoul.
 *
 * Deliberately in the past, and it must stay there. The dirty worktree's `last`
 * is the mtime of a file the fixture wrote seconds ago, which is real and
 * cannot be pinned — the column reads `now` for it only because that mtime is
 * still ahead of this. A moment set in the future would put a real, moving age
 * in the picture instead.
 */
export const NOW = Date.parse("2026-08-24T09:00:00.000Z");

setSystemTime(new Date(NOW));
