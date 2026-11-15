// Folds an incident's event log (in seq order) into its current state.
// Pure: same events in, same state out. Nothing here reads the clock.
import type { StoredEvent, Recommendation, Status } from "./events.js";

export interface IncidentCore {
  id: string;
  codename: string;
  title: string;
  priority: string;
  status: Status;
  lead: string | null;
  summary: string;
  template: string;
  detected_at: string;
  opened_at: string;
  opened_by: string;
  seq: number;
  last_activity: string;
}

export interface TimelineEntry {
  event_id: string;
  seq: number;
  time_utc: string;
  time_original: string;
  source: string | null;
  actor: string | null;
  description: string;
  phase: string | null;
  /** 0–100: how sure the analyst is. 100 unless they hedged. */
  confidence: number;
  author: string;
  source_artifact: string | null;
}

export interface Ioc {
  event_id: string;
  type: string;
  value: string;
  first_seen: string | null;
  sources: string[];
  verdict: string;
  external: boolean;
  author: string;
}

export interface Asset {
  event_id: string;
  host: string | null;
  user: string | null;
  owner: string | null;
  state: string;
  author: string;
}

export interface Task {
  event_id: string;
  seq: number;
  title: string;
  assignee: string | null;
  due: string | null;
  status: string;
  outcome: string | null;
  meeting_id: string | null;
  /** Last meeting at which this action was reviewed (outcome recorded). */
  reviewed_in: string | null;
  created_at: string;
  author: string;
  history: { at: string; by: string; status: string; outcome: string | null; meeting_id: string | null }[];
}

export interface StepState {
  status: string;
  evidence: Record<string, string>;
  updated_at: string | null;
  updated_by: string | null;
  done_at: string | null;
}

export interface ComplianceState {
  track_id: string;
  trigger_at: string;
  attached_at: string;
  steps: Record<string, StepState>;
}

export interface Engagement {
  engagement_id: string;
  team_id: string;
  request_type: string | null;
  status: string;
  reason: string | null;
  outcome: string | null;
  recommendations: (Recommendation & { added_by: string; added_at: string })[];
  created_at: string;
  requested_at: string | null;
  updated_at: string;
  updated_by: string;
  last_seq: number;
}

export interface Flag {
  flag_id: string;
  pair_id: string;
  other_incident_id: string;
  other_codename: string | null;
  kind: string;
  value: string;
  created_at: string;
  decision: string | null;
}

export interface Rhythm {
  cadence_minutes: number;
  next_at: string | null;
  channel_name: string | null;
  join_url: string | null;
  chair: string | null;
  set_at: string;
  set_seq: number;
}

export interface Meeting {
  meeting_id: string;
  seq: number;
  kind: "held" | "skipped";
  at: string; // started_at or scheduled_at
  chair: string | null;
  attendees: string[];
  notes: string | null;
  reason: string | null;
}

export interface Correspondence {
  event_id: string;
  direction: "inbound" | "outbound";
  party: string;
  from: string;
  to: string[];
  subject: string;
  sent_at: string;
  summary: string;
  related_step: string | null;
  author: string;
  source_artifact: string | null;
  proposed_by: string | null;
}

export interface Proposal {
  proposal_id: string;
  source: string;
  link: string | null;
  from: string;
  context: string | null;
  quote: string | null;
  summary: string;
  items: any[];
  created_at: string;
  submitted_by: string;
  status: "pending" | "accepted" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}

export interface CaseState {
  incident: IncidentCore;
  correspondence: Correspondence[];
  proposals: Proposal[];
  timeline: TimelineEntry[];
  iocs: Ioc[];
  assets: Asset[];
  ttps: { event_id: string; technique_id: string; name: string | null; description: string | null; author: string }[];
  cves: { event_id: string; cve_id: string; product: string | null; author: string }[];
  notes: { event_id: string; text: string; author: string; created_at: string }[];
  tasks: Task[];
  artifacts: { artifact_id: string; kind: string; filename: string; sha256: string; bytes: number; author: string; created_at: string }[];
  compliance: ComplianceState[];
  engagements: Engagement[];
  flags: Flag[];
  rhythm: Rhythm | null;
  meetings: Meeting[];
  analysts: Record<string, { first_at: string; last_at: string }>;
  retracted: string[];
}

export function foldEvents(events: StoredEvent[]): CaseState {
  if (!events.length || events[0].type !== "incident.opened") {
    throw new Error("Event log must start with incident.opened");
  }
  const retracted = new Set(
    events.filter((e) => e.type === "event.retracted").map((e) => e.payload.event_id as string),
  );

  const o = events[0].payload;
  const s: CaseState = {
    incident: {
      id: o.id,
      codename: o.codename,
      title: o.title,
      priority: o.priority,
      status: "Open",
      lead: o.lead ?? events[0].author,
      summary: "",
      template: o.template,
      detected_at: o.detected_at,
      opened_at: events[0].created_at,
      opened_by: events[0].author,
      seq: 0,
      last_activity: events[0].created_at,
    },
    correspondence: [],
    proposals: [],
    timeline: [],
    iocs: [],
    assets: [],
    ttps: [],
    cves: [],
    notes: [],
    tasks: [],
    artifacts: [],
    compliance: [],
    engagements: [],
    flags: [],
    rhythm: null,
    meetings: [],
    analysts: {},
    retracted: [...retracted],
  };

  const byId = <T extends { event_id: string }>(arr: T[], id: string) => arr.find((x) => x.event_id === id);

  for (const e of events) {
    s.incident.seq = e.seq;
    if (e.author !== "incident-mcp") {
      const a = (s.analysts[e.author] ??= { first_at: e.created_at, last_at: e.created_at });
      a.last_at = e.created_at;
    }
    if (e.type !== "analyst.connected") s.incident.last_activity = e.created_at;
    if (retracted.has(e.id)) continue;
    const p = e.payload;

    switch (e.type) {
      case "incident.opened":
        break;
      case "field.changed":
        (s.incident as any)[p.field] = p.new;
        break;
      case "artifact.added":
        s.artifacts.push({
          artifact_id: p.artifact_id,
          kind: p.kind,
          filename: p.filename,
          sha256: p.sha256,
          bytes: p.bytes,
          author: e.author,
          created_at: e.created_at,
        });
        break;
      case "timeline.added":
        s.timeline.push({
          event_id: e.id,
          seq: e.seq,
          time_utc: p.time_utc,
          time_original: p.time_original,
          source: p.source ?? null,
          actor: p.actor ?? null,
          description: p.description,
          phase: p.phase ?? null,
          confidence: p.confidence ?? 100,
          author: e.author,
          source_artifact: e.source_artifact,
        });
        break;
      case "timeline.updated": {
        const t = byId(s.timeline, p.timeline_id);
        if (t && typeof p.confidence === "number") t.confidence = p.confidence;
        break;
      }
      case "ioc.added":
        s.iocs.push({
          event_id: e.id,
          type: p.type,
          value: p.value,
          first_seen: p.first_seen ?? null,
          sources: p.source ? [p.source] : [],
          verdict: p.verdict ?? "unknown",
          external: !!p.external,
          author: e.author,
        });
        break;
      case "ioc.source_added": {
        const i = byId(s.iocs, p.ioc_event_id);
        if (i) {
          if (p.source && !i.sources.includes(p.source)) i.sources.push(p.source);
          if (p.verdict && p.verdict !== "unknown") i.verdict = p.verdict;
        }
        break;
      }
      case "asset.added":
        s.assets.push({
          event_id: e.id,
          host: p.host ?? null,
          user: p.user ?? null,
          owner: p.owner ?? null,
          state: p.state ?? "suspected",
          author: e.author,
        });
        break;
      case "asset.updated": {
        const a = byId(s.assets, p.asset_id);
        if (a) Object.assign(a, p.changes);
        break;
      }
      case "ttp.added":
        s.ttps.push({ event_id: e.id, technique_id: p.technique_id, name: p.name ?? null, description: p.description ?? null, author: e.author });
        break;
      case "cve.added":
        s.cves.push({ event_id: e.id, cve_id: p.cve_id, product: p.product ?? null, author: e.author });
        break;
      case "note.added":
        s.notes.push({ event_id: e.id, text: p.text, author: e.author, created_at: e.created_at });
        break;
      case "task.added":
        s.tasks.push({
          event_id: e.id,
          seq: e.seq,
          title: p.title,
          assignee: p.assignee ?? null,
          due: p.due ?? null,
          status: "open",
          outcome: null,
          meeting_id: p.meeting_id ?? null,
          reviewed_in: null,
          created_at: e.created_at,
          author: e.author,
          history: [],
        });
        break;
      case "task.updated": {
        const t = byId(s.tasks, p.task_id);
        if (!t) break;
        for (const k of ["title", "assignee", "due", "status", "outcome"] as const) {
          if (p[k] !== undefined) (t as any)[k] = p[k];
        }
        if (p.meeting_id) t.reviewed_in = p.meeting_id;
        t.history.push({ at: e.created_at, by: e.author, status: t.status, outcome: p.outcome ?? null, meeting_id: p.meeting_id ?? null });
        break;
      }
      case "compliance.attached":
        s.compliance.push({ track_id: p.track_id, trigger_at: p.trigger_at, attached_at: e.created_at, steps: {} });
        break;
      case "compliance.step_updated": {
        const c = s.compliance.find((x) => x.track_id === p.track_id);
        if (!c) break;
        const prev = c.steps[p.step_id];
        c.steps[p.step_id] = {
          status: p.status,
          evidence: { ...(prev?.evidence ?? {}), ...(p.evidence ?? {}) },
          updated_at: e.created_at,
          updated_by: e.author,
          done_at: p.status === "done" || p.status === "not_applicable" ? (p.done_at ?? e.created_at) : null,
        };
        break;
      }
      case "engagement.updated": {
        let g = s.engagements.find((x) => x.engagement_id === p.engagement_id);
        if (!g) {
          g = {
            engagement_id: p.engagement_id,
            team_id: p.team_id,
            request_type: p.request_type ?? null,
            status: p.status,
            reason: null,
            outcome: null,
            recommendations: [],
            created_at: e.created_at,
            requested_at: null,
            updated_at: e.created_at,
            updated_by: e.author,
            last_seq: e.seq,
          };
          s.engagements.push(g);
        }
        g.status = p.status;
        if (p.request_type) g.request_type = p.request_type;
        if (p.reason !== undefined) g.reason = p.reason;
        if (p.outcome !== undefined) g.outcome = p.outcome;
        if (p.status === "requested" && !g.requested_at) g.requested_at = e.created_at;
        for (const r of p.recommendations ?? []) g.recommendations.push({ ...r, added_by: e.author, added_at: e.created_at });
        g.updated_at = e.created_at;
        g.updated_by = e.author;
        g.last_seq = e.seq;
        break;
      }
      case "correlation.flagged":
        s.flags.push({
          flag_id: e.id,
          pair_id: p.pair_id,
          other_incident_id: p.other_incident_id,
          other_codename: p.other_codename ?? null,
          kind: p.kind,
          value: p.value,
          created_at: e.created_at,
          decision: null,
        });
        break;
      case "correlation.resolved": {
        const f = s.flags.find((x) => x.flag_id === p.flag_id);
        if (f) f.decision = p.decision;
        break;
      }
      case "meeting.schedule_set":
        s.rhythm = {
          cadence_minutes: p.cadence_minutes,
          next_at: p.next_at ?? null,
          channel_name: p.channel_name ?? s.rhythm?.channel_name ?? null,
          join_url: p.join_url ?? s.rhythm?.join_url ?? null,
          chair: p.chair ?? s.rhythm?.chair ?? null,
          set_at: e.created_at,
          set_seq: e.seq,
        };
        break;
      case "meeting.held":
        s.meetings.push({
          meeting_id: e.id,
          seq: e.seq,
          kind: "held",
          at: p.started_at,
          chair: p.chair ?? null,
          attendees: p.attendees ?? [],
          notes: p.notes ?? null,
          reason: null,
        });
        break;
      case "meeting.skipped":
        s.meetings.push({
          meeting_id: e.id,
          seq: e.seq,
          kind: "skipped",
          at: p.scheduled_at,
          chair: null,
          attendees: [],
          notes: null,
          reason: p.reason,
        });
        break;
      case "correspondence.added":
        s.correspondence.push({
          event_id: e.id,
          direction: p.direction,
          party: p.party,
          from: p.from,
          to: p.to ?? [],
          subject: p.subject,
          sent_at: p.sent_at,
          summary: p.summary,
          related_step: p.related_step ?? null,
          author: e.author,
          source_artifact: e.source_artifact,
          proposed_by: p.proposed_by ?? null,
        });
        break;
      case "proposal.added":
        s.proposals.push({
          proposal_id: p.proposal_id,
          source: p.source,
          link: p.link ?? null,
          from: p.from,
          context: p.context ?? null,
          quote: p.quote ?? null,
          summary: p.summary,
          items: p.items ?? [],
          created_at: e.created_at,
          submitted_by: e.author,
          status: "pending",
          decided_by: null,
          decided_at: null,
          reason: null,
        });
        break;
      case "proposal.decided": {
        const pr = s.proposals.find((x) => x.proposal_id === p.proposal_id);
        if (pr) Object.assign(pr, { status: p.decision, decided_by: e.author, decided_at: e.created_at, reason: p.reason ?? null });
        break;
      }
      case "analyst.connected":
      case "event.retracted":
        break;
    }
  }
  return s;
}
