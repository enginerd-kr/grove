import { describe, expect, test } from "bun:test";
import { runCli } from "../ui/e2e-utils.ts";
import { parseCliArgs } from "./args.ts";
import {
  BIN_NAME,
  type FlagSpec,
  findSubcommand,
  formatGlobalHelp,
  formatSubcommandHelp,
  GLOBAL_FLAGS,
  SUBCOMMANDS,
  type SubcommandSpec,
} from "./help.ts";

/**
 * Help and the parser are generated from the same table, and the interesting
 * property is that they cannot drift apart. So this asserts the relationship
 * rather than the prose: what the spec declares is what the parser takes and
 * what the page prints, in both directions.
 */

function requiredArgs(spec: SubcommandSpec): readonly string[] {
  return spec.args
    .split(/\s+/)
    .filter((token) => token.startsWith("<"))
    .map((token) => (token === "<shell>" ? "zsh" : "x"));
}

/** A value the flag will accept, so a `run` command is what comes back. */
function argvFor(spec: SubcommandSpec, flag: FlagSpec): readonly string[] {
  const written = flag.type === "string" ? [`--${flag.name}`, "value"] : [`--${flag.name}`];

  return [spec.name, ...written, ...requiredArgs(spec)];
}

/**
 * The flags a rendered section actually shows.
 *
 * Read off the label column rather than the whole block, so a summary that
 * happens to mention a flag is not mistaken for one being offered.
 */
function renderedFlags(help: string, heading: string): readonly string[] {
  const lines = help.split("\n");
  // A command with no flags of its own has no section at all, which reads as no
  // flags — the test below asserts the heading really is absent in that case.
  const start = lines.indexOf(heading);
  if (start === -1) return [];

  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;

    const match = /^\s+(?:-[A-Za-z], )?--([\w-]+)/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }

  return names;
}

describe("the flag table", () => {
  test("every flag a spec declares is accepted by the parser", () => {
    for (const spec of SUBCOMMANDS) {
      for (const flag of [...spec.flags, ...GLOBAL_FLAGS]) {
        // `--help` and `--version` answer with text instead of running, which is
        // still the parser accepting them.
        const parsed = parseCliArgs(argvFor(spec, flag));

        expect([parsed.kind, `${spec.name} --${flag.name}`]).toEqual([
          flag.name === "help" || flag.name === "version" ? "text" : "run",
          `${spec.name} --${flag.name}`,
        ]);
      }
    }
  });

  test("a flag's short spelling is accepted wherever it has one", () => {
    for (const spec of SUBCOMMANDS) {
      for (const flag of spec.flags) {
        if (flag.short === undefined) continue;

        const written = flag.type === "string" ? [`-${flag.short}`, "value"] : [`-${flag.short}`];
        expect(parseCliArgs([spec.name, ...written, ...requiredArgs(spec)]).kind).toBe("run");
      }
    }
  });

  test("no command has two flags by the same name or short", () => {
    for (const spec of SUBCOMMANDS) {
      const flags = [...spec.flags, ...GLOBAL_FLAGS];
      const names = flags.map((flag) => flag.name);
      const shorts = flags
        .map((flag) => flag.short)
        .filter((short): short is string => short !== undefined);

      expect([spec.name, names]).toEqual([spec.name, [...new Set(names)]]);
      expect([spec.name, shorts]).toEqual([spec.name, [...new Set(shorts)]]);
    }
  });

  test("a placeholder is on every string flag and on no boolean one", () => {
    for (const flag of [...GLOBAL_FLAGS, ...SUBCOMMANDS.flatMap((spec) => spec.flags)]) {
      expect([flag.name, flag.placeholder !== undefined]).toEqual([
        flag.name,
        flag.type === "string",
      ]);
      if (flag.placeholder !== undefined) expect(flag.placeholder).toMatch(/^<.+>$/);
    }
  });

  test("no two commands answer to the same word", () => {
    const words = SUBCOMMANDS.flatMap((spec) => [spec.name, ...spec.aliases]);

    expect(words).toEqual([...new Set(words)]);
    for (const word of words) expect(findSubcommand(word)).toBeDefined();
    expect(findSubcommand("nope")).toBeUndefined();
  });
});

describe("the rendered page", () => {
  test("a command's Options section shows its flags and nothing else", () => {
    for (const spec of SUBCOMMANDS) {
      const help = formatSubcommandHelp(spec);

      expect([spec.name, renderedFlags(help, "Options:")]).toEqual([
        spec.name,
        spec.flags.map((flag) => flag.name),
      ]);
      expect([spec.name, renderedFlags(help, "Global options:")]).toEqual([
        spec.name,
        GLOBAL_FLAGS.map((flag) => flag.name),
      ]);
    }
  });

  test("a command with no flags of its own prints no Options section", () => {
    for (const spec of SUBCOMMANDS) {
      const help = formatSubcommandHelp(spec);

      // The global block is on every page; the command's own block is there only
      // when it has flags, which is what makes an empty section impossible.
      expect(help).toContain("\nGlobal options:");
      expect([spec.name, help.includes("\nOptions:")]).toEqual([spec.name, spec.flags.length > 0]);
    }
  });

  test("the usage line is the spec's own arguments", () => {
    for (const spec of SUBCOMMANDS) {
      const first = formatSubcommandHelp(spec).split("\n")[0];
      const args = spec.args === "" ? "" : ` ${spec.args}`;

      expect(first).toBe(`Usage: ${BIN_NAME} ${spec.name}${args} [options]`);
    }
  });

  test("every alias is printed on the page it belongs to", () => {
    for (const spec of SUBCOMMANDS) {
      const help = formatSubcommandHelp(spec);

      if (spec.aliases.length === 0) expect(help).not.toContain("Alias:");
      else expect(help).toContain(`Alias: ${spec.aliases.join(", ")}`);
    }
  });

  test("a string flag is shown with the value it wants", () => {
    for (const spec of SUBCOMMANDS) {
      const help = formatSubcommandHelp(spec);

      for (const flag of [...spec.flags, ...GLOBAL_FLAGS]) {
        const label = `--${flag.name}${flag.placeholder ? ` ${flag.placeholder}` : ""}`;
        expect([spec.name, flag.name, help.includes(label)]).toEqual([spec.name, flag.name, true]);
        expect(help).toContain(flag.summary);
      }
    }
  });

  test("the global page lists every command with its summary", () => {
    const help = formatGlobalHelp();

    for (const spec of SUBCOMMANDS) expect(help).toContain(`  ${spec.name}`);
    for (const spec of SUBCOMMANDS) expect(help).toContain(spec.summary);
    expect(renderedFlags(help, "Options:")).toEqual(GLOBAL_FLAGS.map((flag) => flag.name));
    expect(help).toContain(`Run \`${BIN_NAME} <command> --help\``);
  });

  test("no line runs past the width a narrow terminal has", () => {
    // Help is printed rather than drawn, so nothing wraps it for us.
    const pages = [formatGlobalHelp(), ...SUBCOMMANDS.map(formatSubcommandHelp)];

    for (const page of pages) {
      for (const line of page.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("--help through the binary", () => {
  test("`grove --help` prints the global page on stdout and exits 0", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${formatGlobalHelp()}\n`);
    expect(result.stderr).toBe("");
  });

  test("`grove add --help` prints add's own page on stdout and exits 0", async () => {
    const spec = findSubcommand("add");
    const result = await runCli(["add", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(spec).toBeDefined();
    expect(result.stdout).toBe(`${spec ? formatSubcommandHelp(spec) : ""}\n`);
    expect(result.stderr).toBe("");
  });
});
