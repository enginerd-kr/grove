import { useCallback, useEffect, useRef, useState } from "react";
import type { WorktreeSummary } from "../../core/commands/list.ts";
import type { BranchPullRequest } from "../../core/commands/pr.ts";
import { useInterval } from "../hooks/useInterval.ts";
import type { WorktreeService } from "./service.ts";

export const LOCAL_REFRESH_MS = 2_000;
export const REMOTE_REFRESH_MS = 60_000;

/** Local reads never wait for a network operation. Each background lane allows one request. */
export function useWorktreeRefresh(
  service: WorktreeService,
  paused: boolean,
  localMs = LOCAL_REFRESH_MS,
  remoteMs = REMOTE_REFRESH_MS,
) {
  const [rows, setRows] = useState<readonly WorktreeSummary[]>([]);
  const [pullRequests, setPullRequests] = useState<readonly BranchPullRequest[]>([]);
  const [lastFetched, setLastFetched] = useState<number>();
  const [remoteFailed, setRemoteFailed] = useState(false);
  const [remoteDelay, setRemoteDelay] = useState(remoteMs);
  const mounted = useRef(false);
  const activeService = useRef(service);
  const isPaused = useRef(paused);
  const generation = useRef(0);
  const reading = useRef(false);
  const fetching = useRef(false);
  const askingForge = useRef(false);
  const lastInput = useRef(Date.now());

  useEffect(() => {
    activeService.current = service;
    mounted.current = true;
    reading.current = false;
    fetching.current = false;
    askingForge.current = false;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [service]);

  useEffect(() => {
    isPaused.current = paused;
    // A read started before an action must not paint the state it interrupted.
    if (paused) generation.current += 1;
  }, [paused]);

  const refresh = useCallback(async () => {
    const own = ++generation.current;
    const summaries = await service.list();
    if (mounted.current && own === generation.current) setRows(summaries);
    return summaries;
  }, [service]);

  const readLocal = useCallback(async () => {
    if (reading.current || isPaused.current || !mounted.current) return;
    reading.current = true;
    try {
      await refresh();
    } catch {
      // Keep the last local answer. Explicit actions report their own errors.
    } finally {
      reading.current = false;
    }
  }, [refresh]);

  const readPullRequests = useCallback(async () => {
    if (askingForge.current || !mounted.current) return;
    askingForge.current = true;
    try {
      const found = await service.branchPullRequests();
      if (mounted.current && activeService.current === service) setPullRequests(found);
    } catch {
      // Missing gh or an unavailable forge leaves the previous badges in place.
    } finally {
      if (activeService.current === service) askingForge.current = false;
    }
  }, [service]);

  const fetchRemote = useCallback(async () => {
    if (fetching.current || !mounted.current) return;
    fetching.current = true;
    void readPullRequests();
    try {
      const fetched = await service.fetch();
      if (!mounted.current || activeService.current !== service) return;
      setRemoteFailed(!fetched);
      if (fetched) {
        setLastFetched(Date.now());
        await readLocal();
      }
    } catch {
      if (mounted.current && activeService.current === service) setRemoteFailed(true);
    } finally {
      if (activeService.current === service) fetching.current = false;
    }
  }, [service, readLocal, readPullRequests]);

  useEffect(() => {
    void fetchRemote();
  }, [fetchRemote]);

  useInterval(() => void readLocal(), paused ? null : localMs);
  useInterval(
    () => {
      void fetchRemote();
      setRemoteDelay((current) =>
        Date.now() - lastInput.current < remoteMs * 2
          ? remoteMs
          : Math.min(current * 2, remoteMs * 5),
      );
    },
    paused ? null : remoteDelay,
  );

  const noteInput = useCallback(() => {
    lastInput.current = Date.now();
    setRemoteDelay(remoteMs);
  }, [remoteMs]);

  const age =
    lastFetched === undefined
      ? undefined
      : Math.max(0, Math.floor((Date.now() - lastFetched) / 60_000));
  const remoteStatus =
    age === undefined
      ? "remote: not synced"
      : `remote: ${age === 0 ? "just fetched" : `fetched ${age}m ago`}`;

  return {
    rows,
    refresh,
    noteInput,
    pullRequests,
    remoteStatus: `${remoteStatus}${remoteFailed ? " · offline or unavailable" : ""}`,
  };
}
