"use client";
import { useCadence } from "@/hooks/use-cadence";
import { FindingsBoard } from "@/components/findings/findings-board";

export default function FindingsPage() {
  const { interval, tasks } = useCadence();
  return (
    <div className="mx-auto max-w-[1600px] px-4 py-3">
      <FindingsBoard tasks={tasks.data?.tasks ?? null} interval={interval} />
    </div>
  );
}
