import { Box, Text, useInput } from "ink";
import { useReducer } from "react";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { SelectList } from "../components/SelectList.tsx";
import { theme } from "../theme.ts";

type Task = {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
};

type State = {
  readonly tasks: readonly Task[];
  readonly selectedIndex: number;
};

type Action = { type: "move"; by: number } | { type: "toggle" } | { type: "reset" };

const INITIAL_STATE: State = {
  tasks: [
    { id: "ink", label: "Install ink and react", done: true },
    { id: "shell", label: "Build the app shell with tabs", done: true },
    { id: "input", label: "Wire up keyboard input", done: false },
    { id: "tests", label: "Test views with ink-testing-library", done: false },
    { id: "ship", label: "Ship the terminal app", done: false },
  ],
  selectedIndex: 0,
};

/**
 * A reducer keeps the cursor and the tasks in one state value.
 * With two `useState` calls, a burst of keys (↓ then space, same tick) would
 * toggle the row the cursor had *before* the move.
 */
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "move": {
      const count = state.tasks.length;
      return { ...state, selectedIndex: (state.selectedIndex + action.by + count) % count };
    }

    case "toggle":
      return {
        ...state,
        tasks: state.tasks.map((task, index) =>
          index === state.selectedIndex ? { ...task, done: !task.done } : task,
        ),
      };

    case "reset":
      return INITIAL_STATE;
  }
}

type Props = {
  readonly isActive: boolean;
};

/** List + selection: `useInput` moves a cursor the reducer owns. */
export function TaskListView({ isActive }: Props) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") dispatch({ type: "move", by: -1 });
      if (key.downArrow || input === "j") dispatch({ type: "move", by: 1 });
      if (input === " " || key.return) dispatch({ type: "toggle" });
      if (input === "r") dispatch({ type: "reset" });
    },
    { isActive },
  );

  const doneCount = state.tasks.filter((task) => task.done).length;

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <ProgressBar value={doneCount / state.tasks.length} width={16} color={theme.ok} />
        <Text dimColor>{`${doneCount}/${state.tasks.length} done`}</Text>
      </Box>

      <SelectList
        items={state.tasks.map((task) => ({
          id: task.id,
          label: task.label,
          prefix: task.done ? "[x]" : "[ ]",
        }))}
        selectedIndex={state.selectedIndex}
      />
    </Box>
  );
}
