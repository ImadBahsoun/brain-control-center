"use client";
import type { EventsResponse } from "@/lib/api-types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/table";
import { ActivityLine } from "@/components/events/activity-line";

export function EventLog({ events, error }: { events: EventsResponse | null; error: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Event log</CardTitle>
        <span className="label num text-faint">{events ? `${events.events.length} of ${events.total}${events.hasMore ? " (oldest left out)" : ""} · chain ${events.integrity.log}` : (error ?? "")}</span>
      </CardHeader>
      <CardContent className="scroll-thin max-h-[600px] overflow-y-auto p-2">
        {!events ? (
          <Empty>{error ? `error: ${error}` : "loading…"}</Empty>
        ) : events.events.length === 0 ? (
          <Empty>no events</Empty>
        ) : (
          <ol>
            {events.events.map((item) => (
              <ActivityLine key={item.seq} item={item} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
