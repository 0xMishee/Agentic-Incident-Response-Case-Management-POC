// Acceptance criteria from docs/FEATURES.md section 11.
import { describe, it, expect } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { setup, actor } from "./helpers.js";

describe("acceptance", () => {
  it("2: same idempotency key is stored once", () => {
    const { svc } = setup();
    const a = actor("analyst-a");
    svc.openIncident(a, { title: "Test incident", priority: "P3" });
    const body = { items: [{ type: "note" as const, text: "hello" }], idempotency_key: "k-1" };
    const r1 = svc.addEvents(a, body);
    const r2 = svc.addEvents(a, body);
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
    const id = svc.linkedIncident(a)!;
    expect(svc.store.state(id).notes).toHaveLength(1);
  });

  it("3: stale expected_seq on summary gives conflict with the current value", () => {
    const { svc } = setup();
    const a = actor("analyst-a");
    const b = actor("analyst-b");
    const inc = svc.openIncident(a, { title: "Test incident", priority: "P3" });
    svc.connect(b, { query: inc.codename });
    const seen = svc.store.state(inc.id).incident.seq;
    svc.updateField(a, { field: "summary", value: "A's summary", expected_seq: seen });
    try {
      svc.updateField(b, { field: "summary", value: "B's summary", expected_seq: seen });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("conflict");
      expect(e.details.current).toEqual({ summary: "A's summary" });
    }
  });

  it("4: an IOC seen in another incident flags both reports", () => {
    const { svc } = setup();
    const a = actor("analyst-a");
    const b = actor("analyst-b");
    const older = svc.openIncident(a, { title: "Credential stuffing on shop", priority: "P3" });
    svc.addEvents(a, { items: [{ type: "ioc", value: "203.0.113[.]66", verdict: "malicious" }] });
    const newer = svc.openIncident(b, { title: "Recipe theft", priority: "P2" });
    const r = svc.addEvents(b, { items: [{ type: "ioc", value: "203.0.113.66" }] });
    expect(r.flags_raised).toHaveLength(1);
    expect(r.flags_raised[0].other_incident_id).toBe(older.id);
    svc.flushRenders();
    const repA = readFileSync(svc.reportPath(older.id), "utf8");
    const repB = readFileSync(svc.reportPath(newer.id), "utf8");
    expect(repA).toContain(newer.id);
    expect(repB).toContain(older.id);
  });

  it("5: GDPR authority notice due 72h after trigger, overdue afterwards", () => {
    const { svc, clock } = setup({ start: "2026-11-14T08:00:00Z" });
    const m = actor("manager", "manager");
    svc.openIncident(m, { title: "Recipe theft", priority: "P2", detected_at: "2026-11-14T07:12:00Z", compliance: ["gdpr"] });
    let st = svc.getStatus(m, {});
    const step = st.compliance.find((s) => s.step === "notify-dpa")!;
    expect(step.due_at).toBe("2026-11-17T07:12:00Z");
    expect(step.overdue).toBe(false);
    clock.set("2026-11-17T07:13:00Z");
    st = svc.getStatus(m, {});
    expect(st.compliance.find((s) => s.step === "notify-dpa")!.overdue).toBe(true);
    expect(st.needs_action.some((x) => x.includes("OVERDUE") && x.includes("Notify supervisory authority"))).toBe(true);
  });

  it("6: delivered without outcome is invalid", () => {
    const { svc } = setup();
    const a = actor("analyst-a");
    svc.openIncident(a, { title: "Test incident", priority: "P3" });
    expect(() => svc.setEngagement(a, { team_id: "detection-eng", status: "delivered" })).toThrow(/outcome/);
  });

  it("7: deleting report.md and re-rendering gives an identical file", () => {
    const { svc } = setup();
    const a = actor("analyst-a");
    const inc = svc.openIncident(a, { title: "Test incident", priority: "P2", compliance: ["nis2", "gdpr"] });
    svc.addEvents(a, {
      items: [
        { type: "timeline", time: "2026-11-14T06:58:00+01:00", description: "Clicked link", source: "ALRT-1", phase: "initial access" },
        { type: "ioc", value: "hxxps://goldenpod-invoices[.]test/inv", verdict: "malicious", external: true },
        { type: "asset", host: "FIN-LT-042", user: "clerk@bittersweet.example", state: "compromised" },
      ],
    });
    svc.flushRenders();
    const before = readFileSync(svc.reportPath(inc.id), "utf8");
    rmSync(svc.reportPath(inc.id));
    expect(existsSync(svc.reportPath(inc.id))).toBe(false);
    svc.renderAll();
    expect(readFileSync(svc.reportPath(inc.id), "utf8")).toBe(before);
    // and it contains what we expect, defanged
    expect(before).toContain("goldenpod-invoices[.]test");
    expect(before).toContain("2026-11-14 05:58Z"); // converted to UTC
    expect(before).toContain("Initial access");
  });

  it("8: incident meetings re-anchors on each meeting; unreviewed actions carry over", () => {
    const { svc, clock } = setup({ start: "2026-11-14T09:00:00Z" });
    const lead = actor("analyst-a", "lead");
    svc.openIncident(lead, { title: "Recipe theft", priority: "P1", meeting_schedule: { cadence_minutes: 60, next_at: "2026-11-14T10:00:00Z" } });
    clock.set("2026-11-14T10:00:00Z");
    const m1 = svc.recordMeeting(lead, {
      started_at: "2026-11-14T10:00:00Z",
      attendees: ["analyst-a", "analyst-b", "analyst-c"],
      actions: [
        { assignee: "analyst-b", title: "Revoke CocoaInvoice Sync" },
        { assignee: "analyst-c", title: "Isolate R&D laptop" },
      ],
    });
    expect(m1.next_meeting).toBe("2026-11-14T11:00:00Z");
    expect(m1.new_actions.every((x) => x.due === "2026-11-14T11:00:00Z")).toBe(true);
    clock.set("2026-11-14T11:00:00Z");
    const revoke = m1.new_actions.find((x) => x.assignee === "analyst-b")!;
    const m2 = svc.recordMeeting(lead, {
      started_at: "2026-11-14T11:00:00Z",
      attendees: ["analyst-a", "analyst-b"],
      outcomes: [{ task_id: revoke.task_id, status: "done", outcome: "App consent revoked tenant-wide" }],
    });
    expect(m2.next_meeting).toBe("2026-11-14T12:00:00Z");
    expect(m2.carried_over.map((x) => x.title)).toEqual(["Isolate R&D laptop"]);
    const brief = svc.getMeetingBrief(lead, {});
    expect(brief.actions_by_person["analyst-c"][0].carried_over).toBe(true);
  });

  it("9: cannot close while a GDPR step is open; error names the step", () => {
    const { svc } = setup();
    const lead = actor("analyst-a", "lead");
    const inc = svc.openIncident(lead, { title: "Recipe theft", priority: "P2", compliance: ["gdpr"] });
    const seq = () => svc.store.state(inc.id).incident.seq;
    svc.updateField(lead, { field: "status", value: "Resolved", expected_seq: seq() });
    expect(() => svc.updateField(lead, { field: "status", value: "Closed", expected_seq: seq() })).toThrow(/gdpr\/notify-dpa/);
    for (const step of ["assess", "notify-dpa", "notify-subjects"]) {
      svc.setComplianceStep(lead, {
        track_id: "gdpr",
        step_id: step,
        status: step === "notify-subjects" ? "not_applicable" : "done",
        evidence: { submission_reference: "DPA-2026-123" },
      });
    }
    // CTI was auto-suggested at P2 open; suggestions do not block closing
    const r = svc.updateField(lead, { field: "status", value: "Closed", expected_seq: seq() });
    expect(r.value).toBe("Closed");
    expect(() => svc.addEvents(lead, { items: [{ type: "note", text: "late" }] })).toThrow(/closed/);
  });

  it("10: engineer queue carries the analyst's recommendation; delivery shows in the analyst digest", () => {
    const { svc } = setup();
    const b = actor("analyst-b");
    const eng = actor("engineer", "engineer", "detection-eng");
    const inc = svc.openIncident(b, { title: "Recipe theft", priority: "P2" });
    const added = svc.addEvents(b, {
      items: [{ type: "timeline", time: "2026-11-14T07:20:00Z", description: "Inbox rule forwards invoices to external address", source: "ALRT-890" }],
    });
    svc.setEngagement(b, {
      team_id: "detection-eng",
      request_type: "detection_rule",
      status: "requested",
      recommendations: [
        {
          kind: "detection_rule",
          title: "Inbox rule forwarding invoices externally",
          rationale: "Attacker app created a forwarding rule.",
          evidence: [added.results[0].event_id!],
          draft: { language: "kql", query: "OfficeActivity | where Operation == 'New-InboxRule'" },
          mitre: ["T1114.003"],
        },
      ],
    });
    svc.getUpdates(b, {}); // b has seen everything so far
    const q = svc.getTeamQueue(eng, {});
    expect(q.count).toBe(1);
    expect(q.items[0].recommendations[0].title).toMatch(/forwarding/);
    expect(q.items[0].context.timeline[0].source).toBe("ALRT-890");
    svc.setEngagement(eng, { incident: inc.id, engagement_id: q.items[0].engagement_id, team_id: "detection-eng", status: "delivered", outcome: "Rule DET-1042 deployed" });
    const upd = svc.getUpdates(b, {});
    expect(upd.updates[0].what).toMatch(/delivered.*DET-1042/);
    expect(upd.updates[0].priority_tier).toBe(1);
    expect(svc.getTeamQueue(eng, {}).count).toBe(0);
  });
});
