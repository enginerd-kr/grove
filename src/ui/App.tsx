import { Box, Text, useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import type { Hint } from "./components/StatusBar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { Tabs } from "./components/Tabs.tsx";
import { theme } from "./theme.ts";
import { CounterView } from "./views/CounterView.tsx";
import { LogView } from "./views/LogView.tsx";
import { TaskListView } from "./views/TaskListView.tsx";

type Tab = {
  readonly label: string;
  readonly View: (props: { readonly isActive: boolean }) => ReactElement;
  readonly hints: readonly Hint[];
};

const TABS: readonly Tab[] = [
  {
    label: "Counter",
    View: CounterView,
    hints: [
      { keys: "←/→", action: "adjust" },
      { keys: "r", action: "reset" },
    ],
  },
  {
    label: "Tasks",
    View: TaskListView,
    hints: [
      { keys: "↑/↓", action: "move" },
      { keys: "space", action: "toggle" },
      { keys: "r", action: "reset" },
    ],
  },
  {
    label: "Logs",
    View: LogView,
    hints: [
      { keys: "p", action: "pause" },
      { keys: "c", action: "clear" },
    ],
  },
];

/** Tab names in order. The CLI validates `--tab` against this and lists it in `--help`. */
export const TAB_LABELS: readonly string[] = TABS.map((tab) => tab.label);

const GLOBAL_HINTS: readonly Hint[] = [
  { keys: "1-3/tab", action: "switch" },
  { keys: "q", action: "quit" },
];

type Props = {
  readonly initialTab?: number;
};

/**
 * App shell: owns the active tab and the global keybindings.
 *
 * Every view stays mounted (hidden with `display="none"`) so switching tabs
 * keeps its state; only the visible one listens for input.
 */
export function App({ initialTab = 0 }: Props) {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState(initialTab);

  useInput((input, key) => {
    // Ctrl+C is handled by Ink itself.
    if (input === "q") {
      exit();
      return;
    }

    if (key.tab) {
      const step = key.shift ? TABS.length - 1 : 1;
      setActiveTab((current) => (current + step) % TABS.length);
      return;
    }

    const requested = Number.parseInt(input, 10);
    if (requested >= 1 && requested <= TABS.length) {
      setActiveTab(requested - 1);
    }
  });

  const hints = [...(TABS[activeTab]?.hints ?? []), ...GLOBAL_HINTS];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.muted} paddingX={1} gap={1}>
      <Box justifyContent="space-between">
        <Tabs items={TABS.map((tab) => tab.label)} activeIndex={activeTab} />
        <Text dimColor>ink playground</Text>
      </Box>

      <Box flexDirection="column" minHeight={12}>
        {TABS.map((tab, index) => {
          const isActive = index === activeTab;

          return (
            <Box key={tab.label} display={isActive ? "flex" : "none"} flexDirection="column">
              <tab.View isActive={isActive} />
            </Box>
          );
        })}
      </Box>

      <StatusBar hints={hints} />
    </Box>
  );
}
