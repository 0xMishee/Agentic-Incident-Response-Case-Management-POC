// Renders report.md from template + case state. Deterministic: no clock reads, stable ordering,
// so the same events always give a byte-identical file.
import type { Config, Template } from "./config.js";
import type { CaseState } from "./fold.js";
import { complianceSteps, effectiveCadence, meetingActions, nextMeetingAt } from "./derive.js";
import { defang } from "./normalize.js";

type Section = Template["sections"][number];

const cell = (v: unknown) =>
  v === null || v === undefined || v === "" ? "–" : String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const t = (s: string | null | undefined) => (s ? s.replace("T", " ").replace(/:00Z$/, "Z") : "–");

function table(head: string[], rows: unknown[][]): string {
  if (!rows.length) return "_None yet._";
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => yamlValue(x)).join(", ")}]`;
  const s = String(v);
  return /^[\w@.:+-]+$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s) ? s : JSON.stringify(s);
}

export function renderReport(state: CaseState, cfg: Config): string {
  const i = state.incident;
  const [tplName] = i.template.split("@");
  const tpl = cfg.templates.get(tplName) ?? cfg.templates.get(cfg.settings.default_template)!;

  const front: Record<string, unknown> = {
    id: i.id,
    codename: i.codename,
    title: i.title,
    priority: i.priority,
    status: i.status,
    lead: i.lead,
    detected_at: i.detected_at,
    opened_at: i.opened_at,
    opened_by: i.opened_by,
    template: i.template,
    compliance: state.compliance.map((c) => c.track_id),
    next_meeting: nextMeetingAt(state, cfg),
    seq: i.seq,
  };

  const out: string[] = [
    "---",
    ...Object.entries(front).map(([k, v]) => `${k}: ${yamlValue(v)}`),
    "---",
    "",
    `# ${i.codename} (${i.id})`,
    "",
    `**${i.title}** · ${i.priority} · ${i.status} · Lead: ${i.lead ?? "unassigned"}`,
    "",
  ];

  for (const s of tpl.sections) {
    out.push(`## ${s.title}`, "", renderSection(s, state, cfg), "");
  }
  out.push("## Artifacts", "", renderArtifacts(state), "");
  return out.join("\n");
}

function renderSection(s: Section, st: CaseState, cfg: Config): string {
  switch (s.kind) {
    case "prose":
      return s.id === "summary" ? st.incident.summary || "_No summary yet._" : "_No content._";
    case "meetings":
      return renderRhythm(st, cfg);
    case "compliance":
      return renderCompliance(st, cfg);
    case "timeline": {
      const rows = [...st.timeline]
        .sort((a, b) => a.time_utc.localeCompare(b.time_utc) || a.seq - b.seq)
        .map((e) => [t(e.time_utc), e.source, e.actor, e.description, e.phase, `${e.confidence}%`, e.author]);
      return [":::timeline", table(["Time (UTC)", "Source", "Actor", "Description", "Phase", "Confidence", "Added by"], rows), ":::"].join("\n");
    }
    case "table":
      if (s.id === "iocs") {
        const rows = st.iocs.map((x) => [x.type, `\`${defang(x.type, x.value)}\``, t(x.first_seen), x.sources.join(", "), x.verdict, x.external ? "yes" : "no"]);
        return table(["Type", "Value", "First seen", "Sources", "Verdict", "External"], rows);
      }
      if (s.id === "ttps") {
        const rows = [
          ...st.ttps.map((x) => ["Technique", x.technique_id, x.name, x.description, x.author]),
          ...st.cves.map((x) => ["CVE", x.cve_id, x.product, null, x.author]),
        ];
        return table(["Kind", "Id", "Name / product", "Notes", "Added by"], rows);
      }
      if (s.id === "assets") {
        return table(["Host", "User", "Owner", "State"], st.assets.map((a) => [a.host, a.user, a.owner, a.state]));
      }
      return "_Unknown table section._";
    case "correlations": {
      const rows = st.flags.map((f) => [f.kind, `\`${f.value}\``, `${f.other_incident_id}${f.other_codename ? ` (${f.other_codename})` : ""}`, f.decision ?? "open"]);
      return [":::correlations", table(["Kind", "Match", "Other incident", "Decision"], rows), ":::"].join("\n");
    }
    case "engagements":
      return renderEngagements(st, cfg);
    case "correspondence": {
      const rows = [...st.correspondence]
        .sort((a, b) => a.sent_at.localeCompare(b.sent_at))
        .map((c) => [t(c.sent_at), c.direction === "inbound" ? "In" : "Out", c.party, c.direction === "inbound" ? c.from : c.to.join(", "), c.subject, c.summary, c.related_step]);
      return [":::correspondence", table(["Sent (UTC)", "In/out", "Party", "From / to", "Subject", "Summary", "Compliance step"], rows), ":::"].join("\n");
    }
    case "proposals": {
      const pending = st.proposals.filter((p) => p.status === "pending");
      const decided = st.proposals.filter((p) => p.status !== "pending");
      const parts = [":::proposals"];
      if (!pending.length) parts.push("_Nothing waiting for review._");
      for (const p of pending) {
        parts.push(`- **${p.summary}** · from ${p.from} via ${p.source}${p.context ? ` · ${p.context}` : ""} · ${p.items.length} item(s)${p.link ? ` · [message](${p.link})` : ""}`);
        if (p.quote) parts.push(`  > ${p.quote.replace(/\r?\n/g, " ")}`);
      }
      if (decided.length) {
        parts.push("", table(["Decided (UTC)", "From", "Via", "Suggestion", "Decision", "By"], decided.map((p) => [t(p.decided_at), p.from, p.source, p.summary, p.status, p.decided_by])));
      }
      parts.push(":::");
      return parts.join("\n");
    }
    case "tasks": {
      const tasks = st.tasks.filter((x) => !x.meeting_id);
      if (!tasks.length) return "_None yet._";
      return tasks
        .map((x) => `- [${x.status === "done" ? "x" : " "}] ${x.title} · ${x.assignee ?? "unassigned"}${x.due ? ` · due ${t(x.due)}` : ""}${x.status !== "open" && x.status !== "done" ? ` · ${x.status}` : ""}${x.outcome ? ` · ${x.outcome}` : ""}`)
        .join("\n");
    }
    case "log": {
      if (s.id === "notes") {
        if (!st.notes.length) return "_None yet._";
        return st.notes.map((n) => `- ${t(n.created_at)} **${n.author}**: ${n.text.replace(/\r?\n/g, " ")}`).join("\n");
      }
      return "_None yet._";
    }
  }
}

function renderRhythm(st: CaseState, cfg: Config): string {
  const r = st.rhythm;
  if (!r) return ":::meetings\n_No incident meetings set._\n:::";
  const cadence = effectiveCadence(st, cfg);
  const lines = [
    ":::meetings",
    `- Cadence: ${cadence > 0 ? `every ${cadence} min` : "ad hoc"}`,
    `- Next meeting: ${t(nextMeetingAt(st, cfg))}`,
    `- Channel: ${r.channel_name ?? "–"}${r.join_url ? ` · [Join](${r.join_url})` : ""}`,
    `- Chair: ${r.chair ?? "–"}`,
    "",
    "**Open actions**",
    "",
    table(
      ["Owner", "Action", "Due", "Status", "Carried over"],
      meetingActions(st)
        .sort((a, b) => (a.assignee ?? "").localeCompare(b.assignee ?? "") || a.seq - b.seq)
        .map((a) => [a.assignee ?? "unassigned", a.title, t(a.due), a.status, a.carried_over ? "yes" : "no"]),
    ),
    "",
    "**Meeting log**",
    "",
    table(
      ["Time (UTC)", "Held", "Chair", "Attendees", "Notes", "Actions closed"],
      st.meetings.map((m) => {
        const closed = st.tasks.filter((x) => x.history.some((h) => h.meeting_id === m.meeting_id && h.outcome));
        return [
          t(m.at),
          m.kind === "held" ? "yes" : `skipped: ${m.reason}`,
          m.chair,
          m.attendees.join(", "),
          m.notes,
          closed.map((x) => `${x.title}: ${x.history.find((h) => h.meeting_id === m.meeting_id)?.outcome}`).join("; "),
        ];
      }),
    ),
    ":::",
  ];
  return lines.join("\n");
}

function renderCompliance(st: CaseState, cfg: Config): string {
  const steps = complianceSteps(st, cfg);
  if (!steps.length) return ":::compliance\n_No compliance tracks attached._\n:::";
  const parts = [":::compliance"];
  for (const c of st.compliance) {
    const track = cfg.tracks.get(c.track_id);
    parts.push(`**${track?.name ?? c.track_id}** · clock from ${t(c.trigger_at)}`, "");
    parts.push(
      table(
        ["Step", "Due (UTC)", "Status", "Evidence"],
        steps
          .filter((s) => s.track_id === c.track_id)
          .map((s) => [s.title, s.due_at ? t(s.due_at) : s.due_note, s.status, Object.entries(s.evidence).map(([k, v]) => `${k}: ${v}`).join(", ")]),
      ),
      "",
    );
  }
  parts.push(":::");
  return parts.join("\n");
}

function renderEngagements(st: CaseState, cfg: Config): string {
  if (!st.engagements.length) return ":::engagements\n_None yet._\n:::";
  const name = (id: string) => cfg.teams.teams.find((x) => x.id === id)?.name ?? id;
  const parts = [
    ":::engagements",
    table(
      ["Team", "Request", "Status", "Requested", "Outcome / reason"],
      st.engagements.map((g) => [name(g.team_id), g.request_type, g.status, t(g.requested_at), g.outcome ?? g.reason ?? g.recommendations[0]?.title]),
    ),
  ];
  const recs = st.engagements.flatMap((g) => g.recommendations.map((r) => ({ g, r })));
  if (recs.length) {
    parts.push("", "**Recommendations**", "");
    for (const { g, r } of recs) {
      parts.push(`- **${r.title}** (${r.kind}, for ${name(g.team_id)}, by ${r.added_by})${r.mitre?.length ? ` · ${r.mitre.join(", ")}` : ""}`);
      if (r.rationale) parts.push(`  ${r.rationale.replace(/\r?\n/g, " ")}`);
      if (r.draft.query) parts.push("", "  ```" + (r.draft.language ?? ""), ...r.draft.query.split(/\r?\n/).map((l) => "  " + l), "  ```", "");
      for (const p of r.draft.panels ?? []) parts.push(`  - Panel "${p.title}" (${p.viz}): \`${p.query.replace(/\r?\n/g, " ")}\``);
    }
  }
  parts.push(":::");
  return parts.join("\n");
}

function renderArtifacts(st: CaseState): string {
  return table(
    ["Id", "Kind", "File", "SHA-256", "Added by", "Added"],
    st.artifacts.map((a) => [a.artifact_id, a.kind, a.filename, a.sha256.slice(0, 16) + "…", a.author, t(a.created_at)]),
  );
}
