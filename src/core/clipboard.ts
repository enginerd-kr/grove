/**
 * Copies text to the system clipboard by shelling out to whatever the
 * platform provides — there is no clipboard API in Bun itself, and pulling in
 * a dependency for one `write` is more than this needs.
 */

type Argv = readonly [string, ...string[]];

function candidatesFor(platform: NodeJS.Platform): readonly Argv[] {
  switch (platform) {
    case "darwin":
      return [["pbcopy"]];
    case "win32":
      return [["clip"]];
    default:
      // No single standard clipboard tool on Linux: which one is installed
      // depends on the display server, so every plausible one is tried in
      // turn — Wayland's wl-copy, X11's xclip, then xsel as the older
      // fallback.
      return [
        ["wl-copy"],
        ["xclip", "-selection", "clipboard"],
        ["xsel", "--clipboard", "--input"],
      ];
  }
}

async function trySpawn(
  argv: Argv,
): Promise<Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined> {
  try {
    return Bun.spawn([...argv], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  } catch (error) {
    // Bun.spawn throws when the executable does not exist on PATH.
    if (error instanceof Error && /[Ee]xecutable not found|ENOENT/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

async function tryCopy(argv: Argv, text: string): Promise<boolean> {
  const child = await trySpawn(argv);
  if (!child) return false;

  child.stdin.write(text);
  await child.stdin.end();

  return (await child.exited) === 0;
}

/**
 * `false` means no clipboard tool was found or the copy failed — not thrown,
 * since a worktree without a clipboard is still a worktree, and the caller
 * decides whether that is worth mentioning.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const argv of candidatesFor(process.platform)) {
    if (await tryCopy(argv, text)) return true;
  }

  return false;
}

/** Bare on POSIX. No `\`: a shell reads it as an escape, or as a line continuation at the end. */
const BARE_POSIX = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Windows adds `\`, which is its path separator and not an escape to `cmd` or PowerShell. */
const BARE_WIN32 = /^[A-Za-z0-9_@%+=:,.\\/-]+$/;

/**
 * Bare when it can be, quoted when it has to be.
 *
 * A path with a space in it pasted unquoted is two arguments and a shell error,
 * so quoting is not optional — but quoting every path would put marks around
 * the overwhelming majority that do not need them, and this line is read as
 * often as it is run.
 */
function quoteFor(platform: NodeJS.Platform, path: string): string {
  if ((platform === "win32" ? BARE_WIN32 : BARE_POSIX).test(path)) return path;

  // A double quote cannot appear in a Windows path — the filesystem refuses
  // the character — so there is nothing to escape, and both `cmd` and
  // PowerShell take the quoted form as one argument.
  if (platform === "win32") return `"${path}"`;

  // Single quotes on POSIX, where nothing but the closing quote is special:
  // the usual `'\''` dance ends the quoting, spells the quote, and starts it
  // again.
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * The line to paste into a shell to end up in `path`, not the path alone.
 *
 * What follows a freshly made worktree is almost always stepping into it, and
 * the clipboard is what carries it to the terminal `grove` is not in — so it
 * carries the whole command rather than half of it.
 *
 * `cd` on every platform this runs on: PowerShell and Git Bash both take it,
 * so `cmd`'s `/d` — which the other two reject outright — is left off. A path
 * on a different drive than the terminal's is the one case `cmd` will not
 * follow, and it is not one a worktree beside its repository reaches.
 */
export function cdCommand(path: string, platform: NodeJS.Platform = process.platform): string {
  return `cd ${quoteFor(platform, path)}`;
}
