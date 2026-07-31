import { Box, Text } from "ink";
import { theme } from "../theme.ts";

/**
 * The one place in this app where you type something open-ended.
 *
 * Every other prompt here asks for one named thing — a branch, a yes or a no —
 * and is drawn as a small box around that question. This one is not asking a
 * question, so it is not drawn as one: full width, ruled off above and below,
 * with the caret at the left where a shell puts it. The point is that it looks
 * like somewhere you type rather than somewhere you answer.
 *
 * What you type is read by its first character, so the modes cost no chrome:
 * a leading `!` is a git command and anything else narrows the list. The mode
 * label sits on the right rather than the left, so it cannot push the text you
 * are typing sideways as it changes under you.
 */

export type PromptMode = "filter" | "git";

/** How the two modes read, and what each one is about to do with the line. */
const LABELS: Record<PromptMode, string> = {
  filter: "filter",
  git: "git",
};

type Props = {
  readonly value: string;
  readonly mode: PromptMode;
  readonly columns: number;
  /** Where a `!` command would run, shown so it is never a guess. */
  readonly where?: string;
  /** Drawn without a caret, and dimmed, while the command is running. */
  readonly busy?: boolean;
};

/** How many rows `Prompt` takes. The layout has to know before it draws. */
export const PROMPT_ROWS = 3;

export function Prompt({ value, mode, columns, where, busy }: Props) {
  const rule = "─".repeat(Math.max(0, columns));
  // The right-hand label, and the width the typed line has to leave for it.
  const aside = mode === "git" && where !== undefined ? `${LABELS.git} in ${where}` : LABELS[mode];
  const room = Math.max(0, columns - aside.length - 5);

  return (
    <Box flexDirection="column">
      <Text dimColor>{rule}</Text>
      <Box>
        <Text color={busy === true ? theme.muted : theme.accent}>❯ </Text>
        <Text wrap="truncate">
          {value.length > room ? `…${value.slice(value.length - room + 1)}` : value}
          {busy === true ? null : <Text inverse> </Text>}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>{aside}</Text>
      </Box>
      <Text dimColor>{rule}</Text>
    </Box>
  );
}

/** Which mode a line is in, decided by its first character and nothing else. */
export function modeOf(value: string): PromptMode {
  return value.startsWith("!") ? "git" : "filter";
}

/**
 * The line with its mode sigil taken off.
 *
 * `!` is how you *said* it, not part of what you meant.
 */
export function bodyOf(value: string): string {
  return modeOf(value) === "git" ? value.slice(1).trim() : value.trim();
}

/**
 * A command line split into arguments, respecting quotes.
 *
 * Quotes because a commit message is the first thing anyone types here, and
 * `!commit -m "two words"` splitting on the space would pass `two` and then
 * fail on `words"`. Not a shell: no expansion, no globbing, no pipes — this
 * hands an argument list straight to `git` with no shell in between, which is
 * also what stops `!log; rm -rf ~` from being two commands.
 */
export function tokenize(line: string): readonly string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;

  for (const match of line.matchAll(pattern)) {
    const [, doubled, singled, bare] = match;
    tokens.push(doubled ?? singled ?? bare ?? "");
  }

  // Typing the name of the thing you are already talking to is a reflex, not a
  // mistake: `!git log` means `!log`.
  if (tokens[0] === "git") tokens.shift();

  return tokens;
}
