import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useMemo, useState } from "react";
import { detectShell, installShellInit } from "../../cli/install.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { theme } from "../theme.ts";
import { Banner } from "./Banner.tsx";
import { MessageView } from "./MessageView.tsx";
import { type Message, messageFor } from "./message.ts";

/**
 * The screen a fresh `grove` opens ahead of everything else, offering the one
 * line `shell-init` needs in the rc file.
 *
 * `App`'s own tip already says this, in the corner reserved for standing
 * advice — but a tip nobody has to answer is a tip everybody learns to skim
 * past. This asks once, plainly, and then gets out of the way for good: `run.tsx`
 * stamps the marker before this even mounts, so declining is as final as
 * accepting.
 *
 * Only the two screens share nothing else — no list, no repository — which is
 * why this is its own component rather than another `App` mode.
 */

/** Below this the explanation goes; the question and the keys are what must fit. */
const ROOMY_ROWS = 16;

type Mode = { readonly kind: "ask" } | { readonly kind: "busy" } | { readonly kind: "done" };

type Props = {
  /** The folder the app opened — Banner's own "is this the one I meant?" */
  readonly folder: string;
  /** Called once the screen has nothing left to ask — installed, declined, or already done. */
  readonly onDone: () => void;
  /**
   * Overrides `installShellInit`'s home directory. Absent everywhere but the
   * tests: Bun's `os.homedir()` reads `$HOME` once at process start, so a test
   * cannot redirect it by writing `process.env.HOME` the way it can `$SHELL`.
   */
  readonly home?: string;
};

export function ShellSetup({ folder, onDone, home }: Props) {
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const shell = useMemo(() => detectShell(), []);

  // Undetected means there is nothing to ask — `y` would only fail the same
  // way `n` succeeds, so the screen opens already past the question.
  const [mode, setMode] = useState<Mode>(shell === undefined ? { kind: "done" } : { kind: "ask" });
  const [message, setMessage] = useState<Message | undefined>(
    shell === undefined
      ? {
          kind: "info",
          text: "could not tell which shell this is from $SHELL",
          hint: "run `grove install <shell>` later, naming zsh, bash, or fish",
        }
      : undefined,
  );

  const install = useCallback(async () => {
    if (shell === undefined) return;

    setMode({ kind: "busy" });
    try {
      const result = await installShellInit(shell, { home });
      setMessage({
        kind: "info",
        text:
          result.outcome === "installed"
            ? `added to ${result.rcFile}`
            : `already installed in ${result.rcFile}`,
        hint:
          result.outcome === "installed"
            ? "restart your shell, or open a new tab, to pick it up"
            : undefined,
      });
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setMode({ kind: "done" });
    }
  }, [shell, home]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (mode.kind === "busy") return;
    // Any key at all: the message has already said what happened, and this
    // screen's whole job now is to get out of the way of the one underneath it.
    if (mode.kind === "done") return onDone();

    if (input === "y" || input === "Y" || key.return) return void install();
    if (input === "n" || input === "N" || key.escape) return onDone();
  });

  const hints =
    mode.kind === "busy"
      ? []
      : mode.kind === "done"
        ? [{ keys: "any key", action: "continue" }]
        : [
            { keys: "y", action: "install" },
            { keys: "n", action: "skip" },
          ];

  return (
    <Box flexDirection="column" width={columns} height={terminalRows} paddingTop={1}>
      <Banner repoRoot={folder} columns={columns} rows={terminalRows} />

      {terminalRows >= ROOMY_ROWS ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate">
            A child process cannot move the shell that started it, so `grove cd`
          </Text>
          <Text dimColor wrap="truncate">
            needs one line in your shell's rc file to work at all.
          </Text>
        </Box>
      ) : null}

      {mode.kind === "ask" ? (
        <Box borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
          <Text wrap="truncate">
            Add it to {shell}'s rc file now? <Text dimColor>(y/n)</Text>
          </Text>
        </Box>
      ) : null}

      {message !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <MessageView message={message} />
        </Box>
      ) : null}

      <Box flexGrow={1} />

      <StatusBar hints={hints} columns={columns} />
    </Box>
  );
}
