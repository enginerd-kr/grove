# grove

Git worktrees let one repository have many working directories. grove turns
that into a managed workspace: one bare clone stores the repository once, and
every branch gets its own predictable directory, with a terminal UI over them.

## Install

```bash
npm install -g @enginerd-kr/grove
grove
```

Or run it without installing:

```bash
npx @enginerd-kr/grove
```

Homebrew works too: `brew install enginerd-kr/tap/grove`.

## Quick start

```bash
grove clone https://github.com/org/repo.git
cd repo

grove add feat/login
grove add fix/prod-crash
grove
```

The full guide — every command, `.grove.toml`, stacked pull requests,
scripting and coding-agent sandboxes — is in the repository:

- README: https://github.com/enginerd-kr/grove#readme
- Usage: https://github.com/enginerd-kr/grove/blob/main/USAGE.md
- Changelog: https://github.com/enginerd-kr/grove/blob/main/CHANGELOG.md

## How the package is put together

grove is a compiled binary, not JavaScript. This package holds a small Node
launcher; the binary itself is in one of four platform packages that this one
lists as optional dependencies, and npm installs the one whose `os`/`cpu` match
your machine:

| package | platform |
| --- | --- |
| `@enginerd-kr/grove-darwin-arm64` | macOS, Apple silicon |
| `@enginerd-kr/grove-darwin-x64` | macOS, Intel |
| `@enginerd-kr/grove-linux-x64` | Linux, x86-64 (glibc) |
| `@enginerd-kr/grove-linux-arm64` | Linux, arm64 (glibc) |

There is no install script. If `grove` reports that its binary package is
missing, the install skipped optional dependencies (`--omit=optional`) or used
a lockfile written on another platform; `npm install -g @enginerd-kr/grove
--force` puts it back.

Known limits:

- No Windows build. WSL works.
- The Linux binaries link against glibc; Alpine and other musl systems are not
  supported yet.
- The launcher is a Node script. On a machine with Bun but no Node, run
  `bunx --bun @enginerd-kr/grove`.

## License

MIT
