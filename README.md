# brain-control-center

A local, **read-only** command center over the Brain: task logs and caches under `~/.claude/state/brain`,
the governor policy `~/.claude/brain/governor.json`, and brain-gate's `~/.claude/state/brain-gate`.
Seven views: **Command map** (`/`, the default), **Office** (`/office`), **Missions** (`/missions`),
**Findings** (`/findings`), **Events** (`/events`), **Approvals** (`/approvals`) and **Tokens** (`/tokens`),
plus a mission detail page at
`/tasks/<id>` with the 17-step lifecycle path, the same map for that mission, agent runs, findings,
validation, files changed and the event log.
"Mission" is the UI word for a task; task ids stay visible everywhere.

It never writes, locks, starts a process, or calls `brain-state`, `brain-governor` or `brain-gate`.
There are no actions in the UI: the Commander Gate shows an approval request, never a control.

### The command map

The map is an SVG over the unchanged `/api/*` bodies; every node, connection, meter and threat marker
carries a `source` naming the API field it was derived from (shown in its panel). The Brain core sits in
the middle because the Brain dispatches every agent and receives every report, so the connections are:

- core → Planner (mission brief), Planner → Developer (plan, with the plan-gate lock), Developer → core
  (implementation report), core → QA / Reviewer / Security Reviewer (dispatch), each validator → Synthesis
  (report, routed around the right column), Synthesis → READY, READY → Commander Gate, and Synthesis →
  Developer (fix loop, drawn only when a fix round exists).
- Connection states (a role's state comes from its latest run on the focused mission,
  `/api/tasks/<id>.agents`; step-derived connections come from `lifecycle.steps`):

  | State | Drawn as | Moves |
  |---|---|---|
  | ACTIVE (running) | cyan, particles flowing toward the target | live and replay only |
  | COMPLETED | solid green | never |
  | SYNTHESIS | purple: a delivered report (E7–E9) while the mission is SYNTHESIZING | slow purple flow, live and replay only |
  | PENDING | dim dotted | never |
  | WAITING APPROVAL | amber, pulsing | live and replay only |
  | BLOCKED | red with a warning glyph | never |
  | FAILED | broken red with a cross | red pulse, live and replay only |
  | SKIPPED | faint, labelled SKIPPED | never |
  | UNKNOWN | grey with a question mark | never |

  Particles cross an edge at 240 world units a second (1.2–4.5 s per pass). When a mission is BLOCKED
  in a validation step, only the validators that were dispatched (or have a run) turn red.
- "Running" means a run is **reserved with no report yet**: the Brain records no liveness. A reservation
  older than the governor's stale threshold is drawn static amber ("over stale threshold").
- Modes: **live** (an ACTIVE, WAITING or BLOCKED mission, the newest by last event, or the one picked in
  the mission bar), **debrief** (a terminal mission picked from Recent missions; its recorded history, no
  flow), **idle** (no active mission: every connection dormant, roles IDLE, resource pips empty),
  **replay** (Mission Replay of a debriefed mission, below). A mission that completes while auto-focused
  stays on the map until its terminal detail has been shown (READY and mission-complete play), then
  releases on the first `/api/tasks` poll at least 2 s after that; the immediate refetch when the poll
  cadence drops to 15 s does not count, and the hold ends after 3 polls at most.
- Agents: each role node shows its step number, emblem, title, archetype · model class · policy units
  per run, its state word (IDLE, ACTIVE, COMPLETED or the recorded verdict, RESERVED · STALE …) followed
  by a dim activity from the same runs ("ACTIVE · reserved", "ACTIVE · reserved · r1", "PASS WITH
  CONCERNS · r0", "IDLE · last #0005"); the mission number (`#0002`) sits in the circle when the role has
  a run on that mission. A pending run reads "reserved": the node never claims the agent is working, and
  the verb ("implementing", "fixing (round 1)") is in the HUD, the panel and the node's accessible name.
  Units come from the policy, else from the latest launched run (a refunded run's 0 is never shown).
- Atmosphere: one phase per real state, as a tint under the map and the core's colour (the HUD shows it
  as a word): standby (no mission, dim), build (classifying, planning, implementing, fixing; cyan), scan
  (testing, or validating while QA holds a reservation; blue, with a radar sweep), analysis (reviewing,
  synthesizing, or validating without QA; purple), awaiting commander (amber), blocked (red, pulsing),
  ready / complete (green; the completion pulse is the one-shot READY / mission-complete effect). The
  security reviewer's node gets a shield aura while it holds a reservation. While a mission is live or
  replayed the core's outer ring turns and its status dot blinks; its inner ring counter-turns and it
  pulses only while a reservation that is not stale is held. On the idle map it turns once in two
  minutes with three slow motes; a debrief core is still.
- Mission HUD: mission number and id, title, class, `Round r/max`, the governor share of the class
  budget (`usage.percentOfClassBudget`), then dim `Elapsed 12m · ETA ~5–14 min · Agents n/max` (a COMPLETE
  or CANCELLED mission shows its total instead: `COMPLETE · 31m total`, `CANCELLED · 5m total`), status.
  The ETA is an **estimate, not a guarantee** (`/api/tasks` `tasks[].eta`, computed on read by
  `src/lib/eta.ts` from the log, the runs, the newest 20 COMPLETE missions' run times and the clock;
  the same rules as `brain-governor status`, documented in the orchestration skill's governor.md "ETA").
  It assumes the current pass succeeds, does not predict approval waits or fix rounds, and reads
  `ETA paused …`, `ETA blocked — waiting for available agent`, `ETA unknown …`, `ETA calculating…` or
  `ETA complete` when there is no range to give; it is hidden in a replay. Agents n/max is the ACTIVE
  AGENTS meter (`/api/governor`), shown where the governor is polled (the command map). The Missions
  view shows the same ETA label on each active row and the total on COMPLETE and CANCELLED rows. The
  runs, triggers and round epoch come from the mission's `state.json`; when a non-terminal mission's
  `state.json` is not usable (missing, invalid, ahead or diverged) the ETA reads `ETA calculating…`
  ("state.json not usable; runs unknown"), never a number. This rule is the dashboard's own (`status` reads the log). Below: a segmented **pipeline** bar that counts the lifecycle
  steps reached from RECEIVED to READY (post-READY steps once reached), which is not time or effort; and
  the **current action**: the Commander Gate, BLOCKED and its reason, each pending run as "<Role>
  <verb> · reserved, awaiting report", the Brain's own steps, READY, completion, or the recorded next
  action.
- Mission feed (left column): the newest 12 activity lines of the focused mission, as recorded, with a
  role emblem or a glyph. The tests and files an agent reported are listed under that agent's
  completion line for the same round ("reported at completion"); reports whose line is not shown are
  counted, never placed elsewhere, and when the agent completed more than once in that round (a rerun, or
  a lost run relaunched) its reports are not tied to either line and are counted as such.
- Mission Replay: a debriefed COMPLETE or CANCELLED mission with a readable log and a usable state.json
  offers **Replay mission**. Opening it loads the newest 1000 events (once per visit to that mission;
  re-opening reuses them) and steps through them (one step per activity line, each with its recorded seq
  and timestamp) under a REPLAY label: play / pause, ±1 step, first / last, a scrubber, speed 1× / 2× /
  4×, Exit (or Esc inside the controls); focus returns to the button. Each frame is rebuilt from
  structured fields only (event seq / ts / type / role / round, lifecycle transitions, run start and
  report times, finding ids and history), never from activity text, and nothing appears before its own
  log line. Findings appear at their own creation line (finding ids are numbered in creation order); a
  finding status change appears with the last finding update recorded in the same millisecond, so in a
  large batch it can show many steps late, never early. Nothing in a replay claims the present: the core
  reads REPLAY, a gate that was waiting reads AWAITED APPROVAL, there is no ACTION REQUIRED strip, the
  current action is told in the past tense, and replayed effects are announced to screen readers only
  while paused, prefixed "Replay:". Not in a replay: governor usage, budgets and global slots at the time
  (the HUD says "not recorded per step"), classification, classification reason and risk (the final
  values are shown), the next action, validation records, what a blocked mission needed, the plan scope
  before approval and HEAD at the time, finding text edits (titles are the final wording), which of
  several completions in one round reported a test or file (shown with the last), wall-clock pacing,
  stale flags, and other missions or health. A store with more than 1000 events replays from the first
  loaded one, and says so.
- Motion: continuous loops encode only a current real state (running, waiting approval, a failed run,
  synthesis, the current step, the core while a reservation is active, the scan sweep, the blocked
  pulse, the core's outer ring and status dot) and run only live or in a replay; a debrief draws nothing
  moving and the idle map only its ambient core. One-shot effects fire only on a change between two polls of the same mission (agent
  start/report, finding created/resolved, step change, gate raised, blocked, READY, complete), or on a
  single replay step forward; nothing animates on first load, on a mission switch or when a poll returns
  no change. Keyframes touch only transform, opacity and offset-distance, and every animated rule is a
  `.loop` or `.fx` element; under `prefers-reduced-motion: reduce` no animation runs (a replay opens
  paused) and every state remains readable as text plus styling. No SVG filters are used. Text on the
  map is at least 16 world units (17 for the core's state word), which is at least 11 px at a 1440×900
  window, and no HTML text is below 11 px.
- Findings sit as threat markers in a lane beside their anchor (the first recognised role among the
  finding's sources; `brain` and unknown sources anchor to the core): at most three per anchor, the
  third slot becoming a "+n MORE" chip that opens the anchor's panel (the core's panel lists the
  findings anchored to it). Every marker shows the finding id and
  the severity word; the rail and the mission detail list every finding.
- The Commander Gate: while a mission waits on the commander (WAITING_FOR_APPROVAL or HUMAN_APPROVAL)
  the mission bar shows an ACTION REQUIRED strip with the request line and a Review button that only
  opens the read-only gate panel; the Gate node reads ACTION REQUIRED and the plan-gate lock pulses (a
  replay shows neither the strip nor ACTION REQUIRED).
- Zoom and pan: drag, `+`/`-`, arrow keys, `0` and the Reset button. On the full-height map view a
  plain wheel zooms; on a scrolling page (the mission detail, or the map view below 1100 px) only
  Ctrl/⌘ + wheel zooms and touch scrolls the page. Every node, connection, threat marker and the gate is
  a keyboard button; Enter opens its panel, Esc closes it and focus returns to the element that opened
  the first panel.

Requests per poll (the cadence is 2.5 s while any task is active, 15 s otherwise): map live 7 (tasks,
health, agents, governor, detail, findings, events); map idle 4; debrief 4 plus 3 one-shot (plus 1
one-shot `events?limit=1000` the first time a replay is opened during a visit to that mission; the mission detail page
replays from the events it already holds); Missions 2;
Findings 1 plus one per non-terminal mission in scope plus up to 8 one-shot; Events 1 plus up to 3;
mission detail 3 at 2.5 s, stopping once the mission is terminal.

### The office

`/office` has two modes (see "Global Office and Mission Office" below). In its Mission Office mode it
draws the same focused mission as the command map (live, debrief, idle, loading or replay) as an
isometric office: a second presentation of the same model (`src/lib/ui/office.ts` over `buildCommandMap`),
with the same mission bar, HUD, feed, Recent missions, replay controls, threat rail, mission path and
panels. It makes exactly the same requests as the map. The chosen mission is kept per view (no URL state),
so switching tabs starts on auto focus.

- Rooms, clockwise round the Brain core: PLANNING (Planner), BUILD (Developer), QUALITY (QA), REVIEW
  (Reviewer), SECURITY (Security Reviewer) and COMMANDER GATE / RELEASE. The connections are the map's
  twelve, on the office floor (the plan corridor PLANNING → BUILD carries the plan-gate lock; reports run
  to the synthesis console at the core's rim; READY → commander console runs inside the gate room and is
  drawn above its floor, so its state, pulse and focus ring show and it stays clickable). Each card sits on
  the outer side of its room and the core's sign at the top centre, so no card covers a connection's glyph,
  the ring round the core or a walking token's path.
- One figure per role, a geometric silhouette with the role emblem as a badge. It **sits at its desk only
  while the role holds a pending run on the focused mission** (the map's ACTIVE: reserved, awaiting
  report); otherwise it stands and its card reads IDLE or the real state word. A reservation over the stale
  threshold sits amber and still. A seated figure gets only a soft monitor glow, never typing or other
  motion: a reservation is not proof of work. The gate room has no figure: an empty commander console with
  a lock (the gate has no control here) and four release consoles lit from `lifecycle.steps`.
- Seats: **one desk per role room**. The governor has no per-role-per-mission limit: `max_validators` is
  one pool shared by QA, Reviewer and Security across all missions, and `max_developers` and
  `maxParallelPerTask` do not map onto rooms either, so drawing 3 desks per validator room would show 9
  seats for 3 slots. If a role ever holds more than one pending run, its card reads `2 reserved` and the
  figure gets a `×2` badge. The global lanes stay in the HUD, the panels and the scene's text version.
- Card numbers (anything unavailable shows `—`; every item carries a `source`):

  | Room | Header | Rows |
  |---|---|---|
  | PLANNING | `n/1 busy` (pending runs, `/api/tasks/:id agents`) | RUNS (completed runs), LAST (latest reported verdict; idle: the role's latest run anywhere and its mission number, `/api/agents recent`), TYPICAL |
  | BUILD | same | RUNS, FIX ROUNDS (`rounds.length/maxRounds`), TYPICAL |
  | QUALITY / REVIEW / SECURITY | same | LAST, OPEN FINDINGS (open findings naming the role), TYPICAL |
  | COMMANDER GATE | the gate word | PLAN GATE, HUMAN GATE, RELEASE (`k of m` of COMMITTING, PUSHING, PR, DEPLOYING completed, skipped excluded) |

  TYPICAL is the median duration of completed runs with a positive duration in `/api/agents.recent` (the 20
  newest finished runs of **all missions and projects** in the store: open missions and the 5 newest
  missions) and the focused mission's runs, deduplicated, with `n=`; the room's accessible name and the text
  version say so ("typical 45m 32s (recent runs of all missions and projects, n=4)"). It is `—` in a replay
  (not part of the recorded history). A value too long for its row gets a line of its own and is shortened
  only at a word boundary; gate words are always whole. RELEASE reads `skipped` when every release step was
  skipped, `—` only without data. A role whose state is UNKNOWN (unusable integrity) reads `—/1 busy`. While a gate waits,
  a `WAITING ON YOU` card counts from the recorded APPROVAL_REQUESTED time and names the gate (without a
  request event it still names it; a replay shows `AWAITED APPROVAL · recorded`, no timer).
- Walking tokens: a `#0002` token walks **only on a real handoff**: an agent start or a raised gate between
  two polls of the same mission, or a single replay step forward. It walks from the role whose run finished
  last before the new run started (else from the core) to the new role's door, round the core
  (planner → developer takes the plan corridor; a developer fix round walks from synthesis along the fix
  loop); at most four at once, 2.4 s live and 0.85 of the step time in a replay. One-shot flashes, like
  tokens, belong to the mission shown: nothing of the previous mission flashes after a switch. Nothing walks on first load, a reload, a mission switch, an unchanged poll, or a seek
  or step backwards.
- Motion follows the map's rules: the core's slow ambient turn only on the idle floor, an orbit while live
  or replayed, a pulse while a reservation is fresh; a debrief or loading office is still. Under
  `prefers-reduced-motion` nothing moves: a token becomes a static two-line `#0002 / ← Planner` chip above
  the destination room (clear of desks, cards and the sign) while its effect lasts, and the live announcer
  says the same in words.
- Keyboard: connections first, then the rooms, the gate room, the core, the synthesis and READY consoles;
  Enter or Space opens the map's panel for it, Esc returns focus. A screen-reader text version lists every
  room, the core, the gate, the walking tokens and every connection. The window city and room decor are
  static and carry no data. Card text is 15–16 world units, at least 11 px at a 1440×900 window.

#### Global Office and Mission Office

A toggle under the scene (two pressed-state buttons, 44 px high) switches `/office` between the **Global
Office** (every open mission at once) and the **Mission Office** (the focused mission, exactly as described
above). The choice is remembered per browser in `localStorage` (`bcc.office.mode`, values `global` or
`mission`); a first visit, an unrecognised value or blocked storage gives the Global Office, and a choice that
cannot be stored still holds for the page session. Entering the Global Office ends a running replay. It adds no
requests: it draws from the `/api/agents`, `/api/tasks` and `/api/governor` polls the view already makes.

- Who is in a room: one figure per **pending run** in `/api/agents` `active` of any non-terminal mission
  (ACTIVE, WAITING, BLOCKED, CORRUPT, INCOMPLETE), and one per role of a **recorded concurrency wait** in
  `/api/agents` `queued`. A mission's lifecycle state never puts anyone in a room: an IMPLEMENTING mission
  with no pending run leaves BUILD empty. Up to 3 figures sit in a row per room and up to 2 queued figures
  stand in a line outside its door; the rest are one `+k` marker that opens that role's roster group. Each
  figure carries its mission tag (`#0007`) and opens `/tasks/<id>` (click, Enter or Space).
- Status words: **running** = a reservation recorded with no report yet (a soft glow; it is not proof the agent
  is working); **over stale threshold** = pending for longer than `stale_after_minutes` (240), amber and still,
  never counted as capacity; **queued** = the governor denied the launch for concurrency and no agent start,
  completion or state change has been recorded since. Finished runs (completed, lost, not-launched) appear only
  under "recently finished" in the roster, never as figures.
- `/api/agents` `queued` is an additive, allowlisted projection of the task's governor NOTEs
  (`[governor] DENIED CONCURRENCY <roles>:` and `[governor] WAIT started/ended …`): the task id, the denied
  roles (only the five agents), the denial's seq and time, the latest wait after it (start, timeout, end and
  its outcome word CLEAR, TIMEOUT, DENIED, ERROR or INTERRUPTED) and whether it is past the stale threshold. No
  note text, session id or active-run list is projected. A queued launch older than the threshold reads
  "denied … ago, no launch since"; a wait past its timeout with no end reads "wait started, no end recorded".
- The roster (an HTML column beside the scene, a 45% panel under it below 1024 px, foldable and remembered as
  `bcc.fold.roster`) lists every instance by role with its mission, repo label (computed over the full mission
  list), status chip and live elapsed time on the server's clock (so a device with a wrong clock still counts
  right), linking to `/tasks/<id>`. The capacity strip under the scene shows active / limit for the total,
  developers, validators, opus and fable from `/api/governor`, the stale runs left out and the per-mission
  limit, and stays visible in Focus Mode. The gate room is decor with `/api/tasks` `counts.waitingApproval`.
- Not known, and so never shown: **no liveness data** (nothing records a heartbeat, so the UI never says
  "disconnected"); **no queue position** (the governor polls and keeps no order); **recently finished is capped
  at the 20 newest finished runs** of `/api/agents` `recent`. Switching modes remounts the scene, so its pan
  and zoom reset; Focus Mode never does.

## Commands

```sh
pnpm install            # exact pins in package.json / pnpm-lock.yaml (pnpm 10; build scripts stay unapproved)
pnpm typecheck          # next typegen && tsc --noEmit
pnpm test               # vitest, against temp fixture stores only (HOME is redirected in tests/setup.ts)
pnpm build              # next build
pnpm start              # the supported way to watch the real store: http://127.0.0.1:3077 (production build)
pnpm dev                # development only (fixture work); see "Running it safely"
```

The supported URL is `http://127.0.0.1:3077`. `localhost:3077` is accepted in the `Host` header. A
single tailnet hostname over Tailscale Serve is also accepted, but only when configured (see "Tailnet
access (Tailscale Serve)" below); it is otherwise refused like any other host.

### Running it safely

- **Run only through `pnpm start`** (and `pnpm dev` while developing). Both scripts pass `-H 127.0.0.1`.
  Never run `next start` or `next dev` by hand without `-H 127.0.0.1`: Next's default bind is `0.0.0.0`,
  which exposes the API to the LAN, and `-H` has no environment-variable fallback.
- **The Host/Origin checks stop browsers, not local processes.** There is no authentication. Any process
  on this machine that can open a TCP connection to `127.0.0.1:3077` and send `Host: 127.0.0.1:3077` can
  read the redacted API: other OS users, sandboxed apps, browser extensions with localhost access, and
  Docker Desktop containers via `host.docker.internal`. What they get is the projected, redacted view
  (task titles, findings, test commands, paths with `~`), never packets, reports, plan text or sessions.
  Gate codes are never read from brain-gate's files; a code written into Brain text is masked only in the
  `approve X` and `code X` forms (see Limitations). Stop the server when you are not watching it.
- **`pnpm dev` is for development only**, against fixture stores, not for watching the real store. Dev
  mode adds Next.js endpoints that the API guard does not cover (`/__nextjs_*` such as the launch-editor
  and source-map endpoints, protected only by Next's own Origin check), and it may contact the npm
  registry for version checks.
- A per-launch random access token (printed URL plus cookie, checked in `withApi`) is a possible
  follow-up; it is not implemented.

### Tailnet access (Tailscale Serve)

- Set `BCC_TAILNET_HOST=<machine>.<tailnet>.ts.net` in a gitignored `.env.local` to also answer requests
  addressed to that one tailnet hostname (exactly `<machine>.<tailnet>.ts.net`, no scheme, port, path or
  wildcard). Unset, blank or malformed, the tailnet host is refused like any other.
- Publish the port on the tailnet only: `tailscale serve --bg 3077`. Never use `tailscale funnel`, which
  would expose the dashboard to the public internet.
- Use `pnpm start`, not `pnpm dev`, over Tailscale Serve: dev mode's HMR WebSocket does not reach the
  tailnet hostname, which causes a reload loop, and its `/__nextjs_*` endpoints (outside the API guard)
  would be reachable by any tailnet client.
- Any device your tailnet's ACL lets reach this machine can read the redacted API over that hostname,
  the same read-only, projected view described above. Verify nothing is exposed beyond the tailnet with
  `tailscale funnel status`.

### Changing the port

The port is defined in two places and both must change together:

- `PORT` in `src/server/http.ts` (also the `ALLOWED_HOSTS` set derived from it)
- the `-p 3077` in the `dev` and `start` scripts of `package.json`

## Read-only guarantees

- The only file-system APIs imported under `src/` are `lstat`, `realpath`, `readdir` and `open(..., O_RDONLY | O_NOFOLLOW)`.
  A static check enforces it (`tests/unit/readonly.test.ts`, and the grep below).
- Readers take no locks and never `fchmod` (brain-state's own reader does; a dashboard must not).
- A read-only test hashes every fixture file (content, size, mtime) before and after calling every reader
  and every route, and checks that no file appeared.
- The real store is verified the same way by hand (see "Fingerprint check").

## Security model

- The server binds `127.0.0.1` only. Every `/api/*` route refuses requests whose `Host` is not
  `127.0.0.1:3077` or `localhost:3077` (403 `FORBIDDEN_HOST`), whose `Origin` is present and not
  `http://` plus one of those (403), or that carry `Sec-Fetch-Site: cross-site` (403). `X-Forwarded-*`
  and `Tailscale-User-*` are ignored. No CORS headers are ever set. Responses carry `Cache-Control: no-store`.
- When `BCC_TAILNET_HOST` names one tailnet hostname (`<machine>.<tailnet>.ts.net`, validated and
  normalized on every request, not cached at build time), that exact `Host` is also allowed, and its
  `https://` origin is also an allowed `Origin`; no port, scheme other than `https`, suffix, prefix or
  userinfo variant is accepted. The setting fails closed: unset, blank or malformed, the tailnet host is
  refused exactly like any other foreign host.
- Pages are client shells: the HTML contains no Brain data; everything comes from `/api/*`, so the
  guard covers every data path. In production (`pnpm start`) the pages and `/_next/static/*` remain
  reachable through DNS rebinding but hold nothing. In dev mode Next adds its own `/__nextjs_*`
  endpoints outside the guard (see "Running it safely"), which is why dev is not for the real store.
- The guard is a browser boundary only: it does not authenticate local processes (see "Running it safely").
- Task ids are validated against `^BR-[0-9]{8}-[0-9]{4,6}$` (ASCII, max 20 chars) before any path is
  built; file names come from a fixed allowlist (`events.jsonl`, `state.json`, `governor.json`,
  `audit.jsonl`). Every directory is `lstat`ed (no symlink, a directory, same uid) and its `realpath` must
  equal the expected path. Files are opened with `O_NOFOLLOW`, `fstat`ed on the handle (regular file,
  same uid, `nlink === 1`, within a size cap) and read from that handle only. Anything else is reported as
  `unsafe` and never read.
- Projection first: every response is built from explicit, allowlisted fields. Agent packets and reports,
  the verbatim request, plan text, session ids, gate approval codes, gate request contents (`task`,
  `brain_line`, `display`, `inputs`, `envs`, `cwd`, `approval_uuid`), audit `command`/`code`, and
  `complete_content` are never read into any response. brain-gate appears as aggregates inside
  `/api/health` and, per request, in `/api/approvals`.
- **brain-gate requests (`/api/approvals`).** Only the values of gate `state.json`'s `requests` object are
  iterated: its keys are live approval codes and are never read. From each value only `actions`,
  `created`, `expires`, `consumed_at`, `revoked_at` and `repos[].top`/`repos[].head` are read; the
  request's session, agent id, `display`, `cwd`, `inputs`, `envs`, `task`, `brain_line`, `input_sha256`,
  `approval_uuid` and `approval_prompt_id` are not. From brain-state gate `APPROVAL_REQUESTED` events only
  the task id, `ts` and `payload.repo`/`head`/`actions` are read, never `gate_code` or `command` (the
  session is already dropped at parse time). Emitted per request: actions, repositories (home-masked),
  expiry, status and the mission id when provable; heads, `created` and resolution times are used on the
  server only. This makes **per-request status visible to any local process and to tailnet readers**
  (see "Running it safely" and "Tailnet access"); no code is exposed, so it grants nothing: approving
  still needs the Claude Code session that raised the request.
- Redaction second: `json()` runs a port of brain-state's redactor over every string in every response,
  keys included, before clipping, then replaces the home directory with `~` and escapes control, line
  separator and bidi characters.
- Size caps: `events.jsonl` 32 MiB (tail 256 KiB), task `state.json` 8 MiB, `governor.json` 64 KiB, gate
  `state.json` 4 MiB, `audit.jsonl` tail 512 KiB. The task scan is capped at the 200 most recent ids.
- **New read surface: `~/.claude/projects`.** Token Intelligence adds this as a second root, read with the
  same no-follow, owner-only, single-link, regular-file checks as everything else, but file and directory
  names are checked against a fixed pattern (a project directory name; a session-UUID `.jsonl` file for a
  main session; a session-UUID DIRECTORY with no suffix — confirmed from a live transcript path — holding
  the literal `subagents`, `agent-<id>.jsonl`, `agent-<id>.meta.json`) instead of a fixed allowlist, since
  transcript names vary per session and subagent. `tool-results/`, `memory/` and any other entry are
  never opened.
  This makes local Claude Code usage aggregates readable by any local process that can reach
  `127.0.0.1:3077`; only numbers and fixed labels are exposed (no project names, session ids, or
  transcript content), which the security reviewer should weigh against that exposure. A 20,000-file cap
  and a 31-day mtime filter bound the scan; a line over 64 MiB is discarded, never buffered past the cap.

## Endpoints (GET only; other methods get 405)

| Path | Body |
|---|---|
| `/api/health` | status (`ok`/`degraded`/`unavailable`), task-store counters, governor status, gate aggregates |
| `/api/tasks` | task summaries (newest first), each with its `eta` (an estimate, not a guarantee), counts, scan info |
| `/api/tasks/<id>` | full task detail with the lifecycle view, agents, validation, files changed, usage |
| `/api/tasks/<id>/events?limit=` | activity lines (1–1000, default 200, newest last), `hasMore` |
| `/api/tasks/<id>/findings` | the findings ledger with history and resolution |
| `/api/agents` | pending runs (non-terminal tasks), recent completed runs, global limits |
| `/api/governor` | policy, global usage, per-task usage, denials, soft-limit acceptances |
| `/api/version` | `name` and `version` of the dashboard (a fixed constant; reads nothing) |
| `/api/tokens?window=7d\|30d` | Token Intelligence: cost and token usage by model, agent and mission, context/rebuilds, handoff and instruction-read metrics, reconciliation and coverage (see "Token Intelligence" below) |
| `/api/approvals` | Approval Center: one row per brain-gate request (newest first) with its actions, repositories, expiry, status (`pending`/`consumed`/`expired`/`revoked`) and a mission link or `null` (Unlinked); counts, `linking` (`ok`/`unavailable`) and the gate state status (see "Approval Center" below) |

Errors: 400 `BAD_TASK_ID` / `BAD_LIMIT` / `BAD_WINDOW`, 403 `FORBIDDEN_HOST` / `FORBIDDEN_ORIGIN`,
404 `TASK_NOT_FOUND`, 500 `INTERNAL` (no paths, no stacks). A task directory that fails the safety checks
answers 200 with `integrity.log: "unsafe"` and no data.

## Approval Center

`/approvals` (polled every 15 s while open) lists every request in brain-gate's `state.json`. It is
**read-only**: approving or rejecting happens only in the Claude Code session that raised the request,
and the page has no buttons, forms or other controls.

- **Status** mirrors brain-gate: `consumed` when `consumed_at` is set; `revoked` when `revoked_at` is set at
  or before `expires` (a stale grant: repo, inputs or actions changed); `expired` when `revoked_at` is after
  `expires` (an expiry found on retry) or, with neither set, `expires` has passed; otherwise `pending`
  (`expires >= now`). brain-gate prunes a request 24 h after it was resolved or expired, on its next locked
  write, so a row can show past 24 h with its final status and then disappear. `/api/health`'s gate counts
  use the same rule: `pending` never includes a revoked request, and `revoked` is counted separately.
- **Mission** is linked only when provable without codes or sessions: exactly one Brain gate event in the
  request's window matches its single repo binding (the event's head, 7+ characters, is a prefix of the
  binding's head and the repo paths are equal as text, a single trailing slash ignored; a path with a `.`,
  `..` or empty segment never matches; recorded actions must match), no event in the window is
  undecidable, every other request that already existed at the event's time, resolved or not, is provably
  different (a different head against its bindings, or different recorded actions), and the event is
  under 23 h old. Anything ambiguous, unknown or unreadable shows **Unlinked**; when the task scan is
  unreliable (store not ok, scan capped, an unsafe task, or an unreadable log) or a request has no recorded
  `created` or `expires`, every row is Unlinked and `linking` is `unavailable`. With today's recording practice
  (gate events rarely carry `head`, `repo` and `actions`) most rows show Unlinked.
- Requests with no repo binding (gate-config and unclassified actions) show "repo unknown".

## Token Intelligence

`/tokens` and `GET /api/tokens?window=7d|30d` read local Claude Code transcripts under
`~/.claude/projects` to show API-list-price-equivalent cost and token usage by mission, agent and model,
over the last 7 or 30 days. It never shows what your subscription actually billed you.

A project directory holds a main session file `<session-uuid>.jsonl`; a session that launched subagents
also has a DIRECTORY of the same `<session-uuid>` (no suffix) alongside it, holding
`subagents/agent-<id>.jsonl` and `agent-<id>.meta.json`. Subagents nest under their OWN launching
session's directory, never under a shared top-level `subagents/`; the scanner tracks which session a
subagent belongs to (`parentSession`, server-internal, never output) so reconciliation never counts
another session's subagent as this one's (see "Reconciliation" below).

- **Cost basis.** Every dollar figure is `costBasis.kind: "api-list-price-equivalent"`, priced from the
  published rates at `costBasis.pricingSource`, checked on `costBasis.pricingCheckedAt`. The page shows a
  permanent banner: "estimate at API list prices, not your bill or subscription charge." Assumptions
  (global routing, standard tier, no batch, fast mode priced from the same page) are listed alongside it.
- **Privacy allowlist.** The transcript reader keeps only numbers and a fixed set of labels — never
  message text, tool inputs/outputs beyond a length or a matched instruction-doc label, image data,
  `meta.description`, `cwd`, git branch, session ids, or project directory names. Message ids are kept in
  memory only, to dedupe calls, and are never put in a response. A canary-leak test and a response-wide
  allowlist walker (`tests/api/tokens-leak.test.ts`) enforce this; `json()`'s redaction still applies as
  defense in depth.
- **Dedupe.** Calls are deduped by `message.id`, **last occurrence wins** within a file
  (`DEDUPE_POLICY` in `src/server/tokens/transcript.ts`); across files, the file with the earliest mtime
  wins and later collisions are counted in `coverage.crossFileDuplicates`.
- **Attribution.** A subagent file links to its mission by `agent_id`; a main-session call lands in the
  mission whose session window (first→last event of that session in that mission, from brain-state)
  contains its timestamp. Anything that does not match exactly is labelled with why
  (`unattributed[].reason`), never guessed: overlapping or missing mission windows, an unrecorded or
  ambiguous session/agent id, or an unusable mission log.
- **Reconciliation (R9).** Three separate things, never conflated:
  - `reconciliation.fixture` is a pinned, **test-verified historical fixture** (the CodeBurn 0.9.27
    numbers), labelled "verified historical fixture: proven by tests, not a live check" — it is never
    computed live and never implies anything about the real store.
  - `reconciliation.baseline` (kept under that name for a locked regression test; it is the **live**
    check R9 asks for) recomputes the pinned session's own scope — the main session file plus ONLY the
    subagent files whose `parentSession` is that exact session (never every subagent on disk: that was
    the A2 violation this fixed) — on 2026-10-14, and reports `match` / `mismatch` / `unavailable` with a
    per-field diff and its own `coverage` (files in scope, whether the main file was found, subagent
    files found, unparseable/oversize/overflowed lines in that scope). It reads "unavailable" until the
    matching transcripts are still on disk (they age out of the 31-day scan around 2026-11-13).
  - `reconciliation.reference30d` is a separate, purely **historical** comparison (CodeBurn's own two
    2026-10-19 readings) alongside this dashboard's own recompute, always over the last 30 days
    regardless of the window selected in the UI.

  The UI never states exact agreement with any of these unless `baseline.status` is `match`.
- **Report re-emission (A4).** Whether an agent's report text gets re-recorded into `events.jsonl` is
  **not measured in v1**: `handoff.reportReemission` is a fixed `{ measured: false, note: "not measured
  in v1" }`, shown as that note, never as a count or a 0. `handoff.handbackMessagesToBrain` is a
  different, measured best-effort proxy (an `isMeta` hand-back marker), kept separate so the two are
  never muddled (R8).
- **Performance.** Only files with mtime within 31 days are read; reads resume from a per-file memo keyed
  by `(dev, ino, size, mtimeMs)`, confirmed by a content anchor before resuming. The memo is capped on
  both file count and approximate retained bytes, with LRU eviction (`coverage.memoEvictions`); it holds
  only numbers, the fixed labels above and message ids, never on disk. Concurrent requests share one
  in-flight scan. The client polls with a 120 s fetch timeout (`usePoll`'s additive `timeoutMs` option),
  since a cold scan can run longer than the shared 10 s default.

## Integrity labels

- The log check walks the hash chain (`v`, `seq`, `prev`, `task_id`, known type) like brain-state's
  reader, but **not** the canonical-form check. It is a *chain check*, not `brain-state verify`.
  Terminal tasks are first checked from the tail (`chainChecked: false` when the tail proves the cache).
- `log`: `ok`, `torn_tail` (ignored, as brain-state does), `corrupt` (valid prefix shown; status CORRUPT),
  `incomplete`, `missing`, `unsafe`, `too_large`.
- `cache`: `fresh`, `stale` (the log has grown since; the log wins for state, the cache supplies agents,
  findings and round), `ahead` (the cache claims more events than the log), `diverged` (the cache's
  `last_hash` is not the hash of log line `last_seq`, as in brain-state's `cache_ahead`), `missing`,
  `invalid`, `unsafe`, `too_large`, `unknown` (a cache exists but the log could not be read, so it could
  not be checked). For anything but `fresh`/`stale` the summary is rebuilt from the log and
  `summaryUnavailable` is true (agents, findings, rounds and validation are then empty).
- Terminal tasks are first checked from the log tail; the whole log is read whenever the tail does not
  prove the cache fresh (same last seq and hash), so a terminal task's status always comes from the log.
- Redaction always runs before the final cut (`sanitizeString`/`sanitizedPrefix` are the only cut
  points). To bound its cost, the input is first trimmed to `max` + 32 KiB characters; see Limitations for
  the narrow case where that trim matters.

## Limitations

- Pending agent runs are reservations with no report yet; the Brain records no liveness, so the dashboard
  cannot say whether an agent process is alive. Runs older than `stale_after_minutes` are flagged.
- Governor usage shows the class budget; per-session budget extensions are not visible.
- Agent "effort" is not recorded anywhere the dashboard reads and is shown as "not recorded". The model
  column is the governor policy's model class (`opus`/`fable`).
- On the map, a running connection or node means a reservation with no report yet (see above); the
  dashboard cannot tell whether the agent process is alive.
- The idle map is dormant, not the last mission's history; debrief mode needs a click in Recent missions.
- The Findings view covers at most 8 missions at a time (every non-terminal one, then the newest terminal
  ones) plus any single mission picked by hand; the mission detail page lists all findings of one mission.
- The archetype titles (Strategist, Builder, Scout, Judge, Guardian) and the step numbers on the nodes are
  UI vocabulary, not Brain data. "Security" has no lifecycle state of its own: the security reviewer sits
  on REVIEWING and REVALIDATING.
- Reads are lock-free: a `stale` cache label can appear transiently while brain-state writes and clears
  on the next poll.
- Redaction differs slightly from Python's (`\w`/`\b` are ASCII in JS).
- Known redaction gaps (defense in depth; text written by brain-state is already redacted at write time):
  - A gate code written in Brain text as ``code `X` ``, `code "X"`, `code is X` or similar is not masked,
    and ordinary words after "code" that use only gate-alphabet letters (e.g. "code change") are.
  - The `max` + 32 KiB trim before redaction can let part of a secret through when more than 32 KiB of
    earlier text in the same field shrinks during redaction. brain-state's own write-time redaction makes
    this unreachable for text it wrote.
  - The regex cost is bounded per string, not per response: a state.json crafted with hundreds of large
    PEM-marker fields can slow a findings request to seconds.
- No authentication beyond the 127.0.0.1 bind (accepted; see "Running it safely"). A per-launch access
  token is a possible follow-up.
- Framework behaviour outside the route handlers: a malformed percent-encoded id or a `TRACE` request gets
  Next's plain-text 500, `OPTIONS` gets 204, and an absolute-form request target gets a 308 redirect. None
  of these returns Brain data.
- **Token Intelligence:**
  - Attribution is by exact session window or agent id, with no grace period; a call outside every known
    window, or whose session/agent id is not recorded, is shown as unattributed with a reason, never
    guessed into the nearest mission.
  - Instruction-read token counts are `resultChars ÷ 4`, a labelled estimate, not an exact tokenizer count;
    image tool results are excluded from any size figure.
  - Transcripts are scanned back only 31 days; `window.retentionNote` and `window.partial` say so when the
    requested window (especially 30d) runs past what is still on disk.
  - `inference_geo` (a 1.1x US-only multiplier) IS recorded in transcripts, but v1 never reads it: every
    cost assumes global routing regardless of what `inference_geo` actually says. This is a choice, not a
    blind spot, and is stated exactly that way in `costBasis.assumptions`.
  - Packets, hand-backs and instruction reads are counted per scanned file within the requested window;
    a file with no in-window call contributes nothing even if it holds such records at other times.
  - A single file's own retained records (calls, attachments, instruction reads, packets, hand-backs) are
    capped (`coverage.recordsOverflowed`, `coverage.complete: false` when it is hit); an oversize or
    unparseable line never interrupts the rest of the file.
  - A `timestamp` that fails strict ISO-8601 validation (or is absent) is never used or echoed anywhere
    (including `window.oldestCallAt`); it is counted in `coverage.invalidTimestamps` instead.

## Fingerprint check

Before and after a manual run against the real store, these two listings must be identical:

```sh
find ~/.claude/state/brain ~/.claude/brain/governor.json ~/.claude/state/brain-gate -type f -print0 | xargs -0 stat -f '%N %z %m %p %i' | sort
find ~/.claude/state/brain ~/.claude/brain/governor.json ~/.claude/state/brain-gate -type f -print0 | xargs -0 shasum -a 256 | sort
```

For a run that exercises Token Intelligence against the real store, also take a before/after listing of
`~/.claude/projects` with sizes and mtimes (content hashing it is not required: Claude Code's own session
appends are expected to change it). Only growth of files already present, from the live session, is
expected; any shrink, deletion, or change to a file's `stat` other than size/mtime is a regression:

```sh
find ~/.claude/projects -type f -print0 | xargs -0 stat -f '%N %z %m' | sort
```

Static check (must print nothing):

```sh
grep -rnE "writeFile|appendFile|mkdir|rmSync|\brm\(|unlink|rename|chmod|chown|truncate|O_WRONLY|O_RDWR|O_CREAT|child_process|execSync|spawn|fs\.cp|createWriteStream|process\.env\.[A-Z_]*(ROOT|DIR|PATH)" src
grep -rn "dangerouslySetInnerHTML\|next/font/google\|Access-Control" src
```

Bind check: `lsof -nP -iTCP:3077 -sTCP:LISTEN` must show `127.0.0.1` only.

<!-- Brain smoke test -->
