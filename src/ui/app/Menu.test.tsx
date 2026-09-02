import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { plain } from "../test-utils.ts";
import { commandsFor, Menu, matching, menuRows } from "./Menu.tsx";

/**
 * The slash menu's own parts: what the query narrows to, how tall the popup
 * is, and what it draws.
 *
 * Which key opens it and what `enter` on a row then runs is `App.test.tsx`'s —
 * this is the half that needs no mode machine behind it.
 */

const COMMANDS = commandsFor(true);

describe("matching", () => {
  test("an empty query is every command, in the order they were declared", () => {
    expect(matching(COMMANDS, "")).toEqual(COMMANDS);
    expect(matching(COMMANDS, "   ")).toEqual(COMMANDS);
  });

  // The part of a name you remember is not reliably its first syllable.
  test("the query matches anywhere in the name, not just at the front", () => {
    expect(matching(COMMANDS, "all").map((command) => command.name)).toEqual(["sync-all"]);
    expect(matching(COMMANDS, "sync").map((command) => command.name)).toEqual(["sync-all"]);
  });

  test("a query that narrows to nothing narrows to nothing", () => {
    expect(matching(COMMANDS, "zzz")).toEqual([]);
  });

  test("`re` keeps every command that holds it, in their declared order", () => {
    expect(matching(COMMANDS, "re").map((command) => command.name)).toEqual([
      "rebase",
      "review",
      "refresh",
    ]);
  });
});

describe("commandsFor", () => {
  /**
   * The same rule the key bar's hints follow: a toggle says what it will do
   * next, not what it did. A menu reading `hide the commits` while there are no
   * commits on screen is describing the last press rather than the next one.
   */
  test("`log` says what it will do next", () => {
    const on = commandsFor(true).find((command) => command.name === "log");
    const off = commandsFor(false).find((command) => command.name === "log");

    expect(on?.summary).toContain("hide");
    expect(off?.summary).toContain("show");
  });

  test("nothing else on the menu depends on the screen", () => {
    const names = (logOn: boolean) => commandsFor(logOn).map((command) => command.name);

    expect(names(true)).toEqual(names(false));
  });
});

describe("menuRows", () => {
  test("the border, the prompt, and one row per command it can show", () => {
    expect(menuRows(4, 6)).toBe(2 + 1 + 4);
    expect(menuRows(4, 2)).toBe(2 + 1 + 2);
  });

  /**
   * A query that matched nothing still draws a body row saying so, and the
   * budget has to have counted it — a popup collapsed to its own border reads
   * as a menu that closed rather than as a query that found nothing.
   */
  test("a popup with nothing in it is still a row tall", () => {
    expect(menuRows(0, 6)).toBe(2 + 1 + 1);
    expect(menuRows(4, 0)).toBe(2 + 1 + 1);
  });
});

describe("Menu", () => {
  function draw(props: Partial<Parameters<typeof Menu>[0]> = {}) {
    const instance = render(
      <Menu
        commands={COMMANDS}
        index={0}
        query=""
        total={COMMANDS.length}
        rows={COMMANDS.length}
        {...props}
      />,
    );

    return plain(instance.lastFrame());
  }

  test("every command is drawn with the slash it is typed after", () => {
    const frame = draw();

    for (const command of COMMANDS) expect(frame).toContain(`/${command.name}`);
    expect(frame).toContain("sync every worktree");
  });

  test("the prompt echoes what has been typed", () => {
    expect(draw({ query: "syn" })).toContain("/syn");
  });

  // Only once the query has narrowed the list: a count beside the whole menu
  // would be saying `5 of 5`, which is the popup counting itself.
  test("the count appears only when the query has left something out", () => {
    // The total is read off the menu rather than written here, so a command
    // added to it fails this test with a count and not with a stale number.
    expect(draw()).not.toContain(` of ${COMMANDS.length}`);
    expect(draw({ commands: matching(COMMANDS, "sync"), query: "sync" })).toContain(
      `1 of ${COMMANDS.length}`,
    );
  });

  test("the marker is on the row the cursor is on, and on no other", () => {
    const rows = draw({ index: 1 })
      .split("\n")
      .filter((line) => line.includes("▸"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`/${COMMANDS[1]?.name}`);
  });

  test("a query that matched nothing says so rather than drawing an empty box", () => {
    expect(draw({ commands: [], query: "zzz" })).toContain("no command matches");
  });

  /**
   * The window centres on the cursor the way the list's does, so the rows move
   * under the selection rather than the selection running off the end of what
   * is drawn.
   */
  test("a popup shorter than the list keeps the cursor inside it", () => {
    const frame = draw({ index: COMMANDS.length - 1, rows: 2 });

    expect(frame).toContain(`/${COMMANDS[COMMANDS.length - 1]?.name}`);
    expect(frame).not.toContain(`/${COMMANDS[0]?.name}`);
  });
});
