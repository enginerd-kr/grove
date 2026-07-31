# garden — git worktree manager

Manage git worktrees backed by a single bare clone. One directory per repository, one
subdirectory per branch, and no bookkeeping to remember.

The name is the shape of the thing: a worktree is a tree, and a repository full of them is a
garden.

Runs on [Bun](https://bun.sh) — runtime, bundler, package manager, and test runner in one —
with [Biome](https://biomejs.dev) for linting and formatting. No dependencies beyond
[Ink](https://github.com/vadimdemedes/ink), which draws the progress display.

```bash
bun install
```

## Layout

Running `garden clone https://github.com/org/repo.git` in `~/work` produces:

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
garden                       # open the worktrees, and run any of the below by keystroke
garden clone <url> [dir]     # bare-clone a repo and check out its default branch
garden add <branch>          # give a branch a worktree (tracking or creating it)
garden list                  # what is here, what state it is in, where you are
garden remove <target>       # delete a worktree
garden reset <target>        # throw away a worktree's uncommitted changes
garden sync [target]         # fetch, then bring worktrees up to date
```

`garden` on its own is the app; `garden <command>` is the same thing headless, for a script or a
pipeline. See [The app](#the-app).

`garden <command> --help` lists a command's own options. A worked example:

```bash
cd ~/work
garden clone https://github.com/org/repo.git
cd repo/main

garden add feat/login        # tracks origin/feat/login
garden add feat/new-thing    # branches off origin/main
garden list
#  * main             main             clean
#    feat/login       feat/login       2 ahead
#    feat/new-thing   feat/new-thing   dirty

garden sync --all            # fast-forward main, rebase the rest onto it
garden rm feat/login         # by branch, by directory, or by path
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

### Reset

`reset` runs `git reset --hard` inside one worktree. It is the only command here that destroys
work rather than moving it about, and it exists because the alternative is worse: without it
people `cd` in and type `git reset --hard` from memory, in whichever directory the shell
happened to be sitting in. Naming the worktree is the point.

```
garden reset feat/login              # discard every change to a tracked file
garden reset feat/login --clean      # and delete untracked files and directories
garden reset feat/login --to origin/feat/login   # drop local commits as well
```

Two things are worth knowing, and both are things `git reset --hard` itself will not tell you.
**Untracked files survive it** — that is what `--hard` means — so a worktree can come out of a
reset still dirty. The command says so rather than leaving you to wonder, and `--clean` is how
you take those too; the app's `x` always does. Ignored files are never touched either way, so a
gitignored `.env` survives both. And **the default does not move the branch**: it discards
changes, not commits. Rewinding is `--to`, which has to be typed.

The one refusal is a worktree in the middle of a rebase, where `reset --hard` does not mean
"undo my changes" but "leave the rebase half-applied", with the commits somewhere only the
reflog remembers. Finish or abort the rebase first.

### Sync

`sync` fetches, then **fast-forwards** the default branch's worktree and **rebases** every
other one onto it. The asymmetry is deliberate: rebasing `main` onto `origin/main` would
rewrite local commits nobody asked to have rewritten, so a diverged default branch is refused
instead.

Every check runs before anything is executed. A dirty worktree is skipped without being
touched, and a rebase that conflicts is rolled back by default — pass `--no-abort` to leave it
in place and resolve it by hand.

## The app

Typing `garden` with no arguments opens the worktrees as a full-screen app, and every command above
is a keystroke:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ▗▄▖ ▗▄▖  garden v0.1.0                                                       │
│ ▝▜█▄█▛▘  ~/work/repo                                                         │
│    ▐▌    7 worktrees · in main                                               │
╰──────────────────────────────────────────────────────────────────────────────╯
    worktree  origin       main    state
────────────────────────────────────────────────────────────────────────────────
  * main      ↑0 ↓1                ○
    chore/
      work-1  ↑0 ↓0        ↑1 ↓1   ○ locked
▸     work-2  ↑0 ↓2        ↑3 ↓1   ●
    feat/
      login   ↑2 ↓1        ↑8 ↓1   ○
      api/
        v2    no upstream  ↑2 ↓4   ● rebasing

────────────────────────────────────────────────────────────────────────────────
✓ fetched
✓ feat/login rebased
2 up-to-date, 1 rebased

↑↓ move · a add · r remove · x discard · s sync · S sync all · R refresh · q quit
                                                                        4 of 10
```

The welcome across the top is there because the alternate screen takes the
answers away: what this is, which build of it, which repository it found, and
whether you are standing in one of its worktrees — none of which are on screen
any more once the command that started the app has scrolled into the other
buffer. It costs five rows, so it hands them back on a terminal too short or too
narrow to spare them and says the same things on one line:

```
garden v0.1.0 · ~/work/repo · 7 worktrees · in main
```

The list is the directory tree, because that is what the worktrees already are: `feat/login`
lives in `feat/login`, so a flat list repeats the prefix on every row and hides the grouping the
slashes were there to express. A `branch` column appears only for a worktree whose branch
differs from the directory holding it, which `--dir` and a detached HEAD are the ways to
produce.

**Two drift columns, because working in a worktree you have two questions.** `origin` is how far
the branch has drifted from the one it tracks — is there anything to push, anything to pull.
`main` is how far it has drifted from the default branch — how much this branch adds, and how far
the trunk has moved out from under it, which is the one `sync` exists to close. Neither answers
the other: a branch perfectly in step with its remote can still be twenty commits stale.

Both are drawn the same way, so it is one convention rather than two. `↑` is what the other side
does not have, `↓` is what you do not, and the arrow points the way the commits would have to
travel. `↑` is green — work that exists only here, yours to push or to merge. `↓` is yellow —
work you have not got, and the half that makes a rebase land on a branch that moved under it. A
zero on either side is dimmed, so the rows that have actually drifted are the ones you see.

A branch nobody has pushed says `no upstream` rather than `↑0 ↓0`, which would be claiming it is
in step with something. It still has a `main` column, which is the half that used to be missing
entirely for exactly the branches you are most likely to be working in. The default branch's own
`main` column is blank: there is nothing to compare it against but itself. The heading is
whatever the trunk is actually called, so a repository on `master` says `master`.

The whole set is read with one `git for-each-ref --format='%(ahead-behind:main)'` rather than a
`rev-list` per worktree, which matters because it is on the two-second refresh. That format
arrived in git 2.41; on anything older the column is simply empty and nothing else changes.

`state` is a dot: `●` has uncommitted changes, `○` does not. `clean` was a word on every row that
told you nothing, and the one row that mattered was the same shape and length as the rest — a
filled dot has weight and a hollow one does not, so the worktree you have been editing is now the
one that looks different from across the terminal. Shape as well as colour, deliberately, since
green-versus-yellow is invisible to a good number of people and to any terminal theme with
opinions. The three states a dot cannot say keep their words beside it: `rebasing`, `detached`,
`locked`.

**None of it waits for a keystroke.** The list re-reads itself every two seconds, so a build
that dirties a worktree or a branch created in another terminal shows up while you are looking
at the screen. `↑` and `↓` are counted against `origin/main`, which is a *local* ref — so the
app also fetches for itself, once on open and every minute after, or the column would only say
how far you had drifted as of whenever something last fetched and a colleague's push would never
appear at all. The fetch is quiet: offline, on a VPN, or with no key loaded it fails and the
numbers stay as stale as they were, because a screen that reported each attempt would be
unusable on a train while telling you nothing you could act on. Both timers pause while a
command is running, which is going to re-read everything when it finishes anyway.

The cursor holds onto its row rather than its position, so a worktree appearing above the
selected one does not slide the selection down under your hands — the next `r` stays aimed at
what you pointed at.

Folders are destinations too, and the keys change on one:

```
▸   feat/
      login   ↑2 ↓1   ↑8 ↓1   ○
      api/
        v2    ↑0 ↓0   ↑2 ↓4   ●

↑↓ move · ←→ fold · a add under feat/ · r remove all 3 · S sync all · R refresh · q quit
```

`r` there removes every worktree beneath it, after asking, deepest first — which is `garden remove`
run once per worktree, with each one still facing its own refusals. One that says no does not
stop the rest, and the answer counts both: `removed 2 worktrees, 1 refused`. `a` starts the
branch name inside the folder you are standing on. `s` is absent, because syncing is a thing you
do to a worktree and a menu that offered it there would be lying.

**`←` and `→` fold them.** A shut folder says how many worktrees it is holding, which is what the
folded rows were telling you:

```
  * main      ↑0 ↓0   ○
▸   feat/  3
```

That count is the whole indicator. A chevron beside it would be saying the same thing twice — a
folder with its worktrees indented underneath is visibly open, and one with a number and nothing
under it is visibly not.

`→` opens a shut folder and steps into an open one; `←` shuts an open one and otherwise walks out
to the folder you are in. The second half is what makes it a tree rather than a pair of toggles:
from six rows deep, `←←←` gets you back out and folds up what you came from without counting rows
on the way. `h` and `l` do the same, next to the `j` and `k` that already move. A fold inside a
fold is remembered, so opening the outer one does not spill rows you had already put away.

Folding changes what is on screen and nothing else. `r` on a shut folder removes exactly what it
would have removed open — the worktrees it holds travel on the row itself rather than being read
back off the rows below it, which is the shape of bug this would otherwise have.

`*` is the worktree you started from, `▸` the one the keys act on. `a` prompts for a branch
name; `r` asks before deleting anything; `s` syncs the selected worktree and `S` syncs them all.
Progress is drawn in place — the same spinner and clone percentage a command line gets — and a
refusal ("worktree is dirty") lands on the screen instead of ending the session.

**`a` starts the branch where the cursor is.** Branching off the remote's default is what
`garden add` does from a command line, because there is nothing there to point at. In the app
there is: the worktree you are looking at when you decide you want another one is almost always
the one you mean to carry on from, unpushed commits and all. So the prompt says where it starts,
and starting somewhere else is a matter of moving the cursor first:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ new branch from feat/login   feat/login-part-2▌                              │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The base is read when the prompt opens, not when you press enter — the list refreshes itself, and
a base that changed while you were still typing the name would not be the one the prompt promised.
A folder is not a branch and a detached HEAD has no name to pass, so both fall back to the
remote's default. And it only applies to a branch that does not exist yet: one that is already
local, or already on the remote, is checked out rather than created, which the answer says
(`added feat/login-part-2 from feat/login` against `added feat/login (remote)`). Typing it out
still works either way — `garden add <branch> --from <base>`.

It runs in the terminal's alternate screen, so quitting hands the terminal back exactly as it
was found. The layout is measured against the window: the keys sit on the last row whatever the
height, the list takes what is left and scrolls when there are more worktrees than rows — with
`4 of 10` under the keys saying how far in you are — and a resize redraws to fit, the welcome
collapsing to its one line on the way down. Narrower than the keys are long, the key bar breaks
between them onto a second row and the list gives up the row:

```
↑↓ move · a add under chore/ · r remove all 1
S sync all · R refresh · q quit
```

**`x` throws away everything a worktree has changed**, which is `garden reset --clean` and the
one key here that destroys work. It appears only on a worktree that has something to throw away
— a confirmation whose whole effect is to say "nothing to discard" teaches people to answer `y`
without reading it — and it counts the two kinds apart before it does anything:

```
discard 1 change and 3 untracked files in feat/login? there is no undo
```

Apart, because they are not the same thing. A tracked change has a committed version to go back
to; an untracked file is one git has never seen a copy of, and folding it into "4 changes" is
the sentence someone regrets having skimmed. `.gitignore` still protects what it protects — a
gitignored `secrets/.env` is not touched.

Red rather than amber, because it is not the same risk as the other key that asks: a removed
worktree leaves its branch and its commits behind and `garden add` brings it back, while this
leaves nothing at all.

The app runs the same `core/commands` the CLI does, minus the destructive spellings: no
`--force`, no `--delete-branch`, and for `reset` no `--to`. Those stay on the command line,
where they have to be typed out on purpose. The line it draws is that a keystroke may undo your
afternoon after asking, but not your week — `--to` discards commits, and that is a different
thing from discarding changes.

### Starting from nothing

`garden` in a folder with no repository in it opens anyway, and asks the only question there is:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ▗▄▖ ▗▄▖  garden v0.1.0                                                       │
│ ▝▜█▄█▛▘  ~/Projects/open-source/garden                                       │
│    ▐▌    no repository here yet                                              │
╰──────────────────────────────────────────────────────────────────────────────╯

This folder is empty, so it becomes the repository.
garden clones it bare and checks out the default branch as the first worktree.

╭──────────────────────────────────────────────────────────────────────────────╮
│ repository git@github.com:you/thing.git▌                                     │
╰──────────────────────────────────────────────────────────────────────────────╯

enter clone · esc quit
```

`enter` runs what `garden clone` runs — the bare clone, the fetch refspec a bare clone omits, the
default branch checked out as the first worktree — with the progress drawn in place. The screen
becomes the app the moment it finishes, on the repository it just made.

Where that repository lands is the folder you are standing in if it is empty, and a new folder
named after the URL if it is not. Someone who made a directory, stepped into it, and typed
`garden` means that directory; somewhere with things in it already is the case `garden clone`
and `git clone` both answer by making a folder of their own. A clone that is refused — a typo in
the URL, a remote that says no — is reported on the screen with the URL left where it was, since
retyping forty characters to fix one is the wrong thing to ask.

It needs a terminal on both ends. Piped, redirected, or with `--headless`, a bare `garden` prints
the usage and exits 0, so `garden | head` and `garden > usage.txt` still mean what they used to.
The one discovery failure that still ends the process is the ambiguous one — two managed
repositories directly below where you are standing — because that is a question the screen cannot
answer either, and it exits 3 the way `garden list` does.

## Output and exit codes

**stdout is data, stderr is progress.** `garden list --json | jq` works while a spinner is on
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
garden sync --all --headless
#  · fetching
#  ✓ fetched
#  · syncing feat/login
#  ✓ feat/login already up to date
```

Either way, drawing happens on stderr and results on stdout, so `garden list --json | jq` and
`garden clone <url> | tee log` both work.

### Seeing what git was asked to do

`--verbose` logs one line per git call, on stderr, as each finishes:

```
· git -C ~/work/repo/.bare rev-parse --verify --quiet refs/heads/feat/login → exit 1, 9ms
· git -C ~/work/repo/.bare worktree add --track -b feat/login ../feat/login origin/feat/login → ok, 64ms
```

The `-C` form is what you would paste into a shell to run the same thing by hand. Logging on
completion rather than on start is what makes the exit code available — the `rev-parse` above
"failing" is how `garden` asks whether a branch exists, and nothing else would ever show you that.

## Scripts

| Command             | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `bun run garden`        | Run the CLI (`src/cli.tsx`); `--help` lists commands |
| `bun run garden:dev`    | Same, with hot reload (`--watch`)                    |
| `bun run build`     | Bundle to `dist/garden.js` (minified + sourcemap)        |
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
    exit-codes.ts      GardenErrorCode -> exit code, as a total switch
    run.ts             dispatch, and how results are printed
  core/                knows nothing about argv, stdout, or Ink
    git.ts             the only place that spawns a process, and `--verbose`'s trace
    errors.ts          GardenError, and classifying git's stderr
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
    app/               the interactive screen a bare `garden` opens
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
  somewhere else entirely. `garden clone` sets `remote.origin.fetch` before its first fetch, and an
  integration test pins the broken behaviour so the line cannot be removed as redundant.
- **Local branches start as the ones you checked out.** A bare clone imports every remote
  branch; `garden clone` prunes back to the one with a worktree, so `add` can create-and-track in
  one step and every local branch has a correct upstream. `remove` may leave a branch behind on
  purpose — that is where unpushed commits live — so this is a starting state, not an invariant.
- **A worktree stopped mid-rebase is reported by git as detached.** True, and useless: `garden` reads
  the branch name back out of the rebase state so `sync feat/login` still finds it, and `list`
  says `rebasing` rather than `detached`.
- Bun strips TypeScript types at runtime, so there is no separate compile step. Type errors
  surface via `bun run typecheck`, not at run time.
- Biome replaces ESLint + Prettier + `eslint-plugin-import`. Config lives in `biome.json`;
  style is 2-space indent, double quotes, semicolons, trailing commas, 100-col lines.
- Install the `biomejs.biome` editor extension for format-and-fix on save (already wired up in
  `.vscode/settings.json`).
