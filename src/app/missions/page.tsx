"use client";
import type { GovernorResponse } from "@/lib/api-types";
import { useCadence } from "@/hooks/use-cadence";
import { usePoll } from "@/hooks/use-poll";
import { MissionList } from "@/components/missions/mission-list";

export default function MissionsPage() {
  const { interval, tasks } = useCadence();
  const governor = usePoll<GovernorResponse>("/api/governor", interval);
  return (
    <div className="mx-auto max-w-[1600px] px-4 py-3">
      <MissionList tasks={tasks.data} governor={governor.data} error={tasks.error} interval={interval} />
    </div>
  );
}
