# Using grove

<div align="center">

[English](USAGE.md) · [한국어](docs/md/USAGE.ko.md)

</div>

grove manages git worktrees. Run `grove` and you get an interactive screen:
one row per worktree, one key per action. Every action is also a CLI command
(`grove add`, `grove sync`, ...) for scripts, agents, and non-interactive
shells.

This guide covers the screen first, then the commands.

- [Install and first run](#install-and-first-run)
- [The screen](#the-screen)
- [Common tasks](#common-tasks)
- [Keys](#keys)
- [Layout on disk](#layout-on-disk)
- [Worktree setup: .grove.toml](#worktree-setup-grovetoml)
- [Remotes and forks](#remotes-and-forks)
- [CLI reference](#cli-reference)
- [Scripting and agents](#scripting-and-agents)
- [Troubleshooting](#troubleshooting)

## Install and first run

```bash
brew install enginerd-kr/tap/grove   # or: npm install -g @enginerd-kr/grove
mkdir myapp && cd myapp
grove
```

In a folder with no repository, `grove` asks for a URL, clones it, and opens
the screen. An empty folder becomes the repository itself. A non-empty folder
gets the repository in a subfolder.

grove also works inside an existing `git clone`. New worktrees go beside the
repository (`myapp-feat-login` next to `myapp`). In a folder with several
repositories, `grove` asks which one.

## The screen

<p align="center">
  <img src="docs/screens/list.svg" alt="the grove screen: every worktree, its drift against origin and the trunk, and whether it is clean" width="100%">
</p>

Rows are worktrees, grouped by the folders in their branch names. `*` marks
the worktree you ran `grove` from. `▸` is the cursor.

| column | meaning |
| --- | --- |
| remote | commits ahead / behind the branch's upstream |
| main | commits ahead / behind the trunk |
| pr | the branch's open pull request, as GitHub sees it: the number, `✓` `✗` `·` for checks passed, failed, or still running, then `draft`, `approved`, `changes requested`, `conflicts` as they apply. Read through `gh` once a minute; without `gh`, or outside GitHub, the column is not drawn |
| state | `●` has uncommitted changes, `○` clean, then the age of the last commit. `merged` and `gone` mean the branch is finished with; `setup stale` means `.grove.toml` changed since the worktree was filled in |

A row indented under another worktree, rather than under a folder, sits on
it: `grove add --on` stacked it there. The state column says `on <branch>`
instead when the parent is in another folder.

Below the list: files changed in the selected worktree, and (with `/log`) its
recent commits. Beside the list, when the selected row is in a stack: the
whole stack, each branch under the one it sits on with how far it has drifted
from it — the same picture `grove stack` prints. The bottom bar shows the keys
available right now.

The screen refreshes periodically. `/refresh` forces one.

## Common tasks

**Create a branch.** `a`, type a name, `enter`. grove creates the branch and
worktree, applies `.grove.toml`, opens your editor, and copies `cd <path>` to
the clipboard. The branch is cut from the selected worktree. On a folder row,
the name starts with the folder prefix filled in.

**Jump to a worktree.** Select it, `enter`. The path is on the clipboard.

**Sync.** `s` fetches, rebases onto the remote and then the trunk, and pushes.
If the push would rewrite remote history, grove asks first. A branch that is
on no remote yet is asked about too: `y` pushes it and tracks it. `/sync-all`
does every worktree with a single confirmation, and only says which branches
are on no remote.

**Rebase onto something else.** `/rebase` lists the bases for the selected
worktree: the branch's remote, the branch it is stacked on, the trunk, and the
other worktrees' branches. Pick one, `enter`. Nothing is pushed. Uncommitted
changes are carried through and put back; if the rebase conflicts, or the
changes will not sit on the result, the whole thing is undone.

**Open a pull request.** `/propose` asks the forge to open one for the
selected worktree's branch. A branch added with `--on` goes onto the branch it
sits on, so the second pull request of a stack does not show the first one's
diff again; any other branch goes onto the trunk. The prompt names the base.
`y` pushes the branch where `git push` would send it, a first push included,
and opens the pull request filled in from the commits. A branch that already
has one is reported instead. Requires `gh`.

**Discard changes.** `x` throws away everything uncommitted in the selected
worktree, untracked files included. What goes is saved as a commit first, and
the line after `y` says how to get it back: `git stash apply <sha>`.

**Remove.** `r`. The prompt lists what would be lost. `y` removes the worktree
and keeps the branch. On a folder row, `r` removes every worktree in it.
`/prune` removes every worktree badged `merged` or `gone` at once: the prompt
names them, and the branches stay.

**Review a pull request.** `/review`, pick one, `enter`. It checks out as
`pr/<number>`. `git push` from there updates the PR, and so does `s`.
Requires `gh`.

Every destructive action asks first. `y` confirms. Any other key cancels.

## Keys

| key | action |
| --- | --- |
| `↑` `↓` / `k` `j` | move |
| `←` `→` / `h` `l` | fold or open a folder; step out of or into it |
| `enter` | copy the selected path |
| `a` | add a worktree, branched from the selection |
| `r` | remove the selection, or the whole folder |
| `x` | discard uncommitted changes, keeping a copy (shown only when there are any) |
| `s` | sync the selection |
| `/` | command menu |
| `y` / `n` | confirm / cancel |
| `q` / `esc` | quit |

`/` opens a searchable menu. Type to filter, `↑` `↓` to pick, `enter` to run,
`esc` to close.

<p align="center">
  <img src="docs/screens/menu.svg" alt="the / menu open over the list, narrowed by what has been typed" width="100%">
</p>

| command | action |
| --- | --- |
| `/open` | open the selection in the editor |
| `/setup` | re-apply `.grove.toml` to the selection |
| `/rebase` | rebase the selection onto a base you pick |
| `/propose` | open a pull request for the selection, onto the branch it sits on |
| `/sync-all` | sync every worktree |
| `/prune` | remove the worktrees badged `merged` or `gone` |
| `/review` | check out an open pull request |
| `/upstream` | this is a fork: follow another repository's trunk |
| `/refresh` | re-read worktrees now |
| `/log` | toggle the commit panel |

Two things are CLI-only by design: moving uncommitted changes into a new
worktree (`grove add --take`) and recording a branch as stacked on another
(`grove add --on`).

## Layout on disk

```text
myapp/
  .bare/           # git objects and refs
  .git             # file pointing at .bare
  main/            # default branch
  feat/login/      # branch feat/login
  feat/login-api/  # branch feat/login-api
  pr/42/           # PR checked out for review
```

Directory name = branch name, slashes included. Each directory is a normal git
worktree; `git` works there as usual. The root is never a worktree.

## Worktree setup: .grove.toml

A new worktree has no `.env` and no `node_modules`. `.grove.toml` on the
default branch declares how to fill one in. Every `a` / `grove add` applies it.

```toml
[setup]
copy = [".env", "certs", "config/local.json"]
link = ["node_modules"]
env  = { PORT = 3000 }
run  = ["bun install"]
open = "code ."

[teardown]
run = ["docker compose down"]
```

| key | meaning |
| --- | --- |
| `copy` | copy from the trunk worktree. Trunk wins; directories merge |
| `link` | symlink to the trunk's path. Existing entries are left alone |
| `env` | environment for `run` commands |
| `run` | commands to run in the worktree, in order, awaited |
| `open` | editor command. Not awaited; survives the terminal closing |
| `[teardown] run` | commands to run before the worktree is removed |

Rules:

- Paths must stay inside the worktree. Absolute paths, `..`, `.git`, and
  `.bare` reject the whole file.
- A `copy` or `link` path can be a pattern: `packages/*/.env`,
  `**/.env.local`, `apps/{web,api}/node_modules`. It is matched against the
  trunk's worktree when setup runs, so a package added later is covered. The
  report names each match; a pattern that matches nothing is reported as
  missing under its own spelling.
- Unknown keys are errors. `cpoy = [".env"]` fails instead of doing nothing.
- List keys accept a bare string: `copy = ".env"`.

Any key can be per-platform. The keys are `macos`, `linux`, `windows`; a
platform the table leaves out gets nothing there. `env`'s platform keys hold
that platform's variables, over the shared ones:

```toml
[setup.open]
macos = 'open -a "Visual Studio Code" .'
linux = "code ."

[setup.copy]
macos   = [".env"]
windows = [".env", "local.bat"]

[setup.env]
PORT    = 3000
windows = { SHELL = "pwsh" }

[teardown.run]
macos = ["docker compose down", "colima stop"]
```

### Three config layers

| file | scope |
| --- | --- |
| `~/.config/grove/config.toml` | your machine. Put `open` here |
| `.grove.toml` | the project. Committed |
| `.grove.local.toml` | this checkout. Gitignored |

Applied in that order. Every key takes the value from the highest layer that
sets it — `copy`, `link`, `run` and `open` included, and `env` one variable name
at a time. A higher layer replaces the whole key rather than adding to it, so
`run = []` in `.grove.local.toml` turns the project's commands off on this
machine. Commenting a key out is the same as leaving it out: the layer below
still applies. A key written for another platform is not a value set here.

When more than one layer is in play, each command says which file it came from
as it runs.

### Trust

`copy` and `link` run immediately. `run` and `open` do not until you approve
them, since a `git pull` could otherwise deliver arbitrary commands.

grove shows the commands and asks. `y` approves. On the screen that is the
prompt after `a`; on the CLI it is the same question under `grove add`,
`grove pr`, `grove setup`, and `grove open`, whenever a terminal is attached.
`--trust` answers it in advance. In a pipe, with `--headless`, or with
`--json`, nothing is asked: the commands are printed and skipped.

Approval is a hash of the file, stored in the bare repository's git config
(local, never pushed). Editing the file revokes it. `config.toml` and an
untracked `.grove.local.toml` never need approval.

### Re-applying setup

`a` applies `.grove.toml` as it was at the time. When the file changes later,
the rows filled in from the older version read `setup stale`: grove records
which version each worktree was set up from, beside the branch in the bare
repository's config, and compares it with the trunk's file on every refresh.
Run `/setup` on a worktree or `grove setup --all` to catch them up. It is
idempotent: `copy` overwrites from the trunk, `link` leaves existing entries,
`run` is your own command. A worktree set up before this record existed shows
no badge until its next setup.

`run`, `teardown`, and `exec` commands receive `GROVE_ROOT`, `GROVE_WORKTREE`,
and `GROVE_BRANCH`.

## Remotes and forks

grove never asks which remote to use. It reads what git already knows, so a
repository that works with `git push` and `git pull` works with grove the
same way.

**The trunk** is the branch `origin/HEAD` names, usually `main`. Which copy
of it counts is whatever the local `main` tracks: `origin/main` in a plain
clone, and `upstream/main` once you have said so. Everything is measured
against that copy: the `main` column, the `merged` badge, the base `a` cuts
a branch from, and what `s` rebases onto.

**A branch is pushed** where `git push` would send it: the branch's own
`pushRemote`, else `remote.pushDefault`, else the remote it tracks, else
`origin`. `--push`, `--publish`, and every push `s` makes follow this.
`grove add` looks for an existing branch on that same remote.

So a fork is one line:

```bash
grove clone git@github.com:you/repo.git --upstream git@github.com:them/repo.git
```

or, in a repository you already have, `/upstream` on the screen or
`grove upstream <url>`. Either one writes three git settings and nothing of
grove's: a remote called `upstream`, `git branch -u upstream/main main`, and
`remote.pushDefault = origin`. `git pull` and `git push` read the same
three. The same URL again changes nothing; a different one is refused
unless `--force` says to replace it, and the screen asks.

Nothing is detected. Which repository a fork came from is a fact only the
forge holds, so the URL is typed once by somebody who knows it.

From then on `a` cuts from `upstream/main`, `s` rebases onto it and pushes
to your fork, and `merged` means merged into theirs. `grove pr` fetches the
pull request from the trunk's remote, and a `pr/<n>` worktree always pushes
back to the pull request, whatever `pushDefault` says. `doctor` reports an
`upstream` remote the trunk does not follow yet, and a trunk that tracks a
remote nothing has been fetched from.

## CLI reference

Every command has `--help`, generated from the parser's own table.

```bash
grove clone <url> [-b <branch>]   # first-run screen; `init` is an alias
grove upstream <url>              # /upstream
grove add <branch>                # a
grove list                        # the rows, as text
grove path [target]               # enter; no target prints the root
grove open [target]               # /open
grove setup [target | --all]      # /setup
grove sync [target | --all]       # s, /sync-all
grove rebase [target]             # /rebase
grove pr <number | url | branch>  # /review
grove propose [target]            # /propose
grove stack [target | --all]      # the panel beside a stacked row
grove reset <target>              # x
grove remove <target>             # r
grove prune                       # /prune
grove rename <target> <name>      # move branch and directory together
grove exec -- <command>           # run in every worktree
grove doctor                      # diagnose
```

`<target>` is a branch, directory, or path. It defaults to the current
worktree. `-C <path>` selects a repository explicitly.

```bash
cd "$(grove path feat/login)"
```

### add

Uses the local branch if it exists, tracks the remote branch if that exists,
otherwise creates it from the default branch.

| flag | |
| --- | --- |
| `--from <base>` | create from `<base>` instead |
| `--on <branch>` | create from `<branch>` and record it as the parent (stack) |
| `--take` | move the current worktree's uncommitted changes into the new one |
| `--push` | push and set upstream |
| `--trust` | approve `.grove.toml` commands |
| `--no-fetch`, `--no-setup` | skip the fetch / skip `.grove.toml` |

A stacked branch rebases onto its parent, and onto the trunk only through the
parent. Parents sync before children; syncing a child syncs its parents. The
record is `branch.<name>` in the bare repo's config, so `git branch -m`
carries it along.

### sync

Fetches, then:

- **default branch**: fast-forward, or rebase local commits and push.
- **every other branch**: rebase onto its remote, then onto the trunk, then
  push with `--force-with-lease`.

A dirty worktree aborts before anything runs. A conflicted rebase is aborted
unless `--no-abort`. `--no-push` keeps the result local.

A branch on no remote yet (`grove add` without `--push`) is rebased and then
reported with exit code 4: nothing was pushed, and nothing was refused.
`--publish` pushes it where `git push` would and tracks it. `--no-push` says
it is meant to stay local, and reports nothing. See
[Remotes and forks](#remotes-and-forks) for which remote that is.

The screen confirms before a force-push and before a first push. The CLI does
neither.

### rebase

Moves one worktree's branch onto a base of your choosing and pushes nothing.
`sync` picks its base and pushes; this is for when the base is the question.

| flag | |
| --- | --- |
| `--upstream` | onto the branch the worktree tracks |
| `--trunk` | onto the default branch as origin has it (`--onto main` is the local checkout) |
| `--onto <ref>` | onto any branch or ref; a name only origin has means `origin/<name>` |
| `--no-stash` | refuse a dirty worktree instead of carrying its changes |
| `--no-abort` | leave a conflicted rebase, or conflicting changes, in place |
| `--no-fetch` | skip the fetch |

With none of the three base flags, a terminal is shown the bases and asked for
one by number. A pipe gets exit code 2 with the same list on stderr.

Uncommitted changes are snapshotted (a commit, never `refs/stash`), the rebase
runs, and they are re-applied on top. If the rebase conflicts, or the changes
do not apply cleanly to the rebased branch, everything is undone and the
worktree is exactly as it was: exit code 5. `--no-abort` keeps the half-finished
state instead and prints the snapshot's sha, so `git stash apply <sha>` brings
the changes back once the conflict is resolved.

### propose

Opens a pull request for a worktree's branch. The base is the branch `add
--on` recorded it as sitting on, else the trunk; `--base <branch>` says
otherwise. The branch is pushed first, where `git push` would send it: a
branch on no remote is pushed with `-u`, one that is ahead is pushed plainly,
and one that is behind its remote is refused until `sync` has caught it up.
Uncommitted changes are warned about and left alone.

| flag | |
| --- | --- |
| `--base <branch>` | open it onto `<branch>` |
| `--stack` | the branches it sits on first, bottom-up, then it — one pull request each, onto the branch below |
| `--draft` | open it as a draft |
| `--title <text>` | the title; without it, and `--body`, both are filled in from the commits |
| `--body <text>` | the body, beside `--title` |
| `--web` | push, then write the pull request in the browser |

A branch that already has an open pull request is reported with its number
and base, and nothing is pushed. If that base is not the one the stack says,
the `gh pr edit` that moves it is printed. Needs `gh`; exits `10` without it.

`--stack` is `propose` run over the chain: the bottom branch onto the trunk,
each one above onto the one below, and the target last. A pull request
already open is reported and left alone, so a half-proposed stack is
finished. `--base`, `--title`, `--body` and `--web` are each about one pull
request and are refused beside it; `--draft` applies to every one. The
branches above the target are left alone — a pull request is opened when
its author says the work is ready.

### stack

Draws the stack a worktree's branch is in: the trunk at the top, each branch
under the one it sits on, and beside each its worktree and how far it has
drifted from its base — `↑` commits it adds, `↓` commits it has fallen behind
by, which is the number `sync` would close. `*` marks where you are.

```text
main
├─ feat/login *       feat/login      ↑2 ↓0
│  └─ feat/login-api  feat/login-api  ↑1 ↓1
└─ fix/crash          no worktree     ↑1 ↓0
```

A branch in the stack without a worktree says so; `grove add <branch>` gives
it one. A branch the records name and the repository has lost reads `gone`.
`--all` draws every stack in the repository; an unstacked branch is drawn
alone under the trunk. Reads git only — whether a branch has a pull request
is the forge's word, and the screen's `pr` column is where that is drawn.

### remove / prune

`remove` refuses unsafe worktrees unless `--force`. A worktree mid-rebase is
refused regardless. `--delete-branch` deletes the branch. `--no-teardown`
skips `[teardown]`.

`prune` fetches, then removes worktrees whose branch is gone from the remote
(`--gone`) or merged into the trunk (`--merged`). No flag means both. `-n`
prints what would go. Dirty, mid-rebase, locked, or current worktrees are
skipped and reported.

`--closed` adds the one case only the forge can see: a pull request closed
without being merged, its branch still on the remote and none of its commits
on the trunk. It asks `gh` about every worktree the other two answers left
alone, one question each, and counts a pull request only when its head is the
commit the worktree is at, so a reused branch name does not match an old
pull request. Needs `gh`; exits `10` without it, before anything is removed.
`/prune` on the screen never asks the forge.

### reset

`git reset --hard`. `--clean` also deletes untracked files. `--to <ref>` resets
to another ref.

What it discards is saved first, as a commit that touches no ref — the same
shape `git stash push -u` stores, tracked changes and (with `--clean`) the
untracked files — and the sha is printed: `git stash apply <sha>` brings it
all back. The latest snapshot for a branch is also held under
`refs/grove/discarded/<branch>`, so it survives git's own housekeeping; an
earlier one stays reachable by its sha until git prunes unreferenced objects.
The screen's `x` is `reset --clean`, and says the same line after `y`.

### exec

Runs the command after `--` in every worktree, as a process, not a shell line.
Use `sh -c` for shell syntax. Continues past failures unless `--fail-fast`.
Only the command's stdout goes to stdout.

```bash
grove exec -- bun install
grove exec -- git status --short
grove exec -- sh -c 'echo $GROVE_BRANCH'
```

## Scripting and agents

- `--json` prints one JSON document to stdout. Human output goes to stderr.
- `--headless` (or a non-TTY) disables the screen. Commands never prompt; they
  act or fail with an exit code.
- `--verbose` logs every git command with exit code and timing.

| exit code | meaning |
| --- | --- |
| 0 | ok |
| 1 | grove bug |
| 2 | usage |
| 3 | not a repository |
| 4 | refused |
| 5 | rebase conflict |
| 6 | state conflict (also `doctor` with a problem) |
| 7 | git command failed |
| 8 | remote error |
| 9 | `[setup]` command failed (worktree exists) |
| 10 | `gh` missing or failed |
| 11 | `exec` failed in at least one worktree |
| 130 | Ctrl-C |

### What `--json` says

Every command's document is its result object, and only the fields below need
reading in a script. The exit code is the verdict: non-zero is failure, and
success is never to be inferred from what was printed on stderr.

| command | fields worth reading |
| --- | --- |
| `add` | `path`, `dir`, `branch`, `source` (`existing`/`remote`/`new`), `alreadyPresent`, `setup` |
| `add`'s `setup` | `copied`, `linked`, `ran`, `missing`, `untrusted`, `failed` |
| `list` | one row per worktree: `dir`, `branch`, `dirty`, `ahead`, `behind`, `finished`, `setupStale` |
| `propose` | `url`, `number`, `base`, `created` (false when one already existed), `pushed`; with `--stack`, an array of these, bottom-up |
| `stack` | `trunk`, and `rows[]` top to bottom, each with `branch`, `parent`, `depth`, `dir` (absent without a worktree), `ahead`/`behind` against the parent, `exists`, `current` |
| `reset` | `saved`: the snapshot's sha, for `git stash apply` |
| `sync` | exit `4` with nothing pushed means the branch is on no remote yet |
| `prune -n` | `entries[]`, each with `dir`, `reason`, and `skipped` when it stays |

`setup.untrusted: true` means `.grove.toml`'s commands were printed and not
run, because nobody on this machine has approved that version of the file.
`setup.failed` is set when a command exited non-zero; the worktree exists
either way, and `add` exits `9`.

### Trust is a person's decision

The gate exists so that a human reads `.grove.toml`'s commands before they
run. An agent passing `--trust` is exactly what it guards against. Approve
the file once, as yourself: `y` when the screen asks, or `grove setup --trust`
in a terminal. The approval is stored in the repository, so every later
`grove add` on this machine runs the commands without being asked, from an
agent or not.

A typical agent loop, once the file has been approved:

```bash
grove add agents/<task> --json           # create; read `path` from stdout
# ... work in the worktree ...
grove sync agents/<task> --publish        # first push too; exit 4 without it
grove remove agents/<task> --delete-branch
```

A policy for an `AGENTS.md` or `CLAUDE.md`, ready to paste:

```markdown
## Worktrees

- Inspect with `grove list --json`. Never guess a path from a branch name.
- For a task, create a worktree with `grove add agents/<task> --json` and
  work only in the `path` it returns.
- A non-zero exit is a failure. Do not read success out of the log.
- If the result says `setup.untrusted`, report it. Never pass `--trust`;
  approving the setup file is the user's decision.
- Do not run `grove remove`, `grove prune`, `--delete-branch`, `--force`, or
  `grove reset` unless the user asked for that cleanup.
```

## Troubleshooting

```bash
grove doctor
```

Reports problems and the command that fixes each. Writes nothing. Checks for:
a bare clone with no fetch refspec, a trunk tracking a remote nothing has
been fetched from, an `upstream` remote the trunk does not follow, worktrees
git lists that are missing on disk, leftover directories, a root `.git`
pointing at the wrong place, and broken symlinks. Exits `6` on a problem,
`0` on warnings only.

One of the missing-on-disk cases hides from git itself: a worktree that was
locked and then deleted. A coding agent locks the worktree it works in, its
session dies, the directory is cleaned up, and the entry stays because
`git worktree prune` skips locked entries by design. The branch then reads as
checked out at a path that does not exist, and `grove add` of it fails.
`doctor` names the entry and prints the unlock to run before the prune.

Not bugs:

- **Nothing was installed.** `run` needs trust: answer `y` when asked, or
  pass `--trust`. A pipe is never asked. `copy` / `link` read from the trunk
  worktree, not your branch.
- **`grove` printed usage instead of the screen.** No TTY, or `--headless`.
- **`grove exec` consumed my flags.** Put `--` before the command.
- **`grove <command>` refused to pick a repository.** The folder holds several.
  `cd` into one or pass `-C`.

## What grove is not

- Not a git replacement. Every worktree is a normal git worktree.
- Not a package manager. Setup commands are yours.
- Not a secret manager. `.grove.toml` is committed. Secrets go in the local
  layers.
