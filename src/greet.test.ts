import { expect, test } from "bun:test";
import { greet } from "./greet.ts";

test("greet", () => {
  expect(greet("Bun")).toBe("Hello, Bun!");
});
