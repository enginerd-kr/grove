import { expect, test } from "bun:test";
import { clip } from "./Files.tsx";

/**
 * `clip`, which is where every width on this screen is finally enforced.
 *
 * It is `padTo`'s half of the job without the pad, and both the files panel and
 * every column of the list go through it — so the one thing worth pinning is
 * that it never hands back more characters than it was given room for. A cell
 * one column too wide does not wrap here, it shears the whole table.
 */

test("text that fits comes back untouched, ellipsis and all", () => {
  expect(clip("src/ui", 6)).toBe("src/ui");
  expect(clip("src/ui", 60)).toBe("src/ui");
  expect(clip("", 4)).toBe("");
});

test("text too long loses its tail to the ellipsis, not its width", () => {
  expect(clip("src/ui/app/App.tsx", 10)).toBe("src/ui/ap…");
  // The `…` is one of the ten, not an eleventh stuck on the end: it is the
  // character that would otherwise push a column into its neighbour.
  expect(clip("src/ui/app/App.tsx", 10)).toHaveLength(10);
});

test("a width of one is the ellipsis alone, and nothing narrower draws at all", () => {
  expect(clip("anything", 1)).toBe("…");
  // The panel and the columns both reach zero on a narrow terminal — an empty
  // string is the honest answer there, and a `…` would be a column claiming a
  // width it was not given.
  expect(clip("anything", 0)).toBe("");
  expect(clip("anything", -5)).toBe("");
});

test("nothing it returns is ever wider than the room it was given", () => {
  for (const text of ["", "a", "src/ui", "src/ui/app/App.tsx", "x".repeat(200)]) {
    for (let width = 0; width <= 20; width += 1) {
      expect(`${text.length}@${width}: ${clip(text, width).length <= width}`).toBe(
        `${text.length}@${width}: true`,
      );
    }
  }
});
