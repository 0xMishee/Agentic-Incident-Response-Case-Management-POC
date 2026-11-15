// Event envelope and the closed sets used across the case.
import { z } from "zod";

export const STATUSES = ["Open", "Resolved", "Closed"] as const;
export type Status = (typeof STATUSES)[number];

export const IocType = z.enum(["ipv4", "ipv6", "domain", "url", "sha256", "sha1", "md5", "email"]);
export const Verdict = z.enum(["malicious", "suspicious", "benign", "unknown"]);
export const AssetState = z.enum(["suspected", "compromised", "contained", "clean"]);
export const TaskStatus = z.enum(["open", "in_progress", "done", "cancelled"]);
export const StepStatus = z.enum(["todo", "in_progress", "done", "not_applicable"]);
export const EngagementStatus = z.enum(["suggested", "requested", "engaged", "delivered", "not_needed"]);
export const ArtifactKind = z.enum(["alert", "log", "email", "screenshot", "note", "ioc_list", "other"]);
export const CorrelationDecision = z.enum(["linked", "merged", "dismissed"]);

export const EVENT_TYPES = [
  "incident.opened",
  "field.changed",
  "artifact.added",
  "timeline.added",
  "timeline.updated",
  "ioc.added",
  "ioc.source_added",
  "asset.added",
  "asset.updated",
  "ttp.added",
  "cve.added",
  "note.added",
  "task.added",
  "task.updated",
  "compliance.attached",
  "compliance.step_updated",
  "engagement.updated",
  "correlation.flagged",
  "correlation.resolved",
  "meeting.schedule_set",
  "meeting.held",
  "meeting.skipped",
  "correspondence.added",
  "proposal.added",
  "proposal.decided",
  "analyst.connected",
  "event.retracted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface StoredEvent {
  id: string;
  incident_id: string;
  seq: number;
  type: EventType;
  payload: any;
  author: string;
  session_id: string | null;
  source_artifact: string | null;
  idempotency_key: string;
  created_at: string;
  supersedes: string | null;
  target: string | null;
}

/** What a caller hands the store; the store fills in the envelope. */
export interface Draft {
  type: EventType;
  payload: Record<string, unknown>;
  /** Conflict key for non-append edits, e.g. "field:summary", "task:<id>". */
  target?: string;
  source_artifact?: string | null;
  supersedes?: string | null;
  /** Pre-assigned event id (lets one draft reference another in the same batch). */
  id?: string;
}

export const RecommendationSchema = z.object({
  kind: z.enum(["detection_rule", "dashboard", "hunt_query", "tuning"]),
  title: z.string().min(1),
  rationale: z.string().default(""),
  evidence: z.array(z.string()).default([]),
  draft: z
    .object({
      language: z.enum(["kql", "spl", "sigma", "eql"]).optional(),
      query: z.string().optional(),
      panels: z.array(z.object({ title: z.string(), query: z.string(), viz: z.string() })).optional(),
    })
    .default({}),
  mitre: z.array(z.string()).optional(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** One-line human summary of an event, used in digests, briefs and the live stream. */
export function describe(e: StoredEvent): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case "incident.opened":
      return `Incident opened: ${p.codename} "${p.title}" (${p.priority})`;
    case "field.changed":
      return p.field === "summary" ? "Summary updated" : `${p.field}: ${p.old ?? "none"} -> ${p.new}`;
    case "artifact.added":
      return `Artifact added: ${p.filename} (${p.kind})`;
    case "timeline.added":
      return `Timeline ${p.time_utc}: ${p.description}${p.source ? ` [${p.source}]` : ""}${(p.confidence ?? 100) < 100 ? ` (confidence ${p.confidence}%)` : ""}`;
    case "timeline.updated":
      return `Timeline confidence ${p.old ?? "?"}% -> ${p.confidence}%: ${truncate(p.description ?? p.timeline_id, 80)}${p.reason ? ` (${p.reason})` : ""}`;
    case "ioc.added":
      return `IOC ${p.type} ${p.value}${p.verdict && p.verdict !== "unknown" ? ` (${p.verdict})` : ""}`;
    case "ioc.source_added":
      return `IOC seen again in ${p.source}: ${p.value}`;
    case "asset.added":
      return `Asset ${[p.host, p.user].filter(Boolean).join(" / ")} (${p.state})`;
    case "asset.updated":
      return `Asset ${p.label ?? p.asset_id}: ${Object.entries(p.changes ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}`;
    case "ttp.added":
      return `Technique ${p.technique_id}${p.name ? ` ${p.name}` : ""}`;
    case "cve.added":
      return `CVE ${p.cve_id}${p.product ? ` in ${p.product}` : ""}`;
    case "note.added":
      return `Note: ${truncate(p.text, 120)}`;
    case "task.added":
      return `Task${p.meeting_id ? " (meeting action)" : ""}: ${p.title}${p.assignee ? ` -> ${p.assignee}` : ""}`;
    case "task.updated":
      return `Task ${p.title ?? p.task_id}: ${[p.status, p.assignee && `-> ${p.assignee}`, p.outcome && `outcome: ${p.outcome}`].filter(Boolean).join(", ")}`;
    case "compliance.attached":
      return `Compliance track attached: ${p.track_id} (clock from ${p.trigger_at})`;
    case "compliance.step_updated":
      return `Compliance ${p.track_id}/${p.step_id}: ${p.status}`;
    case "engagement.updated":
      return `Engagement ${p.team_id}${p.request_type ? ` ${p.request_type}` : ""}: ${p.status}${p.outcome ? ` (${p.outcome})` : p.reason ? ` (${p.reason})` : ""}`;
    case "correlation.flagged":
      return `Correlation: ${p.value} also in ${p.other_incident_id}${p.other_codename ? ` (${p.other_codename})` : ""} [${p.kind}]`;
    case "correlation.resolved":
      return `Correlation ${p.flag_id}: ${p.decision}`;
    case "meeting.schedule_set":
      return p.cadence_minutes
        ? `Incident meetings: every ${p.cadence_minutes} min, next ${p.next_at}`
        : `Incident meetings: ad hoc${p.next_at ? `, next ${p.next_at}` : ""}`;
    case "meeting.held":
      return `Meeting held at ${p.started_at} (${(p.attendees ?? []).length} attendees)`;
    case "meeting.skipped":
      return `Meeting at ${p.scheduled_at} skipped: ${p.reason}`;
    case "correspondence.added":
      return `Email ${p.direction === "outbound" ? "to" : "from"} ${p.direction === "outbound" ? (p.to ?? []).join(", ") : p.from}: ${p.subject}`;
    case "proposal.added":
      return `Suggestion from ${p.from} via ${p.source}: ${truncate(p.summary, 100)} (waiting for review)`;
    case "proposal.decided":
      return `Suggestion from ${p.from} ${p.decision}${p.reason ? `: ${p.reason}` : ""}`;
    case "analyst.connected":
      return `${p.author} connected`;
    case "event.retracted":
      return `Retracted ${p.event_id}: ${p.reason}`;
  }
}

function truncate(s: string, n: number) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
