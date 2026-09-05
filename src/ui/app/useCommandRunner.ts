import { type Dispatch, type SetStateAction, useCallback } from "react";
import type { LineStore } from "../../report/lines.ts";
import { type Message, messageFor } from "./message.ts";
import type { Mode } from "./mode.ts";

/** Every command clears its old output, reports its outcome, and rereads after success or failure. */
export function useCommandRunner(
  store: LineStore,
  refresh: () => Promise<unknown>,
  setMode: Dispatch<SetStateAction<Mode>>,
  setMessage: Dispatch<SetStateAction<Message | undefined>>,
) {
  const busy = useCallback(
    (label: string) => {
      store.clear();
      setMessage(undefined);
      setMode({ kind: "busy", label });
    },
    [store, setMode, setMessage],
  );

  const perform = useCallback(
    async (label: string, action: () => Promise<string>) => {
      busy(label);
      try {
        setMessage({ kind: "info", text: await action() });
      } catch (error) {
        setMessage(messageFor(error));
      }
      try {
        // Failed commands may still have changed the repository.
        await refresh();
      } catch {
        // Keep the action's outcome when the follow-up read fails.
      }
      setMode({ kind: "list" });
    },
    [busy, refresh, setMode, setMessage],
  );

  return { busy, perform };
}
