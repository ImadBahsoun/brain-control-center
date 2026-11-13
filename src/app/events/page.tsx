"use client";
import { useCadence } from "@/hooks/use-cadence";
import { EventFeed } from "@/components/events/event-feed";

export default function EventsPage() {
  const { interval, tasks } = useCadence();
  return (
    <div className="mx-auto flex h-[calc(100dvh-44px)] max-w-[1600px] flex-col px-4 py-3">
      <EventFeed tasks={tasks.data?.tasks ?? null} interval={interval} />
    </div>
  );
}
