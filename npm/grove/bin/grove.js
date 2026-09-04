#!/usr/bin/env node
// The npm face of grove. The program itself is a compiled Bun binary that
// lives in @enginerd-kr/grove-<os>-<arch>, one of this package's optional
// dependencies; npm installs the one whose os/cpu fields match the machine.
// This file finds it and runs it — nothing more, so it needs nothing beyond
// what every Node since 12 ships, and runs unchanged under `bunx`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const target = `${process.platform}-${process.arch}`;
const pkg = `@enginerd-kr/grove-${target}`;

function fail(lines) {
  console.error(lines.join("\n"));
  process.exit(1);
}

if (process.platform === "win32") {
  fail([
    "grove: no Windows build is published.",
    "Use WSL, where the linux-x64 / linux-arm64 package installs as usual.",
  ]);
}
if (!TARGETS.includes(target)) {
  fail([`grove: no build for ${target}.`, `supported: ${TARGETS.join(", ")}`]);
}

// The platform package has no main and no exports — it is one file in bin/ —
// so its package.json is the only thing that is guaranteed to resolve.
let bin;
try {
  const require = createRequire(import.meta.url);
  bin = join(dirname(require.resolve(`${pkg}/package.json`)), "bin", "grove");
} catch {
  fail([
    `grove: the binary package ${pkg} is not installed.`,
    "It is an optionalDependency of @enginerd-kr/grove, chosen by os/cpu at install time.",
    "Likely causes: --omit=optional (or --no-optional), a lockfile written on another",
    "platform, or a package manager that ignores os/cpu. There is no install script,",
    "so --ignore-scripts is not the reason.",
    "Try: npm install -g @enginerd-kr/grove --force",
    `supported: ${TARGETS.join(", ")}`,
  ]);
}
if (!existsSync(bin)) {
  fail([`grove: ${pkg} is installed but ${bin} is missing; reinstall it.`]);
}

// Ctrl-C reaches both processes at once: the terminal signals the whole
// foreground group. The child owns the shutdown — it kills the git it started
// and exits 130 — so this process only has to outlive it and repeat its
// answer. A listener, even an empty one, replaces Node's default "terminate on
// signal"; spawnSync then blocks the event loop, so the listener never runs.
// Inside the TUI none of this happens: the terminal is in raw mode there, and
// ^C arrives as a byte on the child's stdin, which the child handles itself.
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const ignore = () => {};
for (const signal of SIGNALS) process.on(signal, ignore);

const result = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, GROVE_INSTALL_CHANNEL: process.env.GROVE_INSTALL_CHANNEL ?? "npm" },
});

if (result.error) fail([`grove: could not start ${bin}: ${result.error.message}`]);

// Died of a signal: die of the same one, so the shell sees 128+n as it would
// have without the launcher. Removing the listener restores the default
// disposition, which is what makes the second kill fatal.
if (result.signal) {
  process.removeListener(result.signal, ignore);
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
