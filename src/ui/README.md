# src/ui — the screen, and the parts it is built from

[Ink](https://github.com/vadimdemedes/ink) is React with a renderer that paints to a terminal
instead of the DOM. `Box` is flexbox (via Yoga), `Text` is the only leaf that may contain
strings.

Two things live here. `app/` is the interactive screen a bare `wt` opens — the worktrees, with
the five commands bound to keys. `components/` is the parts list, shared with
`src/report/ink-reporter.tsx`, which draws progress for a one-shot command and nothing else.

```
theme.ts          shared colors
components/       Spinner, ProgressBar, StatusBar, StepRow
hooks/            useInterval
app/App.tsx       the screen: rows, keys, and one mode at a time
app/tree.ts       the worktree paths as the tree they are on disk
app/service.ts    what the screen is allowed to do, as four functions
app/run.tsx       discovery, the reporter, and render()
test-utils.ts     ANSI stripping + a frame-flush helper for tests
e2e-utils.ts      drives the real binary in a PTY (Bun.spawn)
```

## Things worth knowing

- **The app is full-screen, and that is three decisions.** `render(..., { alternateScreen: true })`
  puts it on the terminal's second buffer, so quitting restores the shell as it was. The root
  `<Box>` takes `useWindowSize()`'s `columns`/`rows`, which re-renders on resize. And the list is
  *sliced* to the rows left over after the header, activity, and key bar — a layout that only
  works because something computes how many rows fit rather than leaving it to the renderer to
  overflow.
- **The tree is pure and lives in `app/tree.ts`.** Ordering is the part worth testing —
  worktrees before folders at each level, the default branch before its siblings — and none of
  it needs a terminal. The screen draws what it returns and the cursor walks every row it
  produced, folders included — `leavesUnder` is what turns a folder row back into the worktrees
  it stands for.
- **Cursor moves go through `setCursor(previous => …)`.** Keys arrive faster than React commits,
  so two presses in one frame both read the same rendered index and the second goes nowhere —
  which is exactly what holding an arrow key does. The clamp lives in the updater too, so a list
  that shrank under the cursor cannot leave it past the end.
- **The screen holds no git knowledge.** `App` takes a `WorktreeService` — four functions, each
  answering with the line to show afterwards. That is what lets `App.test.tsx` drive every key
  with a stub and no repository, and it is why a keystroke cannot grow a capability the command
  line does not have.
- **One `useInput`, one `mode`.** Every key goes through a single handler that switches on
  `list | add | confirm | busy`, rather than each component claiming its own input. The failure
  that prevents: `a` opening the branch prompt and the next keypress being read as a command.
  While `busy`, keys are dropped — except Ctrl-C, which stops the git child before unmounting.
- **Components are presentational; the state lives above them.** `ProgressBar` takes a `value`
  and renders. That is what makes them cheap to assert on, and it is why none of `src/core`
  imports React.
- **Progress comes from the same `LineStore` the reporter uses** (`src/report/lines.ts`), so a
  `git clone` looks the same whether a keystroke or a command line started it. The app renders
  the lines inside its screen; the reporter puts settled ones through `<Static>` so a finished
  step is not repainted on every spinner tick.
- **Timers go through `useInterval`.** It keeps the callback in a ref so re-renders don't
  restart the timer, and accepts `null` to freeze — which is how `Spinner` stops animating
  without being unmounted.
- **The reporter draws on stderr** (`render(..., { stdout: process.stderr })`) and holds results
  back until Ink unmounts. The app does not: it has no pipeline waiting on stdout, so a result
  is just another line on the screen.
- **Without a terminal, Ink is left to sort itself out.** Its own detection
  (`!isInCi && stdout.isTTY`) drops the erase sequences and the repaint loop while `<Static>`
  rows are still written as they arrive — so a pipe gets the settled lines incrementally and
  none of the escape soup. The app never reaches that path: `cli.tsx` prints the usage instead
  when either end is not a TTY.

## Tests

**`ink-testing-library`** renders components and asserts on the plain-text frame; `plain()` in
`test-utils.ts` strips the escape sequences. `app/App.test.tsx` drives the whole screen this
way — arrows, `a` and a typed branch name, `r` then `y` — against a stubbed service.

**A PTY** (`app/App.e2e.test.ts`, `src/report/ink-reporter.e2e.test.ts`) runs the real binary
via `Bun.spawn({ terminal })` — native since Bun 1.3.5, so no `node-pty`, whose C++ addon Bun
cannot load. It exists because `ink-testing-library` fakes stdout with `columns` pinned to 100
and no `isTTY`, and both "is the Ink reporter selected at all" and "does a bare `wt` open
anything" are answers that depend on `isTTY`. POSIX only — the tests skip themselves on Windows.

Three details in `e2e-utils.ts` are load-bearing and were each found the hard way:

- **`QUIET_MS`.** A repaint arrives in several chunks, so a predicate can match text from the
  top of a frame while the bottom is still in flight. Waiting for the stream to go quiet is
  what makes a frame whole.
- **`pressUntil`.** Raw mode is enabled from an effect after the first paint, so a key written
  into that window is swallowed by the line discipline. Only for idempotent keys — `S` syncs
  everything however often it arrives, whereas an arrow key would count every repeat.
- **`CI: "false"`.** Ink's `is-in-ci` disables repainting when `CI` is set, and every wait would
  then time out on an empty buffer. `"false"` is the supported opt-out.

A PTY returns a stream of repaints, not a screen: Ink erases the previous lines and rewrites
the whole frame, so accumulated output still holds every older frame. `clear()` before an
interaction makes the next repaint readable on its own, which is what keeps `not.toContain`
honest. Assertions finer than that (cell colors, cursor position) would need a terminal
emulator such as [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless).
