import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, isNewer } from "./update-check.ts";

/**
 * The whole contract in one sentence: at most one request a day, a newer
 * version or `undefined`, and no way to make it throw. The clock and the
 * network are injected so a day passes in a keystroke and GitHub is a closure.
 */

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function gitHub(body: unknown, status = 200) {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

function offline() {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

async function withCacheDir(body: (cachePath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "grove-update-"));
  try {
    // Nested under a directory that does not exist yet, on purpose: writing
    // the cache must create `grove/` the way it would have to under ~/.cache.
    await body(join(root, "grove", "update-check.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a newer release comes back stripped of its v, and the cache is born", async () => {
  await withCacheDir(async (cachePath) => {
    const api = gitHub({ tag_name: "v0.2.5" });

    const latest = await checkForUpdate({
      currentVersion: "0.2.1",
      cachePath,
      now: () => T0,
      fetcher: api.fetcher,
    });

    expect(latest).toBe("0.2.5");
    expect(await Bun.file(cachePath).json()).toEqual({ checkedAt: T0, latest: "0.2.5" });
  });
});

test("being up to date says nothing, but the day's check is still recorded", async () => {
  await withCacheDir(async (cachePath) => {
    const api = gitHub({ tag_name: "v0.2.1" });

    const latest = await checkForUpdate({
      currentVersion: "0.2.1",
      cachePath,
      now: () => T0,
      fetcher: api.fetcher,
    });

    expect(latest).toBeUndefined();
    expect(await Bun.file(cachePath).json()).toEqual({ checkedAt: T0, latest: "0.2.1" });
  });
});

test("a fresh cache answers without a request — that is what it is for", async () => {
  await withCacheDir(async (cachePath) => {
    await Bun.write(cachePath, JSON.stringify({ checkedAt: T0, latest: "0.3.0" }));
    const api = gitHub({ tag_name: "v9.9.9" });

    const latest = await checkForUpdate({
      currentVersion: "0.2.1",
      cachePath,
      now: () => T0 + HOUR,
      fetcher: api.fetcher,
    });

    expect(latest).toBe("0.3.0");
    expect(api.calls()).toBe(0);
  });
});

test("a fresh cache that matches the binary is silence, not a request", async () => {
  await withCacheDir(async (cachePath) => {
    await Bun.write(cachePath, JSON.stringify({ checkedAt: T0, latest: "0.2.1" }));
    const api = gitHub({ tag_name: "v9.9.9" });

    const latest = await checkForUpdate({
      currentVersion: "0.2.1",
      cachePath,
      now: () => T0 + HOUR,
      fetcher: api.fetcher,
    });

    expect(latest).toBeUndefined();
    expect(api.calls()).toBe(0);
  });
});

test("a cache past its day is asked again", async () => {
  await withCacheDir(async (cachePath) => {
    await Bun.write(cachePath, JSON.stringify({ checkedAt: T0, latest: "0.2.1" }));
    const api = gitHub({ tag_name: "v0.2.5" });

    const latest = await checkForUpdate({
      currentVersion: "0.2.1",
      cachePath,
      now: () => T0 + 25 * HOUR,
      fetcher: api.fetcher,
    });

    expect(latest).toBe("0.2.5");
    expect(api.calls()).toBe(1);
  });
});

// The stamp on failure is the point: without it, "once a day" decays into a
// three-second timeout on every launch exactly when the network is gone.
test("offline learns nothing but still stamps the day, so tomorrow tries once", async () => {
  await withCacheDir(async (cachePath) => {
    const api = offline();

    const latest = await checkForUpdate({
      currentVersion: "0.2.1",
      cachePath,
      now: () => T0,
      fetcher: api.fetcher,
    });

    expect(latest).toBeUndefined();
    expect(await Bun.file(cachePath).json()).toEqual({ checkedAt: T0, latest: "0.2.1" });
  });
});

test("offline keeps what a better day already learned", async () => {
  await withCacheDir(async (cachePath) => {
    await Bun.write(cachePath, JSON.stringify({ checkedAt: T0, latest: "0.3.0" }));

    const latest = await checkForUpdate({
      currentVersion: "0.2.1",
      cachePath,
      now: () => T0 + 25 * HOUR,
      fetcher: offline().fetcher,
    });

    // The release it heard about yesterday did not stop existing.
    expect(latest).toBe("0.3.0");
    expect(await Bun.file(cachePath).json()).toEqual({
      checkedAt: T0 + 25 * HOUR,
      latest: "0.3.0",
    });
  });
});

test("rate-limited and released-nothing-yet are both just silence", async () => {
  await withCacheDir(async (cachePath) => {
    // The clock advances a day per status so the second round is not simply
    // answered by the cache the first one stamped.
    for (const [round, status] of [403, 404].entries()) {
      const api = gitHub({ message: "API rate limit exceeded" }, status);
      const latest = await checkForUpdate({
        currentVersion: "0.2.1",
        cachePath,
        now: () => T0 + round * 25 * HOUR,
        fetcher: api.fetcher,
      });
      expect(latest).toBeUndefined();
      expect(api.calls()).toBe(1);
    }
  });
});

test("a tag that is not x.y.z is not a version anyone should be told about", async () => {
  await withCacheDir(async (cachePath) => {
    const bodies = [{ tag_name: "nightly" }, { message: "moved" }, "not an object"];
    for (const [round, body] of bodies.entries()) {
      const api = gitHub(body);
      const latest = await checkForUpdate({
        currentVersion: "0.2.1",
        cachePath,
        now: () => T0 + round * 25 * HOUR,
        fetcher: api.fetcher,
      });
      expect(latest).toBeUndefined();
      expect(api.calls()).toBe(1);
    }
  });
});

test("a corrupt cache is the same as no cache", async () => {
  await withCacheDir(async (cachePath) => {
    await Bun.write(cachePath, "not json{");
    const api = gitHub({ tag_name: "v0.2.5" });

    const latest = await checkForUpdate({
      currentVersion: "0.2.1",
      cachePath,
      now: () => T0,
      fetcher: api.fetcher,
    });

    expect(latest).toBe("0.2.5");
    expect(api.calls()).toBe(1);
  });
});

test("version order is numeric, per part", () => {
  expect(isNewer("0.10.0", "0.9.9")).toBe(true);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("0.2.1", "0.2.1")).toBe(false);
  expect(isNewer("0.2.0", "0.2.1")).toBe(false);
});
