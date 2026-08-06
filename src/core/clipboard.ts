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
