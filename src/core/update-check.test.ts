import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, defaultCachePath, isNewer } from "./update-check.ts";

/**
 * Every test here injects `fetcher`, `now` and `cachePath`, which is the point
 * of those options existing: nothing below reaches the network, waits a day, or
 * writes to the home directory of whoever is running it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CURRENT = "0.3.7";

/** A clock a test can wind forward, standing in for `Date.now`. */
function clock(start = 1_700_000_000_000) {
  let at = start;

  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** `typeof fetch` is more than a function in Bun; nothing here calls the rest. */
function asFetch(body: () => Promise<Response>): typeof fetch {
  return Object.assign(body, { preconnect: () => {} });
}

/** A fetcher that counts its calls, so "cached" can be asserted and not assumed. */
function serving(make: () => Response | Promise<Response>) {
  let calls = 0;

  const fetcher = asFetch(async () => {
    calls += 1;

    return make();
  });

  return { fetcher, calls: () => calls };
}

function release(tag: unknown): Response {
  return new Response(JSON.stringify({ tag_name: tag }), { status: 200 });
}

async function withScratch(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "grove-update-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One cache file per test, so nothing here can be run in the wrong order. */
async function withCache(body: (cachePath: string, dir: string) => Promise<void>): Promise<void> {
  await withScratch(async (dir) => {
    await body(join(dir, "update-check.json"), dir);
  });
}

async function cacheContents(path: string): Promise<{ checkedAt: number; latest: string }> {
  return Bun.file(path).json();
}

describe("isNewer", () => {
  test("compares numbers, not strings", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("0.9.9", "0.10.0")).toBe(false);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });

  test("the same version is not newer", () => {
    expect(isNewer(CURRENT, CURRENT)).toBe(false);
  });

  test("a missing segment counts as zero", () => {
    expect(isNewer("1", "1.0.0")).toBe(false);
    expect(isNewer("1.0.1", "1")).toBe(true);
  });
});

describe("checkForUpdate", () => {
  test("reports a newer release, with or without the tag's v", async () => {
    await withCache(async (cachePath) => {
      const github = serving(() => release("v0.4.0"));

      expect(
        await checkForUpdate({
          currentVersion: CURRENT,
          cachePath,
          now: clock().now,
          fetcher: github.fetcher,
        }),
      ).toBe("0.4.0");
      expect(github.calls()).toBe(1);
    });

    await withCache(async (cachePath) => {
      const github = serving(() => release("0.4.0"));

      expect(
        await checkForUpdate({
          currentVersion: CURRENT,
          cachePath,
          now: clock().now,
          fetcher: github.fetcher,
        }),
      ).toBe("0.4.0");
    });
  });

  test("says nothing about the same or an older release", async () => {
    for (const tag of ["v0.3.7", "v0.3.6", "v0.2.99"]) {
      await withCache(async (cachePath) => {
        const github = serving(() => release(tag));

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: clock().now,
            fetcher: github.fetcher,
          }),
        ).toBeUndefined();
      });
    }
  });

  test("ignores a tag that is not x.y.z", async () => {
    for (const tag of ["v0.4", "nightly", "v0.4.0.1", "v0.4.0-beta.1", "v0.4.x", "", 4, null]) {
      await withCache(async (cachePath) => {
        const github = serving(() => release(tag));

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: clock().now,
            fetcher: github.fetcher,
          }),
        ).toBeUndefined();
      });
    }
  });

  test("records the answer it earned", async () => {
    await withCache(async (cachePath) => {
      const time = clock();
      const github = serving(() => release("v0.4.0"));

      await checkForUpdate({
        currentVersion: CURRENT,
        cachePath,
        now: time.now,
        fetcher: github.fetcher,
      });

      expect(await cacheContents(cachePath)).toEqual({
        checkedAt: time.now(),
        latest: "0.4.0",
      });
    });
  });

  describe("caching", () => {
    test("a known update is reused for the whole day", async () => {
      await withCache(async (cachePath) => {
        const time = clock();
        const github = serving(() => release("v0.4.0"));
        const check = () =>
          checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: time.now,
            fetcher: github.fetcher,
          });

        expect(await check()).toBe("0.4.0");
        expect(github.calls()).toBe(1);

        time.advance(HOUR_MS * 23);
        expect(await check()).toBe("0.4.0");
        time.advance(DAY_MS - HOUR_MS * 23 - 1);
        expect(await check()).toBe("0.4.0");
        expect(github.calls()).toBe(1);

        // A day exactly is where "once a day" stops being cached.
        time.advance(1);
        expect(await check()).toBe("0.4.0");
        expect(github.calls()).toBe(2);
      });
    });

    test("a cached 'nothing to report' ages out after an hour", async () => {
      await withCache(async (cachePath) => {
        const time = clock();
        const github = serving(() => release(`v${CURRENT}`));
        const check = () =>
          checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: time.now,
            fetcher: github.fetcher,
          });

        expect(await check()).toBeUndefined();
        expect(github.calls()).toBe(1);

        time.advance(HOUR_MS - 1);
        expect(await check()).toBeUndefined();
        expect(github.calls()).toBe(1);

        // An hour rather than a day, so a release published minutes after this
        // answer was cached is not sat on until tomorrow.
        time.advance(1);
        expect(await check()).toBeUndefined();
        expect(github.calls()).toBe(2);
      });
    });

    test("a release that lands during the hour is reported once the hour is up", async () => {
      await withCache(async (cachePath) => {
        const time = clock();
        let tag = `v${CURRENT}`;
        const github = serving(() => release(tag));
        const check = () =>
          checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: time.now,
            fetcher: github.fetcher,
          });

        expect(await check()).toBeUndefined();
        tag = "v0.4.0";

        expect(await check()).toBeUndefined();

        time.advance(HOUR_MS);
        expect(await check()).toBe("0.4.0");
      });
    });

    test("a failed fetch is still stamped, so being offline costs one timeout a day", async () => {
      await withCache(async (cachePath) => {
        const time = clock();
        const github = serving(() => Promise.reject(new Error("offline")));

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: time.now,
            fetcher: github.fetcher,
          }),
        ).toBeUndefined();

        expect(await cacheContents(cachePath)).toEqual({ checkedAt: time.now(), latest: CURRENT });

        time.advance(HOUR_MS - 1);
        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: time.now,
            fetcher: github.fetcher,
          }),
        ).toBeUndefined();
        expect(github.calls()).toBe(1);
      });
    });

    test("keeps the last known release when a later fetch learns nothing", async () => {
      await withCache(async (cachePath) => {
        const time = clock();
        await Bun.write(
          cachePath,
          JSON.stringify({ checkedAt: time.now() - DAY_MS, latest: "0.4.0" }),
        );

        const github = serving(() => Promise.reject(new Error("offline")));

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: time.now,
            fetcher: github.fetcher,
          }),
        ).toBe("0.4.0");
        expect(github.calls()).toBe(1);
      });
    });

    test("a cache it cannot use is the same as no cache", async () => {
      const unusable = [
        "not json at all",
        "",
        "null",
        "[]",
        '"0.4.0"',
        JSON.stringify({ latest: "0.4.0" }),
        JSON.stringify({ checkedAt: "yesterday", latest: "0.4.0" }),
        JSON.stringify({ checkedAt: 1, latest: 4 }),
        // The shape check is the same one a tag gets, so a cache holding
        // rubbish cannot make the tip say rubbish.
        JSON.stringify({ checkedAt: 1, latest: "nightly" }),
      ];

      for (const contents of unusable) {
        await withCache(async (cachePath) => {
          const time = clock();
          await Bun.write(cachePath, contents);

          const github = serving(() => release("v0.4.0"));

          expect(
            await checkForUpdate({
              currentVersion: CURRENT,
              cachePath,
              now: time.now,
              fetcher: github.fetcher,
            }),
          ).toBe("0.4.0");
          expect(github.calls()).toBe(1);
        });
      }
    });
  });

  describe("silence", () => {
    test("a fetcher that rejects", async () => {
      await withCache(async (cachePath) => {
        const github = serving(() => Promise.reject(new Error("ECONNREFUSED")));

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: clock().now,
            fetcher: github.fetcher,
          }),
        ).toBeUndefined();
      });
    });

    test("a fetcher that throws before it returns a promise", async () => {
      await withCache(async (cachePath) => {
        const fetcher = asFetch(() => {
          throw new Error("no network stack");
        });

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: clock().now,
            fetcher,
          }),
        ).toBeUndefined();
      });
    });

    test("a response that is not 200", async () => {
      for (const status of [403, 404, 500]) {
        await withCache(async (cachePath) => {
          const github = serving(
            () => new Response(JSON.stringify({ tag_name: "v0.4.0" }), { status }),
          );

          expect(
            await checkForUpdate({
              currentVersion: CURRENT,
              cachePath,
              now: clock().now,
              fetcher: github.fetcher,
            }),
          ).toBeUndefined();
          expect(github.calls()).toBe(1);
        });
      }
    });

    test("a body that is not JSON", async () => {
      await withCache(async (cachePath) => {
        const github = serving(() => new Response("<html>rate limited</html>", { status: 200 }));

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: clock().now,
            fetcher: github.fetcher,
          }),
        ).toBeUndefined();
      });
    });

    test("a body with no release in it", async () => {
      for (const body of ["{}", "[]", "null", JSON.stringify({ tag_name: {} })]) {
        await withCache(async (cachePath) => {
          const github = serving(() => new Response(body, { status: 200 }));

          expect(
            await checkForUpdate({
              currentVersion: CURRENT,
              cachePath,
              now: clock().now,
              fetcher: github.fetcher,
            }),
          ).toBeUndefined();
        });
      }
    });

    test("a cache path it cannot write to", async () => {
      await withScratch(async (dir) => {
        // A directory where the file should be: the write throws, and a check
        // nobody asked for still says nothing.
        const cachePath = join(dir, "update-check.json");
        await mkdir(cachePath, { recursive: true });

        const github = serving(() => release("v0.4.0"));

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: clock().now,
            fetcher: github.fetcher,
          }),
        ).toBeUndefined();
      });
    });

    test("a cache path in a directory that does not exist yet", async () => {
      await withScratch(async (dir) => {
        const cachePath = join(dir, "nested", "deeper", "update-check.json");
        const github = serving(() => release("v0.4.0"));

        expect(
          await checkForUpdate({
            currentVersion: CURRENT,
            cachePath,
            now: clock().now,
            fetcher: github.fetcher,
          }),
        ).toBe("0.4.0");
      });
    });

    test("a current version it cannot compare", async () => {
      await withCache(async (cachePath) => {
        const github = serving(() => release("v0.4.0"));

        // `NaN` loses every comparison in `isNewer`, so an unparseable running
        // version tips about nothing — which is the right way round for a
        // notice nobody asked for.
        expect(
          await checkForUpdate({
            currentVersion: "not-a-version",
            cachePath,
            now: clock().now,
            fetcher: github.fetcher,
          }),
        ).toBeUndefined();
      });
    });
  });
});

describe("defaultCachePath", () => {
  /** Restores whatever the variable was, including its absence. */
  async function withXdg(value: string | undefined, body: () => void): Promise<void> {
    const before = process.env.XDG_CACHE_HOME;
    if (value === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = value;

    try {
      body();
    } finally {
      if (before === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = before;
    }
  }

  test("honours XDG_CACHE_HOME", async () => {
    await withXdg("/tmp/xdg-cache", () => {
      expect(defaultCachePath()).toBe(join("/tmp/xdg-cache", "grove", "update-check.json"));
    });
  });

  test("falls back to ~/.cache when it is unset or empty", async () => {
    const fallback = join(homedir(), ".cache", "grove", "update-check.json");

    await withXdg(undefined, () => {
      expect(defaultCachePath()).toBe(fallback);
    });
    await withXdg("", () => {
      expect(defaultCachePath()).toBe(fallback);
    });
  });

  test("restores the environment it borrowed", async () => {
    const before = process.env.XDG_CACHE_HOME;
    await withXdg("/tmp/xdg-cache", () => {
      expect(process.env.XDG_CACHE_HOME).toBe("/tmp/xdg-cache");
    });

    expect(process.env.XDG_CACHE_HOME).toBe(before);
  });
});
