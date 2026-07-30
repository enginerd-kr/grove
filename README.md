# wt — git worktree manager

Manage git worktrees backed by a single bare clone. One directory per repository, one
subdirectory per branch, and no bookkeeping to remember.

Runs on [Bun](https://bun.sh) — runtime, bundler, package manager, and test runner in one —
with [Biome](https://biomejs.dev) for linting and formatting. No dependencies beyond
[Ink](https://github.com/vadimdemedes/ink), which draws the progress display.

```bash
bun install
```

## Layout

Running `wt clone https://github.com/org/repo.git` in `~/work` produces:

```
~/work/repo/
  .bare/          the bare clone — all of git's actual storage
  .git            a file containing "gitdir: ./.bare"
  main/           worktree for main
  feat/
    login/        worktree for feat/login
    search/       worktree for feat/search
  fix/
    crash/        worktree for fix/crash
```

Everything for one repository lives in one folder, and every command works out which folder
it means from the directory you ran it in.

## Commands

```bash
wt                       # open the worktrees, and run any of the below by keystroke
wt clone <url> [dir]     # bare-clone a repo and check out its default branch
wt add <branch>          # give a branch a worktree (tracking or creating it)
wt list                  # what is here, what state it is in, where you are
wt remove <target>       # delete a worktree
wt sync [target]         # fetch, then bring worktrees up to date
```

`wt` on its own is the app; `wt <command>` is the same thing headless, for a script or a
pipeline. See [The app](#the-app).

`wt <command> --help` lists a command's own options. A worked example:

```bash
cd ~/work
wt clone https://github.com/org/repo.git
cd repo/main

wt add feat/login        # tracks origin/feat/login
wt add feat/new-thing    # branches off origin/main
wt list
#  * main             main             clean
#    feat/login       feat/login       2 ahead
#    feat/new-thing   feat/new-thing   dirty

wt sync --all            # fast-forward main, rebase the rest onto it
wt rm feat/login         # by branch, by directory, or by path
```

### Naming

A branch keeps its shape: `feat/login` becomes `feat/login` on disk, a worktree inside
`feat/`. The tree mirrors `refs/heads`, so the grouping the slashes were there to express
survives — with thirty branches, `feat/`, `fix/`, and `chore/` are how you find anything.
`remove` deletes the folder too once the last branch under a prefix is gone.

One consequence: `feat` and `feat/test` cannot both exist. git already forbids that pair as a
ref D/F conflict, so the filesystem simply agrees with it.

The mapping is one-way and never inverted — a branch name needing sanitising cannot be
reconstructed, and `--dir` makes it arbitrary anyway. `remove` and `sync` look the target up in
`git worktree list` instead, so a branch name, a directory path, or a filesystem path all work.

`--dir` accepts a nested path but is validated rather than rewritten: no leading slash, no
`..`, nothing that would put a worktree outside the repo folder or inside another worktree.

### Sync

`sync` fetches, then **fast-forwards** the default branch's worktree and **rebases** every
other one onto it. The asymmetry is deliberate: rebasing `main` onto `origin/main` would
rewrite local commits nobody asked to have rewritten, so a diverged default branch is refused
instead.

Every check runs before anything is executed. A dirty worktree is skipped without being
touched, and a rebase that conflicts is rolled back by default — pass `--no-abort` to leave it
in place and resolve it by hand.

## The app

Typing `wt` with no arguments opens the worktrees as a full-screen app, and every command above
is a keystroke:

```
    worktree  state
────────────────────────────────────────────────────────────────────────────────
  * main      clean
    chore/
      work-1  clean
▸     work-2  dirty
    feat/
      login   2 ahead
      api/
        v2    clean

────────────────────────────────────────────────────────────────────────────────
✓ fetched
✓ feat/login rebased
2 up-to-date, 1 rebased

↑↓ move · a add · r remove · s sync · S sync all · R refresh · q quit
wt ~/work/repo                                                      7 worktrees
```

The list is the directory tree, because that is what the worktrees already are: `feat/login`
lives in `feat/login`, so a flat list repeats the prefix on every row and hides the grouping the
slashes were there to express. A `branch` column appears only for a worktree whose branch
differs from the directory holding it, which `--dir` and a detached HEAD are the ways to
produce.

Folders are destinations too, and the keys change on one:

```
▸   feat/
      login   2 ahead
      api/
        v2    clean

↑↓ move · a add under feat/ · r remove all 3 · S sync all · R refresh · q quit
```

`r` there removes every worktree beneath it, after asking, deepest first — which is `wt remove`
run once per worktree, with each one still facing its own refusals. One that says no does not
stop the rest, and the answer counts both: `removed 2 worktrees, 1 refused`. `a` starts the
branch name inside the folder you are standing on. `s` is absent, because syncing is a thing you
do to a worktree and a menu that offered it there would be lying.

`*` is the worktree you started from, `▸` the one the keys act on. `a` prompts for a branch
name; `r` asks before deleting anything; `s` syncs the selected worktree and `S` syncs them all.
Progress is drawn in place — the same spinner and clone percentage a command line gets — and a
refusal ("worktree is dirty") lands on the screen instead of ending the session.

It runs in the terminal's alternate screen, so quitting hands the terminal back exactly as it
was found. The layout is measured against the window: the keys sit on the last row whatever the
height, the list takes what is left and scrolls when there are more worktrees than rows, and a
resize redraws to fit.

The app runs the same `core/commands` the CLI does, minus the destructive spellings: no
`--force`, no `--delete-branch`. Those stay on the command line, where they have to be typed
out on purpose.

It needs a terminal on both ends. Piped, redirected, or with `--headless`, a bare `wt` prints
the usage and exits 0, so `wt | head` and `wt > usage.txt` still mean what they used to. Run
outside a managed repository it fails the way `wt list` does — exit 3, with `wt clone` as the
suggestion.

## Output and exit codes

**stdout is data, stderr is progress.** `wt list --json | jq` works while a spinner is on
screen, because they are different streams. Every failure, including usage errors, goes to
stderr.

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| 0    | success                                                           |
| 1    | a bug in this tool                                                |
| 2    | usage — bad flags, wrong argument count, an unusable name         |
| 3    | no managed repository found from here                             |
| 4    | refused: dirty worktree, unsafe removal, diverged default branch  |
| 5    | a rebase or merge conflicted                                      |
| 6    | conflicting state: directory exists, branch checked out elsewhere |
| 7    | git failed for a reason we could not classify                     |
| 8    | the remote was unreachable, refused us, or does not exist         |
| 130  | interrupted (Ctrl-C)                                              |

They are distinct so a wrapper script can tell "the worktree was dirty" from "the remote was
unreachable" without grepping stderr.

### The display, and `--headless`

Progress is drawn with Ink — a spinner, and a percentage bar during a clone. That is the
default everywhere, with no environment sniffing behind it: there is nothing to detect wrong,
and no flag to remember for the case where the guess would have gone the other way.

Without a terminal the display does not become noise. Ink stops repainting and each line is
written once as its step settles, so a pipe or a CI log gets exactly this, incrementally and
with no escape sequences in it:

```
✓ cloned
✓ fetched refs
· repo is ready
```

What a pipe loses is only what a pipe cannot use: the spinner, the percentage bar, and the
`ctrl+c cancel` hint.

`--headless` opts out of the display altogether and logs plain lines instead — one when a step
starts and one when it ends, which is what a transcript read a week later wants:

```bash
wt sync --all --headless
#  · fetching
#  ✓ fetched
#  · syncing feat/login
#  ✓ feat/login already up to date
```

Either way, drawing happens on stderr and results on stdout, so `wt list --json | jq` and
`wt clone <url> | tee log` both work.

### Seeing what git was asked to do

`--verbose` logs one line per git call, on stderr, as each finishes:

```
· git -C ~/work/repo/.bare rev-parse --verify --quiet refs/heads/feat/login → exit 1, 9ms
· git -C ~/work/repo/.bare worktree add --track -b feat/login ../feat/login origin/feat/login → ok, 64ms
```

The `-C` form is what you would paste into a shell to run the same thing by hand. Logging on
completion rather than on start is what makes the exit code available — the `rev-parse` above
"failing" is how `wt` asks whether a branch exists, and nothing else would ever show you that.

## Scripts

| Command             | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `bun run wt`        | Run the CLI (`src/cli.tsx`); `--help` lists commands |
| `bun run wt:dev`    | Same, with hot reload (`--watch`)                    |
| `bun run build`     | Bundle to `dist/wt.js` (minified + sourcemap)        |
| `bun run typecheck` | Type check with `tsc --noEmit`                       |
| `bun test`          | Run `*.test.ts` via `bun:test`                       |
| `bun run lint`      | Lint + format check (Biome), no writes               |
| `bun run lint:fix`  | Auto-fix lint, format, and import order              |
| `bun run format`    | Format only                                          |
| `bun run ci`        | `biome ci` + typecheck + tests (CI gate)             |

GitHub Actions runs the same checks on every pull request (`.github/workflows/ci.yml`).

`build` keeps dependencies external. Ink reaches for `react-devtools-core` — an optional peer
that is not installed — behind an `import.meta.resolve` guard, and inlining Ink defeats that
guard: the bundler follows the dynamic import and then fails to resolve the package, at build
time or (with `--external`) at startup.

## Structure

```
src/
  cli.tsx              the bin: parse, dispatch, map errors to exit codes
  cli/
    args.ts            subcommand parsing — pure, no fs and no process
    help.ts            the command surface, described once
    exit-codes.ts      WtErrorCode -> exit code, as a total switch
    run.ts             dispatch, and how results are printed
  core/                knows nothing about argv, stdout, or Ink
    git.ts             the only place that spawns a process, and `--verbose`'s trace
    errors.ts          WtError, and classifying git's stderr
    layout.ts          pure path and naming rules
    discover.ts        which repository a command means
    worktrees.ts       porcelain parsers, and resolving a target
    branches.ts        ref questions asked of the bare repo
    commands/          clone, add, list, remove, sync
  report/
    reporter.ts        the Reporter interface, and the plain implementation
    lines.ts           the line store both drawn reporters share
    ink-reporter.tsx   the terminal one — see src/ui/README.md
  ui/
    components/        Spinner, ProgressBar, StatusBar, StepRow
    app/               the interactive screen a bare `wt` opens
```

## Tests

Three layers, all under `bun test`.

**Unit** — parsing, naming, porcelain formats, error classification. No subprocess, so they
run in milliseconds and cover every branch.

**Integration** (`*.int.test.ts`) — the commands against a real git repository built in a temp
directory, with a `file://` remote. No network, works offline, and exercises the actual fetch
machinery, which is the only way to catch things like a missing refspec.

These pin their own git identity and point `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at nothing.
Without that a developer's `commit.gpgsign` or `init.defaultBranch` silently changes what the
tests do, and CI — having neither — disagrees with the laptop that wrote them. Pinning in the
fixture rather than the workflow file means the guarantee travels with the tests.

**End-to-end** — the real binary, both through pipes (exit codes, stream separation) and
through a pseudo-terminal (whether the Ink reporter is chosen at all depends on
`process.stderr.isTTY`, which nothing else can fake).

## Hooks

`.githooks/pre-commit` runs Biome on staged files, applies safe fixes, and re-stages them; an
unfixable lint error aborts the commit. `.githooks/pre-push` refuses a direct push to `main`.

Both are wired up by the `prepare` script, which `bun install` runs automatically:

```bash
git config core.hooksPath .githooks   # what "prepare" does
git config core.hooksPath             # verify -> .githooks
```

Fresh clones need nothing beyond `bun install`. `--no-verify` bypasses either hook.

Note: if a file has both staged and unstaged changes, Biome rewrites the working-tree copy and
the hook stages those unstaged changes too. Stage the whole file to avoid surprises.

## Notes

- **`git clone --bare` writes no fetch refspec.** It copies the remote's heads straight into
  `refs/heads/*` and configures no mapping into `refs/remotes/*`, so a later `git fetch` exits
  0 having updated nothing — no error, no remote-tracking refs, and `add`/`sync` then fail
  somewhere else entirely. `wt clone` sets `remote.origin.fetch` before its first fetch, and an
  integration test pins the broken behaviour so the line cannot be removed as redundant.
- **Local branches start as the ones you checked out.** A bare clone imports every remote
  branch; `wt clone` prunes back to the one with a worktree, so `add` can create-and-track in
  one step and every local branch has a correct upstream. `remove` may leave a branch behind on
  purpose — that is where unpushed commits live — so this is a starting state, not an invariant.
- **A worktree stopped mid-rebase is reported by git as detached.** True, and useless: `wt` reads
  the branch name back out of the rebase state so `sync feat/login` still finds it, and `list`
  says `rebasing` rather than `detached`.
- Bun strips TypeScript types at runtime, so there is no separate compile step. Type errors
  surface via `bun run typecheck`, not at run time.
- Biome replaces ESLint + Prettier + `eslint-plugin-import`. Config lives in `biome.json`;
  style is 2-space indent, double quotes, semicolons, trailing commas, 100-col lines.
- Install the `biomejs.biome` editor extension for format-and-fix on save (already wired up in
  `.vscode/settings.json`).
