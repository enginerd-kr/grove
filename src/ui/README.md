# src/ui — Ink terminal app

A small playground for [Ink](https://github.com/vadimdemedes/ink): React, but the renderer
paints to a terminal instead of the DOM. `Box` is flexbox (via Yoga), `Text` is the only leaf
that may contain strings, and hooks like `useInput` replace DOM events.

```bash
bun run ui              # launch
bun run ui:dev          # launch with hot reload
bun run ui --tab 2      # open on a given tab
```

The entry point lives at `src/cli.tsx` (see `src/cli/`), which parses flags and renders `App`;
this directory is the component library it renders. Needs a real TTY — `bun run ui | cat` exits
with a message instead of crashing inside `useInput`.

## Keys

| Key            | Action                     |
| -------------- | -------------------------- |
| `1` `2` `3`    | jump to a tab              |
| `tab`/`s-tab`  | cycle tabs                 |
| `q`            | quit (`ctrl+c` also works) |
| `←` `→`        | Counter: adjust            |
| `↑` `↓` `space`| Tasks: move, toggle        |
| `p` `c`        | Logs: pause, clear         |

## Layout

```
App.tsx           shell: tabs, global keys, status bar
theme.ts          shared colors
components/       Tabs, StatusBar, SelectList, ProgressBar, Spinner
views/            CounterView, TaskListView, LogView
hooks/            useInterval
test-utils.ts     ANSI stripping + a frame-flush helper for tests
e2e-utils.ts      drives the real binary in a PTY (Bun.spawn)
```

## Things worth knowing

- **Views stay mounted.** `App` hides inactive tabs with `display="none"` instead of unmounting
  them, so each view keeps its state, and only the visible one passes `isActive` to `useInput`.
  Without that gate, every mounted view would react to the same keypress.
- **Components are presentational; state lives in the view.** `SelectList` and `ProgressBar` take
  a `selectedIndex` / `value` and render — which is what makes them cheap to assert on.
- **`TaskListView` uses `useReducer`.** Two `useState` calls lose a burst of keys: `↓` then `space`
  in the same tick would toggle the row the cursor pointed at *before* the move, because the input
  handler closes over the old index.
- **Timers go through `useInterval`.** It keeps the callback in a ref so re-renders don't restart
  the timer, and accepts `null` to pause — that's how `LogView` stops streaming when hidden.

## Tests

Two layers, both under `bun test src/ui`.

**Components** render with [`ink-testing-library`](https://github.com/vadimdemedes/ink-testing-library)
and assert on the plain-text frame. `stdin.write()` simulates keys — arrow keys are the raw escape
sequences (`ESC[C`), and `nextFrame()` lets React flush before the next assertion.

**End-to-end** (`cli.e2e.test.ts`) runs the real `cli.tsx` process in a pseudo-terminal via
`Bun.spawn({ terminal })` — native since Bun 1.3.5, so no `node-pty` (Bun cannot load its C++
addon). It exists because `ink-testing-library` fakes stdout with `columns` pinned to 100, no
`isTTY`, and a no-op `setRawMode`: the TTY guard in `cli.tsx`, the exit code, and resize reflow
are unreachable from a component test. POSIX only — the tests skip themselves on Windows.

A PTY returns a stream of repaints, not a screen. Ink erases the previous lines and rewrites the
whole frame, so accumulated output still holds every older frame. `clear()` before an interaction
makes the next repaint readable on its own, which is what keeps `not.toContain` honest. Assertions
finer than that (cell colors, cursor position) would need a terminal emulator such as
[`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless).
