import { runGit, runGitOrThrow } from "./git.ts";

export type Review = {
  readonly number: number;
  readonly url: string;
  readonly base: string;
  readonly head: string;
  readonly headSha: string;
};

export async function reviewOf(bare: string, branch: string): Promise<Review | undefined> {
  const result = await runGit(["config", "--get", `branch.${branch}.grovepr`], { cwd: bare });
  if (result.code !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout);
    if (
      typeof value.number === "number" &&
      typeof value.url === "string" &&
      typeof value.base === "string" &&
      typeof value.head === "string" &&
      typeof value.headSha === "string"
    )
      return value;
  } catch {
    /* Invalid metadata does not grant review behavior. */
  }
  return undefined;
}

export async function recordReview(bare: string, branch: string, review: Review): Promise<void> {
  await runGitOrThrow(
    ["config", "--replace-all", `branch.${branch}.grovepr`, JSON.stringify(review)],
    { cwd: bare },
  );
}

export async function reviewBranch(
  bare: string,
  url: string,
  number: number,
): Promise<string | undefined> {
  const result = await runGit(["config", "--get-regexp", "^branch\\..*\\.grovepr$"], { cwd: bare });
  if (result.code !== 0) return undefined;
  for (const line of result.stdout.trim().split("\n")) {
    const at = line.indexOf(" ");
    try {
      const value = JSON.parse(line.slice(at + 1));
      if (value.url === url && value.number === number)
        return line.slice(7, at - ".grovepr".length);
    } catch {
      /* Ignore invalid records. */
    }
  }
  return undefined;
}
