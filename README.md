# typescript-test

TypeScript project running on [Bun](https://bun.sh) — runtime, bundler, package manager, and test runner in one — with [Biome](https://biomejs.dev) for linting and formatting.

To install dependencies:

```bash
bun install
```

## Scripts

| Command             | Description                                    |
| ------------------- | ---------------------------------------------- |
| `bun dev`           | Run `src/index.ts` with hot reload (`--watch`) |
| `bun start`         | Run `src/index.ts` once                        |
| `bun run build`     | Bundle to `dist/` (minified + sourcemap)       |
| `bun run typecheck` | Type check with `tsc --noEmit`                 |
| `bun test`          | Run `*.test.ts` via `bun:test`                 |
| `bun run lint`      | Lint + format check (Biome), no writes         |
| `bun run lint:fix`  | Auto-fix lint, format, and import order        |
| `bun run format`    | Format only                                    |
| `bun run ci`        | `biome ci` + typecheck + tests (CI gate)       |

GitHub Actions runs the same checks on every pull request (`.github/workflows/ci.yml`).

## Pre-commit hook

`.githooks/pre-commit` runs Biome on staged files, applies safe fixes, and re-stages them.
An unfixable lint error aborts the commit.

It is wired up by the `prepare` script, which `bun install` runs automatically:

```bash
git config core.hooksPath .githooks   # what "prepare" does
git config core.hooksPath             # verify -> .githooks
```

Fresh clones need nothing beyond `bun install`. Use `git commit --no-verify` to bypass.

## Pre-push hook

`.githooks/pre-push` refuses a direct push to `main` — changes go through a pull request,
which CI checks. Same activation as above, and `git push --no-verify` bypasses it.

Note: if a file has both staged and unstaged changes, Biome rewrites the working-tree copy
and the hook stages those unstaged changes too. Stage the whole file to avoid surprises.

## Structure

```
src/
  index.ts       entry point
  greet.ts       example module
  greet.test.ts  example test
```

## Notes

- Bun strips TypeScript types at runtime, so there is no separate compile step.
  Type errors surface via `bun run typecheck`, not at run time.
- `build` uses `--target bun`. Use `--target node` for Node.js, `--target browser` for the web.
- Biome replaces ESLint + Prettier + `eslint-plugin-import`. Config lives in `biome.json`;
  style is 2-space indent, double quotes, semicolons, trailing commas, 100-col lines.
- Install the `biomejs.biome` editor extension for format-and-fix on save
  (already wired up in `.vscode/settings.json`).
