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
  main/           worktree for the default branch
  feat-login/     worktree for feat/login
```

Everything for one repository lives in one folder, and every command works out which folder
it means from the directory you ran it in.

## Commands

```bash
wt clone <url> [dir]     # bare-clone a repo and check out its default branch
wt add <branch>          # give a branch a worktree (tracking or creating it)
wt list                  # what is here, what state it is in, where you are
wt remove <target>       # delete a worktree
wt sync [target]         # fetch, then bring worktrees up to date
```

`wt <command> --help` lists a command's own options. A worked example:

```bash
cd ~/work
wt clone https://github.com/org/repo.git
cd repo/main

wt add feat/login        # tracks origin/feat/login
wt add feat/new-thing    # branches off origin/main
wt list
#  * main             main             clean
#    feat/login       feat-login       2 ahead
#    feat/new-thing   feat-new-thing   dirty

wt sync --all            # fast-forward main, rebase the rest onto it
wt rm feat/login         # or `wt rm feat-login` — both work
```

### Naming

`feat/login` becomes the directory `feat-login`. The mapping is one-way and never inverted:
it is lossy (`feat/login` and `feat-login` both slug to `feat-login`) and `--dir` makes it
arbitrary anyway. `remove` and `sync` instead look the target up in `git worktree list`, so a
branch name, a directory name, or a path all work.

### Sync

`sync` fetches, then **fast-forwards** the default branch's worktree and **rebases** every
other one onto it. The asymmetry is deliberate: rebasing `main` onto `origin/main` would
rewrite local commits nobody asked to have rewritten, so a diverged default branch is refused
instead.

Every check runs before anything is executed. A dirty worktree is skipped without being
touched, and a rebase that conflicts is rolled back by default — pass `--no-abort` to leave it
in place and resolve it by hand.

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

On a terminal, progress is drawn with Ink — a spinner, and a percentage bar during a clone.
Under a pipe, in CI, with `--json`, or with `NO_COLOR` set, it degrades to plain lines.

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
    git.ts             the only place that spawns a process
    errors.ts          WtError, and classifying git's stderr
    layout.ts          pure path and naming rules
    discover.ts        which repository a command means
    worktrees.ts       porcelain parsers, and resolving a target
    branches.ts        ref questions asked of the bare repo
    commands/          clone, add, list, remove, sync
  report/
    reporter.ts        the Reporter interface, and the plain implementation
    ink-reporter.tsx   the terminal one — see src/ui/README.md
  ui/                  the components it draws with
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
