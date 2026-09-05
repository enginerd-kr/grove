import { mkdir, readdir, readFile, readlink, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RepoPaths } from "./layout.ts";

/** Git's per-worktree admin directory survives branch/directory renames. */
async function identity(repo: RepoPaths, path: string): Promise<string> {
  const pointer = await readFile(join(path, ".git"), "utf8").catch(() => "");
  const admin = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1];
  return Bun.SHA256.hash(admin ? resolve(path, admin) : repo.gitDir, "hex").slice(0, 16);
}

/** Atomic claims allocate distinct ports within this workspace, without binding sockets. */
export async function runtimeEnv(repo: RepoPaths, path: string): Promise<Record<string, string>> {
  const id = await identity(repo, path);
  const ports = join(repo.gitDir, "grove-runtime", "ports");
  await mkdir(ports, { recursive: true });
  const start = Number.parseInt(id.slice(0, 8), 16) % 20000;
  for (let offset = 0; offset < 20000; offset++) {
    const port = String(20000 + ((start + offset) % 20000));
    const claim = join(ports, port);
    try {
      await symlink(id, claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readlink(claim)) !== id) continue;
    }
    const name = `grove_${id}`;
    return {
      GROVE_WORKTREE_ID: id,
      GROVE_PORT: port,
      GROVE_SERVICE_NAME: name,
      GROVE_DATABASE_NAME: name,
    };
  }
  throw new Error("no workspace runtime ports available");
}

/** Called after teardown and before deleting the directory holding its identity. */
export async function releaseRuntime(repo: RepoPaths, path: string): Promise<void> {
  const id = await identity(repo, path);
  const ports = join(repo.gitDir, "grove-runtime", "ports");
  for (const name of await readdir(ports).catch(() => [])) {
    const claim = join(ports, name);
    if ((await readlink(claim).catch(() => "")) === id) await unlink(claim);
  }
}
