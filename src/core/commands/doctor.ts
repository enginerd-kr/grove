import { lstat, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { version } from "../../../package.json";
import { HOOKS_FILE, type Hooks, repoHooks } from "../../hooks/index.ts";
import { FETCH_REFSPEC, REMOTE, trunkOf } from "../branches.ts";
import { GroveError } from "../errors.ts";
import { childDirectories, pathExists } from "../fs.ts";
import { gitSucceeds, runGit } from "../git.ts";
import { BARE_DIR, type RepoKind, type RepoPaths } from "../layout.ts";
import { plural } from "../text.ts";
import { listWorktrees, type WorktreeRecord, worktreeDir } from "../worktrees.ts";

/**
 * `grove doctor` — the questions a maintainer would ask first, asked by the tool.
 *
 * Every check here exists because the same report arrived twice: something that
 * breaks a *later* command, in a place that says nothing about the cause. A bare
 * clone with no fetch refspec surfaces as "`add` cannot find the branch"; a
 * pruned worktree surfaces as "`add` says the directory already exists"; a
 * `link` whose target went away surfaces as a build failure that has nothing to
 * do with git at all. Each one costs a round of questions to place, and each one
 * is a single git command to confirm — so they are confirmed here instead.
 *
 * Nothing is written. The fix is printed rather than applied, because every one
 * of these has a cause worth knowing about before it goes away, and because the
 * two that touch directories are not ours to delete.
 */

/** How far below the root a worktree directory can hide. `feat/a/b/c` and then some. */
const MAX_DEPTH = 5;

export type FindingSeverity = "error" | "warning";

export type Finding = {
  /** A stable name for the check, so a script can match on that rather than on prose. */
  readonly check: string;
  /**
   * `error` breaks a command outright; `warning` is mess that still works.
   *
   * Only errors set the exit code — a worktree directory somebody deleted by
   * hand is untidy, and failing a pipeline over it would make this command one
   * nobody dares put in CI.
   */
  readonly severity: FindingSeverity;
  readonly summary: string;
  /** The specifics: which worktrees, which paths, what git said. */
  readonly details: readonly string[];
  /**
   * The commands that clear it, one per line — or, where no command can, what to
   * do instead.
   *
   * A list rather than one string because a fix is sometimes two commands, and
   * `a && b` on one line puts the repository's path in it twice, which is the
   * difference between a line you paste and a line you have to read first.
   */
  readonly fix: readonly string[];
};

export type Diagnosis = {
  readonly root: string;
  readonly gitDir: string;
  readonly kind: RepoKind;
  readonly grove: string;
  /** git's own version. The first thing anyone reading a bug report asks for. */
  readonly git: string;
  /** How many checks ran, so a clean report says how much it is claiming. */
  readonly checked: number;
  readonly findings: readonly Finding[];
};

/**
 * What every check is handed, gathered once.
 *
 * The three booleans are here rather than read per check so the remote checks
 * can stay independent without repeating each other. They are strictly nested —
 * no refspec means no `origin/*`, which in turn means no `origin/HEAD` — so each
 * check declines to speak while the one above it is still wrong, and the report
 * names the cause rather than burying it under its own consequences.
 */
type Context = {
  readonly repo: RepoPaths;
  readonly worktrees: readonly WorktreeRecord[];
  /** Whether there is an `origin` at all — a `git init` that never got one has none. */
  readonly hasOrigin: boolean;
  /** Whether some refspec writes into `refs/remotes/origin/*`. */
  readonly hasFetchRefspec: boolean;
  /** Whether anything has actually been fetched through it. */
  readonly hasRemoteTracking: boolean;
};

type Check = (context: Context) => Promise<Finding | undefined>;

/**
 * The famous one.
 *
 * `git clone --bare` copies the remote's heads straight into `refs/heads/*` and
 * configures no mapping into `refs/remotes/*`, so `git fetch` exits 0 having
 * updated nothing and `origin/main` never comes into existence. `grove clone`
 * writes the refspec before its first fetch; a repository converted to this
 * layout by hand — which is how most people arrive — has no such step.
 */
async function checkFetchRefspec({
  repo,
  hasOrigin,
  hasFetchRefspec,
}: Context): Promise<Finding | undefined> {
  if (!hasOrigin || hasFetchRefspec) return undefined;

  return {
    check: "fetch-refspec",
    severity: "error",
    summary: `${REMOTE} has no fetch refspec, so ${REMOTE}/* is never written`,
    details: [
      "a bare clone maps nothing into refs/remotes/*, and `git fetch` then exits 0",
      "having updated nothing: `add` cannot find a remote branch, `sync` has no",
      "upstream to rebase onto, and every worktree reads as having no upstream",
    ],
    fix: [
      `git -C ${repo.gitDir} config remote.${REMOTE}.fetch '${FETCH_REFSPEC}'`,
      `git -C ${repo.gitDir} fetch ${REMOTE} --prune --tags`,
    ],
  };
}

/** The refspec is there, but nothing has been pulled through it yet. */
async function checkRemoteTracking({
  repo,
  hasOrigin,
  hasFetchRefspec,
  hasRemoteTracking,
}: Context): Promise<Finding | undefined> {
  if (!hasOrigin || !hasFetchRefspec || hasRemoteTracking) return undefined;

  return {
    check: "remote-tracking",
    severity: "error",
    summary: `${REMOTE}/* is empty: the refspec is configured, but nothing has been fetched`,
    details: ["until a fetch fills these in, every branch reads as having no upstream"],
    fix: [`git -C ${repo.gitDir} fetch ${REMOTE} --prune --tags`],
  };
}

/**
 * The ref that says which branch is the trunk.
 *
 * `defaultBranch` reads it, and every command that measures drift, picks a base,
 * or looks for the worktree to copy `.grove.toml` out of goes through that — so
 * a repository missing this one symbolic ref fails at `list`, before it has done
 * anything.
 */
async function checkOriginHead({
  repo,
  hasOrigin,
  hasFetchRefspec,
  hasRemoteTracking,
}: Context): Promise<Finding | undefined> {
  if (!hasOrigin || !hasFetchRefspec || !hasRemoteTracking) return undefined;

  const head = await runGit(["symbolic-ref", "--short", `refs/remotes/${REMOTE}/HEAD`], {
    cwd: repo.gitDir,
  });
  const target = head.stdout.trim();

  if (head.code === 0 && target.length > 0) {
    const resolves = await gitSucceeds(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/${target}`],
      { cwd: repo.gitDir },
    );
    if (resolves) return undefined;
  }

  return {
    check: "origin-head",
    severity: "error",
    summary: `${REMOTE}/HEAD does not resolve, so nothing can tell which branch is the trunk`,
    details: [
      head.code === 0 && target.length > 0
        ? `it points at ${target}, and that ref is not there`
        : "it is not set",
      "`grove list`, `grove add` and `grove sync` all stop on this",
    ],
    fix: [`git -C ${repo.gitDir} remote set-head ${REMOTE} --auto`],
  };
}

/**
 * The copy of the trunk everything is measured against, when it is not origin's.
 *
 * `git branch -u upstream/main main` is how somebody says their trunk follows
 * the repository they forked, and `trunkOf` takes them at their word: from
 * then on drift, `merged`, the base of every new branch and every rebase are
 * against `upstream/main`. Which is a ref that exists only once `upstream`
 * has been fetched — and a remote added by hand and never fetched, or one
 * whose URL was mistyped, leaves the word given and the ref absent. Every
 * command then fails against a name that reads like a typo of `origin/main`.
 */
async function checkTrunkTracking({
  repo,
  hasOrigin,
  hasFetchRefspec,
  hasRemoteTracking,
}: Context): Promise<Finding | undefined> {
  if (!hasOrigin || !hasFetchRefspec || !hasRemoteTracking) return undefined;

  const trunk = await trunkOf(repo.gitDir).catch(() => undefined);
  if (trunk === undefined || trunk.remote === REMOTE) return undefined;

  const resolves = await gitSucceeds(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${trunk.ref}`],
    { cwd: repo.gitDir },
  );
  if (resolves) return undefined;

  return {
    check: "trunk-tracking",
    severity: "error",
    summary: `${trunk.branch} tracks ${trunk.ref}, and that ref is not there`,
    details: [
      `the trunk is measured against ${trunk.remote}'s copy because ${trunk.branch} was told to`,
      `track it — and nothing has been fetched from ${trunk.remote} into refs/remotes/${trunk.remote}/`,
    ],
    fix: [`git -C ${repo.gitDir} fetch ${trunk.remote} --prune --tags`],
  };
}

/**
 * `<root>/.git` — the one-line file that makes the repo root a place git works.
 *
 * Only a managed repository has one; in a plain clone `.git` is the repository
 * itself and there is nothing here to be wrong.
 */
async function checkGitFile({ repo }: Context): Promise<Finding | undefined> {
  if (repo.kind !== "managed") return undefined;

  const rewrite = `echo 'gitdir: ./${BARE_DIR}' > ${repo.gitFile}`;
  const finding = (
    summary: string,
    details: readonly string[],
    fix: readonly string[] = [rewrite],
  ): Finding => ({ check: "git-file", severity: "error", summary, details, fix });

  const info = await lstat(repo.gitFile).catch(() => undefined);
  if (info === undefined) {
    return finding("the repo root has no .git file, so git does not work from the root itself", [
      `${BARE_DIR} is there, but nothing points at it`,
    ]);
  }
  if (info.isDirectory()) {
    return finding(
      ".git at the repo root is a directory, where this layout wants a pointer file",
      [`a second repository beside ${BARE_DIR}: whichever git finds first is the one you get`],
      // Deliberately not the rewrite above: `>` cannot overwrite a directory,
      // and a directory here is a repository with history in it that this
      // command has no business proposing to flatten.
      [
        "decide which of the two the root belongs to, and move the loser aside;",
        `if ${BARE_DIR} is the one you want, replace .git with its pointer afterwards`,
      ],
    );
  }

  const text = await Bun.file(repo.gitFile).text();
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (match?.[1] === undefined) {
    return finding("the repo root's .git file does not name a git directory", [text.trim()]);
  }

  const target = resolve(repo.root, match[1].trim());
  if (await pathExists(join(target, "HEAD"))) return undefined;

  return finding("the repo root's .git file points at a git directory that is not there", [
    `it names ${target}`,
  ]);
}

/** Worktrees git still lists, whose directories have gone. */
async function checkPrunable({ repo, worktrees }: Context): Promise<Finding | undefined> {
  const prunable = worktrees.filter((record) => record.prunable !== undefined);
  if (prunable.length === 0) return undefined;

  return {
    check: "prunable-worktree",
    severity: "warning",
    summary: `${plural(prunable.length, "worktree")} git still lists, gone from disk`,
    details: prunable.map((record) => {
      const why =
        record.prunable === undefined || record.prunable.length === 0
          ? ""
          : ` — ${record.prunable}`;

      return `${worktreeDir(repo.root, record.path)}${why}`;
    }),
    fix: [`git -C ${repo.gitDir} worktree prune`],
  };
}

/**
 * The worktree the check above cannot see: locked, and gone from disk.
 *
 * `git worktree prune` skips a locked entry by design — the lock exists to say
 * "the directory is on a drive that is not mounted right now, leave it" — and
 * so `git worktree list` never marks one `prunable` either. Which is the right
 * behaviour for a portable drive and the wrong one for how this state actually
 * arises: a coding agent locks the worktree it is working in, its session dies,
 * and the directory is deleted by whatever cleaned up after it. What is left is
 * an entry nothing will prune, holding a branch git still considers checked
 * out — so `grove add` of that branch fails with "already checked out at" a
 * path that does not exist.
 *
 * The fix is two commands rather than one because the unlock has to come
 * first; `prune` alone is exactly what has already been silently declining.
 */
async function checkLockedPhantoms({ repo, worktrees }: Context): Promise<Finding | undefined> {
  const phantoms: WorktreeRecord[] = [];
  for (const record of worktrees) {
    if (record.bare || record.locked === undefined || record.prunable !== undefined) continue;
    if (!(await pathExists(record.path))) phantoms.push(record);
  }
  if (phantoms.length === 0) return undefined;

  return {
    check: "locked-phantom-worktree",
    severity: "warning",
    summary:
      `${plural(phantoms.length, "worktree")} git still lists, gone from disk, and locked` +
      " — which `git worktree prune` skips",
    details: phantoms.map((record) => {
      const why =
        record.locked === undefined || record.locked.length === 0 ? "" : ` — ${record.locked}`;

      return `${worktreeDir(repo.root, record.path)}${why}`;
    }),
    fix: [
      ...phantoms.map((record) => `git -C ${repo.gitDir} worktree unlock ${record.path}`),
      `git -C ${repo.gitDir} worktree prune`,
    ],
  };
}

/** A directory's `.git`, and what it is. */
type GitEntry =
  | { readonly kind: "absent" }
  /** A repository in its own right, which is not this repository's business. */
  | { readonly kind: "repository" }
  | { readonly kind: "pointer"; readonly target: string };

async function gitEntry(dir: string): Promise<GitEntry> {
  const path = join(dir, ".git");
  const info = await lstat(path).catch(() => undefined);

  if (info === undefined) return { kind: "absent" };
  if (info.isDirectory()) return { kind: "repository" };

  const match = /^gitdir:\s*(.+)$/m.exec(await Bun.file(path).text());
  if (match?.[1] === undefined) return { kind: "repository" };

  return { kind: "pointer", target: resolve(dir, match[1].trim()) };
}

/**
 * Walks the root looking for worktree-shaped directories git has forgotten.
 *
 * The mirror of the check above: `git worktree prune` deletes the admin
 * directory and leaves the checkout, which then holds a `.git` file naming
 * something that no longer exists. git will not list it, so it is invisible to
 * everything here — right up until `grove add` picks the same directory for the
 * branch and fails because it is not empty.
 *
 * A live worktree is never descended into. That is what keeps this a scan of the
 * repo's own folders rather than of every file in the project.
 */
async function scanForOrphans(
  dir: string,
  known: ReadonlySet<string>,
  depth: number,
  found: string[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  for (const name of await childDirectories(dir)) {
    // `.bare` is the repository, and grove never names a worktree directory
    // beginning with a dot — so nothing under one is ours to judge.
    if (name.startsWith(".")) continue;

    const child = join(dir, name);
    if (known.has(child)) continue;

    const entry = await gitEntry(child);
    if (entry.kind === "absent") {
      await scanForOrphans(child, known, depth + 1, found);
      continue;
    }
    // A pointer git did not list, aimed at something that is there, belongs to
    // some other repository. Only a dangling one is this repository's leftover.
    if (entry.kind === "pointer" && !(await pathExists(entry.target))) found.push(child);
  }
}

async function checkOrphans({ repo, worktrees }: Context): Promise<Finding | undefined> {
  // A plain repository's root *is* its checkout, so there is nothing to walk
  // here that is not the project's own tree.
  if (repo.kind !== "managed") return undefined;

  const found: string[] = [];
  await scanForOrphans(repo.root, new Set(worktrees.map((record) => record.path)), 1, found);
  if (found.length === 0) return undefined;

  return {
    check: "orphan-worktree",
    severity: "warning",
    summary: `${plural(found.length, "directory", "directories")} left behind by a pruned worktree`,
    details: found.map((path) => worktreeDir(repo.root, path)),
    fix: [
      "git has no record of these, so nothing here will remove them: look inside for",
      "work you have not committed, then delete the directory yourself",
    ],
  };
}

/**
 * The symlinks `.grove.toml`'s `link` made, where the target has since gone.
 *
 * A `link` is relative into the trunk's worktree, which is what makes one
 * `node_modules` serve every branch — and what makes deleting the trunk's copy
 * break all of them at once, in a way that reads as the build's fault.
 *
 * Only the paths the file names are looked at. A dangling symlink somewhere in a
 * checkout is the project's own, and not a thing to report.
 */
async function checkLinks({ repo, worktrees }: Context): Promise<Finding | undefined> {
  let hooks: Hooks;
  try {
    hooks = await repoHooks(repo);
  } catch (error) {
    return {
      check: "setup-file",
      severity: "error",
      summary: `${HOOKS_FILE} cannot be read, so every new worktree fails before it is filled in`,
      details: [error instanceof Error ? error.message : String(error)],
      fix: [`fix ${HOOKS_FILE} in the default branch's worktree`],
    };
  }

  if (hooks.link.length === 0) return undefined;

  const broken: string[] = [];
  for (const record of worktrees) {
    for (const path of hooks.link) {
      const link = join(record.path, path);
      const info = await lstat(link).catch(() => undefined);

      // A real directory here is a worktree set up before the file said to link
      // it — different from what the file asks for, and not broken.
      if (info === undefined || !info.isSymbolicLink()) continue;
      // `pathExists` follows the link, so this is exactly "points at nothing".
      if (await pathExists(link)) continue;

      broken.push(`${worktreeDir(repo.root, record.path)}/${path} → ${await readlink(link)}`);
    }
  }

  if (broken.length === 0) return undefined;

  return {
    check: "broken-link",
    severity: "warning",
    summary:
      `${plural(broken.length, "link")} from ${HOOKS_FILE}` +
      ` ${broken.length === 1 ? "points" : "point"} at nothing`,
    details: broken,
    fix: [
      "they are relative into the default branch's worktree — restore what they name",
      "there, by re-running whatever creates it",
    ],
  };
}

const CHECKS: readonly Check[] = [
  checkFetchRefspec,
  checkRemoteTracking,
  checkOriginHead,
  checkTrunkTracking,
  checkGitFile,
  checkPrunable,
  checkLockedPhantoms,
  checkOrphans,
  checkLinks,
];

async function hasOriginRemote(gitDir: string): Promise<boolean> {
  const result = await runGit(["remote"], { cwd: gitDir });

  return result.stdout.split("\n").some((line) => line.trim() === REMOTE);
}

/** Whether a refspec writes into `refs/remotes/origin/*` — the mapping that makes `origin/x`. */
function writesRemoteTracking(spec: string): boolean {
  const colon = spec.indexOf(":");
  if (colon === -1) return false;

  return spec.slice(colon + 1).startsWith(`refs/remotes/${REMOTE}/`);
}

async function hasFetchRefspec(gitDir: string): Promise<boolean> {
  const result = await runGit(["config", "--get-all", `remote.${REMOTE}.fetch`], { cwd: gitDir });

  return result.stdout.split("\n").some((line) => writesRemoteTracking(line.trim()));
}

/** Whether anything has been fetched into `refs/remotes/origin/*` yet. */
async function hasRemoteTracking(gitDir: string): Promise<boolean> {
  const result = await runGit(
    ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/${REMOTE}/`],
    { cwd: gitDir },
  );

  return result.code === 0 && result.stdout.trim().length > 0;
}

async function gitVersion(): Promise<string> {
  const result = await runGit(["--version"]);
  const output = result.stdout.trim().replace(/^git version /, "");

  return output.length === 0 ? "unknown" : output;
}

export async function diagnose(repo: RepoPaths): Promise<Diagnosis> {
  const [worktrees, origin, git] = await Promise.all([
    listWorktrees(repo.gitDir),
    hasOriginRemote(repo.gitDir),
    gitVersion(),
  ]);

  // Each is asked only once the one above it has answered yes, so a repository
  // with no origin never answers "no refspec" to a question nobody posed.
  const refspec = origin && (await hasFetchRefspec(repo.gitDir));
  const context: Context = {
    repo,
    worktrees,
    hasOrigin: origin,
    hasFetchRefspec: refspec,
    hasRemoteTracking: refspec && (await hasRemoteTracking(repo.gitDir)),
  };

  const results = await Promise.all(CHECKS.map((check) => check(context)));

  return {
    root: repo.root,
    gitDir: repo.gitDir,
    kind: repo.kind,
    grove: version,
    git,
    checked: CHECKS.length,
    findings: results.filter((f) => f !== undefined),
  };
}

const MARK: Readonly<Record<FindingSeverity, string>> = { error: "✗", warning: "!" };

function tally(diagnosis: Diagnosis): string {
  const errors = diagnosis.findings.filter((finding) => finding.severity === "error").length;
  const warnings = diagnosis.findings.length - errors;

  const parts: string[] = [];
  if (errors > 0) parts.push(plural(errors, "problem"));
  if (warnings > 0) parts.push(plural(warnings, "warning"));

  return `${parts.join(" and ")}, out of ${plural(diagnosis.checked, "check")}`;
}

/**
 * The report, written to be pasted into an issue.
 *
 * Which is why the versions are at the top and every finding carries its own
 * fix: the exchange this replaces is three messages long, and two of them are
 * "what version?" and "what does `git -C .bare config --get remote.origin.fetch`
 * say?".
 */
export function formatDiagnosis(diagnosis: Diagnosis): string {
  const header = [
    `${diagnosis.root}  (${diagnosis.kind})`,
    `grove ${diagnosis.grove} · git ${diagnosis.git}`,
  ];

  if (diagnosis.findings.length === 0) {
    return [
      ...header,
      "",
      `nothing to report — ${plural(diagnosis.checked, "check")}, all clean`,
    ].join("\n");
  }

  const blocks = diagnosis.findings.map((finding) =>
    [
      `${MARK[finding.severity]} ${finding.summary}`,
      ...finding.details.map((detail) => `    ${detail}`),
      ...finding.fix.map((line, index) => `    ${index === 0 ? "→" : " "} ${line}`),
    ].join("\n"),
  );

  return [...header, "", blocks.join("\n\n"), "", tally(diagnosis)].join("\n");
}

/**
 * Non-zero for a problem, and only for a problem.
 *
 * Thrown after the report is printed rather than instead of it — the findings
 * are the point, and stdout is where they belong. Warnings deliberately do not
 * reach here: a repository with a stale directory in it still works, and a
 * command that failed CI over one would not be left in CI.
 */
export function failureFor(diagnosis: Diagnosis): GroveError | undefined {
  const problems = diagnosis.findings.filter((finding) => finding.severity === "error");
  if (problems.length === 0) return undefined;

  return new GroveError(
    "state-conflict",
    `the repository has ${plural(problems.length, "problem")}`,
    {
      hint: "each is listed above, with the command that clears it",
    },
  );
}
