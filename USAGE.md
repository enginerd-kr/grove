# grove user guide

[English](USAGE.md) · [한국어](docs/md/USAGE.ko.md) · [Project overview](README.md)

grove gives each branch its own working folder so you can develop and review PRs
at the same time. Start with the **basic development workflow** below. Configure
project setup once and it runs when you create worktrees. Look up additional
options when you need them.

- [Basic development workflow](#basic-development-workflow)
- [What does sync do?](#what-does-sync-do)
- [Interactive screen](#interactive-screen)
- [Project setup](#project-setup)
- [Options for specific tasks](#options-for-specific-tasks)
- [Troubleshooting](#troubleshooting)
- [Command reference](#command-reference)
- [Scripting and agents](#scripting-and-agents)

## Basic development workflow

### 1. Install and clone

With Git installed, choose one way to install grove:

```bash
brew install enginerd-kr/tap/grove
# or install with npm (macOS and Linux; Node 18+)
npm install -g @enginerd-kr/grove
```

Replace the URL with your repository's URL.

```bash
grove clone https://github.com/org/repo.git
cd repo
```

This creates the default branch's worktree and applies project setup. When setup
commands appear for the first time, read them and press `y` to approve. To prepare
the environment later, leave them unapproved and run `grove setup main` when ready.

This guide uses a repository whose default branch is `main`. Substitute `master`
or your repository's actual name where needed. The word `trunk` in the docs and
command options means this default branch.

```text
repo/             # Workspace: manage your tasks here
  .bare/          # Shared Git repository
  .git            # File pointing to .bare
  main/           # Default branch worktree
```

`repo/` is the management folder. Enter a worktree inside it to edit code or make
Git commits. Unless a step says otherwise, the commands below run from `repo/`.

### 2. Start a new task

```bash
grove add feat/login
cd feat/login
```

This creates `repo/feat/login/` and applies setup. A new branch starts from the
latest fetched remote default branch. You do not need to commit on local `main`
or run `grove sync main` first.

If the branch already exists, grove checks it out. If it already has a worktree,
grove reports the existing path.

Edit, test, and commit in this folder as usual. Starting another task leaves this
worktree's changes in place.

### 3. Open a PR for your work

After committing your changes, run this inside `feat/login/`:

```bash
grove propose
```

This pushes the branch and opens a PR using its commits for the title and body.
It also pushes a new branch for the first time, so no separate first push is
needed. To write the title and body yourself, use `grove propose --web`.
PR features require the GitHub CLI, `gh`, installed and signed in. Sign in with
`gh auth login`.

After opening the PR, commit any changes so the worktree is clean, then run this
to incorporate updates from the remote and the default branch:

```bash
grove sync
```

On a development branch, `sync` rebases and pushes. See
[how sync works](#what-does-sync-do) for conflicts and first pushes.

### 4. Review someone else's PR

Return to the workspace and enter the PR number to review.

```bash
cd "$(grove path)"
grove pr 42
cd pr/42
```

Read code and run tests inside `pr/42/`. Your development work in `feat/login/`
stays in place. When the author adds commits, run this in the review folder:

```bash
grove sync
```

**In a PR review worktree, sync only receives the latest PR commits.** It does not
rebase or push. If local commits or changes prevent an update, it stops and
explains why. If the PR was force-pushed, see
[replacing a review worktree](#when-a-force-push-blocks-a-pr-update).

### 5. Clean up finished work

Return to the workspace and preview what can be removed.

```bash
cd "$(grove path)"
grove prune -n
```

After checking the candidates, remove them:

```bash
grove prune
```

By default, this removes worktrees whose branches have disappeared from the
remote or have been merged, and keeps the local branches. If a squash-merged PR
is missing from the candidates, see
[cleanup using GitHub's merge status](#when-squash-merged-work-is-missing-from-cleanup).

To remove just one worktree, such as the review folder, run `grove remove pr/42`.
Removal is refused by default if it has uncommitted changes. If the project has
teardown commands, they run before the directory is removed.

## What does sync do?

`sync` behaves according to the branch's purpose. Run `grove sync` inside a
worktree, or name the target from the workspace: `grove sync feat/login`.

| Target | Example | Behavior |
| --- | --- | --- |
| Development branch | `grove sync feat/login` | Fetch → rebase onto the tracked remote branch and the default branch → push |
| PR review worktree | `grove sync pr/42` | Update to the latest PR commits |
| Default branch | `grove sync main` | Fast-forward to incorporate remote changes |

Development branch sync in the CLI uses `--force-with-lease` when needed and
does not ask for confirmation. The interactive screen asks before a push that
rewrites remote history and before the first push.

| What you need | Command |
| --- | --- |
| Push a new branch before opening a PR | `grove sync feat/login --publish` |
| Keep the synced result local | `grove sync feat/login --no-push` |
| Sync all worktrees | `grove sync --all` |

If a development branch is not on a remote and you omit `--publish`, `sync`
rebases locally and reports exit code `4`. Use `propose` or `sync --publish` for
the first push. With `--no-push`, local sync completes even for an unpublished
branch.

Sync refuses worktrees with uncommitted changes. A conflicting rebase is aborted
by default; check the reported state and instructions. If local commits on the
default branch have diverged from the remote, sync stops without rebasing them.

## Interactive screen

You can also run `grove` in the workspace or a worktree to manage tasks with the
keyboard. Each row is a worktree. `*` marks the current worktree; `▸` marks the
selected row.

<p align="center">
  <img src="docs/screens/list.svg" alt="The grove screen showing worktrees, drift from remotes, and change status" width="100%">
</p>

Start with these keys:

| Key | Action |
| --- | --- |
| `↑` `↓` / `k` `j` | Select a worktree |
| `a` | Start a new task from the latest remote default branch |
| `enter` | Copy the selected worktree's path |
| `s` | Sync the selected worktree |
| `/` | Open the command menu |
| `q` / `esc` | Quit |

Press `a` and enter a branch name to apply setup and open the configured editor.
It also copies `cd <path>` to the clipboard for you to paste into a terminal.
When using `enter` to copy only the path, paste it after `cd`. grove does not
change the working directory of your shell directly.

Type in the `/` menu to search, then press `enter` to run a command.

| Menu command | Task |
| --- | --- |
| `/propose` | Open a PR for the selected development branch |
| `/review` | Choose an open PR and create a review worktree |
| `/open` | Open the selected worktree in the editor |
| `/setup` | Run setup again for the selected worktree |
| `/prune` | Clean up worktrees marked `merged` or `gone` |
| `/sync-all` | Sync all worktrees |
| `/rebase` | Rebase the selected worktree onto another base |
| `/upstream` | Set the original repository for a fork |
| `/refresh` | Refresh the list immediately |
| `/log` | Toggle the recent commits panel |

Additional keys: `A` branches from the selected local branch; `r` removes the
selected worktree. `x` discards uncommitted changes, including untracked files,
while keeping a recovery copy. Confirm removal or discarding with `y` in the
screen. Pressing `r` on a folder row targets all worktrees in that folder.
Use `←` `→` / `h` `l` to fold or open folders.

### Reading the list

| Column or marker | Meaning |
| --- | --- |
| `remote` | Commits ahead of and behind the tracked remote branch |
| `main` | Commits ahead of and behind the default branch's remote reference |
| `pr` | PR number, checks, and review status. Shown when GitHub and `gh` are available |
| `●` / `○` | Uncommitted changes / clean |
| `merged` / `gone` | Merged / the tracked remote branch has disappeared |
| `setup pending`, `setup failed`, `setup stale` | [Setup needs attention or another run](#setup-status-and-retries) |
| `review #42 → main` | The reviewed PR and its actual base branch. Following numbers show drift against that base |
| `on <branch>` or indentation below another worktree | Work stacked on another development branch |

Changed files for the selected worktree appear below the list. Selecting a
stacked branch also shows the relationships between branches.

The list refreshes automatically. Remote and PR updates run separately, so local
changes remain visible when the network is slow. The header reports the last
background fetch and any failure. `/refresh` rereads local worktrees immediately.

## Project setup

If the project already has `.grove.toml`, read and approve the commands it asks
to run. This section is for the person configuring the project's preparation
steps.

### Start with a minimal configuration

Create `main/.grove.toml` in the default branch's worktree. This example is for a
Bun project; use your project's install command, such as `pnpm install` or
`uv sync`, in `run`.

```toml
[setup]
run = ["bun install"]
```

Try applying it from the workspace:

```bash
grove setup main
```

Commit `.grove.toml` and merge it into the default branch so the project can
share it. It then applies to worktrees created by `clone`, `add`, and `pr`.

To copy `.env` too, add it as follows:

```toml
[setup]
copy = [".env"]
run = ["bun install"]
```

Prepare the actual source file at local `main/.env` and add it to `.gitignore`.
Keep secrets out of `.grove.toml`. `copy` reads from the local default branch's
worktree, so cloning alone will not provide someone else's `.env`.

Install dependencies separately in each worktree. Branches may have different
lockfiles; use your package manager's download cache instead of sharing
`node_modules`.

### Approving commands

New project commands are shown for approval. Press `y` in the terminal or the
interactive screen to save approval for this repository. The same content will
not prompt again. If the project configuration changes to content you have not
approved, grove asks again. `copy` and `link` apply before command approval.

If you deferred setup, run `grove setup feat/login` to try again. `--trust` skips
the approval question when you have already read the commands. In a pipe or with
`--json` or `--headless`, grove does not ask and skips unapproved commands.

### Setup status and retries

You do not need to recreate a worktree because installation failed. Fix the cause
of the failed command shown in the output, then apply setup to the existing
worktree again.

```bash
grove setup feat/login
# When all worktrees need setup again
grove setup --all
```

| State | Meaning and next step |
| --- | --- |
| `pending` | Setup was skipped, commands lack approval, or a copy source is missing. Read the report and run `grove setup <branch>` |
| `running` | Setup is in progress |
| `failed` | Setup failed. Fix the cause and run it again |
| `ready` | Setup completed. No separate badge appears in the list |
| `stale` | Configuration or a monitored dependency file changed after setup. Run setup again |

Change detection covers the applied configuration files and these files at the
root of the target worktree: `package.json`, `bun.lock`, `bun.lockb`,
`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `uv.lock`, `pyproject.toml`,
`Cargo.lock`, and `go.sum`. `ready` means setup completed; it does not guarantee
that the app runs or its tests pass. Missing copy sources are reported as
`missing` and leave setup `pending`.

On another run, `copy` overwrites existing files with the default branch's values
and `run` starts its commands from the beginning. Keep files with worktree-specific
values outside the copy list, and write install scripts that can run repeatedly.
`setup` does not reopen the editor. Use `grove open feat/login` for that.

### Additional configuration

| Setting | Purpose |
| --- | --- |
| `[setup] copy` | Copy files and directories from the default branch. Merge directories and overwrite matching files |
| `[setup] link` | Symlink to a path in the default branch. Keep entries already at the destination |
| `[setup] env` | Environment variables for setup commands |
| `[setup] run` | Shell commands run in order inside the new worktree, waiting for completion |
| `[setup] open` | Editor command, without waiting for it to exit |
| `[teardown] run` | Cleanup commands run before removing a worktree |
| `[teardown] env` | Environment variables for cleanup commands |

`copy` and `link` accept patterns such as `packages/*/.env` and `**/.env.local`,
matched against the default branch's worktree. Paths must be relative and stay
inside the worktree. Absolute paths, `..`, `.git`, and `.bare` are not allowed.
Unknown configuration keys produce an error.

### Personal settings and your editor

| Priority | File | Purpose |
| --- | --- | --- |
| 1 — defaults | `~/.config/grove/config.toml` | Your settings for all projects |
| 2 | `.grove.toml` | Shared project settings |
| 3 — overrides | `.grove.local.toml` | Your local settings for this project |

By default, both project files are read from `main/`. A branch with
`--config-source worktree` reads them from its own worktree. Add
`.grove.local.toml` to `.gitignore`.

When several files set the same key, the higher-priority file wins. Lists such as
`run`, `copy`, and `link` are replaced, not combined; `env` is overridden per
variable. For example, `run = []` under `[setup]` in `.grove.local.toml` disables
the project's setup commands. Global settings and local settings not tracked by
Git apply without separate approval.

Set your editor in `~/.config/grove/config.toml`:

```toml
[setup]
open = "code ."
```

Use `macos`, `linux`, and `windows` for platform-specific settings:

```toml
[setup.open]
macos = 'open -a "Visual Studio Code" .'
linux = "code ."

[setup.env]
API_HOST = "http://localhost:3000"
windows = { SHELL = "pwsh" }
```

`copy`, `link`, `run`, and `[teardown] run` also accept per-platform lists.
Values without a platform apply across platforms. A platform omitted from a
platform table receives no setting from that table.

## Options for specific tasks

### Move work to a new branch after starting it

Run this inside the worktree containing your changes:

```bash
grove add feat/search --take
```

It moves uncommitted changes into the new worktree and leaves the original clean.
To base a new branch on committed changes, use `--from` below.

### Continue work from another development branch

```bash
grove add feat/login-ui --from feat/login
```

This selects the starting point only. In the interactive screen, select
`feat/login` and press `A`. To also remember the dependency between the tasks,
use `--on`:

```bash
grove add feat/login-ui --on feat/login
grove stack feat/login-ui
grove propose feat/login-ui --stack
```

Branches created with `--on` sync onto their parent and use that parent as the
default PR base. `--stack` opens PRs starting with the parents. Do not combine
`--from` and `--on`.

### When a force-push blocks a PR update

```bash
grove pr 42 --replace
```

This saves the existing commits under a backup ref and uncommitted changes in a
snapshot, then replaces the checkout with the latest PR commits. Check the output
for the backup location and recovery commands. For ordinary PR updates,
`grove sync pr/42` is enough.

### Send your own changes to a PR you are reviewing

After committing your changes in the review worktree, run this to rebase onto the
PR's actual base and push to the author's branch. You need push permission on
that branch.

```bash
grove sync pr/42 --contribute
```

If your commits are already where you want them and need no rebase, you can also
run `git push` directly in the review folder.

### Test setup changes made on a branch

The default configuration is local `main/.grove.toml`. To try configuration
changes in a PR or development branch, select the target worktree's files:

```bash
grove pr 42 --config-source worktree
# Also works for an existing worktree
grove setup feat/login --config-source worktree
```

This option is available on `add`, `pr`, and `setup`. The choice is saved for the
branch and applies to later setup, editor opening, and teardown. `copy` and
`link` still take their source files from local `main/`. To restore the default:

```bash
grove setup feat/login --config-source trunk
```

### Run servers in several worktrees

Setup, teardown, and editor commands run by grove, as well as `exec`, receive
worktree-specific environment variables. Use them in project scripts as needed.

| Variable | Value |
| --- | --- |
| `GROVE_ROOT` | Workspace path |
| `GROVE_WORKTREE` | Path of the worktree running the command |
| `GROVE_BRANCH` | Branch name |
| `GROVE_WORKTREE_ID` | Worktree identifier, preserved across renames |
| `GROVE_PORT` | Port number distinct within this workspace |
| `GROVE_SERVICE_NAME` | Worktree-specific service name |
| `GROVE_DATABASE_NAME` | Worktree-specific database name |

`PORT` and `COMPOSE_PROJECT_NAME` default to the assigned port and service name.
Explicit values in setup or teardown `env` override these defaults. For example,
setting `PORT = 3000` in shared configuration gives all worktrees the same port.

These variables are not automatically injected into commands you run directly
in an ordinary terminal. To inspect the assigned values, run the following.
`exec` visits every worktree in order.

```bash
grove exec -- sh -c 'echo "$GROVE_BRANCH: PORT=$PORT DB=$GROVE_DATABASE_NAME"'
```

Your app or startup script must read these values. grove does not create databases
or reserve ports with the operating system. Handle conflicts with other
repositories or apps in your project.

### When squash-merged work is missing from cleanup

Include GitHub's PR merge status when checking candidates. This requires `gh`.

```bash
grove prune -n --forge-merged
# Remove the candidates after reviewing them
grove prune --forge-merged
```

GitHub's merge status is used only when the merged PR's final commit exactly
matches the local branch's final commit. Worktrees with additional local commits
or uncommitted changes are kept. The screen's `/prune` does not make this extra
query.

### Contribute from a fork

```bash
grove clone git@github.com:you/repo.git --upstream git@github.com:them/repo.git
```

New tasks and sync use the original repository's default branch, while development
branches push to your fork. If you already cloned, use
`grove upstream <original-repository-URL>` or `/upstream` in the screen. PR review
worktrees push to the PR's source branch.

The default branch is identified through `origin/HEAD`; its local branch's
tracked remote supplies the reference. Setting `upstream` adds the original
remote, makes the default branch track it, and sets `remote.pushDefault` to
`origin`. A development branch's push destination follows Git settings in this
order: `branch.<name>.pushRemote`, `remote.pushDefault`, the tracked remote,
then `origin`.

### Use an existing Git clone or start from the screen

You can run `grove` inside a repository created with ordinary `git clone`.
New worktrees then appear beside the repository with names such as
`myapp-feat-login`. Use `grove path feat/login` to get the path.

Running `grove` in an empty folder asks for a URL and makes that folder the
workspace. In a non-empty folder it clones into a subfolder. When several
repositories are available, a selection screen appears. In the CLI, enter the
repository or use `-C <path>` to select it.

## Troubleshooting

| Situation | Next step |
| --- | --- |
| A worktree exists but installation did not run | Run `grove setup <branch>` and approve commands or inspect the failure |
| `.env` is reported missing | Prepare the source file in the default branch's worktree, then rerun setup |
| Changes to a branch's `.grove.toml` are not applied | Use `grove setup <branch> --config-source worktree` |
| `setup stale` appears | Configuration or dependency files changed. Run `grove setup <branch>` |
| Development branch sync exits with code `4` | Read the error. If it says the branch has no remote yet, use `--publish` |
| Sync is refused after a PR force-push | See [replacing a review worktree](#when-a-force-push-blocks-a-pr-update) |
| Default branch sync is refused | Check for diverged local and remote commits, resolve with Git, then retry |
| PR creation or review fails | Check `gh` installation and `gh auth login` |
| Usage text appears instead of the screen | Run in an interactive terminal without `--headless` |
| `exec` options are interpreted as grove options | Add `--` before the command to run |

If folders and Git's records seem out of step, run:

```bash
grove doctor
```

It reports problems and repair commands without changing the repository. Checks
include a missing default branch worktree, fetch and upstream settings,
worktrees missing from disk, incorrect `.git` paths, and broken symlinks. For a
locked worktree whose folder was deleted, it also reports the unlock command
needed before cleanup. It exits with `6` for problems or `0` for warnings only.

## Command reference

Use `grove <command> --help` for all options. `<target>` below means a branch
name, directory name, or path. `-C <path>` selects the repository to operate on.

### Create and navigate

| Command | Purpose and additional options |
| --- | --- |
| `grove clone <url> [dir]` | Create a workspace. `init` is an alias. `-b <branch>` also checks out that branch beside the default branch |
| `grove add <branch>` | Create a worktree. `--push` publishes it; `--no-fetch` skips fetching |
| `grove pr <number or URL or branch>` | Create or update a PR review worktree. `--replace` saves existing work before replacing it |
| `grove list` | Print the worktree list |
| `grove path [target]` | Print the worktree's absolute path, or the workspace root without a target |
| `grove open [target]` | Open in the configured editor |
| `grove rename <target> <name>` | Rename the branch and directory. `--push` pushes the new name and keeps the old remote branch |

Use `--no-setup` with `clone`, `add`, or `pr` to defer setup. See
[options for specific tasks](#options-for-specific-tasks) for examples of
`--from`, `--on`, `--take`, and PR replacement.

### Prepare and sync

| Command | Purpose and additional options |
| --- | --- |
| `grove setup [target]` | Run setup again. `--all` selects all worktrees |
| `grove sync [target]` | Sync according to the branch's purpose. `--all` selects all worktrees |
| `grove rebase [target]` | Rebase onto a base you choose, without pushing |
| `grove exec -- <command>` | Run a command in every worktree in order. `--fail-fast` stops at the first failure |
| `grove upstream <url>` | Set the original repository for a fork. Use `--force` to replace an existing URL |

`setup`, `sync`, `rebase`, `open`, and `propose` use the current worktree when no
target is given. At the workspace root, name a target.

Choose a `rebase` base with one of `--trunk` (the remote reference followed by the
default branch), `--upstream` (the target branch's tracked remote branch), or
`--onto <ref>`. For example, `--onto main` means local main. Without a base option,
the terminal shows a list to choose from; non-interactive execution exits with
code `2`.

`rebase` saves uncommitted changes temporarily and reapplies them to the result.
On conflicts, it restores the original state by default. `--no-stash` refuses a
worktree with changes, and `--no-abort` leaves conflicts in place. Follow the
printed recovery instructions. `sync` also has `--no-abort`, but does not carry
uncommitted changes through a rebase.

For shell syntax in `exec`, use `sh -c`:

```bash
grove exec -- git status --short
grove exec -- sh -c 'echo "$GROVE_BRANCH"'
```

### Open PRs and inspect stacks

| Command or option | Purpose |
| --- | --- |
| `grove propose [target]` | Push a branch and open a PR |
| `--draft` | Open a draft PR |
| `--web` | Write the title and body in the browser |
| `--title <text> --body <text>` | Supply a title and body. `--body` requires `--title` |
| `--base <branch>` | Choose the PR's base branch |
| `--stack` | Open PRs in order, starting with the target branch's parents |
| `grove stack [target]` | Show the branch's stack and drift against parents. `--all` shows all stacks |

`propose` targets the default branch unless the task was created with `add --on`,
in which case it targets the parent. If a PR already exists, it reports that PR
without pushing. Sync first if the branch is behind the remote. Do not combine
`--stack` with `--base`, `--title`, `--body`, or `--web`.

### Clean up and recover

| Command or option | Purpose |
| --- | --- |
| `grove remove <target>` | Remove a worktree. `rm` is an alias |
| `grove prune` | Remove finished worktrees |
| `prune -n` / `prune --dry-run` | Print candidates without removing them |
| `prune --gone` / `prune --merged` | Select only branches gone from the remote / confirmed merged by Git |
| `prune --forge-merged` | Also query GitHub's PR merge status |
| `prune --closed` | Also query PRs closed without merging. Add a candidate when the PR's final commit matches the local one |
| `remove --delete-branch` / `prune --delete-branch` | Delete local branches along with the worktrees |
| `remove --no-teardown` | Skip cleanup commands |
| `grove reset <target>` | Save a copy of uncommitted changes, then discard them |
| `grove doctor` | Diagnose repository state and print repair commands |

`prune` skips dirty, rebasing, locked, and current worktrees. Use `--no-fetch` to
skip fetching before cleanup. `remove` refuses unsafe removal by default.
`--force` relaxes some protections, but cannot remove a worktree during a rebase.

`reset` discards changes to tracked files by default. `--clean` includes untracked
files; `--to <ref>` resets to a different commit. The output gives a recovery
commit you can restore with `git stash apply <sha>`. The screen's `x` corresponds
to `reset --clean`. The latest copy for each branch survives Git cleanup; older
copies are not guaranteed to remain available indefinitely.

## Scripting and agents

- `--json` prints one JSON document to stdout. Human-readable output goes to stderr.
- `--headless` (or a non-TTY environment) disables the screen. Commands do not ask
  questions; they run or report failure with an exit code.
- `--verbose` logs Git commands with their exit codes and elapsed time.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | grove bug |
| 2 | Usage error |
| 3 | Not a repository |
| 4 | Refused |
| 5 | Rebase conflict |
| 6 | State conflict, including problems found by `doctor` |
| 7 | Git command failed |
| 8 | Remote error |
| 9 | Setup command failed; the worktree exists |
| 10 | `gh` is missing or failed |
| 11 | `exec` failed in one or more worktrees |
| 130 | Ctrl-C |

### Reading `--json` output

Output is a command-specific result object or array. Common fields are listed
below. Use the exit code to determine success: a nonzero code means failure,
regardless of messages printed to stderr.

| Command | Useful fields |
| --- | --- |
| `add` | `path`, `dir`, `branch`, `source` (`existing`/`remote`/`new`), `alreadyPresent`, `base`, `baseSha`, `setup` |
| `add` setup | `copied`, `linked`, `ran`, `missing`, `untrusted`, `failed` |
| `list` | One entry per worktree: `dir`, `branch`, `dirty`, `ahead`, `behind`, `finished`, `setupStale`, `setupState`, `review` |
| `propose` | `url`, `number`, `base`, `created` (false if it already existed), `pushed`; with `--stack`, an array in parent-first order |
| `stack` | `trunk` and ordered `rows[]`: `branch`, `parent`, `depth`, `dir` (absent without a worktree), `ahead`/`behind` against the parent, `exists`, `current` |
| `reset` | `saved`: snapshot SHA for `git stash apply` |
| `sync` | Per-target results. Exit code `4` can mean a first push was not requested or sync was refused because of changes or another condition; read the error too |
| `prune -n` | `entries[]`, each with `dir`, `reason`, and `skipped` when kept |

`setup.untrusted: true` means `.grove.toml` commands were shown but not run because
that version has not been approved on this machine. `setup.failed` is set when
a command exits nonzero. The worktree exists in either case. Skipping unapproved
commands alone does not cause a failure exit code, so check `setup.untrusted` too.
Setup command failures in `clone`, `add`, `pr`, and `setup` produce exit code `9`.

### Approval is a user's decision

Before automating, have the user read and approve the project commands. Answer
`y` in the screen or run `grove setup main --trust` after reading them. Approved
configuration with the same content also applies when an agent creates a
worktree. Your task instructions can prohibit an agent from adding `--trust`
on its own to run unapproved commands.

A typical agent loop after approval:

```bash
grove add agents/refactor --json         # Create; read `path` from stdout
# ... work inside the worktree ...
grove sync agents/refactor --publish     # Includes the first push
# Once the work is finished and cleanup is agreed
grove remove agents/refactor --delete-branch
```

An example policy to paste into `AGENTS.md` or `CLAUDE.md`:

```markdown
## Worktrees

- Inspect `grove list --json`. Do not guess paths from branch names.
- Create a worktree for each task with `grove add agents/<task> --json` and work
  only inside the returned `path`.
- Treat a nonzero exit code as failure. Do not infer success from log messages.
- Report `setup.untrusted` in the result. Never add `--trust`; approval of setup
  files is the user's decision.
- Do not run `grove remove`, `grove prune`, `--delete-branch`, `--force`, or
  `grove reset` unless the user requested that cleanup.
```
