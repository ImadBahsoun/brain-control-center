"use client";
import { useEffect, useState } from "react";
import type { TasksResponse } from "@/lib/api-types";
import { usePoll, type PollState } from "@/hooks/use-poll";

export const FAST_MS = 2500;
export const SLOW_MS = 15000;

/**
 * The polling cadence every view shares: /api/tasks is probed at the current interval, and the
 * interval is 2.5 s while any task is ACTIVE, WAITING or BLOCKED (counts.active), 15 s otherwise.
 */
export function useCadence(): { interval: number; tasks: PollState<TasksResponse> } {
  const [interval, setIntervalMs] = useState(SLOW_MS);
  const tasks = usePoll<TasksResponse>("/api/tasks", interval);
  const anyActive = (tasks.data?.counts.active ?? 0) > 0;
  useEffect(() => {
    setIntervalMs(anyActive ? FAST_MS : SLOW_MS);
  }, [anyActive]);
  return { interval, tasks };
}
