import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { GroveError } from "../../core/errors.ts";
import type { RepoPaths } from "../../core/layout.ts";
import { LineStore } from "../../report/lines.ts";
import { keys, plain, waitFor } from "../test-utils.ts";
import { Setup } from "./Setup.tsx";
import type { SetupService } from "./service.ts";

/**
 * The screen a bare `grove` opens where there is no repository.
 *
 * Driven against a stub, so what is being checked is the one path through it —
 * a URL is typed, `enter` hands it to clone, and what comes back is handed on to
 * whoever mounts the app. Whether the clone itself lays out a repository
 * correctly is `commands/clone`'s own test.
 */

const PATHS: RepoPaths = {
  root: "/work/repo",
  gitDir: "/work/repo/.bare",
  gitFile: "/work/repo/.git",
  kind: "managed",
};

function stub(overrides: Partial<SetupService> = {}): {
  service: SetupService;
  cloned: string[];
} {
  const cloned: string[] = [];

  return {
    cloned,
    service: {
      clone: async (url) => {
        cloned.push(url);

        return { paths: PATHS, branch: "main" };
      },
      ...overrides,
    },
  };
}

function mount(service: SetupService, inPlace = true) {
  const ready: RepoPaths[] = [];
  const instance = render(
    <Setup
      service={service}
      folder="/work/repo"
      inPlace={inPlace}
      store={new LineStore()}
      onReady={(paths) => ready.push(paths)}
    />,
  );

  return { ...instance, ready, frame: () => plain(instance.lastFrame()) };
}

test("opens on the prompt rather than refusing to open at all", async () => {
  const ui = mount(stub().service);

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("repository"));

  expect(frame).toContain("no repository here yet");
  expect(frame).toContain("/work/repo");
  expect(frame).toContain("enter clone");
  expect(frame).toContain("esc quit");
});

test("a typed URL goes to clone, and what comes back opens the app", async () => {
  const { service, cloned } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("repository"));

  ui.stdin.write("git@github.com:you/thing.git");
  await waitFor(ui.lastFrame, (f) => f.includes("git@github.com:you/thing.git"));

  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, () => ui.ready.length > 0);

  expect(cloned).toEqual(["git@github.com:you/thing.git"]);
  expect(ui.ready).toEqual([PATHS]);
});

// A refusal here is almost always a typo in a long string, and clearing it would
// mean typing the whole thing again to fix one character.
test("a refused clone is reported and leaves the URL where it was", async () => {
  const { service, cloned } = stub({
    clone: async () => {
      throw new GroveError("remote", "repository not found", { hint: "check the URL" });
    },
  });
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("repository"));

  ui.stdin.write("git@github.com:you/typo.git");
  await waitFor(ui.lastFrame, (f) => f.includes("typo"));
  ui.stdin.write(keys.enter);

  const frame = await waitFor(ui.lastFrame, (f) => f.includes("repository not found"));

  expect(frame).toContain("check the URL");
  expect(frame).toContain("git@github.com:you/typo.git");
  expect(ui.ready).toEqual([]);
  expect(cloned).toEqual([]);
});

test("enter on an empty prompt does nothing", async () => {
  const { service, cloned } = stub();
  const ui = mount(service);
  await waitFor(ui.lastFrame, (f) => f.includes("repository"));

  ui.stdin.write(keys.enter);
  await waitFor(ui.lastFrame, (f) => f.includes("enter clone"));

  expect(cloned).toEqual([]);
  expect(ui.ready).toEqual([]);
});

// The two are different folders and the screen says which one it means, because
// `grove` in `~/work` and `grove` in `~/work/thing` land in different places.
test("says whether the folder becomes the repository or gains one", async () => {
  const here = mount(stub().service, true);
  expect(await waitFor(here.lastFrame, (f) => f.includes("empty"))).toContain(
    "becomes the repository",
  );

  const under = mount(stub().service, false);
  expect(await waitFor(under.lastFrame, (f) => f.includes("folder of its own"))).toContain(
    "folder of its own",
  );
});
