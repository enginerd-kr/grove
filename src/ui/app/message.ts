import { isGroveError } from "../../core/errors.ts";

/**
 * The one line a screen shows after something happened, and the one under it.
 *
 * Shared by the two screens because a refusal reads the same wherever it lands:
 * a `GroveError` was written to be shown to a person and already carries the
 * sentence and the advice, while anything else is a bug here and gets its
 * message printed rather than dressed up as guidance.
 */

export type Message = {
  readonly kind: "info" | "error";
  readonly text: string;
  readonly hint?: string;
};

export function messageFor(error: unknown): Message {
  if (isGroveError(error)) return { kind: "error", text: error.message, hint: error.hint };

  return { kind: "error", text: error instanceof Error ? error.message : String(error) };
}
