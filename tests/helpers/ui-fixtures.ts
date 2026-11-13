// UI-model fixtures: real API bodies produced by the route handlers over temp fixture stores, so the
// command map tests see exactly the JSON production ships. Nothing here is hand-written data.
import type { AgentsResponse, EventsResponse, FindingsResponse, GovernorResponse, HealthResponse, TaskDetail, TasksResponse } from "@/lib/api-types";
import { GET as agentsGet } from "@/app/api/agents/route";
import { GET as governorGet } from "@/app/api/governor/route";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as detailGet } from "@/app/api/tasks/[id]/route";
import { GET as eventsGet } from "@/app/api/tasks/[id]/events/route";
import { GET as findingsGet } from "@/app/api/tasks/[id]/findings/route";
import { GET as tasksGet } from "@/app/api/tasks/route";
import type { CommandMapInput } from "@/lib/ui/command-map";

const H = { headers: { host: "127.0.0.1:3077" } };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

export async function apiDetail(id: string): Promise<TaskDetail> {
  const res = await detailGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}`, H), ctx(id));
  if (res.status !== 200) throw new Error(`detail ${id}: HTTP ${res.status}`);
  return (await res.json()) as TaskDetail;
}

export async function apiFindings(id: string): Promise<FindingsResponse> {
  const res = await findingsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/findings`, H), ctx(id));
  if (res.status !== 200) throw new Error(`findings ${id}: HTTP ${res.status}`);
  return (await res.json()) as FindingsResponse;
}

export async function apiEvents(id: string, limit = 200): Promise<EventsResponse> {
  const res = await eventsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/events?limit=${limit}`, H), ctx(id));
  if (res.status !== 200) throw new Error(`events ${id}: HTTP ${res.status}`);
  return (await res.json()) as EventsResponse;
}

export async function apiTasks(): Promise<TasksResponse> {
  return (await (await tasksGet(new Request("http://127.0.0.1:3077/api/tasks", H), {})).json()) as TasksResponse;
}

export async function apiAgents(): Promise<AgentsResponse> {
  return (await (await agentsGet(new Request("http://127.0.0.1:3077/api/agents", H), {})).json()) as AgentsResponse;
}

export async function apiGovernor(): Promise<GovernorResponse> {
  return (await (await governorGet(new Request("http://127.0.0.1:3077/api/governor", H), {})).json()) as GovernorResponse;
}

export async function apiHealth(): Promise<HealthResponse> {
  return (await (await healthGet(new Request("http://127.0.0.1:3077/api/health", H), {})).json()) as HealthResponse;
}

/** Everything the command map polls, for a focused task (or the idle map when `id` is null). */
export async function mapInput(id: string | null): Promise<CommandMapInput> {
  const [tasks, agents, governor, health] = await Promise.all([apiTasks(), apiAgents(), apiGovernor(), apiHealth()]);
  if (id === null) return { detail: null, findings: null, events: null, tasks, agents, governor, health };
  const [detail, findings, events] = await Promise.all([apiDetail(id), apiFindings(id), apiEvents(id)]);
  return { detail, findings, events, tasks, agents, governor, health };
}
