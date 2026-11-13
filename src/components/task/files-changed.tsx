"use client";
import type { TaskDetail } from "@/lib/api-types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function FilesChanged({ groups }: { groups: TaskDetail["filesChanged"] }) {
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Files changed (from agent reports)</CardTitle>
        <span className="label num text-faint">{total} file(s)</span>
      </CardHeader>
      <CardContent>
        {groups.length === 0 ? (
          <p className="text-faint">none recorded</p>
        ) : (
          groups.map((g, i) => (
            <details key={i} open={i === groups.length - 1} className="mb-1">
              <summary className="cursor-pointer label-md text-dim">
                {g.agent} · round {g.round ?? "—"} · {g.files.length} file(s)
              </summary>
              <ul className="mt-0.5 font-mono text-[11px]">
                {g.files.map((f) => (
                  <li key={f} className="break-all">
                    {f}
                  </li>
                ))}
              </ul>
            </details>
          ))
        )}
      </CardContent>
    </Card>
  );
}
