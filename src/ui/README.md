# src/ui — the screen, and the parts it is built from

[Ink](https://github.com/vadimdemedes/ink) is React with a renderer that paints to a terminal
instead of the DOM. `Box` is flexbox (via Yoga), `Text` is the only leaf that may contain
strings.

Two things live here. `app/` is the interactive screen a bare `grove` opens — the worktrees, with
the five commands bound to keys. `components/` is the parts list, shared with
`src/report/ink-reporter.tsx`, which draws progress for a one-shot command and nothing else.

```
theme.ts          shared colors
components/       Spinner, ProgressBar, StatusBar, StepRow
hooks/            useInterval
app/App.tsx       the screen: rows, keys, and one mode at a time
app/Setup.tsx     the screen when there is no repository yet: ask, clone, hand over
app/Banner.tsx    the welcome: name, version, folder — and how many rows it took
app/changelog.ts  CHANGELOG.md parsed at compile time, for the banner's "What's new"
app/message.ts    the one line shown after something happened, shared by both screens
app/tree.ts       the worktree paths as the tree they are on disk
app/service.ts    what the screens are allowed to do, as six functions
app/run.tsx       discovery, the reporter, which screen is up, and render()
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
- **Two screens, not another `mode`.** `Setup` is what a bare `grove` opens where discovery
  found nothing, and `run.tsx`'s `Grove` swaps it for `App` the moment it produces a repository.
  They are separate components because they share nothing but the banner: there is no list to
  move a cursor through in `Setup`, and no repository for `App`'s keys to act on until `Setup`
  has made one — which is also why `createWorktreeService` cannot be built until then. Only
  `not-a-repo` opens it; an ambiguous folder still ends the process, since the screen cannot
  answer that question either.
- **A folder row carries the worktrees it holds** (`leaves`), rather than them being read back
  off the rows that follow it. `leavesUnder` did the latter, and a folded folder has no rows
  following it — so `r` there would have found nothing to remove and folding would have quietly
  changed what a key does. Folds themselves are held in a `Set` of folder *keys*, not rows, so
  they survive the list re-reading itself.
- **`←` and `→` mirror each other, including when there is no level to step through.** `→` opens
  a shut folder or goes to its first child; `←` shuts an open one or goes to its parent; and each
  falls back to moving one row its own way rather than doing nothing. `firstChildOf` is
  `parentOf`'s mirror and reads the emitted rows for the same reason — a folded folder has
  nothing under it *here*, and `→` should treat that as the dead end it looks like.
- **A shut folder is indicated by its count, and nothing else.** It reads `feat/  3`; open, it
  reads `feat/` with its worktrees indented underneath. A chevron as well would say the same
  thing twice, and the count says the part a chevron cannot — how much is behind it.
- **The `add` mode carries its base.** `a` reads the selected worktree's branch when the prompt
  opens and keeps it on the mode, rather than reading the selection again on `enter`. With the
  list refreshing itself, the two are not the same value — and the second one would not be what
  the prompt said while the name was being typed.
- **One timer, doing both halves in order.** `REFRESH_MS` (60s) fetches and then re-reads, so
  the read behind the fetch sees what it brought. The fetch's failure is deliberately not the
  read's problem: offline, the local half is still worth refreshing. It pauses while `busy` — a
  command already owns the repository and re-reads it when it finishes, and a `git status`
  racing a `git worktree add` describes a state that was true for neither — and it is guarded by
  a ref, so a tick cannot start before the last one finished. `refreshMs` is a prop with that
  default: the tests that are *about* the refreshing drive it in milliseconds, and the rest
  inherit it and are simply never ticked.
- **The clock backs off once nobody's pressed a key in a while**, doubling `refreshMs` each tick
  the idle stretch is still open, capped at five times it. The fetch behind it is real network
  and process cost paid for a screen nobody is reading, which is what makes a `grove` left open
  overnight expensive rather than idle. Idle is timed from the last key (`useInput` stamps a
  ref on every one, whatever it does), not from the last render, so it survives typing into `a`'s
  prompt without ever seeing the list move. Any key snaps the delay back to `refreshMs`
  immediately, rather than waiting for a backed-off tick to notice — otherwise reopening the
  screen after a while away could wait minutes for its first refresh.
- **The cursor is a row, not an index.** With the list re-reading itself, a worktree appearing
  above the selected one would slide the selection down without anybody touching a key, and the
  next `r` would be aimed at something else. `move` still resolves inside the state updater, so
  two arrow presses in one frame both count; the last index is kept as the fallback for when the
  selected row is the one that vanished.
- **The services are memoised in `Grove`.** Not a micro-optimisation: `App` fetches when its
  service changes, so a fresh object per render would be a `git fetch` per render.
- **One `DriftCell` draws both drift columns.** `origin` and `main` answer different questions —
  is there anything to push, and has the trunk moved out from under you — but `↑2 ↓1` means the
  same shape of thing in each, so it is one convention to learn. The trunk's own row is blank
  rather than `↑0 ↓0`, and the column's heading is read off `isDefault` so a repository on
  `master` says `master`. `driftFrom` reads the whole set in one `for-each-ref`, because this is
  on the refresh tick and a `rev-list` per worktree would grow with the repository.
- **`DriftCell` and `StateCell` colour on their own contents, not on the cursor.** Every other
  column dims when its row is not selected; these two dim a zero and a `○` wherever they are, so
  the rows that have drifted or have changes in them are the ones that read. Both pair colour
  with something else — direction for the arrows, fill for the dot — because a status column
  that only works in colour does not work for everyone. Colours cannot be asserted in
  `App.test.tsx`: `supports-color` sees the `CI` variable that `e2e-utils` sets for Ink's repaint
  loop and turns chalk off, so the tests check text and layout and the colours were checked by
  eye in a PTY.
- **A column is as wide as its heading, too.** Sizing `remote` to its rows alone truncates its
  own label the moment the rows are shorter than it — `↑0 ↓0` under `remo…`. `App.test.tsx`
  caught that one.
- **Anything above the list reports its own height.** `App` slices the list to what is left
  over, so every other section has to be able to say what it will take *before* it is drawn:
  `bannerRows(columns, rows)` and `statusBarRows(hints, columns)`. Both are computed from the
  same predicate the component renders from, so the two cannot disagree, and both are tested by
  rendering and counting lines rather than against a literal. The failure they prevent shows up
  at one window size only — the key bar drawn one row below the bottom of the terminal.
- **"What's new" is baked in, not looked up.** The banner's third column is the top entry of
  `CHANGELOG.md`, bundled as text at compile time (`app/changelog.ts`) the same way the version
  is — the compiled binary runs on machines that have never seen the repository, and the app
  makes no network calls. The column's height flows through `bannerRows` like everything else
  above the list, and it only exists at all when the banner is roomy *and* wide enough that the
  path and count are not the ones paying for it.
- **The key bar packs its own lines** (`packHints`). A `Box` of one `Text` per hint does not
  break between hints when the terminal is too narrow for the row; it squeezes every box until
  the keys and their actions land on separate lines (`↑↓ ⏎ move` reading as `↑↓`/`move`). Each
  packed line is drawn as a single `Text` with the hints as inline spans, which is what welds a
  key to its action. `columns` is optional: the progress reporter draws one short hint into a
  log, where there is no width to pack against and nothing underneath to protect.
- **`StepRow` truncates only for the app** (`truncate`). The app reserves a fixed number of rows
  for activity and would lose the bottom of its layout to a `--verbose` git line long enough to
  wrap; the reporter draws into a log with nothing under it, so wrapping there costs nothing and
  truncating would throw text away.
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
- **Every destructive key goes through the same `confirm`.** `Pending` covers a removal, a
  folder's worth of removals, and a reset; the question is always "is this the row you meant",
  and the answer should not depend on remembering which key you pressed. `x` is also hidden and
  inert on a clean worktree — a confirmation whose only possible outcome is "nothing to discard"
  is training people to answer `y` without reading.
- **The prompt reads its line from a ref, not from `mode`.** Keys arrive faster than React
  commits, and a paste is a whole line and an `enter` inside one frame — reading `mode.value`
  there acts on the line as it was *before* the paste, which is empty. The same branch splits a
  pasted newline into "text, then submit", because the printable-only filter would otherwise
  drop the entire paste for containing a `\r`. Both are pinned by a test that pastes.
- **The prompt does not take the list's keys away.** The arrows still move the cursor while it is
  open — the list is what is being looked at, and narrowing then picking should be one motion.
  Only the real arrows, since `j`/`k` are letters in a text line. `esc` peels one layer: the line,
  then the box. `enter` pins the selected row and clears the filter, so the filter only ever
  exists while the box is open — it pins the row explicitly rather than trusting the cursor's
  anchor, because typing a name until one row is left never moved the cursor, and it resolves
  past a folder heading, which is where that leaves it.
- **Filtering swaps the shape of the list, not just its contents** (`filter.ts`). With no filter
  it is `buildTree`; with one it is `rank` — flat, whole paths, best first. A tree cannot be
  ranked, and the two jobs are different: folders group the whole set for reading, a ranked list
  answers a name. `rank` returns `TreeLeaf[]` rather than `TreeRow[]`, which is what lets the
  screen keep drawing rows without caring which shape produced them.
- **The activity area is budgeted out of the leftovers, not out of the terminal.** A `!`
  command's output asks for half the screen and progress asks for six rows, but both are then
  capped by what is actually free once the banner, prompt, message and key bar have taken theirs,
  with `MIN_LIST_ROWS` held back for the list. A share of the *whole* is a number that can exceed
  the space there is — 200 lines of `git log` against a `Math.max(1, …)` floor under the list adds
  up to more rows than exist, and Ink draws the overflow on top of the banner. Anything clipped is
  counted on a leading row rather than dropped, since a line going missing off the top without the
  screen admitting it is what started this.
- **The prompt's modes are its first character** (`Prompt.tsx`: `modeOf`, `bodyOf`). No mode
  state to get out of step with what is on screen, and no chrome to switch between them.
  `tokenize` is quotes-only on purpose: the result goes straight to `git` as an argument list,
  so there is no shell for a `;` or a `|` to mean anything to.
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
and no `isTTY`, and both "is the Ink reporter selected at all" and "does a bare `grove` open
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
