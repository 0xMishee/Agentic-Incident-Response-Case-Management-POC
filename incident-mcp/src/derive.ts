// Views computed from case state + config. Functions that take `now` are clock-dependent
// and must not be used by the renderer (report.md has to be deterministic).
import type { Config } from "./config.js";
import type { CaseState, Task, Engagement } from "./fold.js";
import { addDuration, iso } from "./util.js";

// ---------- compliance ----------

export interface StepView {
  track_id: string;
  track_name: string;
  step_id: string;
  title: string;
  status: string;
  due_at: string | null;
  /** Why there is no due time: "without undue delay" or "waits for <step>". */
  due_note: string | null;
  evidence_required: string[];
  evidence: Record<string, string>;
  owner_role: string | null;
  condition: string | null;
}

export function complianceSteps(state: CaseState, cfg: Config): StepView[] {
  const out: StepView[] = [];
  for (const c of state.compliance) {
    const track = cfg.tracks.get(c.track_id);
    if (!track) continue;
    for (const step of track.steps) {
      const st = c.steps[step.id];
      const dur = cfg.durations.get(`${track.id}:${step.id}`) ?? null;
      let due_at: string | null = null;
      let due_note: string | null = null;
      if (!dur) {
        due_note = "without undue delay";
      } else if (step.due_from === "trigger") {
        due_at = iso(addDuration(c.trigger_at, dur));
      } else if (step.due_from.startsWith("step:")) {
        const dep = step.due_from.slice(5);
        const depDone = c.steps[dep]?.done_at;
        if (depDone) due_at = iso(addDuration(depDone, dur));
        else due_note = `${step.due} after "${dep}" is done`;
      }
      out.push({
        track_id: track.id,
        track_name: track.name,
        step_id: step.id,
        title: step.title,
        status: st?.status ?? "todo",
        due_at,
        due_note,
        evidence_required: step.evidence,
        evidence: st?.evidence ?? {},
        owner_role: step.owner_role ?? null,
        condition: step.condition ?? null,
      });
    }
  }
  return out;
}

export const stepOpen = (s: StepView) => s.status !== "done" && s.status !== "not_applicable";

export function hoursUntil(at: string, now: Date): number {
  return Math.round(((Date.parse(at) - now.getTime()) / 3_600_000) * 10) / 10;
}

// ---------- engagements ----------

export const engagementOpen = (g: Engagement) => g.status === "requested" || g.status === "engaged";

export function engagementDueAt(g: Engagement, cfg: Config): string | null {
  const sla = cfg.durations.get(`team:${g.team_id}`);
  if (!sla || !g.requested_at) return null;
  return iso(addDuration(g.requested_at, sla));
}

// ---------- incident meetings ----------

/** Cadence actually in force (demo mode shortens it). */
export function effectiveCadence(state: CaseState, cfg: Config): number {
  const c = state.rhythm?.cadence_minutes ?? 0;
  if (c > 0 && cfg.settings.demo.enabled) return cfg.settings.demo.meeting_minutes;
  return c;
}

/** Meetings (held or skipped) since the rhythm was last set. */
function meetingsSinceRhythm(state: CaseState) {
  const since = state.rhythm?.set_seq ?? 0;
  return state.meetings.filter((m) => m.seq > since);
}

export function lastMeeting(state: CaseState) {
  const held = state.meetings.filter((m) => m.kind === "held");
  return held.at(-1) ?? null;
}

/**
 * Next meeting time. After a held or skipped meeting: that time + cadence (re-anchors the clock).
 * Before any: the next_at given when the rhythm was set. Ad hoc rhythm: next_at until a meeting happens.
 */
export function nextMeetingAt(state: CaseState, cfg: Config): string | null {
  if (!state.rhythm) return null;
  const cadence = effectiveCadence(state, cfg);
  const recent = meetingsSinceRhythm(state).at(-1);
  if (!recent) return state.rhythm.next_at;
  if (cadence <= 0) return null;
  return iso(Date.parse(recent.at) + cadence * 60_000);
}

export const taskOpen = (t: Task) => t.status === "open" || t.status === "in_progress";

/** An open meeting action from an earlier meeting that the latest meeting did not review. */
export function isCarriedOver(t: Task, state: CaseState): boolean {
  if (!t.meeting_id || !taskOpen(t)) return false;
  const last = lastMeeting(state);
  if (!last || last.meeting_id === t.meeting_id) return false;
  return t.reviewed_in !== last.meeting_id;
}

export function meetingActions(state: CaseState) {
  return state.tasks
    .filter((t) => t.meeting_id && taskOpen(t))
    .map((t) => ({ ...t, carried_over: isCarriedOver(t, state) }));
}

// ---------- status transitions ----------

/** Things that stop Resolved -> Closed. Empty array = ok to close. */
export function closeBlockers(state: CaseState, cfg: Config): string[] {
  const out: string[] = [];
  for (const s of complianceSteps(state, cfg)) {
    if (stepOpen(s)) out.push(`Compliance step ${s.track_id}/${s.step_id} "${s.title}" is ${s.status}`);
  }
  if (cfg.teams.closure_rule === "all_engagements_resolved") {
    for (const g of state.engagements) {
      if (engagementOpen(g)) out.push(`Engagement ${g.team_id} (${g.request_type ?? "request"}) is ${g.status}`);
    }
  }
  return out;
}
