import { realpath } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { GroveError } from "./errors.ts";
import { childDirectories, pathExists } from "./fs.ts";
import { runGit } from "./git.ts";
import { BARE_DIR, plainRepoPaths, type RepoKind, type RepoPaths, repoPaths } from "./layout.ts";

/**
 * Working out which repository a command means.
 *
 * Every command is relative to where it was invoked, so this runs first and
 * almost always. The rules are ordered and the first match wins; the ordering
 * is the design, because guessing wrong here deletes the wrong worktree.
 */

/** `<root>/.bare/HEAD` — the marker that a directory is one of ours. */
function bareMarker(root: string): string {
  return join(root, BARE_DIR, "HEAD");
}

/**
 * Resolves symlinks so every rule below answers in the same terms.
 *
 * git always reports resolved paths. If the starting point were not resolved
 * too, rule 2 and rule 3 could return the same repository under two spellings,
 * and the "are you standing in the worktree you asked me to delete?" check
 * would compare a prefix that never matches.
 */
async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Not there yet — the caller's error is more useful than one from here.
    return path;
  }
}

type GitFound = { readonly kind: RepoKind; readonly root: string };

/**
 * Rule 2: ask git.
 *
 * Covers being anywhere inside a worktree, at any depth, and the repo root
 * itself — the `.git` file there makes git resolve the same common dir. The
 * basename says which layout it is: `.bare` is one this tool laid out itself,
 * `.git` is an ordinary clone or checkout standing on its own. Anything else —
 * a bare repo named `foo.git`, a submodule's `.git/modules/<name>`, a
 * `--separate-git-dir` — is a shape this rule declines to guess a root from.
 */
async function fromGit(cwd: string): Promise<GitFound | undefined> {
  const result = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (result.code !== 0) return undefined;

  const commonDir = result.stdout.trim();
  if (commonDir.length === 0) return undefined;

  const base = basename(commonDir);
  if (base === BARE_DIR) return { kind: "managed", root: dirname(commonDir) };
  if (base === ".git") return { kind: "plain", root: dirname(commonDir) };

  return undefined;
}

/** Rule 3: walk up looking for the marker, for when git cannot help. */
async function fromAncestors(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);
  const { root } = parse(current);

  for (;;) {
    if (await pathExists(bareMarker(current))) return current;
    if (current === root) return undefined;

    current = dirname(current);
  }
}

/**
 * Rule 4: exactly one managed repository directly below.
 *
 * This is the `~/work` case — you are standing next to the repo rather than in
 * it. Ambiguity is an error rather than a guess: with two repositories below,
 * picking one would run a destructive command against a repository the user
 * never named.
 */
async function fromChildren(cwd: string): Promise<string | undefined> {
  const matches: string[] = [];

  for (const name of await childDirectories(cwd)) {
    const candidate = join(cwd, name);
    if (await pathExists(bareMarker(candidate))) matches.push(candidate);
  }

  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return only;

  if (matches.length > 1) {
    throw new GroveError("usage", `${matches.length} repositories here; say which one`, {
      hint: "pass -C <dir>, or run the command from inside the repository",
      details: matches.map((path) => basename(path)),
    });
  }

  return undefined;
}

/**
 * Finds the repository a command should act on.
 *
 * `explicit` is `-C/--repo`. It does not bypass the rules, it relocates them:
 * pointing at the repo folder, at a worktree inside it, or at the parent all
 * work, which matches what someone typing a path actually expects.
 *
 * A plain repository is recognised last, and only from rule 2 — never rules 3
 * or 4, which stay `.bare`-marker-only. That preserves every existing answer
 * bit-for-bit (a managed repository found by walking up or scanning children
 * always wins) and means standing *beside* an ordinary clone still does not
 * adopt it; only standing *inside* one does.
 */
export async function findRepoRoot(cwd: string, explicit?: string): Promise<RepoPaths> {
  const from = await canonicalize(explicit === undefined ? resolve(cwd) : resolve(cwd, explicit));

  const viaGit = await fromGit(from);
  const managedRoot =
    (viaGit?.kind === "managed" ? viaGit.root : undefined) ??
    (await fromAncestors(from)) ??
    (await fromChildren(from));

  if (managedRoot !== undefined) return repoPaths(managedRoot);
  if (viaGit?.kind === "plain") return plainRepoPaths(viaGit.root);

  throw new GroveError("not-a-repo", `no worktree repository found from ${from}`, {
    hint: `run \`grove clone <url>\` to create one, or -C <dir> to point at an existing one`,
  });
}
