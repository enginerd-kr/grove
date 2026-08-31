import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { keys, nextFrame, plain } from "../test-utils.ts";
import { Pick } from "./Pick.tsx";

/**
 * The screen that answers "which of these did you mean?".
 *
 * What it has to get right is short: every candidate is on it, the cursor
 * moves, and `enter` hands back the root that was under it — because the whole
 * reason this screen exists is that guessing which one is wrong.
 */

const ROOTS = ["/work/one", "/work/two", "/work/three"] as const;

function open(onPick: (root: string) => void = () => {}) {
  return render(<Pick roots={ROOTS} folder="/work" onPick={onPick} />);
}

describe("Pick", () => {
  test("draws every repository in the folder, by name", () => {
    const instance = open();

    try {
      const frame = plain(instance.lastFrame());
      expect(frame).toContain("one");
      expect(frame).toContain("two");
      expect(frame).toContain("three");
      // The count is the reason the screen is up, so it is on it.
      expect(frame).toContain("3 repositories");
    } finally {
      instance.unmount();
    }
  });

  test("enter picks the row under the cursor, which starts on the first", async () => {
    const picked: string[] = [];
    const instance = open((root) => picked.push(root));

    try {
      instance.stdin.write(keys.enter);
      await nextFrame();

      expect(picked).toEqual(["/work/one"]);
    } finally {
      instance.unmount();
    }
  });

  test("the cursor moves, and enter follows it", async () => {
    const picked: string[] = [];
    const instance = open((root) => picked.push(root));

    try {
      instance.stdin.write(keys.down);
      await nextFrame();
      instance.stdin.write(keys.enter);
      await nextFrame();

      expect(picked).toEqual(["/work/two"]);
    } finally {
      instance.unmount();
    }
  });

  // The list is short and whole on screen, so the way back to the first row
  // from the last is one press down rather than the length of the list up.
  test("the cursor wraps at both ends", async () => {
    const picked: string[] = [];
    const instance = open((root) => picked.push(root));

    try {
      instance.stdin.write(keys.up);
      await nextFrame();
      instance.stdin.write(keys.enter);
      await nextFrame();

      expect(picked).toEqual(["/work/three"]);
    } finally {
      instance.unmount();
    }
  });
});
