// Demo seed: plays the fictional "Truffle Thief" scenario at Bittersweet Fjord Chocolate Co.
// through the real CaseService (same validation, correlation and engagement rules as live use).
//
//   npm run demo:seed                  full scenario (5 incidents, Amber Heron worked by 6 people)
//   npm run demo:seed -- --stage video only the background incidents; Amber Heron is opened live on camera
//   npm run demo:seed -- --reset       wipe the local data folder first (the server must be stopped)
//   npm run demo:seed -- --sample ../demo/sample-report.md   also copy Amber Heron's report there
//
// Then: npm run demo:start  (server clock starts at the scenario time, 14 Nov 2026 09:48 UTC)
import { existsSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { CaseService, type Actor, type Role } from "../src/service.js";
import { ManualClock } from "../src/util.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const stage = value("stage") ?? "full";
if (!["full", "video"].includes(stage)) throw new Error(`--stage must be full or video, not ${stage}`);

const cfg = loadConfig(undefined, { dataDir: process.env.IR_DATA_DIR, settings: process.env.IR_PORT ? { port: Number(process.env.IR_PORT) } : {} });
const ALERTS = join(cfg.rootDir, "demo", "alerts");
const alert = (f: string) => readFileSync(join(ALERTS, f), "utf8");

async function serverRunning(): Promise<boolean> {
  try {
    const r = await fetch(`http://${cfg.settings.host}:${cfg.settings.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

if (await serverRunning()) {
  console.error(`The case server is running on port ${cfg.settings.port}. Stop it first (Ctrl+C in its terminal), then seed.`);
  process.exit(1);
}

const dbFile = join(cfg.dataDir, "cases.db");
if (flag("reset")) {
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true });
  rmSync(join(cfg.dataDir, "incidents"), { recursive: true, force: true });
  console.log(`Reset ${cfg.dataDir}`);
} else if (existsSync(dbFile)) {
  console.error(`${dbFile} already exists. Run with --reset to replace it with the demo data.`);
  process.exit(1);
}

// ---- scenario clock: everything is placed on 14 Nov 2026 (and before), times in UTC ----
const DAY = "2026-11-14";
const clock = new ManualClock(`${DAY}T00:00:00Z`);
// "07:12" -> that time on DAY; "2026-11-01T12:40" -> that date and time; both in UTC.
const at = (t: string) => (/T\d\d:\d\d$/.test(t) ? `${t}:00Z` : t.includes("T") ? t : `${DAY}T${t}:00Z`);
const atTime = (hhmm: string) => clock.set(at(hhmm));

const db = openDb(dbFile);
const svc = new CaseService(db, { ...cfg, settings: { ...cfg.settings, demo: { ...cfg.settings.demo, enabled: false } } }, clock, { renderDelayMs: 0 });

let n = 0;
const person = (author: string, role: Role = "analyst", team: string | null = null): Actor => ({ author, role, team, session_id: `demo-${author}-${++n}` });
const A = person("analyst-a", "lead");
const B = person("analyst-b");
const C = person("analyst-c");
const D = person("analyst-d");
const M = person("manager", "manager");
const E = person("engineer", "engineer", "detection-eng");
const CTI = person("cti-analyst", "engineer", "ctic");

const seqOf = (id: string) => svc.store.state(id).incident.seq;
const art = (who: Actor, incident: string, file: string, kind: "alert" | "log" | "email") =>
  svc.addArtifact(who, { incident, kind, filename: file, content: alert(file) }).artifact_id;

// =========================================================================================
// Background incidents
// =========================================================================================

// Velvet Pine: closed P2 from two weeks ago
atTime("2026-11-01T13:05");
const vp = svc.openIncident(A, { title: "Malware on the packaging line HMI", priority: "P2", detected_at: at("2026-11-01T12:40"), meeting_schedule: { cadence_minutes: 0 } }, { codename: "Velvet Pine" });
svc.addEvents(A, { incident: vp.id, items: [
  { type: "timeline", time: "2026-11-01T12:31:00Z", description: "USB-borne malware detected on packaging line HMI PKG-HMI-03", source: "EDR-4410", phase: "Execution" },
  { type: "asset", host: "PKG-HMI-03", owner: "Packaging plant", state: "compromised" },
  { type: "note", text: "Isolated from the OT network by plant engineering at 13:20. No spread found." },
] });
atTime("2026-11-02T09:00");
svc.updateItem(A, { incident: vp.id, kind: "asset", item_id: svc.store.state(vp.id).assets[0].event_id, changes: { state: "clean" } });
svc.updateField(A, { incident: vp.id, field: "summary", value: "USB-borne malware on one packaging HMI. Isolated within an hour, re-imaged, no spread or data loss.", expected_seq: seqOf(vp.id) });
svc.updateField(A, { incident: vp.id, field: "status", value: "Resolved", expected_seq: seqOf(vp.id) });
svc.updateField(A, { incident: vp.id, field: "status", value: "Closed", expected_seq: seqOf(vp.id) });

// Quiet Lynx: last month's credential stuffing on the web shop (same IP the Truffle Thief uses later)
atTime("2026-10-15T22:10");
const ql = svc.openIncident(D, { title: "Credential stuffing on the praline web shop", priority: "P3", detected_at: at("2026-10-15T21:45"), meeting_schedule: { cadence_minutes: 0 } }, { codename: "Quiet Lynx" });
const qlArt = art(D, ql.id, "quiet-lynx-waf.log", "log");
svc.addEvents(D, { incident: ql.id, items: [
  { type: "timeline", time: "2026-10-15T21:02:11Z", description: "Credential-stuffing burst against shop login: 4,812 failures from one IP", source: "WAF-30411", actor: "203.0.113.66", phase: "Credential access", source_artifact: qlArt },
  { type: "timeline", time: "2026-10-15T21:40:55Z", description: "3 customer accounts logged in successfully, order history viewed", source: "WAF-30598", actor: "203.0.113.66", phase: "Initial access", source_artifact: qlArt },
  { type: "ioc", value: "203.0.113.66", verdict: "malicious", external: true, source: "WAF", source_artifact: qlArt },
  { type: "asset", host: "shop.bittersweet.example", owner: "E-commerce", state: "contained" },
] });
atTime("2026-10-17T10:00");
svc.updateField(D, { incident: ql.id, field: "summary", value: "Credential stuffing against the praline web shop. 3 customer accounts accessed; passwords reset, IP blocked, rate limiting added.", expected_seq: seqOf(ql.id) });
for (const g of svc.store.state(ql.id).engagements) svc.setEngagement(D, { incident: ql.id, engagement_id: g.engagement_id, team_id: g.team_id, status: "not_needed", reason: "Commodity credential stuffing; handled by the shop team" });
svc.updateField(D, { incident: ql.id, field: "status", value: "Resolved", expected_seq: seqOf(ql.id) });

// Cobalt Otter: open P3, a Detection Engineering request that is overdue by 09:48
atTime("00:50");
const co = svc.openIncident(C, { title: "Suspicious logins to the cocoa supplier portal", priority: "P3", detected_at: at("00:40"), meeting_schedule: { cadence_minutes: 0 } }, { codename: "Cobalt Otter" });
const coArt = art(C, co.id, "supplier-portal-signins.json", "log");
const coEv = svc.addEvents(C, { incident: co.id, items: [
  { type: "timeline", time: "2026-11-14T00:14:37Z", description: "Supplier account orders@cacaoverde.example signs in from a country never seen for it", source: "SIGNIN-3301", phase: "Initial access", source_artifact: coArt },
  { type: "timeline", time: "2026-11-14T00:31:02Z", description: "Second supplier account signs in from the same network", source: "SIGNIN-3307", phase: "Initial access", confidence: 85, source_artifact: coArt },
  { type: "asset", user: "orders@cacaoverde.example", owner: "Supplier: Cacao Verde", state: "suspected" },
  { type: "asset", user: "dispatch@nibs-and-co.example", owner: "Supplier: Nibs & Co", state: "contained" },
  { type: "ioc", value: "198.51.100.77", external: true, verdict: "suspicious", source: "SIGNIN-3301", source_artifact: coArt },
] });
atTime("00:55");
svc.setEngagement(C, { incident: co.id, team_id: "detection-eng", request_type: "hunt_query", status: "requested", recommendations: [{
  kind: "hunt_query",
  title: "Supplier portal logins from new countries",
  rationale: "Two supplier accounts signed in from countries never seen for them. We need to know if more accounts are affected.",
  evidence: coEv.results.slice(0, 2).map((r) => r.event_id!),
  draft: { language: "kql", query: "SigninLogs\n| where AppDisplayName == \"Supplier Portal\"\n| summarize Countries = make_set(LocationDetails.countryOrRegion) by UserPrincipalName\n| where array_length(Countries) > 1" },
  mitre: ["T1078"],
}] });

// Sable Wren: open P4, lost laptop with GDPR clock
atTime("07:55");
const sw = svc.openIncident(B, { title: "Lost laptop, R&D chocolatier", priority: "P4", detected_at: at("07:53"), compliance: ["gdpr"], meeting_schedule: { cadence_minutes: 0 } }, { codename: "Sable Wren" });
svc.addEvents(B, { incident: sw.id, items: [
  { type: "timeline", time: "2026-11-13T18:30:00+01:00", description: "Chocolatier thinks the laptop was left on the train home", source: "Phone call", phase: "Initial access", confidence: 50 },
  { type: "asset", host: "RND-LT-019", user: "chocolatier2@bittersweet.example", owner: "R&D", state: "suspected" },
  { type: "note", text: "Disk is BitLocker-encrypted per Intune. Remote wipe queued; waiting for the device to check in." },
] });

// Gilded Spruce: resolved P3, a staff-reported phishing wave
atTime("2026-11-11T08:20");
const gs = svc.openIncident(B, { title: "Fake Christmas-bonus phishing reported by 14 staff", priority: "P3", detected_at: at("2026-11-11T08:05"), meeting_schedule: { cadence_minutes: 0 } }, { codename: "Gilded Spruce" });
svc.addEvents(B, { incident: gs.id, items: [
  { type: "timeline", time: "2026-11-11T07:52:00Z", description: "\"Your Christmas bonus is ready\" mail sent to 230 staff", source: "MDO-22018", phase: "Initial access" },
  { type: "timeline", time: "2026-11-11T08:05:00Z", description: "14 staff report the mail with the Report button; 2 clicked, none entered credentials", source: "User reports", phase: "Initial access", confidence: 90 },
  { type: "ioc", value: "bonus-portal.test", verdict: "malicious", external: true, source: "MDO-22018" },
] });
atTime("2026-11-11T11:00");
for (const g of svc.store.state(gs.id).engagements) svc.setEngagement(B, { incident: gs.id, engagement_id: g.engagement_id, team_id: g.team_id, status: "not_needed", reason: "Commodity phishing; mail purged, URL blocked" });
svc.updateField(B, { incident: gs.id, field: "summary", value: "Commodity bonus-themed phishing to 230 staff. Mail purged, URL blocked, 2 clickers checked: no credentials entered.", expected_seq: seqOf(gs.id) });
svc.updateField(B, { incident: gs.id, field: "status", value: "Resolved", expected_seq: seqOf(gs.id) });

// Ivory Beacon: open P3, voice phishing of the CFO about a cocoa futures payment
atTime("2026-11-13T16:40");
const ib = svc.openIncident(B, { title: "CFO targeted by fake bank call about cocoa futures", priority: "P3", detected_at: at("2026-11-13T16:20"), meeting_schedule: { cadence_minutes: 0 } }, { codename: "Ivory Beacon" });
svc.addEvents(B, { incident: ib.id, items: [
  { type: "timeline", time: "2026-11-13T16:05:00+01:00", description: "Caller posing as the company's bank asks the CFO to approve an urgent cocoa futures margin payment", source: "CFO report", actor: "+00 000 000 000", phase: "Initial access", confidence: 80 },
  { type: "timeline", time: "2026-11-13T16:12:00+01:00", description: "Follow-up email with a payment link from a look-alike bank domain", source: "MDO-22140", phase: "Initial access" },
  { type: "ioc", value: "fjordbank-secure.test", verdict: "malicious", external: true, source: "MDO-22140" },
  { type: "correspondence", direction: "outbound", party: "other", from: "cfo@bittersweet.example", to: ["fraud@fjordbank.example"], subject: "Suspected impersonation of your bank", sent_at: "2026-11-13T16:35:00Z", summary: "CFO reported the call and the look-alike domain to the real bank's fraud desk." },
] });

// Hazel Comet: open P2, beacon on the warehouse management server, with an overdue IT Ops request
atTime("2026-11-13T22:30");
const hc = svc.openIncident(D, { title: "Command-and-control beacon on the warehouse management server", priority: "P2", detected_at: at("2026-11-13T22:10"), compliance: ["nis2"], meeting_schedule: { cadence_minutes: 240, next_at: at("2026-11-14T10:30"), channel_name: "IR - Hazel Comet", join_url: "https://teams.example/meet/hazel-comet", chair: "analyst-d" } }, { codename: "Hazel Comet" });
svc.addEvents(D, { incident: hc.id, items: [
  { type: "timeline", time: "2026-11-13T21:58:00Z", description: "WH-SRV-02 beacons every 60 s to 198.51.100.140 over HTTPS", source: "EDR-5490", actor: "svchost.exe", phase: "Execution" },
  { type: "timeline", time: "2026-11-13T21:20:00Z", description: "Unpatched remote management service on WH-SRV-02 was probably the way in", source: "VM scan", phase: "Initial access", confidence: 50 },
  { type: "ioc", value: "198.51.100.140", verdict: "malicious", external: true, source: "EDR-5490" },
  { type: "asset", host: "WH-SRV-02", owner: "Logistics", state: "compromised" },
  { type: "cve", cve_id: "CVE-2026-41001", product: "Remote management agent (fictional)" },
] });
atTime("2026-11-14T06:00");
svc.setEngagement(D, { incident: hc.id, team_id: "it-ops", request_type: "isolate_host", status: "requested", reason: "Isolate WH-SRV-02 without stopping the pick-and-pack line" });
svc.setEngagement(D, { incident: hc.id, team_id: "vuln-mgmt", request_type: "cve_status", status: "requested", reason: "Where else does the vulnerable remote management agent run?" });

// Misty Harbor: open P2, bot traffic and DDoS on the web shop before the holiday sale
atTime("08:15");
const mh = svc.openIncident(C, { title: "DDoS and bot traffic on the praline web shop before the holiday sale", priority: "P2", detected_at: at("08:05"), meeting_schedule: { cadence_minutes: 240, next_at: at("11:00"), channel_name: "IR - Misty Harbor", chair: "analyst-c" } }, { codename: "Misty Harbor" });
svc.addEvents(C, { incident: mh.id, items: [
  { type: "timeline", time: "2026-11-14T07:58:00Z", description: "Checkout latency over 8 s; 40x normal requests to /cart from rotating IPs", source: "CDN-ALERT-311", phase: "Impact" },
  { type: "timeline", time: "2026-11-14T08:20:00Z", description: "Hosting provider enables DDoS mitigation profile", source: "Provider email", phase: "Containment" },
  { type: "asset", host: "shop.bittersweet.example", owner: "E-commerce", state: "suspected" },
  { type: "correspondence", direction: "outbound", party: "supplier", from: "soc@bittersweet.example", to: ["noc@cocoacloud-hosting.example"], subject: "Urgent: DDoS on shop.bittersweet.example", sent_at: "2026-11-14T08:09:00Z", summary: "Asked the hosting provider to enable DDoS mitigation before the 10:00 sale start." },
  { type: "correspondence", direction: "inbound", party: "supplier", from: "noc@cocoacloud-hosting.example", to: ["soc@bittersweet.example"], subject: "RE: Urgent: DDoS on shop.bittersweet.example", sent_at: "2026-11-14T08:21:00Z", summary: "Mitigation profile on since 08:20; they will report peak traffic after the sale." },
] });

// Copper Thicket: open P4, a publicly listable marketing bucket
atTime("08:35");
const ct = svc.openIncident(D, { title: "Marketing photo storage publicly listable", priority: "P4", detected_at: at("08:30"), meeting_schedule: { cadence_minutes: 0 } }, { codename: "Copper Thicket" });
svc.addEvents(D, { incident: ct.id, items: [
  { type: "timeline", time: "2026-11-14T08:30:00Z", description: "Cloud posture scan: marketing photo storage allows public listing", source: "CSPM-118", phase: "Collection" },
  { type: "asset", host: "storage: mkt-photos", owner: "Marketing", state: "suspected" },
  { type: "note", text: "Contains product photos and two spreadsheets with influencer contact details. Checking whether anything was downloaded." },
] });

// =========================================================================================
// Amber Heron: the Truffle Thief (full stage only)
// =========================================================================================
let amber: string | null = null;
if (stage === "full") {
  atTime("07:12");
  const ah = svc.openIncident(A, {
    title: "Truffle Thief: invoice phish and recipe theft",
    priority: "P2",
    detected_at: at("07:12"),
    compliance: ["nis2", "gdpr"],
    meeting_schedule: { cadence_minutes: 60, next_at: at("08:00"), channel_name: "IR - Amber Heron", join_url: "https://teams.example/meet/amber-heron", chair: "analyst-a" },
  }, { codename: "Amber Heron" });
  amber = ah.id;
  const id = ah.id;

  // analyst-b: email and identity
  atTime("07:20");
  svc.connect(B, { query: "Amber Heron" });
  const a881 = art(B, id, "ALRT-881.json", "alert");
  const b1 = svc.addEvents(B, { incident: id, items: [
    { type: "timeline", time: "2026-11-14T06:41:37Z", description: "Phishing mail \"Golden Pod Cocoa Traders invoice 7731 - overdue\" delivered to the finance clerk", source: "ALRT-881", actor: "billing@goldenpod-invoices.test", phase: "Initial access", source_artifact: a881 },
    { type: "timeline", time: "2026-11-14T06:58:11Z", description: "Clerk clicks the fake invoice link to goldenpod-invoices.test", source: "ALRT-881", actor: "clerk@bittersweet.example", phase: "Initial access", source_artifact: a881 },
    { type: "ioc", value: "goldenpod-invoices[.]test", verdict: "malicious", external: true, source: "ALRT-881", source_artifact: a881 },
    { type: "ioc", value: "hxxps://goldenpod-invoices[.]test/inv/7731", verdict: "malicious", external: true, source: "ALRT-881", source_artifact: a881 },
    { type: "ioc", value: "billing[@]goldenpod-invoices.test", verdict: "malicious", external: true, source: "ALRT-881", source_artifact: a881 },
    { type: "ioc", value: "198.51.100.23", verdict: "suspicious", external: true, source: "ALRT-881", source_artifact: a881 },
    { type: "asset", host: "FIN-LT-042", user: "clerk@bittersweet.example", owner: "Finance", state: "compromised" },
    { type: "ttp", technique_id: "T1566.002", name: "Phishing: spearphishing link" },
  ] });

  atTime("07:30");
  const a884 = art(B, id, "ALRT-884.json", "alert");
  const a890 = art(B, id, "ALRT-890.json", "alert");
  const b2 = svc.addEvents(B, { incident: id, items: [
    { type: "timeline", time: "2026-11-14T07:03:22Z", description: "Clerk consents to unverified OAuth app \"CocoaInvoice Sync\" with Mail.ReadWrite and Mail.Send", source: "ALRT-884", actor: "clerk@bittersweet.example", phase: "Persistence", source_artifact: a884 },
    { type: "timeline", time: "2026-11-14T07:09:48Z", description: "App creates inbox rule forwarding mail with \"invoice\" or \"bank details\" to ledger-copy@truffle-mail.test", source: "ALRT-890", actor: "CocoaInvoice Sync", phase: "Collection", source_artifact: a890 },
    { type: "ioc", value: "ledger-copy@truffle-mail.test", verdict: "malicious", external: true, source: "ALRT-890", source_artifact: a890 },
    { type: "ioc", value: "192.0.2.14", verdict: "malicious", external: true, source: "ALRT-884", source_artifact: a884 },
    { type: "ttp", technique_id: "T1528", name: "Steal application access token" },
    { type: "ttp", technique_id: "T1114.003", name: "Email forwarding rule" },
    { type: "note", text: "OAuth app id 11111111-2222-3333-4444-555555555555, publisher not verified, reply URL on goldenpod-invoices.test." },
  ] });

  atTime("07:35");
  svc.setEngagement(B, { incident: id, team_id: "detection-eng", request_type: "detection_rule", status: "requested", recommendations: [{
    kind: "detection_rule",
    title: "Inbox rule forwarding invoices externally",
    rationale: "An attacker-controlled app created a rule forwarding invoice and bank-detail mail outside the company. Nothing alerted on the rule itself until the app alert fired.",
    evidence: [b2.results[1].event_id!],
    draft: { language: "kql", query: "OfficeActivity\n| where Operation in (\"New-InboxRule\", \"Set-InboxRule\")\n| where Parameters has_any (\"ForwardTo\", \"RedirectTo\", \"ForwardAsAttachmentTo\")\n| where Parameters has_any (\"invoice\", \"bank\", \"payment\")\n| project TimeGenerated, UserId, ClientIP, Parameters" },
    mitre: ["T1114.003"],
  }] });

  // first incident meeting
  atTime("08:00");
  const m1 = svc.recordMeeting(A, {
    started_at: at("08:00"),
    attendees: ["analyst-a", "analyst-b", "analyst-c", "analyst-d"],
    notes: "Scope: one finance mailbox so far. Check whether the token was used elsewhere.",
    actions: [
      { assignee: "analyst-b", title: "Revoke CocoaInvoice Sync for the clerk" },
      { assignee: "analyst-c", title: "Isolate RND-LT-007 (chocolatier laptop)" },
      { assignee: "analyst-d", title: "Pull proxy logs for goldenpod and anything new from finance and R&D" },
    ],
  });

  // analyst-c: endpoint
  atTime("08:30");
  svc.connect(C, { query: "amber heron" });
  const e21 = art(C, id, "EDR-5521.json", "alert");
  const e27 = art(C, id, "EDR-5527.json", "alert");
  const c1 = svc.addEvents(C, { incident: id, items: [
    { type: "timeline", time: "2026-11-14T07:41:15Z", description: "Clerk's stolen token used on RND-LT-007, the R&D chocolatier laptop syncing the Recipe Vault", source: "EDR-5521", actor: "192.0.2.14", phase: "Lateral movement", source_artifact: e21 },
    { type: "timeline", time: "2026-11-14T07:30:00Z", description: "Attacker probably browsed the Recipe Vault site before syncing it", source: "EDR-5521", phase: "Collection", confidence: 70, source_artifact: e21 },
    { type: "timeline", time: "2026-11-14T08:15:02Z", description: "recipe_no7.zip (48 MB, label \"Bittersweet Secret - Recipes\") created in the vault sync folder", source: "EDR-5527", actor: "7z.exe", phase: "Collection", source_artifact: e27 },
    { type: "ioc", value: "9f2c7d1e6a4b8c03f5e2d17a9b6c4e81d0f3a2b5c7e9d1f4a6b8c0e2d4f6b04a", verdict: "suspicious", source: "EDR-5527", source_artifact: e27 },
    { type: "asset", host: "RND-LT-007", user: "chocolatier@bittersweet.example", owner: "R&D", state: "compromised" },
    { type: "asset", host: "Recipe Vault (SharePoint)", owner: "R&D", state: "compromised" },
    { type: "ttp", technique_id: "T1560.001", name: "Archive via utility" },
  ] });

  // analyst-d: network, exfil, and the correlation with Quiet Lynx
  atTime("08:40");
  svc.connect(D, { query: id });
  const px = art(D, id, "PROXY-77120.log", "log");
  svc.addEvents(D, { incident: id, items: [
    { type: "timeline", time: "2026-11-14T09:22:05+01:00", description: "48 MB upload from RND-LT-007 to truffle-cdn.test (203.0.113.66)", source: "PROXY-77120", actor: "RND-LT-007", phase: "Exfiltration", source_artifact: px },
    { type: "ioc", value: "truffle-cdn.test", verdict: "malicious", external: true, source: "PROXY-77120", source_artifact: px },
    { type: "ioc", value: "203.0.113.66", verdict: "malicious", external: true, source: "PROXY-77120", source_artifact: px },
    { type: "ioc", value: "goldenpod-invoices.test", source: "PROXY-77101", source_artifact: px },
    { type: "ttp", technique_id: "T1567", name: "Exfiltration over web service" },
  ] });

  // lead: link the flag, raise to P1
  atTime("08:45");
  const flag = svc.store.state(id).flags[0];
  if (flag) svc.resolveCorrelation(A, { incident: id, flag_id: flag.flag_id, decision: "linked" });
  svc.updateField(A, { incident: id, field: "priority", value: "P1", expected_seq: seqOf(id) });

  atTime("08:50");
  svc.setEngagement(D, { incident: id, team_id: "ctic", request_type: "enrichment", status: "requested", reason: "Enrich truffle-cdn.test, goldenpod-invoices.test and 203.0.113.66; link to Quiet Lynx" });
  atTime("08:55");
  svc.setEngagement(C, { incident: id, team_id: "vuln-mgmt", request_type: "asset_exposure", status: "requested", reason: "Exposure of RND-LT-007 and FIN-LT-042" });

  // second meeting: outcomes for two actions, isolation not reviewed -> carried over
  atTime("09:00");
  const t = (title: string) => m1.new_actions.find((x) => x.title.startsWith(title))!.task_id;
  svc.recordMeeting(A, {
    started_at: at("09:00"),
    attendees: ["analyst-a", "analyst-b", "analyst-d", "manager"],
    notes: "Recipe No. 7 confirmed exfiltrated. Raised to P1. Linked to Quiet Lynx via 203.0.113.66. Finance warned about bank-change requests.",
    outcomes: [
      { task_id: t("Revoke CocoaInvoice Sync"), status: "done", outcome: "Revoked for the clerk; tenant-wide check still needed" },
      { task_id: t("Pull proxy logs"), status: "done", outcome: "Found the 48 MB upload to truffle-cdn.test" },
    ],
    actions: [
      { assignee: "analyst-b", title: "Revoke CocoaInvoice Sync tenant-wide" },
      { assignee: "analyst-d", title: "Block truffle-cdn.test and goldenpod-invoices.test at the proxy" },
      { assignee: "manager", title: "Warn Golden Pod about the fake bank-change request" },
      { assignee: "engineer", title: "Ship detection for OAuth consent to unverified apps" },
    ],
  });

  // The Teams meeting bot was in the 09:00 meeting. It heard two things worth adding from people
  // who do not use Claude, and suggests them for review.
  const BOT = person("teams-bot");
  atTime("09:02");
  svc.propose(BOT, {
    incident: id,
    source: "teams-meeting",
    from: "Finance controller",
    context: "Incident meeting 09:00",
    quote: "We paid Golden Pod invoice 7724 last week to the usual account. Nothing has gone out to new bank details.",
    summary: "No payment has gone to new bank details",
    items: [{ type: "note", text: "Finance controller: invoice 7724 to Golden Pod was paid last week to the usual account; no payment to new bank details so far." }],
  });
  svc.propose(BOT, {
    incident: id,
    source: "teams-meeting",
    from: "Plant manager (Trondheim)",
    context: "Incident meeting 09:00",
    quote: "That R&D laptop was plugged into one of our line PCs in Trondheim on Thursday, for the new praline mould settings.",
    summary: "R&D laptop was connected to a Trondheim factory line PC on Thursday",
    items: [
      { type: "asset", host: "TRD-LINE-PC-04", owner: "Trondheim factory", state: "suspected" },
      { type: "timeline", time: "2026-11-12T13:00:00Z", description: "RND-LT-007 connected to Trondheim line PC TRD-LINE-PC-04 (mould settings)", phase: "Lateral movement", confidence: 60 },
    ],
  });
  atTime("09:04");
  const financeTip = svc.store.state(id).proposals.find((p) => p.from === "Finance controller")!;
  svc.decideProposal(A, { incident: id, proposal_id: financeTip.proposal_id, decision: "accepted" });

  // analyst-b told Golden Pod's real security team at 08:58 and logs it now
  atTime("09:06");
  svc.addEvents(B, { incident: id, items: [
    { type: "correspondence", direction: "outbound", party: "supplier", from: "soc@bittersweet.example", to: ["security@goldenpod.example"], subject: "Invoices sent in your name from goldenpod-invoices.test", sent_at: "2026-11-14T08:58:00Z", summary: "Warned Golden Pod that a look-alike domain sends fake invoices and bank-change requests; asked them to confirm their real domain." },
  ] });

  atTime("09:05");
  svc.addEvents(B, { incident: id, items: [
    { type: "timeline", time: "2026-11-14T09:05:00Z", description: "CocoaInvoice Sync consent revoked for the clerk; inbox rule removed", source: "Manual", phase: "Containment" },
  ] });

  atTime("09:10");
  svc.setEngagement(B, { incident: id, team_id: "detection-eng", request_type: "detection_rule", status: "requested", recommendations: [{
    kind: "detection_rule",
    title: "OAuth consent to an unverified app with Mail.ReadWrite",
    rationale: "The Truffle Thief got in through one consent to \"CocoaInvoice Sync\". No rule fired on the consent itself; we caught it only from the phishing alert.",
    evidence: [b1.results[1].event_id!, b2.results[0].event_id!],
    draft: { language: "kql", query: "AuditLogs\n| where OperationName == \"Consent to application\"\n| extend App = tostring(TargetResources[0].displayName)\n| extend Perms = tostring(TargetResources[0].modifiedProperties)\n| where Perms has_any (\"Mail.ReadWrite\", \"Mail.Send\")\n| where tostring(AdditionalDetails) !has \"verifiedPublisher\"\n| project TimeGenerated, InitiatedBy, App, Perms" },
    mitre: ["T1528", "T1550.001"],
  }] });

  // The bot also reads the incident's Teams chat. Treasury (no Claude) mentions something important.
  atTime("09:17");
  svc.propose(BOT, {
    incident: id,
    source: "teams-chat",
    link: "https://teams.example/l/message/ir-amber-heron/1731575820",
    from: "Treasury (Oslo)",
    context: "Teams chat: IR - Amber Heron",
    quote: "FYI our bank just called. Someone tried to add a new payee 'Golden Pod Cocoa Traders Ltd' with a foreign IBAN to our account at 09:12. They blocked it and want us to confirm.",
    summary: "Bank blocked an attempt to add a fake Golden Pod payee at 09:12",
    items: [
      { type: "timeline", time: "2026-11-14T09:12:00Z", description: "Attempt to add new payee \"Golden Pod Cocoa Traders Ltd\" with a foreign IBAN to the company bank account; blocked by the bank", source: "Bank call (Treasury)", phase: "Impact", confidence: 90 },
      { type: "task", title: "Confirm with the bank that the new payee was not authorised", assignee: "manager" },
    ],
  });

  atTime("09:20");
  svc.setEngagement(CTI, { incident: id, team_id: "ctic", engagement_id: svc.store.state(id).engagements.find((g) => g.team_id === "ctic")!.engagement_id, status: "engaged" });
  svc.setEngagement(C, { incident: id, team_id: "detection-eng", request_type: "dashboard", status: "requested", recommendations: [{
    kind: "dashboard",
    title: "Recipe Vault access dashboard",
    rationale: "recipe_no7.zip was staged from the Recipe Vault sync folder. Leadership wants to see who touches the vault and how much leaves it, per day.",
    evidence: [c1.results[2].event_id!],
    draft: { language: "kql", panels: [
      { title: "Vault file access by user, per hour", viz: "timechart", query: "OfficeActivity | where Site_Url has \"/sites/recipe-vault\" | summarize Files = dcount(OfficeObjectId) by UserId, bin(TimeGenerated, 1h)" },
      { title: "Downloads and syncs over 20 files in an hour", viz: "table", query: "OfficeActivity | where Site_Url has \"/sites/recipe-vault\" and Operation in (\"FileDownloaded\", \"FileSyncDownloadedFull\") | summarize n = count() by UserId, bin(TimeGenerated, 1h) | where n > 20" },
      { title: "Vault users signing in from new devices", viz: "table", query: "SigninLogs | where UserPrincipalName in (vault_users) | where DeviceDetail.deviceId !in (known_devices)" },
    ] },
    mitre: ["T1213.002", "T1567"],
  }] });

  atTime("09:25");
  svc.connect(E, { query: id });
  const oauthReq = svc.store.state(id).engagements.find((g) => g.recommendations.some((r) => r.title.startsWith("OAuth consent")))!;
  svc.setEngagement(E, { incident: id, engagement_id: oauthReq.engagement_id, team_id: "detection-eng", status: "engaged" });

  atTime("09:30");
  svc.updateField(A, { incident: id, field: "summary", expected_seq: seqOf(id), value:
    "A finance clerk opened a fake Golden Pod Cocoa Traders invoice and granted the app \"CocoaInvoice Sync\" access to their mailbox. The attacker forwarded invoice mail outside the company, reached the R&D chocolatier's laptop with the stolen token and sent recipe_no7.zip to truffle-cdn.test. The app is revoked for the clerk; the laptop is not yet isolated. The same IP hit the web shop last month (Quiet Lynx)." });

  atTime("09:31");
  const bank = art(B, id, "bank-change-request.eml", "email");
  svc.addEvents(B, { incident: id, items: [
    { type: "timeline", time: "2026-11-14T10:31:00+01:00", description: "Fake \"new bank details\" request for invoice 7731 arrives in finance; caught before payment", source: "Email", actor: "billing@goldenpod-invoices.test", phase: "Impact", source_artifact: bank },
  ] });

  atTime("09:35");
  svc.connect(M, { query: id });
  svc.setComplianceStep(M, { incident: id, track_id: "nis2", step_id: "early-warning", status: "done", evidence: { submission_reference: "CSIRT-2026-1187" } });
  svc.setComplianceStep(M, { incident: id, track_id: "gdpr", step_id: "assess", status: "in_progress" });

  // The NIS2 early warning went out by email; the CSIRT's receipt comes back through the incident mailbox.
  atTime("09:38");
  svc.addEvents(M, { incident: id, items: [
    { type: "correspondence", direction: "outbound", party: "csirt", from: "ciso@bittersweet.example", to: ["intake@csirt.example"], subject: "NIS2 early warning: significant incident at Bittersweet Fjord Chocolate Co.", sent_at: "2026-11-14T09:33:00Z", summary: "Early warning: suspected criminal act, possible impact on payments to suppliers; no cross-border impact known yet.", related_step: "nis2/early-warning" },
    { type: "correspondence", direction: "outbound", party: "legal", from: "manager@bittersweet.example", to: ["counsel@lawfirm.example"], subject: "Privileged: theft of recipe trade secret", sent_at: "2026-11-14T09:20:00Z", summary: "Asked outside counsel whether to report the recipe theft to the police and how to preserve evidence." },
  ] });
  const MAIL = person("mail-connector");
  atTime("09:40");
  const receipt = svc.ingestEmail(MAIL, { incident: id, direction: "inbound", party: "csirt", from: "intake@csirt.example", to: ["ciso@bittersweet.example"], subject: "Receipt CSIRT-2026-1187: early warning received", date: "2026-11-14T09:39:00Z", body: "We confirm receipt of your early warning, reference CSIRT-2026-1187. Please send the incident notification within 72 hours of awareness.", summary: "CSIRT confirms receipt, reference CSIRT-2026-1187; notification due within 72 h." });
  atTime("09:42");
  svc.decideProposal(M, { incident: id, proposal_id: receipt.proposal_id, decision: "accepted" });
  atTime("09:44");
  svc.ingestEmail(MAIL, { incident: id, direction: "inbound", party: "supplier", from: "security@goldenpod.example", to: ["soc@bittersweet.example"], subject: "RE: Invoices sent in your name from goldenpod-invoices.test", date: "2026-11-14T09:43:00Z", body: "Thank you. We did not send invoice 7731 and we have not changed bank details. Our only domain is goldenpod.example. Two other customers reported the same mails this morning.", summary: "Golden Pod confirms the invoice and bank change are fake; two other customers hit too." });

  atTime("09:45");
  const inboxReq = svc.store.state(id).engagements.find((g) => g.recommendations.some((r) => r.title.startsWith("Inbox rule")))!;
  svc.setEngagement(E, { incident: id, engagement_id: inboxReq.engagement_id, team_id: "detection-eng", status: "delivered", outcome: "Rule DET-1042 \"Inbox rule forwarding finance mail externally\" deployed to Sentinel" });

  // the analyst raises confidence once the vault audit log confirms browsing
  atTime("09:47");
  const browse = svc.store.state(id).timeline.find((x) => x.description.startsWith("Attacker probably browsed"))!;
  svc.updateItem(C, { incident: id, kind: "timeline", item_id: browse.event_id, changes: { confidence: 90, reason: "SharePoint audit shows folder views at 07:28-07:33 from the clerk's token" } });
}

svc.flushRenders();
svc.renderAll();

const sample = value("sample");
if (sample && amber) {
  const target = resolve(process.cwd(), sample);
  copyFileSync(svc.reportPath(amber), target);
  console.log(`Sample report written to ${target}`);
}

console.log(`\nDemo data seeded (${stage} stage) in ${cfg.dataDir}`);
for (const r of svc.listIncidents({}).incidents) {
  console.log(`  ${r.codename.padEnd(13)} ${r.id}  ${r.priority}  ${r.status.padEnd(8)}  ${r.title}`);
}
console.log(`\nStart the server in demo mode: npm run demo:start  (clock starts at ${cfg.settings.demo.anchor ?? "now"})`);
