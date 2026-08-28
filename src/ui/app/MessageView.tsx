import { Text } from "ink";
import { theme } from "../theme.ts";
import { detailLines, type Message } from "./message.ts";

/**
 * A message's rows, without the box around them.
 *
 * The three screens space this differently — one against the list, two against
 * a prompt — so the wrapper stays theirs and only the rows are shared. What is
 * worth sharing is the shape: the sentence in the colour of what happened, then
 * what the failing thing said, then the advice, each dimmer than the last.
 *
 * `messageRows` counts exactly what this draws; a screen that budgets rows and
 * a screen that renders them must not disagree.
 */
export function MessageView({ message }: { readonly message: Message }) {
  return (
    <>
      <Text color={message.kind === "error" ? theme.danger : theme.accent} wrap="truncate">
        {message.text}
      </Text>
      {detailLines(message).map((row) => (
        <Text key={row.id} dimColor wrap="truncate">
          {"  "}
          {row.text}
        </Text>
      ))}
      {message.hint === undefined ? null : (
        <Text dimColor wrap="truncate">
          {message.hint}
        </Text>
      )}
    </>
  );
}
