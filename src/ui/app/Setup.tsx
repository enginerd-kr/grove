import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { RepoPaths } from "../../core/layout.ts";
import type { LineStore } from "../../report/lines.ts";
import { StatusBar } from "../components/StatusBar.tsx";
import { StepRow } from "../components/StepRow.tsx";
import { theme } from "../theme.ts";
import { Banner } from "./Banner.tsx";
import { type Message, messageFor } from "./message.ts";
import type { SetupService } from "./service.ts";

/**
 * `garden` in a folder with no repository in it.
 *
 * Discovery failing used to end the process with "no worktree repository found",
 * which is true and unhelpful: the answer is always the same one command, and
 * the app is already the place that runs commands for you. So the screen opens
 * anyway and asks the only question there is — which repository — then does what
 * `garden clone` does: a bare clone, the fetch refspec a bare clone omits, and
 * the default branch checked out as the first worktree.
 *
 * It becomes the app the moment that finishes. The two are separate components
 * rather than another `mode` because they share nothing but the banner: there is
 * no list to move a cursor through here, and no repository for the keys to act
 * on until this screen has made one.
 */

/** The most progress worth keeping on screen; older lines scroll out of it. */
const ACTIVITY_ROWS = 6;

/** Below this the explanation goes; the prompt and the keys are what must fit. */
const ROOMY_ROWS = 16;

// `busy` carries the URL too, so the thing being cloned stays on screen while it
// is being cloned — the prompt is the only place it is written down.
type Mode =
  | { readonly kind: "ask"; readonly value: string }
  | { readonly kind: "busy"; readonly value: string };

type Props = {
  readonly service: SetupService;
  /** The folder the app opened in — where the repository is about to go. */
  readonly folder: string;
  /** True when the folder itself becomes the repository, false when it gains one. */
  readonly inPlace: boolean;
  readonly store: LineStore;
  /** Called once there is a repository; the app takes over from here. */
  readonly onReady: (paths: RepoPaths) => void;
  /** Ctrl-C while cloning: stop the git child before the screen goes away. */
  readonly onCancel?: () => void;
};

export function Setup({ service, folder, inPlace, store, onReady, onCancel }: Props) {
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [mode, setMode] = useState<Mode>({ kind: "ask", value: "" });
  const [message, setMessage] = useState<Message | undefined>(undefined);

  const lines = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  const clone = useCallback(
    async (url: string) => {
      store.clear();
      setMessage(undefined);
      setMode({ kind: "busy", value: url });

      try {
        const { paths } = await service.clone(url);
        // Not `setMode` afterwards: this screen is done, and the parent swapping
        // it for the app is what unmounts it.
        onReady(paths);
      } catch (error) {
        setMessage(messageFor(error));
        // The URL is kept rather than cleared. A refusal here is almost always a
        // typo in a long string, and retyping it from scratch is the wrong ask.
        setMode({ kind: "ask", value: url });
      }
    },
    [service, store, onReady],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel?.();
      exit();

      return;
    }

    if (mode.kind === "busy") return;

    if (key.escape) return exit();
    if (key.return) {
      const url = mode.value.trim();
      if (url.length === 0) return;

      return void clone(url);
    }
    if (key.backspace || key.delete) {
      return setMode({ kind: "ask", value: mode.value.slice(0, -1) });
    }
    // Printable input only, and taken whole: a pasted URL arrives as one chunk,
    // while an arrow key arrives as a control sequence that would otherwise type
    // itself into the middle of it.
    if (input.length > 0 && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
      return setMode({ kind: "ask", value: mode.value + input });
    }
  });

  const activity = lines.slice(-ACTIVITY_ROWS);
  const hints =
    mode.kind === "busy"
      ? [{ keys: "ctrl+c", action: "cancel" }]
      : [
          { keys: "enter", action: "clone" },
          { keys: "esc", action: "quit" },
        ];

  return (
    <Box flexDirection="column" width={columns} height={terminalRows} paddingTop={1}>
      <Banner repoRoot={folder} columns={columns} rows={terminalRows} />

      {terminalRows >= ROOMY_ROWS ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate">
            {inPlace
              ? "This folder is empty, so it becomes the repository."
              : "There are things here already, so the repository goes in a folder of its own."}
          </Text>
          <Text dimColor wrap="truncate">
            garden clones it bare and checks out the default branch as the first worktree.
          </Text>
        </Box>
      ) : null}

      <Box
        borderStyle="round"
        borderColor={mode.kind === "busy" ? theme.muted : theme.accent}
        paddingX={1}
        marginTop={1}
      >
        <Text wrap="truncate">
          <Text dimColor>repository </Text>
          <Text color={theme.accent}>{mode.value}</Text>
          {mode.kind === "busy" ? null : <Text inverse> </Text>}
        </Text>
      </Box>

      {message !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={message.kind === "error" ? theme.danger : undefined} wrap="truncate">
            {message.text}
          </Text>
          {message.hint === undefined ? null : (
            <Text dimColor wrap="truncate">
              {message.hint}
            </Text>
          )}
        </Box>
      ) : null}

      {/* Everything above is pinned to the top and the keys to the bottom, so a
          clone's progress appearing does not shove the prompt up the screen. */}
      <Box flexGrow={1} />

      {activity.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {activity.map((line) => (
            <StepRow key={line.id} line={line} truncate />
          ))}
        </Box>
      ) : null}

      <StatusBar hints={hints} columns={columns} />
    </Box>
  );
}
