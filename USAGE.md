# Using grove

A working guide to grove: what each command is for, what `.grove.toml` can say,
and what a script can rely on. The README sells the idea; this is the manual.
Every flag here is also in `grove <command> --help`, which is generated from the
same table the parser reads, so the two cannot drift.

- [Getting a repository](#getting-a-repository)
- [The layout](#the-layout)
- [Everyday commands](#everyday-commands)
- [Keeping branches up to date](#keeping-branches-up-to-date)
- [Stacked branches](#stacked-branches)
- [Reviewing pull requests](#reviewing-pull-requests)
- [Clearing worktrees away](#clearing-worktrees-away)
- [Project setup with .grove.toml](#project-setup-with-grovetoml)
- [Trust](#trust)
- [The interactive screen](#the-interactive-screen)
- [Scripting grove](#scripting-grove)
- [When something is wrong](#when-something-is-wrong)

## Getting a repository

```bash
brew install enginerd-kr/tap/grove
```

Start from a remote:

```bash
grove clone https://github.com/org/repo.git
cd repo
```

`clone` makes a bare clone at `repo/.bare`, points `repo/.git` at it, and checks
out the remote's default branch as the first worktree. `-b <name>` checks out
something else first. `grove init` is the same command under another name.

You do not have to convert anything. grove also works inside an ordinary
`git clone` — it recognises the plain layout as-is and puts new worktrees beside
the repository rather than inside it (`myapp-feat-login` next to `myapp`).

Every command works out which repository you mean from where you are standing:
the worktree you are in, any directory inside it, the repository root, or the
folder that holds the repository. `-C <path>` (spelled after git's own) skips
that and names one outright. If a folder holds more than one managed repository,
a bare `grove` asks which; a command refuses rather than guessing, since picking
one would run a destructive command against a repository you never named.

## The layout

```text
repo/
  .bare/           # git objects and refs, stored once
  .git             # points git commands at .bare
  main/            # default branch worktree
  feat/login/      # branch feat/login
  fix/prod-crash/  # branch fix/prod-crash
  agents/refactor/ # branch agents/refactor
```

The directory is the branch's name, including its slashes: `feat/login` lives in
`feat/`, next to every other `feat/*`. Case is kept, characters a filesystem
cannot take become `-`, and a name that slugs away to nothing is refused rather
than quietly landing a level up.

Everything under the root is an ordinary git worktree. `git` works there
normally, and grove is never in the way of it.

## Everyday commands

```bash
grove add feat/login          # create the branch and its worktree
grove list                    # every worktree, its branch, whether it is clean
grove path feat/login         # print its directory
grove open feat/login         # start the editor .grove.toml names
grove remove feat/login       # delete the worktree
```

**`grove add <branch>`** uses the branch if it exists locally, tracks it if the
remote has it, and otherwise cuts it from the default branch. Then it fills the
new worktree in from `.grove.toml`. Useful flags:

| flag | what it does |
| --- | --- |
| `--from <base>` | cut a new branch from `<base>` instead of the default branch |
| `--on <branch>` | the same, and remember that the branch sits there — see [stacks](#stacked-branches) |
| `--take` | move the uncommitted changes of the worktree you are standing in into the new one |
| `--push` | push the branch and set its upstream |
| `--no-fetch` | skip the fetch that looks for a remote branch |
| `--no-setup` | skip everything `.grove.toml` asks for |
| `--trust` | run `.grove.toml`'s commands, recording that you have read them |

`--take` is the answer to "I should have branched first": your changes move to
the new worktree and the one you were in is left clean. It does not touch
`refs/stash`, which every worktree in a repository shares.

**`grove path [target]`** is what shells and scripts use. With no target it
prints the repository root — the one directory that is never a worktree, and so
the safe place to stand while removing anything.

```bash
cd "$(grove path feat/login)"
```

**`grove exec -- <command>`** runs one command in every worktree — the `for` loop
that otherwise gets written, mis-quoted, and written again next week:

```bash
grove exec -- bun install
grove exec -- git status --short
grove exec -- sh -c 'echo $GROVE_BRANCH'
```

The `--` is what stops the command's flags being read as grove's. What follows
it is run as a program, not as a shell line, so a line that wants a shell asks
for one. Every worktree gets its turn even if one fails; `--fail-fast` stops at
the first. Only the command's own output goes to stdout, so
`grove exec -- cat version.txt > all.txt` collects versions rather than a
transcript. The run exits `11` if the command failed anywhere.

**`grove reset <target>`** throws a worktree's uncommitted changes away —
`git reset --hard`, with no undo. `--clean` deletes untracked files too, and
`--to <ref>` resets somewhere else entirely, dropping commits with it.

**`grove rename <target> <name>`** moves the branch and its directory together,
so the directory goes on being the branch's name, and clears up the folders the
old name left empty. The remote keeps the old name until something pushes the
new one; `--push` is that something.

## Keeping branches up to date

```bash
grove sync                # the worktree you are standing in
grove sync feat/login     # one, by name
grove sync --all          # every one of them
```

`sync` fetches first, then:

- the **default branch's worktree** is fast-forwarded — or, when it has commits
  of its own, they are rebased on top and pushed plainly;
- **every other worktree** is rebased onto its own remote, then onto the default
  branch, and force-pushed back with `--force-with-lease`.

A dirty worktree stops the whole thing before anything is touched. A conflicted
rebase is aborted, leaving the branch where it was, unless `--no-abort` says to
leave it in place to resolve. `--no-push` keeps the rebased commits local, which
leaves the branch diverged from its own remote.

Because `sync` force-pushes, it is the one thing here that reaches other
people's clones. The interactive screen asks before doing it; the command
assumes you meant it.

## Stacked branches

git has nowhere to record what a branch was cut from once the cut is made, so
grove writes it down:

```bash
grove add feat/login
grove add feat/login-api --on feat/login
```

From then on `sync` rebases `feat/login-api` onto `feat/login`, and onto the
trunk only through it — which is what keeps a second pull request written on top
of a first one from being replayed over the absence of it. Parents move before
their children, and syncing a child brings its parents along. `list` shows where
a row sits.

The record lives in the bare repository's config under `branch.<name>`, so
`git branch -m` moves it and deleting the branch's section takes it with it.
`--on` and `--from` both name a base and only one of them is remembered, so
passing both is a usage error rather than a coin flip.

## Reviewing pull requests

```bash
grove pr 42
grove pr https://github.com/org/repo/pull/42
grove pr somebodys-branch
```

The pull request is fetched from wherever it was proposed — a branch on the
remote, or somebody's fork — and gets a worktree at `pr/42` on a real local
branch of that name. Committing there and pushing sends the change back to the
pull request rather than to a branch of your own.

`gh` is what resolves the argument, and it is the only tool beyond git that
grove ever runs. Run `grove pr` again to catch the worktree up when the pull
request moves; it refuses rather than dropping commits you added to it.

## Clearing worktrees away

```bash
grove remove feat/login
grove remove feat/login --force --delete-branch
```

`<target>` may be a branch name, a directory name, or a path. Anything unsafe is
refused unless `--force` — though a worktree stopped part-way through a rebase
is refused even then, since half-applied commits are not what "discard my
changes" means. `.grove.toml`'s `[teardown]` commands run inside the worktree
first, so whatever the setup started gets the chance to stop; `--no-teardown`
skips them.

```bash
grove prune -n            # say what would go
grove prune               # remove them
grove prune --gone        # only branches the remote no longer has
grove prune --merged      # only branches the trunk already contains
```

`prune` fetches first — a branch deleted on the forge only reads as gone once a
fetch has pruned the ref that tracked it — and then removes the worktrees that
are finished with, keeping the branches unless `--delete-branch` says otherwise.
Anything holding uncommitted work, stopped mid-rebase, locked, or containing the
directory you are standing in is reported and left exactly where it is.

## Project setup with .grove.toml

A repository can carry its own recipe for what a usable worktree looks like. It
is a tracked file on the default branch, reviewed in a pull request like
anything else, so a fresh clone is set up before anybody explains how.

```toml
[setup]
copy = [".env", "certs", "config/local.json"]
link = ["node_modules"]
env  = { PORT = 3000, API_HOST = "http://localhost:3000" }
run  = ["bun install"]
open = "code ."

[teardown]
run = ["docker compose down"]
```

| key | what it means |
| --- | --- |
| `copy` | files or whole directories taken from the **trunk's** worktree. The trunk's version wins over what the branch has; directories merge entry by entry |
| `link` | symlinks to shared paths like dependency folders. What the worktree already has is left alone |
| `env` | given to every `run` command, over the environment grove was started in |
| `run` | command lines, run in the worktree in the order they are listed, awaited |
| `open` | one command line to start the editor with. Not awaited, and outlives the terminal grove was typed into |

Paths are relative and must stay inside the worktree: an absolute path, a `..`,
or anything naming `.git` or `.bare` is refused, and the whole file is refused
with it rather than half-applied. A key that takes a list takes a bare string
too — `copy = ".env"` is what people write the first time. A key grove does not
know is an error, not something ignored: `cpoy = [".env"]` that quietly does
nothing is the failure this file exists to prevent.

`env` is written whichever way round you think of it, and a number is read as
the string a process was always going to receive:

```toml
env = { PORT = 3000 }              # a table
env = ["PORT=3000"]                # a list of NAME=value

[setup.env]                        # or a section
PORT = 3000
```

`open` cannot be a `run` line — a `run` line is awaited, so `grove add` would
sit there until you quit your editor, and it shares a process group, so the next
Ctrl-C would close it. It is also the one line that does not work everywhere, so
it can be written per platform:

```toml
[setup.open]
macos = 'open -a "Visual Studio Code" .'
linux = "code ."
```

A platform the table leaves out opens nothing and says so. A bare
`open = "code ."` covers all three.

`[teardown]` takes `run` and its own `env` — the credential that installs
dependencies and the one that tears down a stack are rarely the same, and
sharing them would put both in reach of both.

### Three files, not one

`.grove.toml` travels with the repository, which is its point and its limit.
Two more files stack under and over it, all read from the trunk's worktree:

| file | for |
| --- | --- |
| `~/.config/grove/config.toml` | facts about **you**, once per machine — `open = "code ."` belongs here, not in every project |
| `.grove.toml` | facts about the **project**, committed and reviewed |
| `.grove.local.toml` | facts about **this checkout**, gitignored — what you need in a repository you cannot commit to |

They take effect in that order. `copy`, `link` and `run` collect what every
layer named; `open` and each `env` name come from the nearest layer that says
anything. A higher layer cannot un-say something a lower one asked for.

### Filling in worktrees that already exist

`grove add` applies the file as it was the day the worktree was made. When a
pull request adds a `copy` line afterwards, catch the older worktrees up:

```bash
grove setup             # the worktree you are standing in
grove setup feat/login  # one, by name
grove setup --all       # all of them
```

It is safe to run again — `copy` takes the trunk's version, `link` leaves what
is there, and the `run` commands are the project's own. It opens nothing;
`grove open [target]` is that half, aimed at one worktree at a time.

Every `run`, `teardown` and `exec` command gets three variables in its
environment: `GROVE_ROOT`, `GROVE_WORKTREE` and `GROVE_BRANCH`.

## Trust

`copy` and `link` apply on sight: they move files already on your disk into a
directory you asked to have created. `run` and `open` do not, because a
`git pull` could otherwise hand you a command that executes on your machine.

Until you say you have read them, the commands are printed and skipped. Saying
so is `--trust`:

```bash
grove add feat/login --trust
```

What is recorded is a fingerprint of the file's exact contents, kept in the bare
repository's git config — local, per-repository, never pushed. Editing the file
withdraws the trust, so a pull that changes a command stops the commands until
somebody has read them again. Only the layers git tracks are gated; your own
`~/.config/grove/config.toml` and an untracked `.grove.local.toml` are not asked
about, since nothing pulls them.

In the interactive screen, an untrusted line is quoted and asked about instead,
and `y` records the same agreement `--trust` writes.

## The interactive screen

Run `grove` with no arguments. It shows every worktree, its branch, whether it
is dirty, how far it has drifted, the files changed in the row under the cursor,
and that row's recent commits.

| key | |
| --- | --- |
| `↑` `↓` / `k` `j` | move |
| `←` `→` | fold or open a folder |
| `enter` | copy the row's path to the clipboard |
| `a` | add a worktree — under the folder, if the cursor is on one |
| `r` | remove the row, or every worktree in the folder |
| `x` | discard the row's uncommitted changes (only where there are some) |
| `s` | sync the row |
| `/` | everything with no key of its own |
| `q` | quit |
| `y` / `n` | answer a confirmation |

`/` opens a menu you type into: `open`, `setup`, `sync-all`, `review` (pick from
the open pull requests and check one out), `refresh`, and `log` (show or hide
the commits under the list). Anything destructive asks first, and the question
counts what the answer costs.

The screen needs a terminal. Piped, or with `--headless`, grove prints its usage
instead, and progress is logged as plain lines rather than drawn.

## Scripting grove

`--json` makes any command print one document on stdout. Human commentary always
goes to stderr, so `grove prune -n | wc -l` counts worktrees rather than reading
a sentence about them.

Failures are spread across distinct exit codes, so a wrapper can tell "the
worktree was dirty" from "the remote was unreachable" without grepping stderr:

| code | |
| --- | --- |
| 0 | fine |
| 1 | a bug in grove |
| 2 | usage |
| 3 | not a repository |
| 4 | refused |
| 5 | rebase conflict |
| 6 | state conflict (also what `doctor` exits with when it found a problem) |
| 7 | a git command failed |
| 8 | the remote |
| 9 | a `[setup]` command failed — the worktree is there, the install on top of it is not |
| 10 | `gh` was missing or refused |
| 11 | a `grove exec` command failed in at least one worktree |
| 130 | Ctrl-C |

Other flags worth knowing: `--verbose` logs every git command with its exit code
and timing, `-C <path>` names the repository, and `--version` prints the
version.

## When something is wrong

```bash
grove doctor
```

It reads the repository, reports what is wrong, and prints the command that
clears each one. Nothing is written. It looks for the bare clone with no fetch
refspec — the one that makes `origin/*` never appear and every later command
fail somewhere else — worktrees git still lists that are gone from disk,
directories a prune left behind, a repository root whose `.git` names the wrong
place, and links whose target has since gone.

It exits `6` when it found a problem and `0` for a warning, so a stale directory
does not fail a pipeline it is running in.

A few things it will not fix, because they are not broken:

- **Nothing was copied or installed.** The `run` commands wait for `--trust`,
  and `copy`/`link` read the **trunk's** worktree — if the file only exists on
  your branch, there is nothing to take.
- **`grove` printed usage instead of drawing.** There is no terminal: it is in a
  pipe, or `--headless` was passed.
- **`grove exec` read your flags.** Put `--` before the command.

## What grove is not

- Not a replacement for git. Every checkout is an ordinary git worktree.
- Not a package manager. The setup commands are yours: `bun install`, `uv sync`,
  `just setup`.
- Not a secret manager. `.grove.toml` is committed and reviewed; real values
  belong in the uncommitted layers beside it.
