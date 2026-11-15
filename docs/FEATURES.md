# Feature spec — Agentic IR Case Management POC

Status: draft for build. Companion to the design document.
Stack: TypeScript, Node 24, `node:sqlite`, `@modelcontextprotocol/sdk`, React (portal, later).

---

## 1. Runtime shape

One local daemon, `incident-mcp`, owns all case data. Every Claude session and the portal talk to it.

| Endpoint | Transport | Used by |
| --- | --- | --- |
| `http://127.0.0.1:7400/mcp` | MCP Streamable HTTP | Claude sessions (via the SOC profile) |
| `http://127.0.0.1:7400/api/*` | JSON REST | Portal, future SIEM connector |

Why one daemon: one process means one in-memory write queue per incident. SQLite transactions
(`BEGIN IMMEDIATE`) are a second guard, so even two daemons by mistake cannot corrupt ordering.

Data lives in `data/` (git-ignored):

```
data/
  cases.db                          SQLite: incidents, events, artifacts, sessions
  incidents/INC-2026-0042/
    report.md                       rendered projection, rebuilt after every event
    artifacts/<artifact_id>.<ext>   raw inputs, named by id
```

Config lives in `config/` (committed, team-editable):

```
config/
  templates/default.yml
  compliance/nis2.yml  gdpr.yml  dora.yml
  org/teams.yml
  codenames/adjectives.txt  nouns.txt
  settings.yml                      port, data dir, confirm_before_write default
```

---

## 2. Identifiers and conventions

| Thing | Format | Example |
| --- | --- | --- |
| Incident ID | `INC-<year>-<4-digit counter>` | `INC-2026-0042` |
| Codename | `<Adjective> <Noun>`, unique among open incidents | `Amber Heron` |
| Codename slug | lower-kebab | `amber-heron` |
| Event ID | ULID | `01JCX7Q8...` |
| Artifact ID | `art_` + ULID | `art_01JCX7...` |
| Sequence | integer per incident, starts at 1, no gaps | `17` |
| Time | ISO 8601 UTC, `Z` suffix | `2026-11-14T06:58:00Z` |
| Author | display name from profile config | `analyst-a` |

Codenames: drawn at random from the two word lists; redraw if the pair is used by an open incident
or was used in the last 90 days. Word lists avoid colours or animals with obvious negative meaning.

Incident resolution (`find_incident`) accepts, in order: exact ID, number only (`42`), codename or slug
(case-insensitive), then a free-text match on title. More than one match → all candidates returned.

---

## 3. Data model

### 3.1 Incident (current state, derived from events)

```ts
interface Incident {
  id: string;               // INC-2026-0042
  codename: string;         // Amber Heron
  title: string;
  priority: "P1" | "P2" | "P3" | "P4";   // P1 = highest
  status: "Open" | "Resolved" | "Closed";
  lead: string | null;
  meeting_schedule: MeetingSchedule | null;      // §8a
  summary: string;
  template: string;         // "default@3"
  detected_at: string;      // trigger time for compliance deadlines unless a track overrides
  opened_at: string;
  opened_by: string;
  seq: number;              // last applied event sequence
}
```

### 3.2 Event envelope

```ts
interface Event<T extends EventType = EventType> {
  id: string;               // ULID
  incident_id: string;
  seq: number;              // assigned by server
  type: T;
  payload: PayloadOf<T>;
  author: string;
  session_id: string | null;  // MCP session or "portal"
  source_artifact: string | null;
  idempotency_key: string;  // client-supplied; unique per incident
  created_at: string;
  supersedes: string | null;  // event id this one corrects
}
```

### 3.3 Event types

| Type | Payload (key fields) | Notes |
| --- | --- | --- |
| `incident.opened` | id, codename, title, priority, template, detected_at | always seq 1 |
| `field.changed` | field, old, new | fields: title, priority, status, lead, summary, detected_at |
| `artifact.added` | artifact_id, kind, filename, sha256, bytes | kind: alert, log, email, screenshot, note, ioc_list, other |
| `timeline.added` | time_utc, time_original, source, actor, description, phase, confidence | phase from template list or null; confidence 0–100, default 100, lower when the analyst hedges ("I think it was…") |
| `timeline.updated` | timeline_id, old, confidence, reason | confidence raised or lowered later ("confirmed in audit log") |
| `ioc.added` | type, value, first_seen, source, verdict | dedup on (type, normalised value) |
| `ioc.source_added` | ioc_event_id, source | second sighting of an existing IOC |
| `asset.added` | host, user, owner, state | state: suspected, compromised, contained, clean |
| `asset.updated` | asset_event_id, state | |
| `note.added` | text | |
| `task.added` | title, assignee, due, meeting_id? | a task with `meeting_id` is a meeting action; due defaults to the next meeting |
| `task.updated` | task_event_id, status, assignee, outcome? | status: open, in_progress, done, cancelled; `outcome` = what came of it |
| `meeting.schedule_set` | cadence_minutes, next_at, channel_name, join_url, chair | starts or changes the incident meetings; cadence 0 = ad hoc |
| `meeting.held` | meeting_id, started_at, chair, attendees, notes | one per meeting |
| `meeting.skipped` | scheduled_at, reason | keeps the meeting log honest |
| `compliance.attached` | track_id, trigger_at | |
| `compliance.step_updated` | track_id, step_id, status, evidence | status: todo, in_progress, done, not_applicable |
| `engagement.updated` | team_id, request_type, status, reason, outcome, recommendations? | status: suggested, requested, engaged, delivered, not_needed; `recommendations` = drafts for the team (§8b) |
| `correlation.flagged` | other_incident_id, kind, value | kind: ioc_exact, shared_host, shared_user |
| `correlation.resolved` | flag_event_id, decision | decision: linked, merged, dismissed |
| `analyst.connected` | author | drives "who is working" |
| `correspondence.added` | direction, party, from, to, subject, sent_at, summary, related_step | an email in or out |
| `proposal.added` | proposal_id, source, from, context, quote, summary, items | suggestion waiting for review |
| `proposal.decided` | proposal_id, decision, reason, accepted_items | accepted items are appended in the same transaction |
| `event.retracted` | event_id, reason | corrections; nothing is deleted |

The current state of anything (an IOC, a task, a step) is the fold of its events in `seq` order.

### 3.4 SQLite tables

```sql
incidents(id PK, codename, codename_slug, title, priority, status, lead, summary,
          template, detected_at, opened_at, opened_by, meetings_json, seq)
events(id PK, incident_id, seq, type, payload_json, author, session_id,
       source_artifact, idempotency_key, created_at, supersedes,
       UNIQUE(incident_id, seq), UNIQUE(incident_id, idempotency_key))
artifacts(id PK, incident_id, kind, filename, sha256, bytes, path, added_by, added_at)
iocs_index(type, value_norm, incident_id, event_id)        -- for correlation
sessions(session_id PK, author, incident_id, last_seen_seq, connected_at)
counters(year PK, last_number)
```

`incidents` is a cache of the fold; it can be rebuilt from `events`.

---

## 4. Write path and concurrency

1. Tool call arrives with an `idempotency_key` (the profile skill generates a UUID per logical write).
2. Request is pushed onto the incident's in-memory queue. Queues for different incidents run in parallel.
3. Worker: `BEGIN IMMEDIATE` → check idempotency key (hit → return the stored result) →
   check `expected_seq` when present → assign `seq = incidents.seq + 1 …` → insert events →
   update `incidents` cache and `iocs_index` → `COMMIT`.
4. After commit: re-render `report.md` (debounced 250 ms per incident), run correlation, push an
   update to portal subscribers (server-sent events on `/api/incidents/:id/stream`).

Conflict rule: only `update_field` and status changes on tasks, steps and engagements carry
`expected_seq`. They are rejected with `conflict` if any event touching **the same target** has
`seq > expected_seq`. Appends never conflict.

Errors returned to tools (stable codes):

| Code | Meaning |
| --- | --- |
| `not_found` | incident, task, step or team unknown |
| `ambiguous` | name resolved to more than one incident; candidates included |
| `not_connected` | write tool called with no linked incident and no `incident` argument |
| `conflict` | stale `expected_seq`; current value included |
| `invalid` | payload fails schema; field path and reason included |
| `closed` | write to a Closed incident (only a `field.changed` status back to Open is allowed) |

Status rules: Open → Resolved when the threat is dealt with (work may continue: reporting,
compliance, engagements). Resolved → Closed only when `closure_rule` passes and every compliance
step is done or not applicable. Resolved or Closed → Open is allowed (reopen) and logged.

---

## 5. MCP tools

All write tools take an optional `incident` (ID, number or codename). When omitted, the session's
linked incident is used. All writes require `idempotency_key`.

### Read tools

| Tool | Input | Output |
| --- | --- | --- |
| `list_incidents` | `status?`, `limit?` | rows: id, codename, title, priority, status, lead, next_deadline, next_meeting, last_activity |
| `find_incident` | `query` | `{ match }` or `{ candidates[] }` |
| `connect_incident` | `query` | briefing: incident, summary, open tasks, last 10 timeline entries, IOC count, open flags, compliance due next, engagements open, analysts active in last 2 h, `seq` |
| `get_report` | `incident?`, `section?` | Markdown of the whole report or one section, plus `seq` |
| `get_updates` | `incident?`, `since_seq?` | events after `since_seq` (default: session's `last_seen_seq`), ranked (§8); advances `last_seen_seq` |
| `get_status` | `incident?` | manager view: status, priority, counts, next meeting, open meeting actions per person, overdue tasks, compliance steps by urgency, overdue engagements, unassigned tasks |
| `get_meeting_brief` | `incident?` | agenda for the next meeting (§8a) |
| `get_team_queue` | `team_id?` (default: caller's team) | open engagements for that team across all incidents, each with its context pack and recommendations (§8b) |
| `get_next_steps` | `incident?` | facts for analyst recommendations: suggested engagements, template phases with no timeline entries yet, assets not contained, IOCs with no verdict, unassigned tasks, the caller's own open actions |
| `get_template` | `incident?` | the template's section rules, so the agent knows how to extract |

### Write tools

| Tool | Input | Emits |
| --- | --- | --- |
| `open_incident` | title, priority, template?, detected_at?, compliance?[] | `incident.opened`, `compliance.attached`*; links session; returns id + codename |
| `add_artifact` | kind, filename, content (text) or content_base64 | `artifact.added`; returns artifact_id |
| `add_events` | items[] of {type, …, source_artifact?} — types: timeline, ioc, asset, note, task, ttp (MITRE technique), cve | one event per item; returns per-item result incl. `deduplicated` and correlation flags raised |
| `update_field` | field, value, expected_seq | `field.changed` |
| `update_item` | kind (task, asset, timeline), item_id, changes, expected_seq | `task.updated` / `asset.updated` / `timeline.updated` (confidence) |
| `set_compliance_step` | track_id, step_id, status, evidence?, expected_seq | `compliance.step_updated` (evidence required where the track says so) |
| `attach_compliance` | track_id, trigger_at? | `compliance.attached` |
| `set_engagement` | team_id, request_type?, status, reason?, outcome?, expected_seq? | `engagement.updated` (reason required for not_needed, outcome for delivered) |
| `resolve_correlation` | flag_id, decision | `correlation.resolved` |
| `set_meeting_schedule` | cadence_minutes, next_at?, channel_name?, join_url?, chair? | `meeting.schedule_set` |
| `record_meeting` | started_at, attendees[], notes?, outcomes[] {task_id, status, outcome}, actions[] {assignee, title, due?} | `meeting.held`, then one `task.updated` per outcome and one `task.added` per action, in one transaction |
| `skip_meeting` | scheduled_at, reason | `meeting.skipped` |
| `retract_event` | event_id, reason | `event.retracted` |

Extraction (timestamps, IOCs, phases) is done by Claude in the `ingest-evidence` skill. The server
validates and normalises; it does not parse free text.

Server-side normalisation:

- IOC values: lower-case domains and emails, strip `[.]` / `hxxp` defanging, canonical IPv6,
  lower-case hashes; type checked by regex (ipv4, ipv6, domain, url, sha256, sha1, md5, email).
- Times: must parse as ISO 8601 with offset; stored as UTC; original string kept.

---

## 6. Config schemas

### 6.1 Template (`config/templates/*.yml`)

```yaml
name: string
version: int
priorities: [P4, P3, P2, P1]  # ordered low → high; P1 = highest
default_meeting_minutes: { P1: 60, P2: 240, P3: 0, P4: 0 }   # offered at open; 0 = no fixed meetings
sections:
  - id: string
    title: string
    kind: prose | timeline | table | tasks | log | compliance | engagements | correlations | meetings
    instructions: string      # read by Claude, shown in get_template
    fields: [string]          # timeline/table
    phases: [string]          # timeline only
    types: [string]           # iocs table only
compliance_offer: [track_id]  # tracks Claude asks about at open
```

Validated at daemon start; an invalid template is reported and skipped.

### 6.2 Compliance track (`config/compliance/*.yml`)

```yaml
id: string
name: string
ask_at_open: string           # yes/no question Claude asks
trigger: detected_at | aware_at | classified_at   # which incident time starts the clock
steps:
  - id: string
    title: string
    due: duration | null      # 24h, 72h, 1mo; null = without undue delay
    due_from: trigger | step:<id>   # default trigger
    owner_role: string?
    evidence: [string]?       # fields required to mark done
    condition: string?        # free text shown to analyst, e.g. "only if high risk"
```

Starter tracks: `nis2.yml`, `gdpr.yml`, `dora.yml`. Each file carries a header comment:
deadlines are approximate and must be checked by legal before use.

### 6.3 Teams (`config/org/teams.yml`)

```yaml
teams:
  - id: string
    name: string
    contact: string
    request_via: string?      # informational in POC
    respond_within: duration
    request_types: [string]
    suggest_when:
      - event: ioc.added | ttp.added | cve.added | asset.added | priority.changed | task.added
        condition: string?    # simple expression, see below
closure_rule: all_engagements_resolved | none
```

Conditions (POC): `field == value`, `priority >= P2` (P1 counts as highest), `external == true`,
`no_matching_rule` (always true in POC; real check needs a SIEM MCP). Evaluated by the server,
which emits `engagement.updated` with status `suggested`; Claude surfaces the suggestion.

### 6.4 Settings (`config/settings.yml`)

```yaml
port: 7400
data_dir: ./data
confirm_before_write: true
trusted_sources: []           # sources that skip confirm, e.g. siem-connector
digest_window_hours: 2        # "active analysts" window
```

---

## 7. Rendered report

`report.md` = YAML frontmatter (incident fields + `seq`) + one block per template section, in template
order. Widget sections use fenced directives the portal recognises:

```
:::timeline        Markdown table inside; portal draws chart + table
:::compliance      checklist per track with due time and status
:::engagements     table per team
:::correlations    open flags with links
:::meetings   next meeting, join link, actions per person, meeting log
:::
```

Rules:
- Retracted events are omitted; superseded values show the latest.
- Every timeline row and IOC row ends with its source (`ALRT-881`, `art_…`).
- Deterministic: same events → byte-identical file (enables snapshot tests).

---

## 8. Correlation and digest

Correlation runs after each commit on new `ioc.added` and `asset.added`:

| Kind | Rule | Flag strength |
| --- | --- | --- |
| `ioc_exact` | same (type, value_norm) in another incident opened in the last 180 days | strong |
| `shared_host` | same host in another open incident | weak |
| `shared_user` | same user in another open incident | weak |

Each match emits `correlation.flagged` in **both** incidents (one event each, same pair id).
A pair is flagged once; later matches add to it as a note in the payload.

Digest ranking for `get_updates` (highest first):
1. Correlation flags and compliance steps due within 12 h.
2. Events that mention the caller's own IOCs, hosts or users (those they added).
3. Tasks assigned to the caller.
4. Everything else, newest first.
Events written by the caller are excluded.

---

## 8a. Incident meetings

A incident meetings is a fixed meeting cadence for an incident, for example every 60 minutes on a P1.
Each meeting hands out actions to named people; the next meeting records what came of each one.

```ts
interface MeetingSchedule {
  cadence_minutes: number;     // 0 = ad hoc, next_at set by hand
  next_at: string | null;      // computed: last meeting (or next_at from meeting.schedule_set) + cadence
  channel_name: string | null; // e.g. "IR - Amber Heron" Teams group
  join_url: string | null;     // Teams / Meet link; shown as a Join button
  chair: string | null;
}
```

**Next meeting time.** Set by `set_meeting_schedule`. After `meeting.held` or `meeting.skipped`,
`next_at = that meeting's time + cadence`. A meeting held early or late re-anchors the clock.

**Actions.** A meeting action is a task with `meeting_id` set, one assignee, and a due time that
defaults to the next meeting. They show grouped by person: "analyst-b: reset j.doe tokens".

**Meeting brief** (`get_meeting_brief`), in this order:
1. Actions from the last meeting, grouped by person, each still waiting for an outcome.
2. What changed since the last meeting: new timeline entries, IOCs, flags, engagement replies.
3. Compliance steps and engagement deadlines that fall due before the meeting after this one.
4. Open questions: unassigned tasks, unresolved correlation flags.

**Recording a meeting** (`record_meeting`): the chair (or Claude, from the chair's notes) gives
attendees, an outcome for every open action, and the new actions. Actions with no outcome are
carried over and marked `carried_over` in the brief, so nothing silently drops.

**Reminders.** The SessionStart hook and `get_updates` mention a meeting starting within 15 minutes
and the caller's own open actions. Missing a meeting time by more than one cadence without
`meeting.held` or `meeting.skipped` shows as "meeting overdue" in `get_status`.

**Teams integration.** POC: the channel name and join link are typed in (or Claude reads them from
a pasted Teams invite). Later: a Microsoft Graph MCP in the profile finds the incident's Teams group
by its codename, reads the next meeting from its calendar, and fills `next_at` and `join_url`.

---

## 8b. Engineering recommendations

Engineers (Detection Engineering, platform, SIEM owners) work a **team queue**, not a single case.
They are fed recommendations for detection rules and dashboards that come out of live incidents.

**Who writes a recommendation.** Two sources, both stored on the engagement:
1. The analyst's Claude, when it requests a Detection Engineering engagement, attaches a draft:
   what to detect, why (the events that show it), and a first query.
2. The server's `suggest_when` rules raise a `suggested` engagement on their own (for example a new
   IOC type or technique with no matching rule). Claude in the next analyst session turns it into a
   draft, or the analyst marks it Not needed.

```ts
interface Recommendation {
  kind: "detection_rule" | "dashboard" | "hunt_query" | "tuning";
  title: string;                 // "Inbox rule forwarding to external domain"
  rationale: string;             // why, in two sentences
  evidence: string[];            // event ids / alert ids that show the behaviour
  draft: {
    language?: "kql" | "spl" | "sigma" | "eql";
    query?: string;              // first draft; engineer owns the final version
    panels?: { title: string; query: string; viz: string }[];   // dashboards
  };
  mitre?: string[];              // technique ids, e.g. T1114.003
}
```

**Context pack.** Every queue item carries what the engineer needs without opening the case:
incident codename and priority, the relevant timeline rows, IOCs, affected assets, and links to the
source artifacts.

**Engineer loop** (skill `engineering-queue`):
1. `get_team_queue` → items ordered by incident priority, then by how long they have waited.
2. Engineer picks one; Claude refines the draft into the team's rule language and checks it against
   the evidence rows.
3. Engineer moves it to Engaged, then Delivered with `outcome` = rule id or dashboard link. Analysts
   on the case see the delivery in their next digest.

The server stores and routes recommendations; it never generates query text itself.

---

## 8c. Correspondence and suggestions waiting for review

Much of an incident happens over email, and many people who know things never use Claude: a plant
manager, the finance controller, a supplier. Two features bring that in.

**Correspondence.** An evidence item type, `correspondence`, logs every email that matters: direction,
party (regulator, csirt, supplier, customer, legal, law_enforcement, insurer, internal, other), from, to,
subject, sent_at, a one- or two-line summary, and optionally the compliance step it serves
(`nis2/early-warning`). The raw email is stored as an artifact first. The report has a Correspondence
section; the portal shows it as a mail log next to the compliance tracker.

**Suggestions waiting for review.** Sources that are not a Claude session do not write into the case.
They submit a suggestion: who said it, where, the quote, a summary, and the evidence items it would add
(the same item shapes as `add_events`). Items are validated when submitted, so a bad suggestion is
refused at the door. Nothing enters the case until someone accepts it, wholly or item by item;
accepted items carry `proposed_by`, `via` and `proposal_id`.

| Source | How it arrives |
| --- | --- |
| Teams bot in the meeting | Invited to the incident meeting like a person. Listens to the transcript and suggests what sounded worth adding ("the R&D laptop was plugged into a line PC in Trondheim on Thursday"). Source `teams-meeting`. |
| Teams bot in the chat | Added to the incident's Teams group chat or channel. Reads new messages there (only that chat, never anyone's private chats), ignores small talk and acknowledgements ("on it", "thanks"), and suggests messages that carry a fact: a time, a host, a person, an indicator, a payment, a decision. Each suggestion carries the quote and a link back to the message. Anyone can force one by @-mentioning the bot ("@IR bot add this"). Source `teams-chat`. |
| Incident mailbox | A shared mailbox per incident (or one mailbox with the codename in the subject) forwards mail to `POST /api/ingest/email`; it is stored as an artifact and suggested as a correspondence entry. |
| Portal form | Anyone without Claude can type a finding into the case page. |

Suggestions show in the meeting brief, `get_status` needs-action, the digest and the session-start
message. The meeting decides them, or the lead does in Claude (`list_suggestions`, `decide_suggestion`).

POC scope: the server side is built (`POST /api/incidents/:id/suggestions`, `/api/ingest/email`,
decision endpoint, MCP tools). The Teams bot itself needs a Microsoft Teams bot registration and
meeting-transcript access; in the demo its suggestions are seeded.

---

## 9. REST API (portal)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/incidents` | list (same as `list_incidents`) |
| POST | `/api/incidents` | open |
| GET | `/api/incidents/:id` | incident + folded state (timeline, iocs, assets, tasks, compliance, engagements, flags) |
| GET | `/api/incidents/:id/report.md` | raw Markdown |
| GET | `/api/incidents/:id/events?since=` | event list |
| POST | `/api/incidents/:id/events` | same body as `add_events` |
| PATCH | `/api/incidents/:id` | `update_field` |
| POST | `/api/incidents/:id/compliance/:track/:step` | `set_compliance_step` |
| POST | `/api/incidents/:id/engagements/:team` | `set_engagement` |
| PUT | `/api/incidents/:id/meetings/schedule` | `set_meeting_schedule` |
| GET | `/api/incidents/:id/meetings/brief` | `get_meeting_brief` |
| POST | `/api/incidents/:id/meetings` | `record_meeting` |
| GET | `/api/teams/:team/queue` | `get_team_queue` |
| GET/POST | `/api/incidents/:id/suggestions` | list / submit a suggestion (Teams bot, portal form) |
| POST | `/api/incidents/:id/suggestions/:pid/decision` | `decide_suggestion` |
| POST | `/api/ingest/email` | incident mailbox connector: email stored and suggested as correspondence |
| GET | `/api/analysts/:name/summary?team=` | SessionStart hook: the analyst's incidents, unread counts, open actions, next meeting, team queue size |
| POST | `/api/ingest/alert` | future SIEM connector: `{incident, source, alert_id, raw}` stored as an artifact |
| GET | `/api/incidents/:id/stream` | server-sent events, one message per committed event |
| GET | `/api/config` | templates, tracks, teams (read-only) |

Author for portal writes: `X-Analyst` header (POC only; no auth).

---

## 10. SOC profile (Claude Code plugin)

```
profile/
  .claude-plugin/plugin.json
  .mcp.json                     incident-mcp at http://127.0.0.1:7400/mcp
  skills/open-incident/SKILL.md
  skills/connect-incident/SKILL.md
  skills/ingest-evidence/SKILL.md
  skills/case-digest/SKILL.md
  skills/incident-meetings/SKILL.md
  skills/engineering-queue/SKILL.md
  commands/incident.md          /incident open | connect <name> | status | updates | meeting | next | queue
  hooks/hooks.json              SessionStart → prints linked incident + unread count
```

Skill behaviour:

| Skill | Must do |
| --- | --- |
| open-incident | Propose title (≤ 60 chars) and priority (P1–P4) from input; ask compliance questions from `compliance_offer`; ask which teams to pre-engage; offer the template's default incident meetings for that priority and ask for the Teams link; call `open_incident`; then hand the input to ingest-evidence |
| incident-meetings | Before a meeting: `get_meeting_brief`, formatted for screen-share. After: turn the chair's notes into `record_meeting` (outcome per open action, new actions with one owner each), confirm, write |
| connect-incident | `find_incident`; ask on ambiguity; `connect_incident`; print briefing in ≤ 15 lines |
| ingest-evidence | `add_artifact` first; `get_template`; extract per section rules; show preview counts; on yes `add_events` in one call; report dedups, flags and suggested engagements |
| case-digest | Analyst: `get_updates`, top 5 items, then up to 3 recommended next steps from `get_next_steps`. Manager: `get_status`, then "needs action" list first |
| engineering-queue | `get_team_queue`; summarise items; on pick, refine the draft into the team's language, test it against the evidence rows, record Engaged / Delivered |
| open-incident, ingest-evidence | When requesting Detection Engineering, attach a `Recommendation` built from the evidence just added |

Identity: `analyst_name`, `analyst_role` (analyst, lead, manager, engineer), `analyst_team`
(a team id from `teams.yml`, for engineers) and `server_url` are the plugin's `userConfig` options,
asked for when the plugin is enabled, and sent as `X-Analyst-*` MCP headers. Role changes what the digest leads with; it grants no permissions in the POC.

---

## 11. Acceptance criteria (POC done)

1. Two Claude sessions add 50 events each to one incident at the same time → 100 events, seq 1…101 with no gaps, report contains all of them.
2. The same `add_events` call sent twice with one idempotency key → stored once.
3. `update_field` with a stale `expected_seq` on summary → `conflict` with the current summary.
4. An IOC added to incident B that exists in incident A → flag visible in both reports.
5. GDPR attached with trigger 2026-11-14T07:12Z → "Notify supervisory authority" due 2026-11-17T07:12Z, shown as overdue after that time.
6. `set_engagement` delivered without outcome → `invalid`.
7. Deleting `report.md` and restarting the daemon → identical file regenerated.
8. Incident meetings at 60 min, meeting held 10:00 with two actions → next meeting 11:00; at 11:00 one action gets an outcome, the other shows as carried over; next meeting 12:00.
9. Incident with an open GDPR step cannot move Resolved → Closed; `invalid` names the step.
10. Engineer's `get_team_queue` returns a recommendation raised from another analyst's session, with its context pack; delivering it shows up in that analyst's next digest.
11. The demo in §13 runs end to end with six live Claude sessions and the portal.

---

## 12. Build order

1. `incident-mcp`: config loader + schemas (zod), SQLite store, event fold, write queue.
2. Renderer + snapshot tests.
3. MCP tools + REST API; concurrency test (criterion 1–3).
4. Correlation, compliance clocks, engagement suggestions (criteria 4–6).
5. Profile plugin; manual run-through with two terminals.
6. Portal (after Claude Design screens).
7. Demo kit (§13) and video takes.

---

## 13. Demo video

Goal: one short video where six people work one incident at the same time through their own Claude
sessions, with the portal updating live.

### Cast

| Persona | `ANALYST_ROLE` | Works on |
| --- | --- | --- |
| analyst-a | lead | Opens the incident, chairs the incident meetings |
| analyst-b | analyst | Email and identity: phishing mail, OAuth consent, mailbox rules |
| analyst-c | analyst | Endpoint: EDR alerts on the user's laptop |
| analyst-d | analyst | Network and CTI: proxy logs, external IPs, enrichment |
| manager | manager | Status, compliance steps, deadlines |
| engineer | engineer (`detection-eng`) | Team queue: detection rules and a dashboard |

### Setting: the Truffle Thief

Everything in the demo is fictional and clearly so.

| Element | Demo value |
| --- | --- |
| Company | **Bittersweet Fjord Chocolate Co.**, a mid-size EU chocolate maker (food production, so NIS2 applies) |
| Domain | `bittersweet.example` (reserved test TLD) |
| Crown jewel | **Recipe No. 7**, the secret praline recipe, kept in the R&D "Recipe Vault" SharePoint site |
| Adversary | **The Truffle Thief**, a fictional crew that steals recipes and diverts cocoa-bean payments |
| Lure | A fake invoice from "Golden Pod Cocoa Traders", the company's real-looking bean supplier |
| Attacker infrastructure | `goldenpod-invoices.test`, `truffle-cdn.test`, IPs from 203.0.113.0/24 and 198.51.100.0/24 (RFC 5737) |
| Older incident (seed) | **Quiet Lynx**, a credential-stuffing attempt on the online praline shop last month, from 203.0.113.66 |

Attack chain the analysts uncover:
1. A finance clerk opens the fake Golden Pod invoice and consents to an OAuth app, "CocoaInvoice Sync".
2. The app creates an inbox rule forwarding every mail with "invoice" or "bank details" to the attacker.
3. With the clerk's token, the thief reaches the R&D chocolatier's laptop and the Recipe Vault.
4. `recipe_no7.zip` is staged and sent to `truffle-cdn.test` (203.0.113.66).
5. A supplier email asking to "update our bank account for the next cocoa shipment" is about to go out.

Compliance: NIS2 (food producer, significant incident) and GDPR (supplier contacts and employee mail
are personal data).

### Storyline (target 6–8 minutes)

1. **Open.** analyst-a pastes the Defender alert on the Golden Pod phishing mail: "open an incident". Claude proposes P2, NIS2 and GDPR, meetings every 60 minutes; the incident becomes Amber Heron, "Truffle Thief: invoice phish and recipe theft". The portal shows it appear.
2. **Swarm.** b, c and d each "connect to Amber Heron" and paste their evidence at the same moment: b the OAuth consent and inbox rule, c the EDR alert for `recipe_no7.zip` on the chocolatier's laptop, d the proxy logs to `truffle-cdn.test`. The timeline fills in from three sources; nothing lost.
3. **Correlation.** analyst-d adds 203.0.113.66; it matches the Quiet Lynx shop attack and a flag appears in both cases. Priority goes to P1.
4. **Recommendations to analysts.** analyst-c asks "anything new?"; Claude surfaces b's OAuth app as the likely way in to c's laptop and suggests revoking it and checking other Recipe Vault access.
5. **Engineering.** b's inbox forwarding rule raises a Detection Engineering recommendation. The engineer runs `/incident queue`; Claude refines a KQL rule for "inbox rule forwarding invoices externally" and a "Recipe Vault access" dashboard. The engineer marks it Delivered with a rule id; the analysts see it in their digest.
6. **Incident meetings.** analyst-a pulls the meeting brief and hands out actions: b revokes CocoaInvoice Sync, c isolates the laptop, d blocks the Truffle Thief domains, and finance warns Golden Pod about the fake bank change. At the next meeting outcomes are recorded; one action carries over.
7. **Manager.** "What's going on with Amber Heron?" → status, P1, overdue items. The manager marks the NIS2 early warning Done with a reference; the GDPR countdown is visible.
8. **Resolve.** Status goes to Resolved; close is refused because the GDPR step is still open, showing the guard.

### Demo kit (`demo/`)

```
demo/
  README.md                story, who pastes what, video script
  alerts/                  fictional Truffle Thief alerts, logs and emails (.test/.example domains, RFC 5737 IPs)
  personas/persona.cmd|.sh start a Claude session as one persona (name, role, team)
  sample-report.md         what a finished case file looks like
incident-mcp/scripts/demo.ts  seeds the scenario (npm run demo:seed -- --reset [--stage video])
```

Demo settings: `demo.clock_offset` shifts the server clock so timestamps read as a plausible day,
and `demo.meeting_minutes: 5` shortens the incident meetings so two meetings fit in the video. Both are
off outside demo mode.

Recording: real Claude sessions, not replays, so the video shows the actual product. Each persona
follows its lines in `scenario.md`. A take that goes wrong is reset with `reset.ts` and rerun.
