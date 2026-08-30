# src/ui — the screen, and the parts it is built from

[Ink](https://github.com/vadimdemedes/ink) is React with a renderer that paints to a terminal
instead of the DOM. `Box` is flexbox (via Yoga), `Text` is the only leaf that may contain
strings.

Two things live here. `app/` is the interactive screen a bare `grove` opens — the worktrees, with
making, syncing and removing them bound to keys. `components/` is the parts list, shared with
`src/report/ink-reporter.tsx`, which draws progress for a one-shot command and nothing else.

```
theme.ts          shared colors
components/       Spinner, ProgressBar, StatusBar, StepRow
hooks/            useInterval
app/App.tsx       the screen: rows, keys, and one mode at a time
app/Setup.tsx     the screen when there is no repository yet: ask, clone, hand over
app/Banner.tsx    the welcome: name, version, folder — and how many rows it took
app/Log.tsx       the commits under the list, for the row the cursor is on
app/Files.tsx     the uncommitted files beside the list, as the tree they sit in
app/PullRequests.tsx  the open pull requests, as a list to pick one out of
app/changelog.ts  CHANGELOG.md parsed at compile time, for the banner's "What's new"
app/message.ts    the one line shown after something happened, shared by both screens
app/tree.ts       the worktree paths, and one worktree's changed paths, as the trees they are
app/service.ts    what the screens are allowed to do: add, sync, remove, discard, check out a PR
app/run.tsx       discovery, the reporter, which screen is up, and render()
test-utils.ts     ANSI stripping + a frame-flush helper for tests
e2e-utils.ts      drives the real binary in a PTY (Bun.spawn), through an emulated screen
                  its piped sibling is ../cli/test-cli.ts, which is not a UI concern
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
- **The commit panel is a view, and it is budgeted like one.** `Log.tsx` draws `git log --oneline`
  for the row under the cursor — sha, age, ref names, subject, in columns, with git's own colours —
  and `L` toggles it for the session (on by default; nothing is written to disk). It is read by
  `service.log` when the selection changes and again whenever the list re-reads itself, rather than
  as a column of `listWorktreeSummaries`: that walks every worktree on the refresh tick, and a
  `git log` per row would pay for thirty answers to draw one. Its height comes out of what is left
  *after* the activity area has taken its rows — while a command is running, what it is doing now
  beats what was committed yesterday — and below `LOG_MIN_ROWS` it is dropped rather than drawn as
  a heading with one commit stuck to it. The panel renders its own fixed height, blank rows
  included, so a shallow history does not move the rule above it.
- **The pull-request popup is budgeted like the log panel, not like the `add` box.** `add`
  reserves a flat three rows however long the branch name is; a list of pull requests is as tall as
  the forge says, so `pullRequestRows` caps it at `PR_ROWS` and then caps *that* by what is free
  once the header, the key bar and `MIN_LIST_ROWS` have taken theirs — with a floor of one row,
  since a popup you cannot see the cursor in is worse than a short one. The rows come out of the
  list, which is the same trade the `add` box makes; the difference is only that this one could
  ask for eight. Its window centres on the cursor the way the list's does, so the rows move under
  the selection rather than the selection running off the end of what is drawn.
- **The files panel is drawn in the list's slack, and nowhere else.** `Files.tsx` names the
  uncommitted paths of the row under the cursor — the paths alone, since the `state` dot has
  already said the one thing a status letter would add — and it comes and goes as the cursor
  crosses a dirty row. That it costs the list nothing is what makes that bearable: every column
  of the list is sized to its own contents, `listWidth` adds them back up, and the panel takes
  only what is past the last one, capped by `MAX_FILES_COLS` and dropped below `MIN_FILES_COLS`
  rather than squeezing the table. A panel that took a column's width with it would shear the
  whole list on every second keypress. The paths are folded into their directories by
  `buildFileTree`, so a change confined to one directory is one heading rather than the same
  prefix down every row, and the rule down the left edge runs the full height it is given — the
  pane is the same shape beside a worktree with two files open and one with twenty. What the
  panel is short of is *rows*, which is why the overflow row counts files rather than rows (the
  directories are the panel's own doing, and nobody is missing one) and why a cut that would
  leave a directory heading nothing drops it instead.
- **The changed paths ride along on `WorktreeSummary`, unlike the commits.** `Log` is read by
  `service.log` when the selection moves, because a `git log` per row would pay for thirty
  answers to draw one. `Files` needs no read at all: the `git status` that counts `changed` for
  every row has already named them, so `list.ts` keeps the first `FILE_SAMPLE` of them and the
  panel draws from the same tick the list does. `changed` stays the honest total, which is what
  lets the panel say how many it is not showing.
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
  that only works in colour does not work for everyone. Colour is not asserted in
  `App.test.tsx`, which has no terminal behind its fake stdout; the one assertion that a dirty
  row's dot is undimmed and yellow *wherever the cursor is* lives in `App.e2e.test.tsx`, where
  the emulated screen keeps the attributes, with the clean row beside it as the control that
  stops it passing on a screen with no colour in it at all. `DriftCell`'s arrows are still an
  eye check.
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
- **The trees are pure and live in `app/tree.ts`.** Ordering is the part worth testing —
  worktrees before folders at each level, the default branch before its siblings — and none of
  it needs a terminal. `buildFileTree` is the same fold one level down, over one worktree's
  changed paths for the panel beside the list, and it sorts by the same rule on purpose: two
  trees on one screen that ordered themselves differently would be two conventions to learn for
  one idea. It keeps the trailing slash git puts on an untracked directory it did not walk
  into — that slash is the difference between one file and everything under a folder — while
  still counting the row as the single status entry it is. The screen draws what it returns and the cursor walks every row it
  produced, folders included — `leavesUnder` is what turns a folder row back into the worktrees
  it stands for.
- **Cursor moves go through `setCursor(previous => …)`.** Keys arrive faster than React commits,
  so two presses in one frame both read the same rendered index and the second goes nowhere —
  which is exactly what holding an arrow key does. The clamp lives in the updater too, so a list
  that shrank under the cursor cannot leave it past the end.
- **The screen holds no git knowledge.** `App` takes a `WorktreeService` — add, sync, remove,
  discard a worktree's changes, check out a pull request, and the reads behind them, each
  answering with the line to show afterwards. It is still deliberately narrow: a stash, a bisect, a force-push stays on the
  command line, where it has to be typed out on purpose rather than reached with one finger. That
  is what lets `App.test.tsx` drive every key with a stub and no repository, and it is why a
  keystroke cannot grow a capability the command line does not have.
- **`p` is the one key whose answer is not `git`, and it is here for a reason the others are
  not.** What it needs is not a command but a *choice*, out of a list only the forge can produce:
  `grove pr 42` already exists and works, but knowing that 42 is the number means leaving to go and
  look it up — and not leaving is the whole argument for a key. It runs exactly what the command
  line runs, through the same `checkoutPullRequest`, so the rule above still holds. `gh` is the
  only tool besides git that any of this spawns, and it answers only what git cannot: which
  repository the head is on, what the ref is called there, and whether the pull request is still
  open.
- **`r` goes through a `confirm` whichever row it is on.** `Pending` covers a removal and a
  folder's worth of removals; the question is always "is this the row you meant", and the answer
  should not depend on how many rows are behind it. What `y` costs is spelled out before it is
  pressed — the directory goes, the branch stays, and uncommitted changes are counted by kind.
- **The activity area is budgeted out of the leftovers, not out of the terminal.** Progress asks
  for six rows, and that is then capped by what is actually free once the banner, message and key
  bar have taken theirs, with `MIN_LIST_ROWS` held back for the list. A fixed number is one that
  can exceed the space there is — six rows against a `Math.max(1, …)` floor under the list adds up
  to more rows than a short terminal has, and Ink draws the overflow on top of the banner.
  Anything clipped is counted on a leading row rather than dropped, since a line going missing off
  the top without the screen admitting it is what started this.
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

**A PTY** (`app/App.e2e.test.tsx`) runs the real binary
via `Bun.spawn({ terminal })` — native since Bun 1.3.5, so no `node-pty`, whose C++ addon Bun
cannot load. It exists because `ink-testing-library` fakes stdout with `columns` pinned to 100
and no `isTTY`, and both "is the Ink reporter selected at all" and "does a bare `grove` open
anything" are answers that depend on `isTTY`. POSIX only — the tests skip themselves on Windows.

**The PTY output goes through a terminal emulator**, and that is what `frame()` reads. A PTY
returns a stream of repaints, not a screen: Ink walks the cursor back over the lines it drew
and rewrites them, so stripping the escapes and accumulating the text gives you every frame
since the process started, laid end to end. `not.toContain` means nothing against that, and
the assertions worth making — is this row still listed, has that panel gone — are all of that
shape. So the bytes are fed to [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless)
(pure TypeScript, so unlike `node-pty` Bun loads it without complaint) and `frame()` returns the
lines of `buffer.active` — `active` and not `normal`, because the app is on the alternate screen
and the normal buffer still holds whatever the shell left there. `cellAt(row, column)` returns
one position with the attributes text throws away, which is how the state dot's colour stopped
being checked by eye. `raw()` still hands back the untouched bytes, for the assertions that are
*about* the escapes: entering and leaving the alternate screen is a sequence and nothing else.

Four details in `e2e-utils.ts` are load-bearing and were each found the hard way:

- **`QUIET_MS`.** The emulator retired half of what this was for — a predicate can no longer
  match text from a frame that has already been painted over. The other half it makes worse.
  A repaint still arrives in several chunks and Ink's is not atomic, and a grid fed half of one
  does not look half-applied: it looks like a screen, with the new rows sitting on top of the
  rows the last frame left underneath. Waiting for the stream to go quiet is still what makes a
  frame whole.
- **`clear()`.** No longer about readability, since the screen is not an accumulation any more.
  It is the barrier: most of these predicates are already true of the screen before the key is
  pressed, so without a mark saying "not until the child has spoken since", the wait returns on
  its first poll and the assertion races the repaint.
- **`pressUntil`.** Raw mode is enabled from an effect after the first paint, so a key written
  into that window is swallowed by the line discipline. Only for idempotent keys — `S` syncs
  everything however often it arrives, whereas an arrow key would count every repeat.
- **`CI: "false"`.** Ink's `is-in-ci` disables repainting when `CI` is set, and every wait would
  then time out on an empty buffer. `"false"` is the supported opt-out — and `FORCE_COLOR` is
  its bill: `supports-color` asks only whether `CI` is *present*, so the opt-out meant for Ink
  turned chalk off, and turned it off on a laptop while leaving it on under GitHub Actions,
  whose own variables win that branch. Pinning the level makes the colour on screen a decision
  of the harness rather than of whoever is running it.
