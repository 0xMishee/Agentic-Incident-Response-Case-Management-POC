import { describe, it, expect } from "vitest";
import { normalizeIoc, normalizeTime, detectIocType, defang } from "../src/normalize.js";
import { parseDuration, addDuration, iso } from "../src/util.js";
import { setup, actor } from "./helpers.js";

describe("normalisation", () => {
  it("refangs and types indicators", () => {
    expect(normalizeIoc("203.0.113[.]66")).toEqual({ type: "ipv4", value: "203.0.113.66" });
    expect(normalizeIoc("GoldenPod-Invoices[.]TEST")).toEqual({ type: "domain", value: "goldenpod-invoices.test" });
    expect(normalizeIoc("hxxps://truffle-cdn[.]test/up").type).toBe("url");
    expect(normalizeIoc("Clerk[at]Bittersweet.Example")).toEqual({ type: "email", value: "clerk@bittersweet.example" });
    expect(detectIocType("A".repeat(64))).toBe("sha256");
    expect(normalizeIoc("2001:DB8:0:0::1").value).toBe("2001:db8::1");
    expect(() => normalizeIoc("999.1.1.1", "ipv4")).toThrow(/not a valid ipv4/);
    expect(defang("ipv4", "203.0.113.66")).toBe("203.0.113[.]66");
  });

  it("requires a timezone and converts to UTC", () => {
    expect(normalizeTime("2026-11-14T08:58:00+02:00")).toBe("2026-11-14T06:58:00Z");
    expect(normalizeTime("2026-11-14 06:58:00Z")).toBe("2026-11-14T06:58:00Z");
    expect(() => normalizeTime("2026-11-14T06:58:00")).toThrow(/timezone/);
  });

  it("parses durations including months", () => {
    expect(iso(addDuration("2026-11-14T07:12:00Z", parseDuration("72h")))).toBe("2026-11-17T07:12:00Z");
    expect(iso(addDuration("2026-11-14T07:12:00Z", parseDuration("1mo")))).toBe("2026-12-14T07:12:00Z");
  });
});

describe("incidents", () => {
  it("assigns ids and distinct codenames, resolves by name, number and words", () => {
    const { svc } = setup();
    const a = actor("analyst-a");
    const one = svc.openIncident(a, { title: "Truffle Thief invoice phish", priority: "P2" });
    const two = svc.openIncident(a, { title: "Webshop credential stuffing", priority: "P4" });
    expect(one.id).toBe("INC-2026-0001");
    expect(two.id).toBe("INC-2026-0002");
    expect(one.codename).not.toBe(two.codename);
    expect(svc.resolve(one.codename.toLowerCase())).toBe(one.id);
    expect(svc.resolve(one.codename.toLowerCase().replace(" ", "-"))).toBe(one.id);
    expect(svc.resolve("2")).toBe(two.id);
    expect(svc.resolve("truffle phish")).toBe(one.id);
    expect(() => svc.resolve("nothing like this")).toThrow(/No incident/);
  });

  it("P1 and P2 get the template's default incident meetings; P3 does not", () => {
    const { svc } = setup({ start: "2026-11-14T08:00:00Z" });
    const a = actor("analyst-a");
    expect(svc.openIncident(a, { title: "Big one", priority: "P1" }).next_meeting).toBe("2026-11-14T09:00:00Z");
    expect(svc.openIncident(a, { title: "Medium one", priority: "P2" }).next_meeting).toBe("2026-11-14T12:00:00Z");
    expect(svc.openIncident(a, { title: "Small one", priority: "P3" }).next_meeting).toBeNull();
  });

  it("demo mode shortens the rhythm", () => {
    const { svc } = setup({ start: "2026-11-14T08:00:00Z", overrides: { settings: { demo: { enabled: true, clock_offset_minutes: 0, meeting_minutes: 5, anchor: null } } } });
    const a = actor("analyst-a", "lead");
    svc.openIncident(a, { title: "Demo", priority: "P1", meeting_schedule: { cadence_minutes: 60, next_at: "2026-11-14T08:05:00Z" } });
    const m = svc.recordMeeting(a, { started_at: "2026-11-14T08:05:00Z", attendees: ["analyst-a"] });
    expect(m.next_meeting).toBe("2026-11-14T08:10:00Z");
  });

  it("suggests teams from teams.yml rules and turns a suggestion into a request", () => {
    const { svc } = setup();
    const a = actor("analyst-d");
    const inc = svc.openIncident(a, { title: "Recipe theft", priority: "P3" });
    expect(inc.suggested_engagements).toHaveLength(0);
    const r = svc.addEvents(a, { items: [{ type: "ioc", value: "truffle-cdn.test", external: true }] });
    const teams = r.engagements_suggested.map((x) => x.team).sort();
    expect(teams).toEqual(["ctic", "detection-eng"]);
    const ctic = r.engagements_suggested.find((x) => x.team === "ctic")!;
    const req = svc.setEngagement(a, { team_id: "ctic", request_type: "enrichment", status: "requested" });
    expect(req.engagement_id).toBe(ctic.engagement_id);
    // a second external IOC does not suggest CTI again
    expect(svc.addEvents(a, { items: [{ type: "ioc", value: "goldenpod-invoices.test", external: true }] }).engagements_suggested).toHaveLength(0);
  });

  it("dedups IOCs and merges sources", () => {
    const { svc } = setup();
    const a = actor("analyst-a");
    const b = actor("analyst-b");
    const inc = svc.openIncident(a, { title: "Recipe theft", priority: "P3" });
    svc.connect(b, { query: inc.id });
    svc.addEvents(a, { items: [{ type: "ioc", value: "203.0.113.66", source: "proxy" }] });
    const r = svc.addEvents(b, { items: [{ type: "ioc", value: "203.0.113[.]66", source: "EDR", verdict: "malicious" }, { type: "ioc", value: "203.0.113.66" }] });
    expect(r.results.every((x) => x.deduplicated)).toBe(true);
    const ioc = svc.store.state(inc.id).iocs[0];
    expect(ioc.sources).toEqual(["proxy", "EDR"]);
    expect(ioc.verdict).toBe("malicious");
  });

  it("digest ranks items touching my own IOCs above the rest and excludes my own writes", () => {
    const { svc } = setup();
    const c = actor("analyst-c");
    const b = actor("analyst-b");
    const inc = svc.openIncident(c, { title: "Recipe theft", priority: "P3" });
    svc.addEvents(c, { items: [{ type: "asset", host: "RND-LT-007", state: "compromised" }] });
    svc.getUpdates(c, {});
    svc.connect(b, { query: inc.id });
    svc.addEvents(b, { items: [{ type: "note", text: "Unrelated note" }] });
    svc.addEvents(b, { items: [{ type: "timeline", time: "2026-11-14T07:30:00Z", description: "CocoaInvoice Sync token used on RND-LT-007" }] });
    const u = svc.getUpdates(c, {});
    expect(u.updates[0].what).toMatch(/RND-LT-007/);
    expect(u.updates[0].why).toMatch(/rnd-lt-007/);
    expect(u.updates.some((x) => x.by === "analyst-c")).toBe(false);
  });

  it("timeline confidence defaults to 100, can be lower, and can be raised later", () => {
    const { svc } = setup();
    const a = actor("analyst-c");
    const inc = svc.openIncident(a, { title: "Recipe theft", priority: "P3" });
    const r = svc.addEvents(a, {
      items: [
        { type: "timeline", time: "2026-11-14T07:41:00Z", description: "Clerk token used on RND-LT-007" },
        { type: "timeline", time: "2026-11-14T07:30:00Z", description: "I think the attacker browsed the vault first", confidence: 70 },
      ],
    });
    let tl = svc.store.state(inc.id).timeline;
    expect(tl.map((t) => t.confidence)).toEqual([100, 70]);
    expect(svc.getReport(a, { section: "timeline" }).markdown).toContain("| 70% |");
    svc.updateItem(a, { kind: "timeline", item_id: r.results[1].event_id!, changes: { confidence: 100, reason: "Confirmed in SharePoint audit log" } });
    tl = svc.store.state(inc.id).timeline;
    expect(tl[1].confidence).toBe(100);
    expect(() => svc.addEvents(a, { items: [{ type: "timeline", time: "2026-11-14T07:00:00Z", description: "x", confidence: 140 }] })).toThrow();
  });

  it("a Teams-bot suggestion stays out of the case until accepted, then carries who proposed it", () => {
    const { svc } = setup();
    const lead = actor("analyst-a", "lead");
    const bot = actor("teams-bot");
    const inc = svc.openIncident(lead, { title: "Recipe theft", priority: "P2" });
    const p = svc.propose(bot, {
      incident: inc.id,
      source: "teams-meeting",
      from: "Plant manager (Trondheim)",
      context: "Incident meeting 10:00",
      quote: "That R&D laptop was plugged into the line PC at the Trondheim factory on Thursday.",
      summary: "R&D laptop connected to a factory line PC on Thursday",
      items: [
        { type: "asset", host: "TRD-LINE-PC-04", owner: "Trondheim factory", state: "suspected" },
        { type: "timeline", time: "2026-11-12T13:00:00Z", description: "RND-LT-007 connected to a Trondheim line PC", confidence: 60 },
      ],
    });
    expect(svc.store.state(inc.id).assets).toHaveLength(0);
    expect(svc.getStatus(lead, {}).needs_action.some((x) => x.startsWith("Waiting for review"))).toBe(true);
    // a bad suggestion is refused at the door
    expect(() => svc.propose(bot, { incident: inc.id, source: "teams-meeting", from: "x", summary: "bad", items: [{ type: "timeline", time: "yesterday", description: "?" }] })).toThrow(/timezone|valid time/);

    const r = svc.decideProposal(lead, { proposal_id: p.proposal_id, decision: "accepted", item_indexes: [0] });
    expect(r.added).toBe(1);
    const st = svc.store.state(inc.id);
    expect(st.assets[0].host).toBe("TRD-LINE-PC-04");
    expect(st.timeline).toHaveLength(0); // item 1 was not picked
    expect(svc.store.events(inc.id).find((e) => e.type === "asset.added")!.payload.proposed_by).toBe("Plant manager (Trondheim)");
    expect(() => svc.decideProposal(lead, { proposal_id: p.proposal_id, decision: "rejected" })).toThrow(/already accepted/);
  });

  it("the bot can suggest from the incident chat, with a link back to the message", () => {
    const { svc } = setup();
    const lead = actor("analyst-a", "lead");
    const bot = actor("teams-bot");
    const inc = svc.openIncident(lead, { title: "Recipe theft", priority: "P2" });
    svc.propose(bot, {
      incident: inc.id,
      source: "teams-chat",
      link: "https://teams.example/l/message/1",
      from: "Treasury",
      context: "Teams chat: IR - test",
      quote: "Bank blocked a new payee at 09:12",
      summary: "Bank blocked a fake payee",
      items: [{ type: "note", text: "Bank blocked a fake payee at 09:12" }],
    });
    const p = svc.listProposals(lead, {}).pending[0];
    expect(p.source).toBe("teams-chat");
    expect(p.link).toBe("https://teams.example/l/message/1");
    expect(svc.getReport(lead, { section: "proposals" }).markdown).toContain("[message](https://teams.example/l/message/1)");
  });

  it("an email from the mailbox connector becomes a correspondence suggestion and, once accepted, a report row", () => {
    const { svc } = setup();
    const lead = actor("analyst-a", "lead");
    const mail = actor("mail-connector");
    const inc = svc.openIncident(lead, { title: "Recipe theft", priority: "P2", compliance: ["nis2"] });
    const e = svc.ingestEmail(mail, {
      incident: inc.id,
      direction: "inbound",
      party: "csirt",
      from: "intake@csirt.example",
      to: ["soc@bittersweet.example"],
      subject: "Receipt: early warning CSIRT-2026-1187",
      date: "2026-11-14T09:40:00Z",
      body: "We confirm receipt of your early warning.",
    });
    svc.decideProposal(lead, { proposal_id: e.proposal_id, decision: "accepted" });
    const c = svc.store.state(inc.id).correspondence[0];
    expect(c.party).toBe("csirt");
    expect(c.source_artifact).toBe(e.artifact_id);
    expect(svc.getReport(lead, { section: "correspondence" }).markdown).toContain("Receipt: early warning CSIRT-2026-1187");
  });

  it("retracting an event removes it from the report but keeps it in the log", () => {
    const { svc } = setup();
    const a = actor("analyst-a");
    const inc = svc.openIncident(a, { title: "Recipe theft", priority: "P3" });
    const r = svc.addEvents(a, { items: [{ type: "timeline", time: "2026-11-14T07:00:00Z", description: "Wrong entry" }] });
    svc.retractEvent(a, { event_id: r.results[0].event_id!, reason: "Wrong host" });
    expect(svc.getReport(a, {}).markdown).not.toContain("Wrong entry");
    expect(svc.store.events(inc.id).some((e) => e.type === "timeline.added")).toBe(true);
  });
});
