# Changelog

The newest entry is what the app's banner shows as "What's new", and what a
release ships as its notes. Entries begin `## <version>`; only `- ` bullets
directly under one are read.

## 0.4.4 — 2026-09-02

- Nothing a user of grove can observe changed in this release. Everything since 0.4.3 is the code behind it: the rules that were written out once per command have one home each now, the six confirmation kinds are decided in one place instead of kept in step across four lists by hand, the parser that reads `.grove.toml` no longer reaches for git to find out which worktree governs, and three exports nothing ever called are gone. The binary does what 0.4.3's did

## 0.4.3 — 2026-08-31

- The shell integration is gone, and `grove cd`, `grove shell-init`, `grove install` and `grove completion` with it. `cd` existed for the one thing a child process cannot do — move the shell that started it — which is why there was a function to source, a command that printed it, and a command that wrote it into an rc file. Enter in the screen copies the path now rather than landing a shell in the worktree, so `cd "$(grove path feat/login)"` is the whole of what `cd` was for, in one line. With `cd` gone the function has no body worth printing, `install` has nothing left to install, and the completions — the other half of what it wrote — go with the rc file they lived in. grove is one binary again: installing it writes nothing outside the repository, and there is no state in a shell's config that a version of it can be out of step with
- `USAGE.md` is the manual the README stopped being. The README makes the case once and `--help` answers one flag at a time from the table the parser reads; neither of them describes a day — what `sync` does to the trunk as against every other worktree, why three config files stack and in which order, what the trust gate is comparing when it asks, which exit code tells a dirty worktree from an unreachable remote. That was spread across source comments and changelog entries nobody reads twice, and it is one document now, written from the source rather than from the README
- Smaller: the README sells what a worktree arrives with instead of listing a second time what `--help` already answers — a demo, the install, and the `.grove.toml` recipe that is the actual difference — and the three things it claimed that had stopped being true are corrected; the logo's pixels are twice as tall as they are wide now, the shape a terminal cell has, so the sprout stands up in the README the way it does in the banner

## 0.4.2 — 2026-08-31

- `s` asks before a sync rewrites what the remote already has. A force-push was the one thing this screen does that reaches other people's clones, and it was the one thing reached with a single keystroke and no question — while `r` confirms a removal and `x` counts the files before it destroys them. The question comes up before anything is touched rather than in front of the push, since answering "no" after the rebase would leave the branch rewritten and adrift from its own remote, and it comes up only where there is something to rewrite: the trunk, a dirty or mid-rebase worktree, a branch with no upstream, and one already level with both are all unchanged. It refetches before deciding, because a trunk that has moved since the last background tick is exactly the case stale numbers miss. The README describes the push now too — it had said `sync` was a fetch and a rebase, and the one place the rest was written down was `--help`
- `grove` in a folder holding more than one repository opens a screen listing them, instead of printing "say which one" and exiting before it draws. Refusing is still right for a command — `grove remove main` with two candidates would delete a worktree from whichever the scan happened to list first — but it is an answer to a question the screen can just ask: the repositories under the folder, a cursor, and enter, and the app carries on into the one that is chosen. Discovery returns the ambiguity as a value now rather than throwing it, so every command keeps its exit code, its message, and the order the rules are read in
- `/open` on a worktree whose `.grove.toml` nobody on this machine has read quotes the command and asks, rather than reporting a dead end whose only way out was leaving for a terminal to type `grove open --trust` — from the one surface that could have shown the line and asked about it. What trust wants is that somebody read the exact text before it ran, and a prompt is that reading, so `y` records the same agreement `--trust` writes, over the same whole file, and `a`'s setup commands stop asking afterwards too. `grove open` itself still refuses, because in a pipe there is nobody to ask

## 0.4.1 — 2026-08-30

- `.grove.toml` is no longer the only file: `~/.config/grove/config.toml` once per machine and a gitignored `.grove.local.toml` beside the project's own now stack under and over it, so a repository you cannot commit to — `grove pr 42` on somebody else's project — still gets its `.env` and its install, and `open = "code ."` is a fact about you written once rather than into every project. `copy`, `link` and `run` collect what every layer named, in that order; `open` and each `env` name come from the nearest layer that says anything. What waits for `--trust` is now what came from a file git tracks, since a `git pull` handing you a command is the whole reason the gate is there — your own commands are not asked about
- `grove open [target]` runs `.grove.toml`'s `open` on any day, not only the one the worktree was made on. No target is the worktree you are standing in — found by which one contains the directory, not by an exact path — and `/open` in the app opens the row under the cursor
- `grove setup [target]`, or `--all`, runs `[setup]` again in the worktrees that already exist, so a `copy` line added in a pull request reaches the older ones instead of only what is made after it: `copy` takes the trunk's version, `link` leaves what is there, and the commands wait for the same `--trust`. It opens nothing, because `--all` over eleven worktrees would be eleven editor windows
- `grove exec -- <command>` runs one command in every worktree — the loop that otherwise gets written, mis-quoted, and written again next week. Every worktree gets its turn even when one fails, the run exits 11 if the command failed anywhere, and only the command's own stdout is on stdout, so `grove exec -- cat version.txt > all.txt` collects versions rather than a transcript
- `grove add feat/login-api --on feat/login` writes down what a branch was cut from, which git has nowhere to keep once the cut is made. `sync` then rebases the branch onto its parent and onto the trunk only through it, moves parents before their children, and brings a named branch's parents along with it. A record pointing at a branch that has gone is repaired rather than tolerated — by `remove --delete-branch`, `prune --delete-branch`, `rename`, and by a `sync` that meets it — and `list` shows where a row sits
- `grove completion <shell>` prints a tab-completion script for zsh, bash or fish, and `grove install` writes the line that loads it beside the one it already wrote, so `feat/login` is typed once instead of twice. The commands and flags come from the same table `--help` renders; the worktrees, and the branches that do not have one yet, are asked for at the moment TAB is pressed
- The app's key bar stops growing: `/` is the overflow. A key stays on the bar when it acts on the row under the cursor and is reached often enough to be muscle memory — `a`, `r`, `s`, `enter` — and `sync-all`, `review`, `log` and `refresh` moved behind `/`, where `open` and `setup` joined them. A worktree row's bar went from a hundred and eleven columns to seventy-one
- `x` discards the changes on the row under the cursor: `reset --hard` and `clean -fd` together, offered only where there is something to discard, and the question counts `3 changes and 1 untracked file` apart because one of those is work git has never seen a copy of
- Smaller: the pictures in the README draw their blocks and rules as geometry rather than as font glyphs, so the banner's tree stops arriving as three bars with daylight between them

## 0.4.0 — 2026-08-30

- `.grove.toml` takes an `open`: the editor, or whatever else you were going to start in the new worktree anyway. It was a `run` line before, and every part of that was wrong — `run` commands are awaited, so `grove add` stood behind an editor nobody had quit; they share a process group, so the next Ctrl-C closed it; and their output went to a pipe nothing read. `open` is watched just long enough to catch a line that falls over immediately, which is what a misspelled editor does, and then let go of — it outlives the terminal `grove` was typed into, and Ctrl-C aimed at the setup cannot reach it
- `open` can be written once per platform, since `open -a` is macOS only and `code` reaches a Linux PATH long before macOS installs the shim: `[setup.open]` takes `macos`, `linux` and `windows`, and a platform the table leaves out opens nothing and says so. A bare `open = "code ."` still covers all three
- It waits for the same `--trust` the `run` commands do, does not run when a `run` command failed, and is skipped where there is no terminal to open into — `grove add | tee`, or CI

## 0.3.8 — 2026-08-30

- `grove pr 42` gives a pull request a worktree of its own at `pr/42`, on a real local branch, so reviewing somebody's change becomes running it rather than reading it — and a plain `git push` from there goes back to the pull request's own branch, fork or not. `p` in the app picks from what is open, since the number is the one part you cannot supply without leaving to look it up
- `grove prune` clears away the worktrees that are finished with — the branch the trunk already has, or the one the remote no longer does — and reports rather than touches anything holding uncommitted work, stopped mid-rebase, locked, or containing the directory you are standing in. The list badges those rows `merged` and `gone`, so `r` clears the one under the cursor
- `grove rename feat/logn feat/login` moves the branch and its directory together, so the directory goes on being the branch's name, and clears up the folders the old name left empty behind it
- `grove add feat/login --take` carries the changes you should have branched first into the new worktree and leaves the one you were standing in clean. Nothing goes near `refs/stash`, which every worktree in a repository shares
- `.grove.toml` takes a `[teardown]` section: whatever `[setup]` started is stopped inside the worktree before `remove` deletes it. A command that fails there is reported loudly and the worktree still goes; `grove remove --no-teardown` skips the section outright
- `grove doctor` confirms the repository states that otherwise arrive as a bug report about somewhere else — a bare clone with no fetch refspec, an `origin/HEAD` that resolves to nothing, worktrees git still lists that are gone from disk — and prints the fix rather than applying it
- The name `a` asks for can be edited: `←`/`→` walk a caret through it, so a typo three characters back no longer costs every character after it, and a pasted branch name now arrives whole instead of submitting an empty prompt
- Ctrl-C stops the work and nothing else — the git child is killed, the command unwinds through its own cleanup, and a second Ctrl-C exits at once — so an interrupted `clone` no longer leaves a half-made `.bare` that every later command trips over, and a `[setup]` command's whole process tree goes with the screen instead of outliving it
- `sync` no longer says `rebased` when the push was refused, nor rebases onto a trunk whose fetch failed; `remove` refuses a worktree stopped part-way through a rebase, and `--force` does not override that, because half-applied commits are not what "discard my changes" means
- `.grove.toml`'s `copy` refuses a symlink pointing out of the worktree, including one buried inside a copied directory, so a committed `certs -> ~/.ssh` no longer hands over the real key
- Smaller: `prune --delete-branch` drops the `pr-<n>` remote along with the branch, a conflicted sync is coloured as one rather than as a success, a row's age is measured against the clock the columns were sized with, and a checkout with CRLF line endings no longer empties the banner's "What's new"

## 0.3.7 — 2026-08-29

- The app's keys are back to the three things worktree management is made of: `a` adds, `r` removes — one worktree or a folder's worth — and `s`/`S` sync, with `R` and `q` beside them. The filter prompt and the raw git behind its `!`, `p`'s pull request and `x`'s discard are gone; `grove reset`, `grove path`, `grove cd` and `git` itself still do all of it a command away
- The row under the cursor shows its uncommitted files beside the list — the paths alone, folded into the tree they sit in the same way the worktrees are, so "what have I got open over there" no longer needs a `git status` in another terminal. It takes only the width left past the last column, so a clean row costs the list nothing
- The last five commits of the row under the cursor are drawn under the list — sha, age and subject in columns, with git's own colours on the refs — so `↑2` reads as the two commits it stands for. `L` puts the panel away when the rows are wanted for the list instead
- `grove sync` gets past a force-pushed trunk: a commit the base has since withdrawn is dropped rather than replayed onto its own replacement, which used to hand you a conflict between a change and an edit of that same change that syncing again never cleared
- Adding a worktree puts a whole `cd` line on the clipboard, quoted if the path needs it, and `enter` copies the bare path of any row — a worktree or a folder — for an editor's "open folder" box
- A setup step that fails now says what the command said, instead of ending its warning with `undefined`

## 0.3.6 — 2026-08-29

- `.grove.toml`'s `copy` now takes the trunk's version over what the worktree already holds — a stale `.env` is refreshed instead of kept, directories merge with the trunk winning, and what only the worktree has stays
- Removing a dirty worktree asks about its uncommitted changes instead of refusing after the fact: the confirmation counts what `y` would discard, in red, and answering it removes the worktree, changes and all
- `y` copies the path under the cursor to the clipboard — a worktree or a folder, ready to paste into another tab

## 0.3.5 — 2026-08-29

- `.grove.toml`'s `copy` now fills in a directory the new worktree already has, so the ignored files inside a tracked folder — `config/local.json` and the like — arrive with it instead of being skipped as "already there"

## 0.3.4 — 2026-08-28

- `.grove.toml`'s `[setup]` takes an `env` key, so a setup command gets the credential or setting the shell grove was launched from does not have
- An error now shows what the failing thing said — the setup command's own output, the worktrees an ambiguous name matched — instead of only that it failed

## 0.3.3 — 2026-08-06

- `grove install` detects your shell and adds the `grove cd` / enter-to-go line to its rc file, so `shell-init` no longer has to be wired up by hand
- A fresh `grove`, opened without the shell function listening, now offers to install it on the spot — once, before the app opens

## 0.3.2 — 2026-08-06

- New worktrees copy their path to the clipboard, so opening one in another terminal tab is a paste away
- The tip line is colored so it reads against the default line, not the dim hint underneath it
- A new release is re-checked for within the hour instead of a full day, and the tip line now cycles through more advice

## 0.3.1 — 2026-08-06

- Adding a worktree runs its `.grove.toml` commands right away, instead of asking first
- Welcome banner: a quieter version number, brighter changelog bullets, and a tighter card

## 0.3.0 — 2026-08-06

- Each worktree row now shows when it was last touched — `5m ago`, `2d ago`, or a date
- `grove add` no longer takes `--dir`; a worktree's directory always matches its branch

## 0.2.1 — 2026-08-05

- Open with a startup tip pointing at `?` — filtering and raw git from one line

## 0.2.0 — 2026-08-05

- Renamed to grove: the binary, the Homebrew formula, and the repository

## 0.1.1 — 2026-08-05

- A release now bumps the Homebrew tap's formula by itself

## 0.1.0 — 2026-08-05

- First release: worktrees as a tree — add, remove, do PRs, discard from one screen
- Self-contained binaries for macOS and Linux, installed through the Homebrew tap
- `.garden.toml` fills a fresh worktree in and says what a new clone should run
