// CaseService: every operation the MCP tools and the REST API expose. Validation lives here;
// ordering and atomicity live in Store.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Config } from "./config.js";
import {
  closeBlockers,
  complianceSteps,
  effectiveCadence,
  engagementDueAt,
  engagementOpen,
  hoursUntil,
  isCarriedOver,
  lastMeeting,
  meetingActions,
  nextMeetingAt,
  stepOpen,
  taskOpen,
} from "./derive.js";
import {
  ArtifactKind,
  AssetState,
  CorrelationDecision,
  EngagementStatus,
  RecommendationSchema,
  STATUSES,
  StepStatus,
  TaskStatus,
  Verdict,
  describe,
  type Draft,
  type StoredEvent,
} from "./events.js";
import type { CaseState } from "./fold.js";
import { normalizeIoc, normalizeTime } from "./normalize.js";
import { renderReport } from "./render.js";
import { Store, type AppendResult } from "./store.js";
import { AppError, PRIORITIES, iso, priorityRank, slugify, ulid, type Clock } from "./util.js";

export const ROLES = ["analyst", "lead", "manager", "engineer"] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  author: string;
  role: Role;
  team: string | null;
  session_id: string | null;
}

export const SYSTEM_AUTHOR = "incident-mcp";
export const CORRESPONDENCE_PARTIES = ["regulator", "csirt", "supplier", "customer", "legal", "law_enforcement", "insurer", "internal", "other"] as const;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

// ---------- input schemas (shared by MCP tools and REST) ----------

const Ref = z.string().min(1).optional().describe("Incident id (INC-2026-0042), number (42) or codename. Omit to use the incident this session is connected to.");
const Key = z.string().min(1).max(200).optional().describe("Client-generated idempotency key (e.g. a UUID). A retried call with the same key is stored once.");
const Priority = z.enum(PRIORITIES);
const Time = z.string().describe("ISO 8601 with Z or an offset");

export const RhythmInput = z.object({
  cadence_minutes: z.number().int().min(0).describe("Minutes between meetings; 0 = ad hoc"),
  next_at: Time.optional(),
  channel_name: z.string().optional(),
  join_url: z.string().url().optional(),
  chair: z.string().optional(),
});

export const EventItem = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("timeline"),
    time: Time.describe("When it happened (the event's own timestamp, with timezone)"),
    description: z.string().min(1),
    source: z.string().optional().describe("Alert or log id, e.g. ALRT-881"),
    actor: z.string().optional().describe("User, host or process that did it"),
    phase: z.string().optional(),
    confidence: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("How sure the analyst is, 0–100. Default 100. Lower it when they hedge: \"I think it was…\", \"probably\", \"might have\"."),
    source_artifact: z.string().optional(),
  }),
  z.object({
    type: z.literal("ioc"),
    value: z.string().min(1).describe("Indicator; defanged values are fine"),
    ioc_type: z.enum(["ipv4", "ipv6", "domain", "url", "sha256", "sha1", "md5", "email"]).optional(),
    first_seen: Time.optional(),
    source: z.string().optional(),
    verdict: Verdict.optional(),
    external: z.boolean().optional().describe("True if outside the organisation"),
    source_artifact: z.string().optional(),
  }),
  z.object({
    type: z.literal("asset"),
    host: z.string().optional(),
    user: z.string().optional(),
    owner: z.string().optional(),
    state: AssetState.optional(),
    source_artifact: z.string().optional(),
  }),
  z.object({ type: z.literal("note"), text: z.string().min(1), source_artifact: z.string().optional() }),
  z.object({ type: z.literal("task"), title: z.string().min(1), assignee: z.string().optional(), due: Time.optional() }),
  z.object({
    type: z.literal("ttp"),
    technique_id: z.string().regex(/^T\d{4}(\.\d{3})?$/, "MITRE technique id like T1114 or T1114.003"),
    name: z.string().optional(),
    description: z.string().optional(),
    source_artifact: z.string().optional(),
  }),
  z.object({
    type: z.literal("cve"),
    cve_id: z.string().regex(/^CVE-\d{4}-\d{4,}$/i, "CVE id like CVE-2024-12345"),
    product: z.string().optional(),
    source_artifact: z.string().optional(),
  }),
  z.object({
    type: z.literal("correspondence"),
    direction: z.enum(["inbound", "outbound"]),
    party: z.enum(CORRESPONDENCE_PARTIES).describe("Who is on the other side"),
    from: z.string().min(1),
    to: z.array(z.string().min(1)).min(1),
    subject: z.string().min(1),
    sent_at: Time,
    summary: z.string().min(1).describe("One or two lines: what it says or asks"),
    related_step: z.string().optional().describe("Compliance step it belongs to, as track/step, e.g. nis2/early-warning"),
    source_artifact: z.string().optional(),
  }),
]);
export type EventItemInput = z.infer<typeof EventItem>;
type ItemResult = { index: number; type: string; event_id?: string; deduplicated?: boolean; warning?: string };

export const Inputs = {
  listIncidents: z.object({ status: z.enum(STATUSES).optional(), limit: z.number().int().min(1).max(500).optional() }),
  findIncident: z.object({ query: z.string().min(1) }),
  connect: z.object({ query: z.string().min(1).describe("Codename, id, number or words from the title") }),
  openIncident: z.object({
    title: z.string().min(3).max(120),
    priority: Priority,
    template: z.string().optional(),
    detected_at: Time.optional(),
    lead: z.string().optional(),
    summary: z.string().optional(),
    compliance: z.array(z.string()).optional().describe("Track ids to attach, e.g. [nis2, gdpr]"),
    meeting_schedule: RhythmInput.optional().describe("Omit to use the template default for this priority"),
    idempotency_key: Key,
  }),
  addArtifact: z.object({
    incident: Ref,
    kind: ArtifactKind,
    filename: z.string().min(1).max(200),
    content: z.string().optional().describe("Text content"),
    content_base64: z.string().optional().describe("Binary content, base64"),
    idempotency_key: Key,
  }),
  addEvents: z.object({ incident: Ref, items: z.array(EventItem).min(1).max(500), idempotency_key: Key }),
  updateField: z.object({
    incident: Ref,
    field: z.enum(["title", "priority", "status", "lead", "summary", "detected_at"]),
    value: z.string(),
    expected_seq: z.number().int().min(0).optional().describe("The seq you last saw. Required for summary, status and priority."),
    idempotency_key: Key,
  }),
  updateItem: z.object({
    incident: Ref,
    kind: z.enum(["task", "asset", "timeline"]),
    item_id: z.string(),
    changes: z.object({
      confidence: z.number().int().min(0).max(100).optional().describe("Timeline entries: new confidence, e.g. 100 once confirmed"),
      reason: z.string().optional().describe("Timeline entries: why the confidence changed"),
      title: z.string().optional(),
      assignee: z.string().optional(),
      due: Time.optional(),
      status: TaskStatus.optional(),
      outcome: z.string().optional(),
      state: AssetState.optional(),
      owner: z.string().optional(),
    }),
    expected_seq: z.number().int().min(0).optional(),
    idempotency_key: Key,
  }),
  attachCompliance: z.object({ incident: Ref, track_id: z.string(), trigger_at: Time.optional(), idempotency_key: Key }),
  setComplianceStep: z.object({
    incident: Ref,
    track_id: z.string(),
    step_id: z.string(),
    status: StepStatus,
    evidence: z.record(z.string(), z.string()).optional(),
    expected_seq: z.number().int().min(0).optional(),
    idempotency_key: Key,
  }),
  setEngagement: z.object({
    incident: Ref,
    engagement_id: z.string().optional().describe("Omit to create, or to turn a suggestion for this team into a request"),
    team_id: z.string(),
    request_type: z.string().optional(),
    status: EngagementStatus,
    reason: z.string().optional().describe("Required for not_needed"),
    outcome: z.string().optional().describe("Required for delivered: rule id, dashboard link, finding"),
    recommendations: z.array(RecommendationSchema).optional(),
    expected_seq: z.number().int().min(0).optional(),
    idempotency_key: Key,
  }),
  resolveCorrelation: z.object({ incident: Ref, flag_id: z.string(), decision: CorrelationDecision, idempotency_key: Key }),
  setMeetingSchedule: RhythmInput.extend({ incident: Ref, idempotency_key: Key }),
  recordMeeting: z.object({
    incident: Ref,
    started_at: Time.optional(),
    chair: z.string().optional(),
    attendees: z.array(z.string()).default([]),
    notes: z.string().optional(),
    outcomes: z
      .array(z.object({ task_id: z.string(), status: TaskStatus, outcome: z.string().min(1) }))
      .default([]),
    actions: z.array(z.object({ assignee: z.string().min(1), title: z.string().min(1), due: Time.optional() })).default([]),
    idempotency_key: Key,
  }),
  skipMeeting: z.object({ incident: Ref, scheduled_at: Time.optional(), reason: z.string().min(1), idempotency_key: Key }),
  retractEvent: z.object({ incident: Ref, event_id: z.string(), reason: z.string().min(1), idempotency_key: Key }),
  getReport: z.object({ incident: Ref, section: z.string().optional().describe("Template section id, e.g. timeline") }),
  getUpdates: z.object({ incident: Ref, since_seq: z.number().int().min(0).optional() }),
  incidentOnly: z.object({ incident: Ref }),
  getTeamQueue: z.object({ team_id: z.string().optional() }),
  propose: z.object({
    incident: Ref,
    source: z.enum(["teams-meeting", "teams-chat", "email", "portal", "other"]).describe("teams-meeting: heard in the incident meeting; teams-chat: read in the incident chat"),
    link: z.string().url().optional().describe("Deep link to the chat message, meeting recording moment or email"),
    from: z.string().min(1).describe("The person who said or sent it"),
    context: z.string().optional().describe("Where it came from, e.g. \"Incident meeting 10:00\" or an email subject"),
    quote: z.string().optional().describe("What was actually said or written"),
    summary: z.string().min(1),
    items: z.array(EventItem).min(1).max(50),
    idempotency_key: Key,
  }),
  decideProposal: z.object({
    incident: Ref,
    proposal_id: z.string(),
    decision: z.enum(["accepted", "rejected"]),
    reason: z.string().optional(),
    item_indexes: z.array(z.number().int().min(0)).optional().describe("Accept only these items (default: all)"),
    idempotency_key: Key,
  }),
  ingestEmail: z.object({
    incident: Ref,
    direction: z.enum(["inbound", "outbound"]).default("inbound"),
    party: z.enum(CORRESPONDENCE_PARTIES).default("other"),
    from: z.string().min(1),
    to: z.array(z.string().min(1)).min(1),
    subject: z.string().min(1),
    date: Time,
    body: z.string(),
    summary: z.string().optional(),
    idempotency_key: Key,
  }),
};

type In<K extends keyof typeof Inputs> = z.input<(typeof Inputs)[K]>;

function parse<K extends keyof typeof Inputs>(k: K, raw: unknown): z.output<(typeof Inputs)[K]> {
  const r = Inputs[k].safeParse(raw ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AppError("invalid", `${issue.path.join(".") || "input"}: ${issue.message}`, {
      field: issue.path.join("."),
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data as any;
}

// ---------- service ----------

export class CaseService {
  readonly store: Store;
  private renderTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    db: DatabaseSync,
    readonly cfg: Config,
    readonly clock: Clock,
    private opts: { renderDelayMs?: number } = {},
  ) {
    this.store = new Store(db, cfg, clock);
    this.store.on("committed", ({ incident_id }) => this.scheduleRender(incident_id));
  }

  get db() {
    return this.store.db;
  }
  private now() {
    return this.clock.now();
  }

  // ---------- rendering ----------

  reportPath(id: string) {
    return join(this.cfg.dataDir, "incidents", id, "report.md");
  }

  renderNow(id: string): string {
    const md = renderReport(this.store.state(id), this.cfg);
    mkdirSync(join(this.cfg.dataDir, "incidents", id), { recursive: true });
    writeFileSync(this.reportPath(id), md, "utf8");
    return md;
  }

  renderAll() {
    for (const r of this.store.listIncidentRows()) this.renderNow(r.id);
  }

  private scheduleRender(id: string) {
    const delay = this.opts.renderDelayMs ?? 250;
    if (delay <= 0) return void this.renderNow(id);
    clearTimeout(this.renderTimers.get(id));
    this.renderTimers.set(id, setTimeout(() => {
      this.renderTimers.delete(id);
      this.renderNow(id);
    }, delay));
  }

  /** Write any pending reports now (used on shutdown and in tests). */
  flushRenders() {
    for (const [id, t] of this.renderTimers) {
      clearTimeout(t);
      this.renderNow(id);
    }
    this.renderTimers.clear();
  }

  // ---------- sessions ----------

  registerSession(actor: Actor) {
    if (!actor.session_id) return;
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, author, role, team, incident_id, connected_at) VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(session_id) DO UPDATE SET author = excluded.author, role = excluded.role, team = excluded.team`,
      )
      .run(actor.session_id, actor.author, actor.role, actor.team, iso(this.now()));
  }

  linkedIncident(actor: Actor): string | null {
    if (!actor.session_id) return null;
    const r = this.db.prepare("SELECT incident_id FROM sessions WHERE session_id = ?").get(actor.session_id) as
      | { incident_id: string | null }
      | undefined;
    return r?.incident_id ?? null;
  }

  private link(actor: Actor, incidentId: string) {
    if (!actor.session_id) return;
    this.registerSession(actor);
    this.db.prepare("UPDATE sessions SET incident_id = ? WHERE session_id = ?").run(incidentId, actor.session_id);
  }

  // ---------- resolution ----------

  /** All incidents matching a name, id, number or title words. */
  match(query: string): any[] {
    const q = query.trim();
    const rows = this.store.listIncidentRows();
    const byId = rows.filter((r) => r.id.toLowerCase() === q.toLowerCase());
    if (byId.length) return byId;
    if (/^\d+$/.test(q)) {
      const n = Number(q);
      const hits = rows.filter((r) => r.number === n);
      if (hits.length) return hits.sort((a, b) => b.year - a.year).slice(0, 1);
    }
    const slug = slugify(q.replace(/^connect to\s+/i, ""));
    const byName = rows.filter((r) => r.codename_slug === slug);
    if (byName.length) return byName;
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (!words.length) return [];
    return rows.filter((r) => {
      const hay = `${r.title} ${r.codename}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  resolve(ref: string | undefined, actor?: Actor): string {
    if (!ref) {
      const linked = actor ? this.linkedIncident(actor) : null;
      if (!linked) {
        throw new AppError("not_connected", "This session is not connected to an incident. Pass `incident`, or connect first (connect_incident).");
      }
      return linked;
    }
    const m = this.match(ref);
    if (m.length === 1) return m[0].id;
    if (!m.length) throw new AppError("not_found", `No incident matches "${ref}".`);
    throw new AppError("ambiguous", `"${ref}" matches ${m.length} incidents. Pick one.`, {
      candidates: m.map((r) => this.listRow(r)),
    });
  }

  private writable(id: string, allowReopen = false): CaseState {
    const st = this.store.state(id);
    if (st.incident.status === "Closed" && !allowReopen) {
      throw new AppError("closed", `${st.incident.codename} (${id}) is closed. Reopen it (status -> Open) to make changes.`);
    }
    return st;
  }

  private ctx(actor: Actor, key?: string, expected_seq?: number) {
    return { author: actor.author, session_id: actor.session_id, idempotency_key: key, expected_seq };
  }

  // ---------- list / find / connect ----------

  private listRow(r: any) {
    const st = this.store.state(r.id);
    const next = complianceSteps(st, this.cfg)
      .filter((s) => stepOpen(s) && s.due_at)
      .sort((a, b) => a.due_at!.localeCompare(b.due_at!))[0];
    return {
      id: r.id,
      codename: r.codename,
      title: r.title,
      priority: r.priority,
      status: r.status,
      lead: r.lead,
      next_deadline: next ? { at: next.due_at, what: `${next.track_id}: ${next.title}` } : null,
      next_meeting: nextMeetingAt(st, this.cfg),
      last_activity: r.last_activity,
      seq: r.seq,
    };
  }

  listIncidents(raw: In<"listIncidents"> = {}) {
    const { status, limit } = parse("listIncidents", raw);
    const rows = this.store
      .listIncidentRows()
      .filter((r) => (status ? r.status === status : true))
      .map((r) => this.listRow(r))
      .sort((a, b) => {
        // Open first, then most urgent deadline, then priority, then most recent activity
        if ((a.status === "Closed") !== (b.status === "Closed")) return a.status === "Closed" ? 1 : -1;
        const da = a.next_deadline?.at ?? "9999", dbb = b.next_deadline?.at ?? "9999";
        if (da !== dbb) return da.localeCompare(dbb);
        return priorityRank(b.priority) - priorityRank(a.priority) || b.last_activity.localeCompare(a.last_activity);
      });
    return { incidents: rows.slice(0, limit ?? 100) };
  }

  findIncident(raw: In<"findIncident">) {
    const { query } = parse("findIncident", raw);
    const m = this.match(query);
    if (!m.length) throw new AppError("not_found", `No incident matches "${query}".`);
    if (m.length === 1) return { match: this.listRow(m[0]) };
    return { candidates: m.map((r) => this.listRow(r)) };
  }

  connect(actor: Actor, raw: In<"connect">) {
    const { query } = parse("connect", raw);
    const id = this.resolve(query);
    this.link(actor, id);
    const firstVisit = this.store.lastSeen(actor.author, id) === 0;
    this.store.append(id, [{ type: "analyst.connected", payload: { author: actor.author, role: actor.role } }], this.ctx(actor));
    const st = this.store.state(id);
    if (firstVisit) this.store.markSeen(actor.author, id, st.incident.seq);
    return { connected: true, ...this.briefing(st, actor) };
  }

  private briefing(st: CaseState, actor: Actor) {
    const now = this.now();
    const windowStart = iso(now.getTime() - this.cfg.settings.digest_window_hours * 3_600_000);
    const steps = complianceSteps(st, this.cfg).filter(stepOpen);
    const next = nextMeetingAt(st, this.cfg);
    return {
      incident: {
        id: st.incident.id,
        codename: st.incident.codename,
        title: st.incident.title,
        priority: st.incident.priority,
        status: st.incident.status,
        lead: st.incident.lead,
        detected_at: st.incident.detected_at,
      },
      summary: st.incident.summary || null,
      seq: st.incident.seq,
      counts: { timeline: st.timeline.length, iocs: st.iocs.length, assets: st.assets.length, artifacts: st.artifacts.length },
      latest_timeline: [...st.timeline].sort((a, b) => a.time_utc.localeCompare(b.time_utc)).slice(-10).map((t) => ({ event_id: t.event_id, time_utc: t.time_utc, description: t.description, source: t.source, phase: t.phase, confidence: t.confidence })),
      open_tasks: st.tasks.filter(taskOpen).map((t) => ({ task_id: t.event_id, title: t.title, assignee: t.assignee, due: t.due, meeting_action: !!t.meeting_id })),
      your_open_actions: st.tasks.filter((t) => taskOpen(t) && t.assignee === actor.author).map((t) => ({ task_id: t.event_id, title: t.title, due: t.due })),
      open_flags: st.flags.filter((f) => !f.decision).map((f) => ({ flag_id: f.flag_id, kind: f.kind, value: f.value, other: `${f.other_incident_id} (${f.other_codename})` })),
      compliance_due_next: steps
        .filter((s) => s.due_at)
        .sort((a, b) => a.due_at!.localeCompare(b.due_at!))
        .slice(0, 3)
        .map((s) => ({ track: s.track_id, step: s.step_id, title: s.title, due_at: s.due_at, hours_left: hoursUntil(s.due_at!, now), status: s.status })),
      open_engagements: st.engagements
        .filter((g) => g.status !== "delivered" && g.status !== "not_needed")
        .map((g) => ({ engagement_id: g.engagement_id, team: g.team_id, request_type: g.request_type, status: g.status, reason: g.reason })),
      next_meeting: next ? { at: next, minutes_until: Math.round((Date.parse(next) - now.getTime()) / 60_000), join_url: st.rhythm?.join_url ?? null, channel: st.rhythm?.channel_name ?? null } : null,
      waiting_for_review: st.proposals.filter((p) => p.status === "pending").map((p) => ({ proposal_id: p.proposal_id, from: p.from, via: p.source, summary: p.summary, items: p.items.length })),
      active_analysts: Object.entries(st.analysts)
        .filter(([, a]) => a.last_at >= windowStart)
        .map(([name]) => name),
    };
  }

  // ---------- open ----------

  /** `opts.codename` is for the demo seed only; it is not exposed as a tool input. */
  openIncident(actor: Actor, raw: In<"openIncident">, opts: { codename?: string } = {}) {
    const input = parse("openIncident", raw);
    const template = input.template ?? this.cfg.settings.default_template;
    const tpl = this.cfg.templates.get(template);
    if (!tpl) throw new AppError("invalid", `Unknown template "${template}". Known: ${[...this.cfg.templates.keys()].join(", ")}`, { field: "template" });
    for (const t of input.compliance ?? []) {
      if (!this.cfg.tracks.has(t)) throw new AppError("invalid", `Unknown compliance track "${t}". Known: ${[...this.cfg.tracks.keys()].join(", ")}`, { field: "compliance" });
    }
    const now = this.now();
    const detected_at = input.detected_at ? normalizeTime(input.detected_at, "detected_at") : iso(now);
    const rhythm = input.meeting_schedule ?? (tpl.default_meeting_minutes[input.priority] ? { cadence_minutes: tpl.default_meeting_minutes[input.priority]! } : undefined);

    const r = this.store.createIncident(
      { title: input.title, priority: input.priority, template: `${tpl.name}@${tpl.version}`, detected_at, lead: input.lead, codename: opts.codename },
      () => {
        const extra: Draft[] = [];
        if (input.summary) extra.push({ type: "field.changed", payload: { field: "summary", old: "", new: input.summary }, target: "field:summary" });
        for (const t of input.compliance ?? []) {
          extra.push({ type: "compliance.attached", payload: { track_id: t, trigger_at: detected_at }, target: `track:${t}` });
        }
        if (rhythm) extra.push(this.rhythmDraft(rhythm, now));
        return extra;
      },
      this.ctx(actor, input.idempotency_key),
    );
    this.link(actor, r.incident_id);
    const st = this.store.state(r.incident_id);
    this.store.markSeen(actor.author, r.incident_id, st.incident.seq);
    return {
      id: st.incident.id,
      codename: st.incident.codename,
      title: st.incident.title,
      priority: st.incident.priority,
      status: st.incident.status,
      lead: st.incident.lead,
      detected_at: st.incident.detected_at,
      seq: st.incident.seq,
      replayed: r.replayed,
      compliance: st.compliance.map((c) => c.track_id),
      next_meeting: nextMeetingAt(st, this.cfg),
      suggested_engagements: st.engagements.filter((g) => g.status === "suggested").map((g) => ({ engagement_id: g.engagement_id, team: g.team_id, reason: g.reason })),
      compliance_not_attached: tpl.compliance_offer
        .filter((t) => !(input.compliance ?? []).includes(t))
        .map((t) => ({ track_id: t, question: this.cfg.tracks.get(t)?.ask_at_open })),
    };
  }

  private rhythmDraft(r: z.output<typeof RhythmInput>, now: Date): Draft {
    // Default: one cadence from now, rounded up to the whole minute so it reads well ("10:14Z").
    const next_at = r.next_at
      ? normalizeTime(r.next_at, "next_at")
      : r.cadence_minutes > 0
        ? iso(Math.ceil((now.getTime() + r.cadence_minutes * 60_000) / 60_000) * 60_000)
        : null;
    return {
      type: "meeting.schedule_set",
      payload: { cadence_minutes: r.cadence_minutes, next_at, channel_name: r.channel_name ?? null, join_url: r.join_url ?? null, chair: r.chair ?? null },
      target: "rhythm",
    };
  }

  // ---------- artifacts & evidence ----------

  addArtifact(actor: Actor, raw: In<"addArtifact">) {
    const input = parse("addArtifact", raw);
    const id = this.resolve(input.incident, actor);
    this.writable(id);
    if (input.content === undefined && input.content_base64 === undefined) {
      throw new AppError("invalid", "Give content (text) or content_base64.", { field: "content" });
    }
    const buf = input.content_base64 !== undefined ? Buffer.from(input.content_base64, "base64") : Buffer.from(input.content!, "utf8");
    if (buf.length > MAX_ARTIFACT_BYTES) throw new AppError("invalid", `Artifact is larger than ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.`);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const dup = this.db.prepare("SELECT id FROM artifacts WHERE incident_id = ? AND sha256 = ?").get(id, sha256) as { id: string } | undefined;
    if (dup) return { artifact_id: dup.id, sha256, deduplicated: true, note: "Same content was already added to this incident." };

    const artifact_id = `art_${ulid()}`;
    const ext = (extname(input.filename).toLowerCase().match(/^\.[a-z0-9]{1,8}$/)?.[0]) ?? (input.content_base64 ? ".bin" : ".txt");
    const dir = join(this.cfg.dataDir, "incidents", id, "artifacts");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, artifact_id + ext);
    writeFileSync(path, buf);
    const r = this.store.append(
      id,
      [{ type: "artifact.added", payload: { artifact_id, kind: input.kind, filename: input.filename, sha256, bytes: buf.length } }],
      this.ctx(actor, input.idempotency_key),
    );
    if (!r.replayed) {
      this.db
        .prepare("INSERT INTO artifacts (id, incident_id, kind, filename, sha256, bytes, path, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(artifact_id, id, input.kind, input.filename, sha256, buf.length, path, actor.author, iso(this.now()));
    }
    const stored = r.events[0].payload;
    return { artifact_id: stored.artifact_id, sha256: stored.sha256, bytes: stored.bytes, deduplicated: false, replayed: r.replayed, seq: r.seq };
  }

  artifactContent(incidentId: string, artifactId: string) {
    const a = this.db.prepare("SELECT * FROM artifacts WHERE incident_id = ? AND id = ?").get(incidentId, artifactId) as any;
    if (!a || !existsSync(a.path)) throw new AppError("not_found", `No artifact ${artifactId}`);
    return { meta: a, content: readFileSync(a.path) };
  }

  addEvents(actor: Actor, raw: In<"addEvents">) {
    const input = parse("addEvents", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    const { drafts, results } = this.buildDrafts(st, input.items);
    return this.commitItems(id, actor, st, drafts, results, input.idempotency_key);
  }

  private commitItems(id: string, actor: Actor, st: CaseState, drafts: Draft[], results: ItemResult[], key?: string, extra: Draft[] = []) {
    if (!drafts.length && !extra.length) return { added: 0, results, flags_raised: [], engagements_suggested: [], seq: st.incident.seq, replayed: false };
    const r = this.store.append(id, [...drafts, ...extra], this.ctx(actor, key));
    return {
      added: r.events.filter((e) => e.type !== "ioc.source_added" && !extra.some((x) => x.id === e.id)).length,
      results: r.replayed ? r.events.map((e, index) => ({ index, type: e.type as string, event_id: e.id as string | undefined, deduplicated: undefined as boolean | undefined })) : results,
      ...this.derivedSummary(r),
      seq: r.seq,
      replayed: r.replayed,
    };
  }

  /**
   * Validates and normalises evidence items into event drafts (shared by add_events, new suggestions
   * and accepted suggestions). Throws `invalid` naming the item. `annotate` is merged into each payload.
   */
  private buildDrafts(st: CaseState, items: EventItemInput[], annotate: Record<string, unknown> = {}): { drafts: Draft[]; results: ItemResult[] } {
    const input = { items };
    const tpl = this.templateFor(st);
    const phases = tpl.sections.find((s) => s.kind === "timeline")?.phases ?? [];
    const artifacts = new Set(st.artifacts.map((a) => a.artifact_id));

    const drafts: Draft[] = [];
    const results: ItemResult[] = [];
    const seenIocs = new Map(st.iocs.map((i) => [`${i.type}|${i.value}`, i]));
    const batchIocs = new Map<string, Draft>();

    input.items.forEach((item, index) => {
      const src = "source_artifact" in item ? item.source_artifact : undefined;
      if (src && !artifacts.has(src)) throw new AppError("invalid", `items.${index}.source_artifact: no artifact ${src} in this incident`, { field: `items.${index}.source_artifact` });
      const push = (d: Draft, warning?: string) => {
        d.id = ulid();
        d.source_artifact = src ?? null;
        drafts.push(d);
        results.push({ index, type: item.type, event_id: d.id, ...(warning ? { warning } : {}) });
      };
      try {
        switch (item.type) {
          case "timeline": {
            let phase = item.phase ?? null;
            let warning: string | undefined;
            if (phase && phases.length && !phases.some((p) => p.toLowerCase() === phase!.toLowerCase())) {
              warning = `Phase "${phase}" is not in the template; stored without a phase.`;
              phase = null;
            } else if (phase) phase = phases.find((p) => p.toLowerCase() === phase!.toLowerCase()) ?? phase;
            push({ type: "timeline.added", payload: { time_utc: normalizeTime(item.time, `items.${index}.time`), time_original: item.time, description: item.description, source: item.source ?? null, actor: item.actor ?? null, phase, confidence: item.confidence ?? 100 } }, warning);
            break;
          }
          case "ioc": {
            const n = normalizeIoc(item.value, item.ioc_type);
            const k = `${n.type}|${n.value}`;
            const existing = seenIocs.get(k);
            if (existing) {
              const newSource = item.source && !existing.sources.includes(item.source);
              const newVerdict = item.verdict && item.verdict !== "unknown" && item.verdict !== existing.verdict;
              if (newSource || newVerdict) {
                drafts.push({ id: ulid(), type: "ioc.source_added", payload: { ioc_event_id: existing.event_id, value: n.value, source: item.source ?? null, verdict: item.verdict ?? null }, source_artifact: src ?? null });
              }
              results.push({ index, type: "ioc", event_id: existing.event_id, deduplicated: true });
              break;
            }
            if (batchIocs.has(k)) {
              results.push({ index, type: "ioc", event_id: batchIocs.get(k)!.id, deduplicated: true });
              break;
            }
            const d: Draft = { type: "ioc.added", payload: { type: n.type, value: n.value, first_seen: item.first_seen ? normalizeTime(item.first_seen, `items.${index}.first_seen`) : null, source: item.source ?? null, verdict: item.verdict ?? "unknown", external: item.external ?? false } };
            push(d);
            batchIocs.set(k, d);
            break;
          }
          case "asset": {
            if (!item.host && !item.user) throw new AppError("invalid", `items.${index}: an asset needs a host or a user`);
            const dup = st.assets.find((a) => (a.host ?? "").toLowerCase() === (item.host ?? "").toLowerCase() && (a.user ?? "").toLowerCase() === (item.user ?? "").toLowerCase());
            if (dup) {
              results.push({ index, type: "asset", event_id: dup.event_id, deduplicated: true });
              break;
            }
            push({ type: "asset.added", payload: { host: item.host ?? null, user: item.user ?? null, owner: item.owner ?? null, state: item.state ?? "suspected" } });
            break;
          }
          case "note":
            push({ type: "note.added", payload: { text: item.text } });
            break;
          case "task":
            push({ type: "task.added", payload: { title: item.title, assignee: item.assignee ?? null, due: item.due ? normalizeTime(item.due, `items.${index}.due`) : null } });
            break;
          case "ttp":
            if (st.ttps.some((t) => t.technique_id === item.technique_id)) {
              results.push({ index, type: "ttp", deduplicated: true });
              break;
            }
            push({ type: "ttp.added", payload: { technique_id: item.technique_id.toUpperCase(), name: item.name ?? null, description: item.description ?? null } });
            break;
          case "cve":
            if (st.cves.some((c) => c.cve_id.toUpperCase() === item.cve_id.toUpperCase())) {
              results.push({ index, type: "cve", deduplicated: true });
              break;
            }
            push({ type: "cve.added", payload: { cve_id: item.cve_id.toUpperCase(), product: item.product ?? null } });
            break;
          case "correspondence":
            push({
              type: "correspondence.added",
              payload: {
                direction: item.direction,
                party: item.party,
                from: item.from,
                to: item.to,
                subject: item.subject,
                sent_at: normalizeTime(item.sent_at, `items.${index}.sent_at`),
                summary: item.summary,
                related_step: item.related_step ?? null,
              },
            });
            break;
        }
      } catch (e) {
        if (e instanceof AppError && !e.message.startsWith("items.")) e.message = `items.${index}: ${e.message}`;
        throw e;
      }
    });
    if (Object.keys(annotate).length) for (const d of drafts) d.payload = { ...d.payload, ...annotate };
    return { drafts, results };
  }

  // ---------- suggestions waiting for review (Teams bot, email connector, people without Claude) ----------

  propose(actor: Actor, raw: In<"propose">) {
    const input = parse("propose", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    this.buildDrafts(st, input.items); // validate now, so a bad suggestion is refused at the door
    const proposal_id = ulid();
    const r = this.store.append(
      id,
      [{ id: proposal_id, type: "proposal.added", payload: { proposal_id, source: input.source, link: input.link ?? null, from: input.from, context: input.context ?? null, quote: input.quote ?? null, summary: input.summary, items: input.items } }],
      this.ctx(actor, input.idempotency_key),
    );
    return { proposal_id: r.events[0].payload.proposal_id, status: "pending", seq: r.seq, replayed: r.replayed };
  }

  listProposals(actor: Actor, raw: In<"incidentOnly">) {
    const { incident } = parse("incidentOnly", raw);
    const id = this.resolve(incident, actor);
    const st = this.store.state(id);
    return {
      incident: `${st.incident.codename} (${id})`,
      pending: st.proposals.filter((p) => p.status === "pending"),
      decided: st.proposals.filter((p) => p.status !== "pending").slice(-10),
    };
  }

  decideProposal(actor: Actor, raw: In<"decideProposal">) {
    const input = parse("decideProposal", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    const p = st.proposals.find((x) => x.proposal_id === input.proposal_id);
    if (!p) throw new AppError("not_found", `No suggestion ${input.proposal_id}`);
    if (p.status !== "pending") throw new AppError("conflict", `Suggestion was already ${p.status} by ${p.decided_by}.`, { current: { status: p.status, decided_by: p.decided_by } });
    const decided: Draft = {
      id: ulid(),
      type: "proposal.decided",
      payload: { proposal_id: p.proposal_id, decision: input.decision, reason: input.reason ?? null, accepted_items: input.decision === "accepted" ? (input.item_indexes ?? p.items.map((_, i) => i)) : [], summary: p.summary, from: p.from },
      target: `proposal:${p.proposal_id}`,
    };
    if (input.decision === "rejected") {
      const r = this.store.append(id, [decided], this.ctx(actor, input.idempotency_key));
      return { proposal_id: p.proposal_id, decision: "rejected", added: 0, seq: r.seq };
    }
    const pick = input.item_indexes ?? p.items.map((_, i) => i);
    const bad = pick.find((i) => i < 0 || i >= p.items.length);
    if (bad !== undefined) throw new AppError("invalid", `item_indexes: no item ${bad} (the suggestion has ${p.items.length}).`);
    const { drafts, results } = this.buildDrafts(st, pick.map((i) => p.items[i]) as EventItemInput[], { proposed_by: p.from, via: p.source, proposal_id: p.proposal_id });
    const out = this.commitItems(id, actor, st, drafts, results, input.idempotency_key, [decided]);
    return { proposal_id: p.proposal_id, decision: "accepted", ...out };
  }

  /** Email connector (future: a shared mailbox per incident). Stores the mail and suggests a correspondence entry. */
  ingestEmail(actor: Actor, raw: In<"ingestEmail">) {
    const input = parse("ingestEmail", raw);
    const id = this.resolve(input.incident, actor);
    const sent_at = normalizeTime(input.date, "date");
    const text = `From: ${input.from}\nTo: ${input.to.join(", ")}\nDate: ${input.date}\nSubject: ${input.subject}\n\n${input.body}`;
    const a = this.addArtifact(actor, { incident: id, kind: "email", filename: `${input.subject.replace(/[^\w.-]+/g, "_").slice(0, 60) || "email"}.eml`, content: text });
    const p = this.propose(actor, {
      incident: id,
      source: "email",
      from: input.from,
      context: `Email: ${input.subject}`,
      quote: input.body.slice(0, 600),
      summary: `Email ${input.direction === "outbound" ? "to" : "from"} ${input.direction === "outbound" ? input.to.join(", ") : input.from}: ${input.subject}`,
      items: [{ type: "correspondence", direction: input.direction, party: input.party, from: input.from, to: input.to, subject: input.subject, sent_at, summary: input.summary ?? input.subject, source_artifact: a.artifact_id }],
      idempotency_key: input.idempotency_key,
    });
    return { artifact_id: a.artifact_id, ...p };
  }

  private derivedSummary(r: AppendResult) {
    return {
      flags_raised: r.derived.filter((e) => e.type === "correlation.flagged").map((e) => ({ flag_id: e.id, ...e.payload })),
      engagements_suggested: r.derived.filter((e) => e.type === "engagement.updated").map((e) => ({ engagement_id: e.payload.engagement_id, team: e.payload.team_id, reason: e.payload.reason })),
    };
  }

  // ---------- edits that can conflict ----------

  updateField(actor: Actor, raw: In<"updateField">) {
    const input = parse("updateField", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id, input.field === "status" && input.value === "Open");
    const i = st.incident;
    let value: string = input.value;

    if (["summary", "status", "priority"].includes(input.field) && input.expected_seq === undefined) {
      throw new AppError("invalid", `expected_seq is required when changing ${input.field}. Pass the seq you last saw.`, { field: "expected_seq", current_seq: i.seq });
    }
    switch (input.field) {
      case "priority":
        if (!PRIORITIES.includes(value as any)) throw new AppError("invalid", `Priority must be one of ${PRIORITIES.join(", ")}`, { field: "value" });
        break;
      case "status": {
        if (!STATUSES.includes(value as any)) throw new AppError("invalid", `Status must be one of ${STATUSES.join(", ")}`, { field: "value" });
        const from = i.status;
        if (from === value) throw new AppError("invalid", `Status is already ${value}.`);
        if (value === "Closed") {
          if (from !== "Resolved") throw new AppError("invalid", "Resolve the incident before closing it.", { field: "value" });
          const blockers = closeBlockers(st, this.cfg);
          if (blockers.length) throw new AppError("invalid", `Cannot close: ${blockers.join("; ")}.`, { field: "value", blockers });
        }
        break;
      }
      case "detected_at":
        value = normalizeTime(value, "value");
        break;
      case "title":
        if (value.length < 3 || value.length > 120) throw new AppError("invalid", "Title must be 3–120 characters.", { field: "value" });
        break;
    }
    const old = (i as any)[input.field] ?? null;
    if (old === value) return { changed: false, field: input.field, value, seq: i.seq };
    try {
      const r = this.store.append(
        id,
        [{ type: "field.changed", payload: { field: input.field, old, new: value }, target: `field:${input.field}` }],
        this.ctx(actor, input.idempotency_key, input.expected_seq),
      );
      return { changed: true, field: input.field, value, seq: r.seq, ...this.derivedSummary(r) };
    } catch (e) {
      if (e instanceof AppError && e.code === "conflict") e.details.current = { [input.field]: (this.store.state(id).incident as any)[input.field] };
      throw e;
    }
  }

  updateItem(actor: Actor, raw: In<"updateItem">) {
    const input = parse("updateItem", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    const c = input.changes;
    if (input.kind === "timeline") {
      const t = st.timeline.find((x) => x.event_id === input.item_id);
      if (!t) throw new AppError("not_found", `No timeline entry ${input.item_id}`);
      if (c.confidence === undefined) throw new AppError("invalid", "For timeline entries, change confidence (0–100).", { field: "changes.confidence" });
      return this.conflictAware(
        id,
        actor,
        input,
        { type: "timeline.updated", payload: { timeline_id: t.event_id, description: t.description, old: t.confidence, confidence: c.confidence, reason: c.reason ?? null }, target: `timeline:${t.event_id}` },
        () => this.store.state(id).timeline.find((x) => x.event_id === t.event_id),
      );
    }
    if (input.kind === "task") {
      const t = st.tasks.find((x) => x.event_id === input.item_id);
      if (!t) throw new AppError("not_found", `No task ${input.item_id}`);
      if (c.state || c.owner) throw new AppError("invalid", "state and owner apply to assets, not tasks.");
      const payload = { task_id: t.event_id, title: c.title, assignee: c.assignee, due: c.due ? normalizeTime(c.due, "changes.due") : undefined, status: c.status, outcome: c.outcome };
      return this.conflictAware(id, actor, input, { type: "task.updated", payload: stripUndefined(payload), target: `task:${t.event_id}` }, () => this.store.state(id).tasks.find((x) => x.event_id === t.event_id));
    }
    const a = st.assets.find((x) => x.event_id === input.item_id);
    if (!a) throw new AppError("not_found", `No asset ${input.item_id}`);
    const changes = stripUndefined({ state: c.state, owner: c.owner });
    if (!Object.keys(changes).length) throw new AppError("invalid", "For assets, change state or owner.");
    return this.conflictAware(id, actor, input, { type: "asset.updated", payload: { asset_id: a.event_id, label: a.host ?? a.user, changes }, target: `asset:${a.event_id}` }, () => this.store.state(id).assets.find((x) => x.event_id === a.event_id));
  }

  private conflictAware(id: string, actor: Actor, input: { idempotency_key?: string; expected_seq?: number }, draft: Draft, current: () => unknown) {
    try {
      const r = this.store.append(id, [draft], this.ctx(actor, input.idempotency_key, input.expected_seq));
      return { ok: true, event_id: r.events[0].id, seq: r.seq, replayed: r.replayed };
    } catch (e) {
      if (e instanceof AppError && e.code === "conflict") e.details.current = current();
      throw e;
    }
  }

  // ---------- compliance ----------

  attachCompliance(actor: Actor, raw: In<"attachCompliance">) {
    const input = parse("attachCompliance", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    if (!this.cfg.tracks.has(input.track_id)) throw new AppError("not_found", `Unknown compliance track "${input.track_id}"`);
    if (st.compliance.some((c) => c.track_id === input.track_id)) throw new AppError("invalid", `${input.track_id} is already attached.`);
    const trigger_at = input.trigger_at ? normalizeTime(input.trigger_at, "trigger_at") : st.incident.detected_at;
    const r = this.store.append(id, [{ type: "compliance.attached", payload: { track_id: input.track_id, trigger_at }, target: `track:${input.track_id}` }], this.ctx(actor, input.idempotency_key));
    const steps = complianceSteps(this.store.state(id), this.cfg).filter((s) => s.track_id === input.track_id);
    return { attached: input.track_id, trigger_at, steps: steps.map((s) => ({ step_id: s.step_id, title: s.title, due_at: s.due_at, due_note: s.due_note })), seq: r.seq };
  }

  setComplianceStep(actor: Actor, raw: In<"setComplianceStep">) {
    const input = parse("setComplianceStep", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    const track = this.cfg.tracks.get(input.track_id);
    if (!track || !st.compliance.some((c) => c.track_id === input.track_id)) throw new AppError("not_found", `Track ${input.track_id} is not attached to this incident.`);
    const step = track.steps.find((s) => s.id === input.step_id);
    if (!step) throw new AppError("not_found", `No step ${input.step_id} in ${track.id}. Steps: ${track.steps.map((s) => s.id).join(", ")}`);
    if (input.status === "done") {
      const have = { ...(st.compliance.find((c) => c.track_id === track.id)!.steps[step.id]?.evidence ?? {}), ...(input.evidence ?? {}) };
      const missing = step.evidence.filter((k) => !have[k]);
      if (missing.length) throw new AppError("invalid", `Marking "${step.title}" done needs evidence: ${missing.join(", ")}.`, { field: "evidence", missing });
    }
    return this.conflictAware(
      id,
      actor,
      input,
      { type: "compliance.step_updated", payload: { track_id: track.id, step_id: step.id, status: input.status, evidence: input.evidence ?? {} }, target: `step:${track.id}:${step.id}` },
      () => this.store.state(id).compliance.find((c) => c.track_id === track.id)?.steps[step.id] ?? { status: "todo" },
    );
  }

  // ---------- engagements ----------

  setEngagement(actor: Actor, raw: In<"setEngagement">) {
    const input = parse("setEngagement", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    const team = this.cfg.teams.teams.find((t) => t.id === input.team_id);
    if (!team) throw new AppError("not_found", `Unknown team "${input.team_id}". Teams: ${this.cfg.teams.teams.map((t) => t.id).join(", ")}`);
    if (input.request_type && team.request_types.length && !team.request_types.includes(input.request_type)) {
      throw new AppError("invalid", `${team.name} takes: ${team.request_types.join(", ")}`, { field: "request_type" });
    }
    if (input.status === "not_needed" && !input.reason) throw new AppError("invalid", "Not needed requires a one-line reason.", { field: "reason" });
    if (input.status === "delivered" && !input.outcome) throw new AppError("invalid", "Delivered requires an outcome: rule id, dashboard link or finding.", { field: "outcome" });

    let existing = input.engagement_id ? st.engagements.find((g) => g.engagement_id === input.engagement_id) : undefined;
    if (input.engagement_id && !existing) throw new AppError("not_found", `No engagement ${input.engagement_id}`);
    if (existing && existing.team_id !== team.id) throw new AppError("invalid", `Engagement ${existing.engagement_id} belongs to ${existing.team_id}.`);
    // A request for a team that only has a pending suggestion turns that suggestion into the request.
    if (!existing && input.status !== "suggested") {
      existing = st.engagements.find((g) => g.team_id === team.id && g.status === "suggested");
    }
    const engagement_id = existing?.engagement_id ?? ulid();
    const r = this.conflictAware(
      id,
      actor,
      input,
      {
        type: "engagement.updated",
        payload: stripUndefined({
          engagement_id,
          team_id: team.id,
          request_type: input.request_type,
          status: input.status,
          reason: input.reason,
          outcome: input.outcome,
          recommendations: input.recommendations,
        }),
        target: `engagement:${engagement_id}`,
      },
      () => this.store.state(id).engagements.find((g) => g.engagement_id === engagement_id),
    );
    return { ...r, engagement_id, team: team.id, status: input.status, contact: team.contact, request_via: team.request_via ?? null, respond_within: team.respond_within };
  }

  resolveCorrelation(actor: Actor, raw: In<"resolveCorrelation">) {
    const input = parse("resolveCorrelation", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    const f = st.flags.find((x) => x.flag_id === input.flag_id);
    if (!f) throw new AppError("not_found", `No correlation flag ${input.flag_id}`);
    const r = this.store.append(id, [{ type: "correlation.resolved", payload: { flag_id: f.flag_id, pair_id: f.pair_id, decision: input.decision }, target: `flag:${f.flag_id}` }], this.ctx(actor, input.idempotency_key));
    return { ok: true, seq: r.seq };
  }

  // ---------- incident meetings ----------

  setMeetingSchedule(actor: Actor, raw: In<"setMeetingSchedule">) {
    const input = parse("setMeetingSchedule", raw);
    const id = this.resolve(input.incident, actor);
    this.writable(id);
    const r = this.store.append(id, [this.rhythmDraft(input, this.now())], this.ctx(actor, input.idempotency_key));
    const st = this.store.state(id);
    return { ok: true, cadence_minutes: effectiveCadence(st, this.cfg), next_meeting: nextMeetingAt(st, this.cfg), seq: r.seq };
  }

  recordMeeting(actor: Actor, raw: In<"recordMeeting">) {
    const input = parse("recordMeeting", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    const started_at = input.started_at ? normalizeTime(input.started_at, "started_at") : iso(this.now());
    const cadence = effectiveCadence(st, this.cfg);
    const defaultDue = cadence > 0 ? iso(Date.parse(started_at) + cadence * 60_000) : null;
    const meeting_id = ulid();
    const drafts: Draft[] = [
      { id: meeting_id, type: "meeting.held", payload: { started_at, chair: input.chair ?? st.rhythm?.chair ?? actor.author, attendees: input.attendees, notes: input.notes ?? null } },
    ];
    for (const o of input.outcomes) {
      const t = st.tasks.find((x) => x.event_id === o.task_id);
      if (!t) throw new AppError("not_found", `outcomes: no task ${o.task_id}`);
      drafts.push({ type: "task.updated", payload: { task_id: t.event_id, title: t.title, status: o.status, outcome: o.outcome, meeting_id }, target: `task:${t.event_id}` });
    }
    for (const a of input.actions) {
      drafts.push({ type: "task.added", payload: { title: a.title, assignee: a.assignee, due: a.due ? normalizeTime(a.due, "actions.due") : defaultDue, meeting_id } });
    }
    const r = this.store.append(id, drafts, this.ctx(actor, input.idempotency_key));
    const after = this.store.state(id);
    const notReviewed = meetingActions(after).filter((a) => a.carried_over);
    return {
      meeting_id: r.events[0].id,
      seq: r.seq,
      replayed: r.replayed,
      next_meeting: nextMeetingAt(after, this.cfg),
      new_actions: r.events.filter((e) => e.type === "task.added").map((e) => ({ task_id: e.id, assignee: e.payload.assignee, title: e.payload.title, due: e.payload.due })),
      carried_over: notReviewed.map((a) => ({ task_id: a.event_id, assignee: a.assignee, title: a.title })),
    };
  }

  skipMeeting(actor: Actor, raw: In<"skipMeeting">) {
    const input = parse("skipMeeting", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.writable(id);
    const scheduled_at = input.scheduled_at ? normalizeTime(input.scheduled_at, "scheduled_at") : (nextMeetingAt(st, this.cfg) ?? iso(this.now()));
    const r = this.store.append(id, [{ type: "meeting.skipped", payload: { scheduled_at, reason: input.reason } }], this.ctx(actor, input.idempotency_key));
    return { ok: true, seq: r.seq, next_meeting: nextMeetingAt(this.store.state(id), this.cfg) };
  }

  getMeetingBrief(actor: Actor, raw: In<"incidentOnly">) {
    const { incident } = parse("incidentOnly", raw);
    const id = this.resolve(incident, actor);
    const st = this.store.state(id);
    const now = this.now();
    const last = lastMeeting(st);
    const next = nextMeetingAt(st, this.cfg);
    const cadence = effectiveCadence(st, this.cfg);
    const horizon = next && cadence > 0 ? Date.parse(next) + cadence * 60_000 : now.getTime() + 24 * 3_600_000;
    const since = last?.seq ?? 0;
    const changes = this.store.events(id, since).filter((e) => ["timeline.added", "ioc.added", "asset.added", "correlation.flagged", "engagement.updated", "field.changed", "compliance.step_updated", "ttp.added", "cve.added"].includes(e.type) && !st.retracted.includes(e.id));

    const byPerson: Record<string, { task_id: string; title: string; due: string | null; status: string; carried_over: boolean; from_meeting_at: string | null }[]> = {};
    for (const a of meetingActions(st)) {
      (byPerson[a.assignee ?? "unassigned"] ??= []).push({
        task_id: a.event_id,
        title: a.title,
        due: a.due,
        status: a.status,
        carried_over: a.carried_over,
        from_meeting_at: st.meetings.find((m) => m.meeting_id === a.meeting_id)?.at ?? null,
      });
    }
    const deadlines = [
      ...complianceSteps(st, this.cfg)
        .filter((s) => stepOpen(s) && s.due_at && Date.parse(s.due_at) <= horizon)
        .map((s) => ({ kind: "compliance", what: `${s.track_id}: ${s.title}`, due_at: s.due_at, status: s.status, overdue: Date.parse(s.due_at!) < now.getTime() })),
      ...st.engagements
        .filter(engagementOpen)
        .map((g) => ({ g, due: engagementDueAt(g, this.cfg) }))
        .filter((x) => x.due && Date.parse(x.due) <= horizon)
        .map(({ g, due }) => ({ kind: "engagement", what: `${g.team_id} ${g.request_type ?? ""}`.trim(), due_at: due, status: g.status, overdue: Date.parse(due!) < now.getTime() })),
    ].sort((a, b) => a.due_at!.localeCompare(b.due_at!));

    return {
      incident: { id, codename: st.incident.codename, title: st.incident.title, priority: st.incident.priority, status: st.incident.status },
      meeting: { next_at: next, cadence_minutes: cadence, channel: st.rhythm?.channel_name ?? null, join_url: st.rhythm?.join_url ?? null, chair: st.rhythm?.chair ?? null, last_meeting_at: last?.at ?? null },
      actions_by_person: byPerson,
      changes_since_last_meeting: { count: changes.length, items: changes.slice(-25).map((e) => ({ seq: e.seq, by: e.author, what: describe(e) })) },
      deadlines_before_following_meeting: deadlines,
      open_questions: {
        unassigned_tasks: st.tasks.filter((t) => taskOpen(t) && !t.assignee).map((t) => ({ task_id: t.event_id, title: t.title })),
        unresolved_flags: st.flags.filter((f) => !f.decision).map((f) => ({ flag_id: f.flag_id, what: `${f.value} also in ${f.other_incident_id} (${f.other_codename})` })),
        suggested_engagements: st.engagements.filter((g) => g.status === "suggested").map((g) => ({ engagement_id: g.engagement_id, team: g.team_id, reason: g.reason })),
        waiting_for_review: st.proposals.filter((p) => p.status === "pending").map((p) => ({ proposal_id: p.proposal_id, from: p.from, via: p.source, summary: p.summary, items: p.items.length })),
      },
      seq: st.incident.seq,
    };
  }

  // ---------- corrections ----------

  retractEvent(actor: Actor, raw: In<"retractEvent">) {
    const input = parse("retractEvent", raw);
    const id = this.resolve(input.incident, actor);
    this.writable(id);
    const e = this.store.event(input.event_id);
    if (!e || e.incident_id !== id) throw new AppError("not_found", `No event ${input.event_id} in ${id}`);
    if (e.type === "incident.opened") throw new AppError("invalid", "The opening event cannot be retracted.");
    const r = this.store.append(id, [{ type: "event.retracted", payload: { event_id: e.id, reason: input.reason }, supersedes: e.id }], this.ctx(actor, input.idempotency_key));
    return { ok: true, retracted: describe(e), seq: r.seq };
  }

  // ---------- reads ----------

  private templateFor(st: CaseState) {
    const [name] = st.incident.template.split("@");
    return this.cfg.templates.get(name) ?? this.cfg.templates.get(this.cfg.settings.default_template)!;
  }

  getTemplate(actor: Actor, raw: In<"incidentOnly">) {
    const { incident } = parse("incidentOnly", raw);
    let tpl = this.cfg.templates.get(this.cfg.settings.default_template)!;
    if (incident || this.linkedIncident(actor)) tpl = this.templateFor(this.store.state(this.resolve(incident, actor)));
    return {
      template: `${tpl.name}@${tpl.version}`,
      priorities: tpl.priorities,
      default_meeting_minutes: tpl.default_meeting_minutes,
      compliance_offer: tpl.compliance_offer.map((t) => ({ track_id: t, question: this.cfg.tracks.get(t)?.ask_at_open })),
      sections: tpl.sections,
      item_types: ["timeline", "ioc", "asset", "note", "task", "ttp", "cve", "correspondence"],
      teams: this.cfg.teams.teams.map((t) => ({ id: t.id, name: t.name, request_types: t.request_types })),
      confirm_before_write: this.cfg.settings.confirm_before_write,
      trusted_sources: this.cfg.settings.trusted_sources,
    };
  }

  getReport(actor: Actor, raw: In<"getReport">) {
    const input = parse("getReport", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.store.state(id);
    const md = renderReport(st, this.cfg);
    if (!input.section) return { markdown: md, seq: st.incident.seq };
    const sec = this.templateFor(st).sections.find((s) => s.id === input.section);
    if (!sec) throw new AppError("not_found", `No section "${input.section}". Sections: ${this.templateFor(st).sections.map((s) => s.id).join(", ")}`);
    const start = md.indexOf(`\n## ${sec.title}\n`);
    const end = md.indexOf("\n## ", start + 4);
    return { markdown: md.slice(start + 1, end === -1 ? undefined : end), seq: st.incident.seq };
  }

  getUpdates(actor: Actor, raw: In<"getUpdates">) {
    const input = parse("getUpdates", raw);
    const id = this.resolve(input.incident, actor);
    const st = this.store.state(id);
    const since = input.since_seq ?? this.store.lastSeen(actor.author, id);
    const now = this.now();
    const events = this.store.events(id, since).filter((e) => e.author !== actor.author && e.type !== "analyst.connected" && !st.retracted.includes(e.id));

    // What "mine" means: IOCs, hosts and users this analyst added.
    const mine = new Set<string>();
    for (const i of st.iocs) if (i.author === actor.author) mine.add(i.value.toLowerCase());
    for (const a of st.assets) if (a.author === actor.author) for (const v of [a.host, a.user]) if (v) mine.add(v.toLowerCase());

    const rank = (e: StoredEvent): { tier: number; why: string } => {
      if (e.type === "correlation.flagged") return { tier: 1, why: "correlation flag" };
      if (e.type === "proposal.added") return { tier: 1, why: "waiting for review" };
      if (e.type === "engagement.updated" && e.payload.status === "delivered") return { tier: 1, why: "engagement delivered" };
      const text = JSON.stringify(e.payload).toLowerCase();
      for (const m of mine) if (text.includes(m)) return { tier: 2, why: `mentions ${m}, which you added` };
      if ((e.type === "task.added" || e.type === "task.updated") && e.payload.assignee === actor.author) return { tier: 3, why: "assigned to you" };
      return { tier: 4, why: "" };
    };
    const ranked = events
      .map((e) => ({ e, ...rank(e) }))
      .sort((a, b) => a.tier - b.tier || b.e.seq - a.e.seq)
      .map(({ e, tier, why }) => ({ seq: e.seq, event_id: e.id, type: e.type, by: e.author, at: e.created_at, what: describe(e), priority_tier: tier, ...(why ? { why } : {}) }));

    const soon = complianceSteps(st, this.cfg)
      .filter((s) => stepOpen(s) && s.due_at && hoursUntil(s.due_at, now) <= 12)
      .map((s) => ({ what: `${s.track_id}: ${s.title}`, due_at: s.due_at, hours_left: hoursUntil(s.due_at!, now) }));
    const next = nextMeetingAt(st, this.cfg);
    const minutesToMeeting = next ? Math.round((Date.parse(next) - now.getTime()) / 60_000) : null;

    this.store.markSeen(actor.author, id, st.incident.seq);
    return {
      incident: `${st.incident.codename} (${id})`,
      since_seq: since,
      seq: st.incident.seq,
      new_count: ranked.length,
      updates: ranked,
      reminders: {
        meeting_soon: minutesToMeeting !== null && minutesToMeeting <= 15 && minutesToMeeting >= -5 ? { at: next, minutes_until: minutesToMeeting, join_url: st.rhythm?.join_url ?? null } : null,
        your_open_actions: st.tasks.filter((t) => taskOpen(t) && t.assignee === actor.author).map((t) => ({ task_id: t.event_id, title: t.title, due: t.due, carried_over: isCarriedOver(t, st) })),
        compliance_due_within_12h: soon,
      },
    };
  }

  getStatus(actor: Actor, raw: In<"incidentOnly">) {
    const { incident } = parse("incidentOnly", raw);
    const id = this.resolve(incident, actor);
    const st = this.store.state(id);
    const now = this.now();
    const nowIso = iso(now);
    const steps = complianceSteps(st, this.cfg);
    const next = nextMeetingAt(st, this.cfg);
    const cadence = effectiveCadence(st, this.cfg);
    const meetingOverdue = !!(next && cadence > 0 && now.getTime() > Date.parse(next) + cadence * 60_000);
    const overdueTasks = st.tasks.filter((t) => taskOpen(t) && t.due && t.due < nowIso);
    const slaBreaches = st.engagements
      .filter(engagementOpen)
      .map((g) => ({ g, due: engagementDueAt(g, this.cfg) }))
      .filter((x) => x.due && x.due < nowIso);
    const stepViews = steps
      .filter(stepOpen)
      .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"))
      .map((s) => ({ track: s.track_id, step: s.step_id, title: s.title, status: s.status, due_at: s.due_at, due_note: s.due_note, hours_left: s.due_at ? hoursUntil(s.due_at, now) : null, overdue: !!(s.due_at && s.due_at < nowIso), evidence_required: s.evidence_required }));

    const needs_action: string[] = [];
    for (const s of stepViews.filter((s) => s.overdue)) needs_action.push(`OVERDUE compliance: ${s.track} "${s.title}" was due ${s.due_at}`);
    for (const s of stepViews.filter((s) => !s.overdue && s.hours_left !== null && s.hours_left <= 12)) needs_action.push(`Compliance due in ${s.hours_left} h: ${s.track} "${s.title}"`);
    if (meetingOverdue) needs_action.push(`Incident meeting overdue (was due ${next})`);
    for (const t of overdueTasks) needs_action.push(`Overdue task: "${t.title}" (${t.assignee ?? "unassigned"}, due ${t.due})`);
    for (const { g, due } of slaBreaches) needs_action.push(`Engagement overdue: ${g.team_id} ${g.request_type ?? ""} (${g.status} since ${g.requested_at}, deadline ${due})`.replace("  ", " "));
    for (const t of st.tasks.filter((t) => taskOpen(t) && !t.assignee)) needs_action.push(`Unassigned task: "${t.title}"`);
    for (const f of st.flags.filter((f) => !f.decision)) needs_action.push(`Correlation flag to decide: ${f.value} also in ${f.other_incident_id} (${f.other_codename})`);
    for (const g of st.engagements.filter((g) => g.status === "suggested")) needs_action.push(`Suggested engagement to decide: ${g.team_id}`);
    for (const p of st.proposals.filter((p) => p.status === "pending")) needs_action.push(`Waiting for review: ${p.summary} (from ${p.from} via ${p.source})`);

    const actionsByPerson: Record<string, string[]> = {};
    for (const a of meetingActions(st)) (actionsByPerson[a.assignee ?? "unassigned"] ??= []).push(a.title + (a.carried_over ? " (carried over)" : ""));

    return {
      incident: { id, codename: st.incident.codename, title: st.incident.title, priority: st.incident.priority, status: st.incident.status, lead: st.incident.lead, opened_at: st.incident.opened_at, detected_at: st.incident.detected_at },
      summary: st.incident.summary || null,
      needs_action,
      counts: {
        timeline: st.timeline.length,
        iocs: st.iocs.length,
        malicious_iocs: st.iocs.filter((i) => i.verdict === "malicious").length,
        assets: st.assets.length,
        compromised_assets: st.assets.filter((a) => a.state === "compromised").length,
        open_tasks: st.tasks.filter(taskOpen).length,
        artifacts: st.artifacts.length,
      },
      meetings: st.rhythm ? { next_meeting: next, cadence_minutes: cadence, meeting_overdue: meetingOverdue, open_actions_by_person: actionsByPerson, join_url: st.rhythm.join_url } : null,
      compliance: stepViews,
      engagements: st.engagements.map((g) => ({ engagement_id: g.engagement_id, team: g.team_id, request_type: g.request_type, status: g.status, due_at: engagementDueAt(g, this.cfg), outcome: g.outcome, reason: g.reason })),
      can_close: st.incident.status === "Resolved" ? closeBlockers(st, this.cfg) : ["Incident must be Resolved first"],
      active_analysts: Object.entries(st.analysts).sort((a, b) => b[1].last_at.localeCompare(a[1].last_at)).map(([name, a]) => ({ name, last_at: a.last_at })),
      seq: st.incident.seq,
    };
  }

  getNextSteps(actor: Actor, raw: In<"incidentOnly">) {
    const { incident } = parse("incidentOnly", raw);
    const id = this.resolve(incident, actor);
    const st = this.store.state(id);
    const now = this.now();
    const phases = this.templateFor(st).sections.find((s) => s.kind === "timeline")?.phases ?? [];
    const covered = new Set(st.timeline.map((t) => t.phase).filter(Boolean));
    return {
      incident: `${st.incident.codename} (${id})`,
      your_open_actions: st.tasks.filter((t) => taskOpen(t) && t.assignee === actor.author).map((t) => ({ task_id: t.event_id, title: t.title, due: t.due })),
      suggested_engagements: st.engagements.filter((g) => g.status === "suggested").map((g) => ({ engagement_id: g.engagement_id, team: g.team_id, reason: g.reason })),
      assets_not_contained: st.assets.filter((a) => a.state === "suspected" || a.state === "compromised").map((a) => ({ asset_id: a.event_id, host: a.host, user: a.user, state: a.state })),
      iocs_without_verdict: st.iocs.filter((i) => i.verdict === "unknown").map((i) => ({ type: i.type, value: i.value })),
      phases_without_timeline_entries: phases.filter((p) => !covered.has(p)),
      unassigned_tasks: st.tasks.filter((t) => taskOpen(t) && !t.assignee).map((t) => ({ task_id: t.event_id, title: t.title })),
      unresolved_flags: st.flags.filter((f) => !f.decision).map((f) => ({ flag_id: f.flag_id, value: f.value, other: `${f.other_incident_id} (${f.other_codename})` })),
      compliance_due_within_24h: complianceSteps(st, this.cfg)
        .filter((s) => stepOpen(s) && s.due_at && hoursUntil(s.due_at, now) <= 24)
        .map((s) => ({ track: s.track_id, step: s.step_id, title: s.title, hours_left: hoursUntil(s.due_at!, now) })),
      waiting_for_review: st.proposals.filter((p) => p.status === "pending").map((p) => ({ proposal_id: p.proposal_id, from: p.from, via: p.source, summary: p.summary, items: p.items.length })),
      delivered_by_engineering: st.engagements.filter((g) => g.status === "delivered").map((g) => ({ team: g.team_id, outcome: g.outcome })),
    };
  }

  getTeamQueue(actor: Actor, raw: In<"getTeamQueue">) {
    const input = parse("getTeamQueue", raw);
    const teamId = input.team_id ?? actor.team;
    if (!teamId) throw new AppError("invalid", "Pass team_id, or set ANALYST_TEAM in your profile.", { field: "team_id" });
    const team = this.cfg.teams.teams.find((t) => t.id === teamId);
    if (!team) throw new AppError("not_found", `Unknown team "${teamId}"`);
    const now = this.now();
    const items: any[] = [];
    for (const row of this.store.listIncidentRows()) {
      if (row.status === "Closed") continue;
      const st = this.store.state(row.id);
      for (const g of st.engagements) {
        if (g.team_id !== team.id || !engagementOpen(g)) continue;
        const evidenceIds = new Set(g.recommendations.flatMap((r) => r.evidence));
        const timeline = [...st.timeline]
          .filter((t) => !evidenceIds.size || evidenceIds.has(t.event_id) || (t.source && evidenceIds.has(t.source)))
          .sort((a, b) => a.time_utc.localeCompare(b.time_utc))
          .slice(-15);
        const due = engagementDueAt(g, this.cfg);
        items.push({
          incident: { id: row.id, codename: row.codename, title: row.title, priority: row.priority },
          engagement_id: g.engagement_id,
          request_type: g.request_type,
          status: g.status,
          requested_at: g.requested_at,
          waiting_hours: g.requested_at ? Math.round(((now.getTime() - Date.parse(g.requested_at)) / 3_600_000) * 10) / 10 : null,
          deadline_at: due,
          overdue: !!(due && Date.parse(due) < now.getTime()),
          recommendations: g.recommendations,
          context: {
            timeline: timeline.map((t) => ({ event_id: t.event_id, time_utc: t.time_utc, source: t.source, actor: t.actor, description: t.description, phase: t.phase, confidence: t.confidence })),
            iocs: st.iocs.slice(0, 50).map((i) => ({ type: i.type, value: i.value, verdict: i.verdict })),
            assets: st.assets.map((a) => ({ host: a.host, user: a.user, state: a.state })),
            ttps: st.ttps.map((t) => ({ technique_id: t.technique_id, name: t.name })),
            artifacts: st.artifacts.map((a) => ({ artifact_id: a.artifact_id, kind: a.kind, filename: a.filename })),
          },
        });
      }
    }
    items.sort((a, b) => priorityRank(b.incident.priority) - priorityRank(a.incident.priority) || (a.requested_at ?? "").localeCompare(b.requested_at ?? ""));
    return { team: { id: team.id, name: team.name, respond_within: team.respond_within }, count: items.length, items };
  }

  /** What an analyst should hear about when a Claude session starts (SessionStart hook). */
  analystSummary(author: string, team: string | null) {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT i.* FROM incidents i
         WHERE i.status != 'Closed'
           AND (EXISTS (SELECT 1 FROM seen s WHERE s.incident_id = i.id AND s.author = ?)
             OR EXISTS (SELECT 1 FROM events e WHERE e.incident_id = i.id AND e.author = ?))
         ORDER BY i.last_activity DESC`,
      )
      .all(author, author) as any[];
    const mine = rows.map((r) => {
      const st = this.store.state(r.id);
      const since = this.store.lastSeen(author, r.id);
      const unread = this.store.events(r.id, since).filter((e) => e.author !== author && e.type !== "analyst.connected").length;
      const next = nextMeetingAt(st, this.cfg);
      return {
        id: r.id,
        codename: r.codename,
        title: r.title,
        priority: r.priority,
        status: r.status,
        unread,
        your_open_actions: st.tasks.filter((t) => taskOpen(t) && t.assignee === author).map((t) => t.title),
        waiting_for_review: st.proposals.filter((p) => p.status === "pending").length,
        next_meeting: next ? { at: next, minutes_until: Math.round((Date.parse(next) - now.getTime()) / 60_000) } : null,
      };
    });
    const queue = team && this.cfg.teams.teams.some((t) => t.id === team) ? this.getTeamQueue({ author, role: "engineer", team, session_id: null }, { team_id: team }).count : null;
    return { author, incidents: mine, open_incidents_total: this.store.listIncidentRows().filter((r) => r.status !== "Closed").length, team_queue: queue };
  }

  /** Full folded state + derived views, for the portal. */
  caseView(ref: string) {
    const id = this.resolve(ref);
    const st = this.store.state(id);
    const now = this.now();
    return {
      ...st,
      derived: {
        compliance_steps: complianceSteps(st, this.cfg).map((s) => ({ ...s, hours_left: s.due_at ? hoursUntil(s.due_at, now) : null, overdue: !!(stepOpen(s) && s.due_at && Date.parse(s.due_at) < now.getTime()) })),
        next_meeting: nextMeetingAt(st, this.cfg),
        cadence_minutes: effectiveCadence(st, this.cfg),
        meeting_actions: meetingActions(st),
        close_blockers: closeBlockers(st, this.cfg),
        engagement_due: Object.fromEntries(st.engagements.map((g) => [g.engagement_id, engagementDueAt(g, this.cfg)])),
        server_time: iso(now),
      },
    };
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
