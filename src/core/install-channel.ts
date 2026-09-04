/**
 * How this grove was installed, and therefore how it is upgraded.
 *
 * The binary is the same file on every channel — the npm platform packages
 * hold the very bytes the Homebrew tap serves — so the binary cannot tell by
 * looking at itself. Only the npm launcher knows it is the npm one, and it says
 * so with `GROVE_INSTALL_CHANNEL=npm` before it execs. Nothing set means brew,
 * which was the only channel before npm and is still the one the tap installs.
 */

export type InstallChannel = "brew" | "npm";

/** The package `npm install -g` and `npx` know grove by. */
export const NPM_PACKAGE = "@enginerd-kr/grove";

export function installChannel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InstallChannel {
  return env.GROVE_INSTALL_CHANNEL === "npm" ? "npm" : "brew";
}

/** The one-line "upgrade:" hint the update tip shows, in the installer's words. */
export function upgradeHint(channel: InstallChannel = installChannel()): string {
  return channel === "npm"
    ? `upgrade: npm install -g ${NPM_PACKAGE}@latest`
    : "upgrade: brew upgrade grove";
}
