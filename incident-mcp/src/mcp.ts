// MCP tool surface. One McpServer per Claude session; each knows who its analyst is.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "./util.js";
import { Inputs, type Actor, type CaseService } from "./service.js";

type ToolDef = {
  name: string;
  title: string;
  description: string;
  input: keyof typeof Inputs;
  readOnly?: boolean;
  run: (svc: CaseService, actor: Actor, args: any) => unknown;
};

const TOOLS: ToolDef[] = [
  // ---- reads ----
  {
    name: "list_incidents",
    title: "List incidents",
    description: "List incidents with codename, title, priority (P1 highest), status, lead, next compliance deadline and next incident meeting. Most urgent first.",
    input: "listIncidents",
    readOnly: true,
    run: (s, _a, x) => s.listIncidents(x),
  },
  {
    name: "find_incident",
    title: "Find incident",
    description: "Resolve a codename (\"Amber Heron\"), id (INC-2026-0042), number (42) or words from the title to an incident. Returns one match or several candidates to choose from.",
    input: "findIncident",
    readOnly: true,
    run: (s, _a, x) => s.findIncident(x),
  },
  {
    name: "connect_incident",
    title: "Connect to incident",
    description: "Link this Claude session to an incident. After this, write tools default to it. Returns a briefing: summary, latest timeline, open tasks and your actions, open flags, compliance due next, open engagements, next meeting and who is active.",
    input: "connect",
    run: (s, a, x) => s.connect(a, x),
  },
  {
    name: "get_template",
    title: "Get case template",
    description: "The team's template: section rules telling you how to extract timeline entries, IOCs, assets etc., allowed phases and IOC types, compliance questions to ask at open, and the supporting teams. Read this before extracting evidence.",
    input: "incidentOnly",
    readOnly: true,
    run: (s, a, x) => s.getTemplate(a, x),
  },
  {
    name: "get_report",
    title: "Get incident report",
    description: "The rendered incident report (Markdown), whole or one section by template section id (e.g. timeline, iocs, compliance, meetings).",
    input: "getReport",
    readOnly: true,
    run: (s, a, x) => s.getReport(a, x),
  },
  {
    name: "get_updates",
    title: "What's new",
    description: "What other people added since you last looked, ranked: correlation flags and engineering deliveries first, then items touching IOCs/hosts/users you added, then tasks assigned to you, then the rest. Includes reminders: meeting starting soon, your open actions, compliance due within 12 h. Marks everything as seen.",
    input: "getUpdates",
    run: (s, a, x) => s.getUpdates(a, x),
  },
  {
    name: "get_next_steps",
    title: "Facts for next-step recommendations",
    description: "Facts to base recommendations on: your open actions, suggested engagements, assets not yet contained, IOCs without a verdict, kill-chain phases with no timeline entries, unassigned tasks, unresolved correlation flags, compliance due within 24 h, and what engineering delivered.",
    input: "incidentOnly",
    readOnly: true,
    run: (s, a, x) => s.getNextSteps(a, x),
  },
  {
    name: "get_status",
    title: "Incident status (manager view)",
    description: "Status for a manager or lead: a needs_action list first (overdue compliance, steps due soon, missed meeting, overdue tasks, overdue engagements, unassigned work, flags to decide), then counts, incident meetings with actions per person, compliance steps by urgency, engagements and close blockers.",
    input: "incidentOnly",
    readOnly: true,
    run: (s, a, x) => s.getStatus(a, x),
  },
  {
    name: "get_meeting_brief",
    title: "Incident meeting brief",
    description: "Agenda for the next incident meeting: last meeting's actions by person (carried-over ones marked), what changed since the last meeting, deadlines before the meeting after this one, and open questions.",
    input: "incidentOnly",
    readOnly: true,
    run: (s, a, x) => s.getMeetingBrief(a, x),
  },
  {
    name: "get_team_queue",
    title: "Team queue (engineers)",
    description: "Open requests (requested or engaged) for a supporting team across all incidents, most urgent first. Each item carries the recommendations (draft rules, dashboards, hunt queries) and a context pack: relevant timeline rows, IOCs, assets, techniques and artifacts. Defaults to your own team.",
    input: "getTeamQueue",
    readOnly: true,
    run: (s, a, x) => s.getTeamQueue(a, x),
  },

  // ---- writes ----
  {
    name: "open_incident",
    title: "Open incident",
    description: "Open a new incident. The server assigns the id and a speakable codename. Priority is P1 (highest) to P4. Attach compliance tracks you confirmed with the analyst. Omit meeting_schedule to use the template default for the priority. Links this session to the new incident.",
    input: "openIncident",
    run: (s, a, x) => s.openIncident(a, x),
  },
  {
    name: "add_artifact",
    title: "Store raw evidence",
    description: "Store the raw input (alert JSON, log excerpt, email, note) before extracting from it. Returns an artifact_id to pass as source_artifact on extracted items. Same content twice is stored once.",
    input: "addArtifact",
    run: (s, a, x) => s.addArtifact(a, x),
  },
  {
    name: "add_events",
    title: "Add evidence to the case",
    description: "Append extracted facts in one call: timeline entries (with the event's own timestamp and timezone, and a 0-100 confidence: 100 unless the analyst hedges), IOCs (defanged is fine; duplicates merge), assets, notes, tasks, MITRE techniques and CVEs. Returns per-item results, any correlation flags raised against other incidents, and engagements the server suggests.",
    input: "addEvents",
    run: (s, a, x) => s.addEvents(a, x),
  },
  {
    name: "update_field",
    title: "Change incident field",
    description: "Change title, priority (P1–P4), status (Open, Resolved, Closed), lead, summary or detected_at. summary, status and priority need expected_seq (the seq you last saw); if someone changed it since, you get `conflict` with the current value: show both to the analyst. Closing needs Resolved first and every compliance step and engagement resolved.",
    input: "updateField",
    run: (s, a, x) => s.updateField(a, x),
  },
  {
    name: "update_item",
    title: "Update task or asset",
    description: "Update a task (status, assignee, outcome, due, title), an asset (state, owner) or a timeline entry's confidence (e.g. raise it to 100 once confirmed, with a reason) by its id. Pass expected_seq to guard against concurrent edits.",
    input: "updateItem",
    run: (s, a, x) => s.updateItem(a, x),
  },
  {
    name: "attach_compliance",
    title: "Attach compliance track",
    description: "Attach a compliance track (e.g. nis2, gdpr, dora). Deadlines run from trigger_at (default: detected_at).",
    input: "attachCompliance",
    run: (s, a, x) => s.attachCompliance(a, x),
  },
  {
    name: "set_compliance_step",
    title: "Set compliance step",
    description: "Move a compliance step to todo, in_progress, done or not_applicable. Done requires the evidence the track lists (e.g. submission_reference).",
    input: "setComplianceStep",
    run: (s, a, x) => s.setComplianceStep(a, x),
  },
  {
    name: "set_engagement",
    title: "Engage a supporting team",
    description: "Create or move an engagement with a supporting team (e.g. detection-eng, vuln-mgmt, ctic): suggested, requested, engaged, delivered (needs outcome) or not_needed (needs reason). When requesting Detection Engineering, attach recommendations: what to detect, why, evidence event ids, and a first draft query or dashboard panels.",
    input: "setEngagement",
    run: (s, a, x) => s.setEngagement(a, x),
  },
  {
    name: "resolve_correlation",
    title: "Resolve correlation flag",
    description: "Decide a correlation flag: linked, merged or dismissed.",
    input: "resolveCorrelation",
    run: (s, a, x) => s.resolveCorrelation(a, x),
  },
  {
    name: "set_meeting_schedule",
    title: "Set incident meetings",
    description: "Set or change the meeting cadence (minutes; 0 = ad hoc), next meeting time, Teams channel name, join link and chair.",
    input: "setMeetingSchedule",
    run: (s, a, x) => s.setMeetingSchedule(a, x),
  },
  {
    name: "record_meeting",
    title: "Record incident meeting",
    description: "Record a held meeting in one call: attendees, notes, an outcome for each open action (task_id, status, one line on what came of it), and new actions with exactly one assignee each (due defaults to the next meeting). Actions without an outcome are carried over.",
    input: "recordMeeting",
    run: (s, a, x) => s.recordMeeting(a, x),
  },
  {
    name: "skip_meeting",
    title: "Skip meeting",
    description: "Record that a scheduled meeting did not take place, with a reason. Re-anchors the next meeting time.",
    input: "skipMeeting",
    run: (s, a, x) => s.skipMeeting(a, x),
  },
  {
    name: "list_suggestions",
    title: "Suggestions waiting for review",
    description: "Suggestions from the Teams meeting bot, the incident mailbox and people without Claude (e.g. a plant manager). Each has who said it, where, the quote, and the items it would add. Nothing is in the case until someone accepts it.",
    input: "incidentOnly",
    readOnly: true,
    run: (s, a, x) => s.listProposals(a, x),
  },
  {
    name: "decide_suggestion",
    title: "Accept or reject a suggestion",
    description: "Accept (all items, or only item_indexes) or reject a suggestion waiting for review. Accepted items are added to the case marked with who proposed them and how. Show the analyst the suggestion and get a yes before accepting.",
    input: "decideProposal",
    run: (s, a, x) => s.decideProposal(a, x),
  },
  {
    name: "retract_event",
    title: "Retract an entry",
    description: "Correct a mistake: retract an event (e.g. a wrong timeline entry) with a reason. Nothing is deleted; the retraction is logged.",
    input: "retractEvent",
    run: (s, a, x) => s.retractEvent(a, x),
  },
];

export function createMcpServer(svc: CaseService, actor: Actor): McpServer {
  const server = new McpServer(
    { name: "incident-mcp", version: "0.1.0" },
    {
      instructions:
        "Case server for SOC incident response. Every analyst's Claude session writes into the same incident through these tools. " +
        "Connect first (connect_incident or open_incident). Store raw input with add_artifact, read get_template, extract, then add_events in one call. " +
        "Pass an idempotency_key (a fresh UUID per logical write) on every write. Priorities run P1 (highest) to P4; statuses are Open, Resolved, Closed.",
    },
  );
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: Inputs[t.input].shape,
        annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args: any) => {
        try {
          const result = t.run(svc, actor, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          const body = e instanceof AppError ? e.toJSON() : { error: "internal", message: (e as Error).message };
          return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
        }
      },
    );
  }
  return server;
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);
