import { useEffect, useRef } from "react";

/**
 * Calls `callback` every `delayMs`. Pass `null` to pause without unmounting.
 *
 * The callback is kept in a ref so re-creating it on every render does not
 * restart the timer.
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const saved = useRef(callback);

  useEffect(() => {
    saved.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs === null) return;

    const id = setInterval(() => saved.current(), delayMs);
    return () => clearInterval(id);
  }, [delayMs]);
}
