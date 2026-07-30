import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { plain } from "../test-utils.ts";
import { SelectList } from "./SelectList.tsx";

const ITEMS = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta", prefix: "[x]" },
  { id: "c", label: "Gamma", hint: "ctrl+g" },
];

afterEach(cleanup);

test("marks only the selected row", () => {
  const { lastFrame } = render(<SelectList items={ITEMS} selectedIndex={1} />);
  const lines = plain(lastFrame()).split("\n");

  expect(lines[0]).toBe("  Alpha");
  expect(lines[1]).toBe("❯ [x] Beta");
  expect(lines[2]).toBe("  Gamma  ctrl+g");
});

test("falls back to a message when empty", () => {
  const { lastFrame } = render(<SelectList items={[]} selectedIndex={0} emptyMessage="No items" />);

  expect(plain(lastFrame())).toBe("No items");
});
