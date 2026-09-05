import { join } from "node:path";
import { runGit, runGitOrThrow } from "../core/git.ts";
import type { Hooks } from "./config.ts";

export type SetupState = "pending" | "running" | "failed" | "ready" | "stale";
export type SetupRecord = {
  readonly state: SetupState;
  readonly fingerprint?: string;
  readonly updatedAt: number;
};
const SUFFIX = ".grovesetupstate";

/** Readiness includes local layers and dependency manifests, independently of trust. */
export async function setupFingerprint(hooks: Hooks, path: string): Promise<string> {
  const files = [
    "package.json",
    "bun.lock",
    "bun.lockb",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "uv.lock",
    "pyproject.toml",
    "Cargo.lock",
    "go.sum",
  ];
  const texts = await Promise.all(
    files.map(async (name) => {
      const file = Bun.file(join(path, name));
      return (await file.exists())
        ? `${name}\0${Bun.SHA256.hash(await file.arrayBuffer(), "hex")}`
        : name;
    }),
  );
  return Bun.SHA256.hash(JSON.stringify([hooks.layers.map((layer) => layer.text), texts]), "hex");
}

export async function recordSetupState(
  bare: string,
  branch: string,
  state: SetupState,
  fingerprint?: string,
): Promise<void> {
  await runGitOrThrow(
    [
      "config",
      "--replace-all",
      `branch.${branch}${SUFFIX}`,
      JSON.stringify({ state, fingerprint, updatedAt: Date.now() }),
    ],
    { cwd: bare },
  );
}

export async function setupStates(bare: string): Promise<ReadonlyMap<string, SetupRecord>> {
  const result = await runGit(["config", "--get-regexp", "^branch\\..*\\.grovesetupstate$"], {
    cwd: bare,
  });
  const states = new Map<string, SetupRecord>();
  if (result.code !== 0) return states;
  for (const line of result.stdout.trim().split("\n")) {
    const at = line.indexOf(" ");
    try {
      const value = JSON.parse(line.slice(at + 1));
      if (["pending", "running", "failed", "ready", "stale"].includes(value.state))
        states.set(line.slice(7, at - SUFFIX.length), value);
    } catch {
      /* Unknown records leave readiness unknown. */
    }
  }
  return states;
}
