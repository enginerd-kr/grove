#!/usr/bin/env bun
/**
 * Assemble the npm packages from binaries scripts/build-binaries.sh already
 * compiled. Writes dist/npm/<pkg>/ for five packages: one per platform holding
 * bin/grove, and `grove` — published as @enginerd-kr/grove — whose bin is the
 * Node launcher in npm/grove/bin/grove.js and whose optionalDependencies name
 * the other four at this exact version.
 *
 * Usage: bun scripts/build-npm.ts [--targets darwin-arm64,linux-x64]
 *
 * The five package.json files are generated, not committed, so the version
 * has one source — the root package.json, the same one the tag and CHANGELOG
 * guards in release.yml read — and the pins in optionalDependencies cannot
 * drift from it. `--targets` assembles a subset of platform packages for a
 * machine that only compiled some; the main package still pins all four,
 * because its manifest is the one that ships.
 */
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { version } from "../package.json";

const SCOPE = "@enginerd-kr";
const REPO = "https://github.com/enginerd-kr/grove";

const TARGETS = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-x64": { os: "linux", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64" },
} as const;
type Target = keyof typeof TARGETS;

const ALL_TARGETS = Object.keys(TARGETS) as Target[];

const links = {
  repository: { type: "git", url: `git+${REPO}.git` },
  homepage: `${REPO}#readme`,
  bugs: { url: `${REPO}/issues` },
  license: "MIT",
  publishConfig: { access: "public" },
};

function parseTargets(argv: readonly string[]): Target[] {
  const flag = argv.indexOf("--targets");
  if (flag === -1) return ALL_TARGETS;
  const raw = argv[flag + 1];
  if (raw === undefined || raw === "") {
    throw new Error("--targets needs a comma-separated list");
  }
  return raw.split(",").map((name) => {
    if (!(name in TARGETS)) {
      throw new Error(`unknown target '${name}'; known: ${ALL_TARGETS.join(", ")}`);
    }
    return name as Target;
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function platformPackage(target: Target): Promise<void> {
  const source = join("dist", "compile", target, "grove");
  if (!(await Bun.file(source).exists())) {
    throw new Error(`${source} is missing; run scripts/build-binaries.sh ${target} first`);
  }

  const dir = join("dist", "npm", `grove-${target}`);
  await mkdir(join(dir, "bin"), { recursive: true });
  await copyFile(source, join(dir, "bin", "grove"));
  // upload-artifact zips the binaries and zip forgets the mode, so the bit is
  // restored here rather than trusted from the copy.
  await chmod(join(dir, "bin", "grove"), 0o755);
  await copyFile("LICENSE", join(dir, "LICENSE"));
  await copyFile(join("npm", "platform", "README.md"), join(dir, "README.md"));

  await writeJson(join(dir, "package.json"), {
    name: `${SCOPE}/grove-${target}`,
    version,
    description: `The ${target} binary for ${SCOPE}/grove`,
    os: [TARGETS[target].os],
    cpu: [TARGETS[target].cpu],
    files: ["bin"],
    ...links,
  });
}

async function mainPackage(): Promise<void> {
  const dir = join("dist", "npm", "grove");
  await mkdir(join(dir, "bin"), { recursive: true });
  await copyFile(join("npm", "grove", "bin", "grove.js"), join(dir, "bin", "grove.js"));
  await chmod(join(dir, "bin", "grove.js"), 0o755);
  await copyFile("LICENSE", join(dir, "LICENSE"));
  await copyFile(join("npm", "grove", "README.md"), join(dir, "README.md"));

  await writeJson(join(dir, "package.json"), {
    name: `${SCOPE}/grove`,
    version,
    description:
      "Git worktrees as a managed workspace: one bare clone, a directory per branch, and a terminal UI over them",
    type: "module",
    bin: { grove: "bin/grove.js" },
    files: ["bin"],
    engines: { node: ">=18" },
    os: ["darwin", "linux"],
    keywords: ["git", "worktree", "worktrees", "cli", "tui", "branches"],
    ...links,
    optionalDependencies: Object.fromEntries(
      ALL_TARGETS.map((target) => [`${SCOPE}/grove-${target}`, version]),
    ),
  });
}

const targets = parseTargets(Bun.argv.slice(2));

await rm(join("dist", "npm"), { recursive: true, force: true });
for (const target of targets) await platformPackage(target);
await mainPackage();

console.log(`dist/npm — ${SCOPE}/grove ${version}`);
for (const target of targets) console.log(`  grove-${target}/bin/grove`);
console.log("  grove/bin/grove.js");
