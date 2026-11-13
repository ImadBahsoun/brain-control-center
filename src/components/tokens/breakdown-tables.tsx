"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import type { TokenAgentRow, TokenMissionRow, TokenModelRow, TokenUnattributedRow } from "@/lib/api-types";
import { agentLabel, formatTokens, formatUsd, reasonLabel, sortByCost, totalCacheWrite } from "@/lib/ui/tokens";
import { Field, Fields } from "@/components/panels/side-panel";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** One row's values below its title line, below 768px, in the same order and labels as the table's columns. */
function Card({ title, right, children }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="border-b border-border px-3 py-2 last:border-0">
      <div className="mb-1 flex items-start justify-between gap-2 text-[12px] text-foreground">
        <div className="min-w-0">{title}</div>
        {right}
      </div>
      <Fields>{children}</Fields>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="hud">
      <div className="border-b border-border px-3 py-1.5">
        <h2 className="hud-title">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function ByModelTable({ rows }: { rows: TokenModelRow[] }) {
  const sorted = sortByCost(rows);
  return (
    <Section title="By model">
      {sorted.length === 0 ? (
        <Empty>no calls in this window</Empty>
      ) : (
        <>
          <div className="max-md:hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Speed</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Input</TableHead>
                  <TableHead>Output</TableHead>
                  <TableHead>Cache read</TableHead>
                  <TableHead>Cache write</TableHead>
                  <TableHead>Unpriced</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => (
                  <TableRow key={`${r.model}-${r.fast}`}>
                    <TableCell className="font-mono whitespace-nowrap">{r.model}</TableCell>
                    <TableCell>{r.fast ? "fast" : "standard"}</TableCell>
                    <TableCell className="num">{formatTokens(r.calls)}</TableCell>
                    <TableCell className="num">{r.priced ? formatUsd(r.costUsd) : "unpriced"}</TableCell>
                    <TableCell className="num">{formatTokens(r.input)}</TableCell>
                    <TableCell className="num">{formatTokens(r.output)}</TableCell>
                    <TableCell className="num">{formatTokens(r.cacheRead)}</TableCell>
                    <TableCell className="num">{formatTokens(totalCacheWrite(r))}</TableCell>
                    <TableCell className="num">{formatTokens(r.unpricedCalls)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="md:hidden">
            {sorted.map((r) => (
              <Card key={`${r.model}-${r.fast}`} title={<span className="font-mono">{r.model}</span>} right={<span className="label text-faint">{r.fast ? "fast" : "standard"}</span>}>
                <Field label="Calls" value={formatTokens(r.calls)} />
                <Field label="Cost" value={r.priced ? formatUsd(r.costUsd) : "unpriced"} />
                <Field label="Input" value={formatTokens(r.input)} />
                <Field label="Output" value={formatTokens(r.output)} />
                <Field label="Cache read" value={formatTokens(r.cacheRead)} />
                <Field label="Cache write" value={formatTokens(totalCacheWrite(r))} />
                <Field label="Unpriced" value={formatTokens(r.unpricedCalls)} />
              </Card>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

export function ByAgentTable({ rows }: { rows: TokenAgentRow[] }) {
  const sorted = sortByCost(rows);
  return (
    <Section title="By agent">
      {sorted.length === 0 ? (
        <Empty>no calls in this window</Empty>
      ) : (
        <>
          <div className="max-md:hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Cache read</TableHead>
                  <TableHead>Cache write</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => (
                  <TableRow key={r.agent}>
                    <TableCell>{agentLabel(r.agent)}</TableCell>
                    <TableCell className="num">{formatTokens(r.runs)}</TableCell>
                    <TableCell className="num">{formatTokens(r.calls)}</TableCell>
                    <TableCell className="num">{formatUsd(r.costUsd)}</TableCell>
                    <TableCell className="num">{formatTokens(r.cacheRead)}</TableCell>
                    <TableCell className="num">{formatTokens(totalCacheWrite(r))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="md:hidden">
            {sorted.map((r) => (
              <Card key={r.agent} title={agentLabel(r.agent)}>
                <Field label="Runs" value={formatTokens(r.runs)} />
                <Field label="Calls" value={formatTokens(r.calls)} />
                <Field label="Cost" value={formatUsd(r.costUsd)} />
                <Field label="Cache read" value={formatTokens(r.cacheRead)} />
                <Field label="Cache write" value={formatTokens(totalCacheWrite(r))} />
              </Card>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

export function ByMissionTable({ rows, titles }: { rows: TokenMissionRow[]; titles?: ReadonlyMap<string, string | null> }) {
  const sorted = sortByCost(rows);
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Section title="By mission">
      {sorted.length === 0 ? (
        <Empty>no attributed calls in this window</Empty>
      ) : (
        <>
          <div className="max-md:hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mission</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Agent-linked</TableHead>
                  <TableHead>Window-linked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((m) => (
                  <Fragment key={m.taskId}>
                    <TableRow className="cursor-pointer" onClick={() => setExpanded(expanded === m.taskId ? null : m.taskId)}>
                      <TableCell className="font-mono whitespace-nowrap">
                        <Link href={`/tasks/${encodeURIComponent(m.taskId)}`} className="text-signal" onClick={(e) => e.stopPropagation()}>
                          {m.taskId}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap" title={titles?.get(m.taskId) ?? undefined}>
                        {titles?.get(m.taskId) ?? <span className="text-faint">—</span>}
                      </TableCell>
                      <TableCell className="num">{formatTokens(m.calls)}</TableCell>
                      <TableCell className="num">{formatUsd(m.costUsd)}</TableCell>
                      <TableCell className="num">{formatTokens(m.attributedBy.agentLink)}</TableCell>
                      <TableCell className="num">{formatTokens(m.attributedBy.window)}</TableCell>
                    </TableRow>
                    {expanded === m.taskId &&
                      m.rows.map((row) => (
                        <TableRow key={`${m.taskId}-${row.agent}-${row.model}`} className="bg-accent/20">
                          <TableCell className="pl-6 text-dim">
                            {agentLabel(row.agent)} · {row.model}
                          </TableCell>
                          <TableCell />
                          <TableCell className="num">{formatTokens(row.calls)}</TableCell>
                          <TableCell className="num">{formatUsd(row.costUsd)}</TableCell>
                          <TableCell />
                          <TableCell />
                        </TableRow>
                      ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="md:hidden">
            {sorted.map((m) => {
              const isOpen = expanded === m.taskId;
              return (
                <li key={m.taskId} className="border-b border-border px-3 py-2 last:border-0">
                  <Link href={`/tasks/${encodeURIComponent(m.taskId)}`} className="font-mono text-[12px] text-signal">
                    {m.taskId}
                  </Link>
                  <p className="mb-1 line-clamp-2 text-[12px] text-foreground" title={titles?.get(m.taskId) ?? undefined}>
                    {titles?.get(m.taskId) ?? <span className="text-faint">—</span>}
                  </p>
                  <Fields>
                    <Field label="Calls" value={formatTokens(m.calls)} />
                    <Field label="Cost" value={formatUsd(m.costUsd)} />
                    <Field label="Agent-linked" value={formatTokens(m.attributedBy.agentLink)} />
                    <Field label="Window-linked" value={formatTokens(m.attributedBy.window)} />
                  </Fields>
                  <button type="button" className="btn mt-2" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : m.taskId)}>
                    Agent rows
                  </button>
                  {isOpen && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {m.rows.map((row) => (
                        <li key={`${m.taskId}-${row.agent}-${row.model}`} className="label flex flex-wrap items-center gap-x-2 gap-y-0.5 text-dim">
                          <span>
                            {agentLabel(row.agent)} · {row.model}
                          </span>
                          <span className="num">{formatTokens(row.calls)}</span>
                          <span className="num">{formatUsd(row.costUsd)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Section>
  );
}

export function UnattributedTable({ rows }: { rows: TokenUnattributedRow[] }) {
  const sorted = sortByCost(rows);
  return (
    <Section title="Unattributed">
      {sorted.length === 0 ? (
        <Empty>every in-window call was attributed to a mission</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reason</TableHead>
              <TableHead>Calls</TableHead>
              <TableHead>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow key={r.reason}>
                <TableCell>{reasonLabel(r.reason)}</TableCell>
                <TableCell className="num">{formatTokens(r.calls)}</TableCell>
                <TableCell className="num">{formatUsd(r.costUsd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
