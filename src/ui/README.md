# src/ui — the components the progress reporter draws with

[Ink](https://github.com/vadimdemedes/ink) is React with a renderer that paints to a terminal
instead of the DOM. `Box` is flexbox (via Yoga), `Text` is the only leaf that may contain
strings.

There is no app here — `wt` is a non-interactive CLI. Ink earns its place for one job: showing
a spinner and a clone percentage while git works, on a terminal, and getting out of the way
everywhere else. `src/report/ink-reporter.tsx` owns that; this directory is the parts list.

```
theme.ts          shared colors
components/       Spinner, ProgressBar, StatusBar
hooks/            useInterval
test-utils.ts     ANSI stripping + a frame-flush helper for tests
e2e-utils.ts      drives the real binary in a PTY (Bun.spawn)
```

## Things worth knowing

- **Components are presentational; the reporter owns the state.** `ProgressBar` takes a `value`
  and renders. That is what makes it cheap to assert on, and it is why none of `src/core`
  imports React.
- **Timers go through `useInterval`.** It keeps the callback in a ref so re-renders don't
  restart the timer, and accepts `null` to freeze — which is how `Spinner` stops animating
  without being unmounted.
- **The reporter draws on stderr.** `render(..., { stdout: process.stderr })`. Results are
  buffered and written to stdout only after Ink unmounts, because stdout and stderr are usually
  the same terminal and a result printed mid-repaint lands inside a frame about to be erased.
- **Settled steps go through `<Static>`.** Otherwise every finished line is repainted on each
  spinner tick.

## Tests

**`ink-testing-library`** renders components and asserts on the plain-text frame; `plain()` in
`test-utils.ts` strips the escape sequences.

**A PTY** (`src/report/ink-reporter.e2e.test.ts`) runs the real binary via
`Bun.spawn({ terminal })` — native since Bun 1.3.5, so no `node-pty`, whose C++ addon Bun
cannot load. It exists because `ink-testing-library` fakes stdout with `columns` pinned to 100
and no `isTTY`, and whether the Ink reporter is selected *at all* depends on
`process.stderr.isTTY`. POSIX only — the tests skip themselves on Windows.

Three details in `e2e-utils.ts` are load-bearing and were each found the hard way:

- **`QUIET_MS`.** A repaint arrives in several chunks, so a predicate can match text from the
  top of a frame while the bottom is still in flight. Waiting for the stream to go quiet is
  what makes a frame whole.
- **`pressUntil`.** Raw mode is enabled from an effect after the first paint, so a key written
  into that window is swallowed by the line discipline. Only for idempotent keys.
- **`CI: "false"`.** Ink's `is-in-ci` disables repainting when `CI` is set, and every wait would
  then time out on an empty buffer. `"false"` is the supported opt-out.

A PTY returns a stream of repaints, not a screen: Ink erases the previous lines and rewrites
the whole frame, so accumulated output still holds every older frame. `clear()` before an
interaction makes the next repaint readable on its own, which is what keeps `not.toContain`
honest. Assertions finer than that (cell colors, cursor position) would need a terminal
emulator such as [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless).
