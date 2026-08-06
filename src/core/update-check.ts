import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether a newer grove has been released, asked politely: one request a day,
 * three seconds of patience, and silence about every possible failure.
 *
 * Releases are the source of truth — the Homebrew formula is bumped from the
 * tag by CI — so the GitHub API answers for brew without invoking brew, which
 * is slow and only knows what its last `brew update` fetched. The answer lands
 * in a cache file so every launch of the day can tip without a request, and so
 * a dead network costs one timeout per day rather than one per launch.
 *
 * A cached "no update" ages out in an hour rather than a day: a release
 * published minutes after that answer was cached would otherwise stay
 * unreported for up to 24 hours. A cached "update found" keeps the full day —
 * that answer only gets more true with time, so there's nothing to re-earn.
 */

const RELEASES_URL = "https://api.github.com/repos/enginerd-kr/grove/releases/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

type Cache = { readonly checkedAt: number; readonly latest: string };

export type UpdateCheckOptions = {
  /** The version of the running binary, `package.json` style — no `v`. */
  readonly currentVersion: string;
  /** Where the once-a-day bookkeeping lives. Tests point this at scratch. */
  readonly cachePath?: string;
  /** The clock, injectable so tests can age the cache without waiting a day. */
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
};

/** `$XDG_CACHE_HOME/grove/update-check.json`, or `~/.cache` where XDG is silent. */
export function defaultCachePath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".cache");
  return join(base, "grove", "update-check.json");
}

/** Numeric x.y.z comparison — `0.10.0` beats `0.9.9`, which string order gets wrong. */
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

// A cache that fails to parse, or parses into the wrong shape, is the same as
// no cache: the next step re-earns it. Nothing here is worth an error.
async function readCache(path: string): Promise<Cache | undefined> {
  try {
    const raw: unknown = await Bun.file(path).json();
    if (typeof raw !== "object" || raw === null) return undefined;
    const { checkedAt, latest } = raw as { checkedAt?: unknown; latest?: unknown };
    if (typeof checkedAt !== "number" || typeof latest !== "string") return undefined;
    if (!VERSION_SHAPE.test(latest)) return undefined;
    return { checkedAt, latest };
  } catch {
    return undefined;
  }
}

// Anything short of a well-formed release — offline, rate-limited, no releases
// yet, a tag that is not x.y.z — is one answer: nothing learned.
async function fetchLatest(fetcher: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetcher(RELEASES_URL, {
      headers: { "User-Agent": "grove", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const tag = (body as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string") return undefined;
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    return VERSION_SHAPE.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The newer released version, or `undefined` for "nothing to say" — which
 * covers up to date, unreachable, rate-limited, and every other mishap alike.
 * A check nobody asked for reports no failure, so this never throws.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | undefined> {
  const {
    currentVersion,
    cachePath = defaultCachePath(),
    now = Date.now,
    fetcher = fetch,
  } = options;

  try {
    const cache = await readCache(cachePath);
    if (cache !== undefined) {
      const knownUpdate = isNewer(cache.latest, currentVersion);
      const ttl = knownUpdate ? DAY_MS : HOUR_MS;
      if (now() - cache.checkedAt < ttl) {
        return knownUpdate ? cache.latest : undefined;
      }
    }

    const fetched = await fetchLatest(fetcher);
    // Stamped even when the fetch learned nothing, or "once a day" would decay
    // into "a three-second timeout on every launch" exactly when offline.
    // Two instances racing this write both hold valid answers; last one wins.
    const latest = fetched ?? cache?.latest ?? currentVersion;
    await Bun.write(cachePath, JSON.stringify({ checkedAt: now(), latest }));

    return isNewer(latest, currentVersion) ? latest : undefined;
  } catch {
    return undefined;
  }
}
