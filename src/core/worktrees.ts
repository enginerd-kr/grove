import { join, relative, resolve, sep } from "node:path";
import { GroveError } from "./errors.ts";
import { pathExists } from "./fs.ts";
import { gitOutput, runGit } from "./git.ts";

/**
 * Reading the repository's worktrees, and working out which one a user meant.
 *
 * Both halves parse git's porcelain formats rather than guessing from names.
 * That matters most for the second: the branch-to-directory mapping is lossy,
 * so it is never inverted — the answer is looked up instead.
 */

export type WorktreeRecord = {
  readonly path: string;
  readonly head?: string;
  /** Short branch name. Absent when detached, or for the bare entry. */
  readonly branch?: string;
  readonly detached: boolean;
  /** The bare repository's own entry, which is not a worktree anyone visits. */
  readonly bare: boolean;
  /** Present when locked; the string is the reason, which may be empty. */
  readonly locked?: string;
  readonly prunable?: string;
  /** A rebase is stopped part-way here. Only ever set by `listWorktrees`. */
  readonly rebasing?: boolean;
};

/**
 * Parses `git worktree list --porcelain`.
 *
 * Records are separated by blank lines and every attribute is `key value` or a
 * bare `key`. Paths are printed raw, so a path containing spaces is handled by
 * splitting only on the first space — never by tokenising the line.
 */
export function parseWorktreeList(porcelain: string): readonly WorktreeRecord[] {
  const records: WorktreeRecord[] = [];

  for (const block of porcelain.split(/\n\s*\n/)) {
    const attrs = new Map<string, string>();

    for (const line of block.split("\n")) {
      if (line.length === 0) continue;

      const space = line.indexOf(" ");
      attrs.set(
        space === -1 ? line : line.slice(0, space),
        space === -1 ? "" : line.slice(space + 1),
      );
    }

    const path = attrs.get("worktree");
    if (path === undefined) continue;

    records.push({
      path,
      head: attrs.get("HEAD"),
      branch: attrs.get("branch")?.replace(/^refs\/heads\//, ""),
      detached: attrs.has("detached"),
      bare: attrs.has("bare"),
      // Both can appear with or without a reason, so the empty string is a
      // meaningful value here and `undefined` is what means "not locked".
      locked: attrs.get("locked"),
      prunable: attrs.get("prunable"),
    });
  }

  return records;
}

export type WorktreeStatus = {
  readonly dirty: boolean;
  /** A few changed paths, for telling the user what is in the way. */
  readonly changed: readonly string[];
  /**
   * The subset of `changed` that git is not tracking.
   *
   * Kept apart because `reset --hard` does not touch these: a worktree can come
   * out of a reset still dirty, and saying which files those are beats leaving
   * someone to wonder why the dot stayed filled.
   */
  readonly untracked: readonly string[];
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
};

/** The remainder of `line` after its `n`th space — how porcelain v2 delimits paths. */
function afterSpaces(line: string, n: number): string {
  let index = -1;

  for (let i = 0; i < n; i += 1) {
    index = line.indexOf(" ", index + 1);
    if (index === -1) return "";
  }

  return line.slice(index + 1);
}

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 * One call answers both questions worth asking — is it dirty, and how far has
 * it drifted — which is why `list` does not run `status` twice per worktree.
 *
 * The `-z` form is not a convenience: without it git quotes paths containing
 * spaces or non-ASCII, and the changed-file list reported back to the user would
 * be quoted nonsense. It does mean the field count per entry type has to be
 * respected exactly, since a path may itself contain spaces.
 */
export function parseStatus(output: string): WorktreeStatus {
  const fields = output.split("\0").filter((field) => field.length > 0);
  const changed: string[] = [];
  const untracked: string[] = [];
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === undefined) continue;

    if (field.startsWith("# branch.upstream ")) {
      upstream = field.slice("# branch.upstream ".length);
      continue;
    }
    if (field.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(field);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (field.startsWith("#")) continue;

    // Field counts come straight from the porcelain v2 spec; the path is
    // whatever follows, spaces and all.
    if (field.startsWith("1 ")) changed.push(afterSpaces(field, 8));
    else if (field.startsWith("2 ")) {
      changed.push(afterSpaces(field, 9));
      // A rename spends a second field on the original path. Skipping it is what
      // stops that path being read as another entry.
      i += 1;
    } else if (field.startsWith("u ")) changed.push(afterSpaces(field, 10));
    else if (field.startsWith("? ") || field.startsWith("! ")) {
      changed.push(field.slice(2));
      untracked.push(field.slice(2));
    }
  }

  return { dirty: changed.length > 0, changed, untracked, upstream, ahead, behind };
}

/**
 * A rebase stopped part-way, and the branch it was moving.
 *
 * git reports a mid-rebase worktree as detached, because HEAD genuinely is. That
 * is true and useless: the user still calls it `feat/login`, and without this
 * `grove sync feat/login` would answer "no worktree matches feat/login" at exactly
 * the moment they most need the tool to know where they are. The branch name is
 * kept in the rebase state directory, so it is read back from there.
 */
async function rebaseState(path: string): Promise<{ branch?: string } | undefined> {
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    const located = await runGit(["rev-parse", "--path-format=absolute", "--git-path", marker], {
      cwd: path,
    });
    if (located.code !== 0) continue;

    const dir = located.stdout.trim();
    if (!(await pathExists(dir))) continue;

    const headName = Bun.file(join(dir, "head-name"));
    const branch = (await headName.exists())
      ? (await headName.text()).trim().replace(/^refs\/heads\//, "")
      : undefined;

    return { branch };
  }

  return undefined;
}

/**
 * Every worktree the repository has, without the bare entry nobody visits.
 *
 * Detached records are checked for an interrupted rebase, so callers see the
 * branch the user is thinking of rather than the truthful but unhelpful
 * "detached".
 */
export async function listWorktrees(bare: string): Promise<readonly WorktreeRecord[]> {
  const output = await gitOutput(["worktree", "list", "--porcelain"], { cwd: bare });
  const records = parseWorktreeList(output).filter((record) => !record.bare);

  return Promise.all(
    records.map(async (record) => {
      if (!record.detached) return record;

      const rebase = await rebaseState(record.path);
      if (!rebase) return record;

      return { ...record, branch: rebase.branch ?? record.branch, rebasing: true };
    }),
  );
}

export async function statusOf(path: string): Promise<WorktreeStatus> {
  const result = await runGit(["status", "--porcelain=v2", "--branch", "-z"], { cwd: path });

  // A worktree whose directory was deleted behind git's back still appears in
  // the list; reporting it as clean-and-unknown beats failing the whole command.
  if (result.code !== 0) return { dirty: false, changed: [], untracked: [], ahead: 0, behind: 0 };

  return parseStatus(result.stdout);
}

/**
 * A worktree's directory relative to the repo root, always with `/` separators.
 *
 * `"."` for the root itself — a plain repository's main checkout, which `relative`
 * would otherwise answer with the empty string. A hand-made sibling worktree
 * (outside the root, which only a plain repository has) comes back as `../name`,
 * honest about where it actually lives.
 */
export function worktreeDir(root: string, path: string): string {
  const rel = relative(root, path).split(sep).join("/");

  return rel.length === 0 ? "." : rel;
}

/**
 * Finds the worktree a user means by `target`.
 *
 * The branch-to-directory mapping is never inverted. It is lossy — a branch
 * whose name needed sanitising cannot be reconstructed from the result — and a
 * worktree made by hand can sit anywhere, so the answer is looked up in what
 * git reports rather than recomputed.
 *
 * Order matters. Branch first, because that is what people say out loud; then
 * the directory, which for a nested layout is the whole relative path (`feat`
 * alone is a folder, not a worktree); then a path, for tab completion.
 */
export function resolveTarget(
  target: string,
  worktrees: readonly WorktreeRecord[],
  { root, cwd }: { readonly root: string; readonly cwd: string },
): WorktreeRecord {
  const byBranch = worktrees.filter((record) => record.branch === target);
  if (byBranch.length === 1 && byBranch[0]) return byBranch[0];

  const wantedDir = target.split(sep).join("/").replace(/\/+$/, "");
  const byDir = worktrees.filter((record) => worktreeDir(root, record.path) === wantedDir);
  if (byDir.length === 1 && byDir[0]) return byDir[0];

  const wanted = resolve(cwd, target);
  const byPath = worktrees.filter((record) => record.path === wanted);
  if (byPath.length === 1 && byPath[0]) return byPath[0];

  const ambiguous = [...byBranch, ...byDir, ...byPath];
  if (ambiguous.length > 1) {
    throw new GroveError("usage", `${JSON.stringify(target)} matches more than one worktree`, {
      hint: "pass the directory path or the full path",
      details: ambiguous.map((record) => record.path),
    });
  }

  throw new GroveError("not-a-repo", `no worktree matches ${JSON.stringify(target)}`, {
    hint: "run `grove list` to see what is there",
    details: worktrees.map(
      (record) => `${record.branch ?? "(detached)"}  ${worktreeDir(root, record.path)}`,
    ),
  });
}
