// The write path. Every change to a case goes through Store.append or Store.createIncident.
//
// Ordering: node:sqlite is synchronous, so inside this process each append runs start-to-finish
// without interleaving: that is the per-incident write queue. BEGIN IMMEDIATE adds a database
// write lock, so even a second daemon on the same file cannot interleave sequence numbers.
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import { tx } from "./db.js";
import type { Draft, StoredEvent, EventType } from "./events.js";
import { foldEvents, type CaseState } from "./fold.js";
import { defang } from "./normalize.js";
import { AppError, iso, priorityRank, slugify, ulid, type Clock } from "./util.js";

export interface WriteCtx {
  author: string;
  session_id?: string | null;
  idempotency_key?: string;
  /** For non-append edits: reject if any draft's target changed after this seq. */
  expected_seq?: number;
}

export interface AppendResult {
  incident_id: string;
  events: StoredEvent[];
  /** Events the server added on its own (correlation flags, suggested engagements). */
  derived: StoredEvent[];
  replayed: boolean;
  seq: number;
}

const SYSTEM = "incident-mcp";

export class Store extends EventEmitter {
  private cache = new Map<string, CaseState>();

  constructor(
    readonly db: DatabaseSync,
    readonly cfg: Config,
    readonly clock: Clock,
  ) {
    super();
  }

  now() {
    return iso(this.clock.now());
  }

  // ---------- reads ----------

  incidentRow(id: string): any | undefined {
    return this.db.prepare("SELECT * FROM incidents WHERE id = ?").get(id);
  }

  listIncidentRows(): any[] {
    return this.db.prepare("SELECT * FROM incidents ORDER BY opened_at DESC").all();
  }

  events(incidentId: string, sinceSeq = 0): StoredEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE incident_id = ? AND seq > ? ORDER BY seq")
      .all(incidentId, sinceSeq)
      .map(rowToEvent);
  }

  event(id: string): StoredEvent | undefined {
    const r = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id);
    return r ? rowToEvent(r) : undefined;
  }

  state(incidentId: string): CaseState {
    const row = this.incidentRow(incidentId);
    if (!row) throw new AppError("not_found", `No incident ${incidentId}`);
    const hit = this.cache.get(incidentId);
    if (hit && hit.incident.seq === row.seq) return hit;
    const st = foldEvents(this.events(incidentId));
    this.cache.set(incidentId, st);
    return st;
  }

  // ---------- create ----------

  createIncident(
    input: { title: string; priority: string; template: string; detected_at: string; lead?: string | null; codename?: string },
    extra: (incidentId: string) => Draft[],
    ctx: WriteCtx,
  ): AppendResult {
    if (ctx.idempotency_key) {
      const prev = this.db
        .prepare("SELECT incident_id FROM events WHERE idempotency_key = ? AND type = 'incident.opened'")
        .get(ctx.idempotency_key) as { incident_id: string } | undefined;
      if (prev) return this.replay(prev.incident_id, ctx.idempotency_key);
    }
    const result = this.guarded(() => tx(this.db, () => {
      const now = this.now();
      const year = this.clock.now().getUTCFullYear();
      const counter = this.db.prepare("SELECT last_number FROM counters WHERE year = ?").get(year) as
        | { last_number: number }
        | undefined;
      const number = (counter?.last_number ?? 0) + 1;
      this.db
        .prepare("INSERT INTO counters (year, last_number) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET last_number = excluded.last_number")
        .run(year, number);
      const id = `INC-${year}-${String(number).padStart(4, "0")}`;
      // A fixed codename is only used by the demo seed; normal incidents draw one.
      const codename = input.codename ?? this.drawCodename();
      if (input.codename && this.db.prepare("SELECT 1 FROM incidents WHERE codename = ?").get(input.codename)) {
        throw new AppError("invalid", `Codename "${input.codename}" is already in use.`);
      }
      this.db
        .prepare(
          `INSERT INTO incidents (id, year, number, codename, codename_slug, title, priority, status, lead, template,
             detected_at, opened_at, opened_by, seq, last_activity)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(id, year, number, codename, slugify(codename), input.title, input.priority, input.lead ?? ctx.author,
          input.template, input.detected_at, now, ctx.author, now);
      const opened: Draft = {
        type: "incident.opened",
        payload: { id, codename, title: input.title, priority: input.priority, template: input.template, detected_at: input.detected_at, lead: input.lead ?? ctx.author },
      };
      return this.appendInTx(id, [opened, ...extra(id)], ctx);
    }));
    this.afterCommit(result);
    return result;
  }

  private drawCodename(): string {
    const { adjectives, nouns } = this.cfg.codenames;
    const cutoff = iso(this.clock.now().getTime() - 90 * 86_400_000);
    const used = new Set(
      (this.db
        .prepare("SELECT codename FROM incidents WHERE status != 'Closed' OR opened_at >= ?")
        .all(cutoff) as { codename: string }[]).map((r) => r.codename),
    );
    for (let i = 0; i < 500; i++) {
      const c = `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
      if (!used.has(c)) return c;
    }
    // Word lists exhausted: fall back to a numbered name rather than failing.
    return `${adjectives[0]} ${nouns[0]} ${used.size + 1}`;
  }

  // ---------- append ----------

  append(incidentId: string, drafts: Draft[], ctx: WriteCtx): AppendResult {
    if (!this.incidentRow(incidentId)) throw new AppError("not_found", `No incident ${incidentId}`);
    if (ctx.idempotency_key) {
      const hit = this.db
        .prepare("SELECT 1 FROM events WHERE incident_id = ? AND idempotency_key = ?")
        .get(incidentId, ctx.idempotency_key);
      if (hit) return this.replay(incidentId, ctx.idempotency_key);
    }
    const result = this.guarded(() => tx(this.db, () => this.appendInTx(incidentId, drafts, ctx)));
    this.afterCommit(result);
    return result;
  }

  private replay(incidentId: string, key: string): AppendResult {
    const events = this.db
      .prepare(
        "SELECT * FROM events WHERE incident_id = ? AND (idempotency_key = ? OR substr(idempotency_key, 1, ?) = ?) ORDER BY seq",
      )
      .all(incidentId, key, key.length + 1, key + "#")
      .map(rowToEvent);
    const primary = events.filter((e) => !/#d\d+$/.test(e.idempotency_key));
    const derived = events.filter((e) => /#d\d+$/.test(e.idempotency_key));
    return { incident_id: incidentId, events: primary, derived, replayed: true, seq: this.incidentRow(incidentId).seq };
  }

  private appendInTx(incidentId: string, drafts: Draft[], ctx: WriteCtx): AppendResult {
    if (ctx.expected_seq !== undefined) {
      for (const d of drafts) {
        if (!d.target) continue;
        const r = this.db
          .prepare("SELECT MAX(seq) AS s FROM events WHERE incident_id = ? AND target = ?")
          .get(incidentId, d.target) as { s: number | null };
        if (r.s !== null && r.s > ctx.expected_seq) {
          throw new AppError("conflict", `${d.target} was changed by someone else (at seq ${r.s}) after seq ${ctx.expected_seq}.`, {
            target: d.target,
            latest_seq: r.s,
          });
        }
      }
    }
    const key = ctx.idempotency_key ?? `auto-${ulid()}`;
    const events = this.insert(incidentId, drafts, ctx, (i) => (i === 0 ? key : `${key}#${i}`));
    const derived = this.derive(incidentId, events, key);
    const seq = this.refreshIncidentRow(incidentId);
    return { incident_id: incidentId, events, derived, replayed: false, seq };
  }

  private insert(incidentId: string, drafts: Draft[], ctx: WriteCtx, keyFor: (i: number) => string): StoredEvent[] {
    if (!drafts.length) return [];
    const row = this.db.prepare("SELECT seq FROM incidents WHERE id = ?").get(incidentId) as { seq: number };
    let seq = row.seq;
    const now = this.now();
    const ins = this.db.prepare(
      `INSERT INTO events (id, incident_id, seq, type, payload_json, author, session_id, source_artifact,
         idempotency_key, created_at, supersedes, target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const out: StoredEvent[] = [];
    drafts.forEach((d, i) => {
      const e: StoredEvent = {
        id: d.id ?? ulid(),
        incident_id: incidentId,
        seq: ++seq,
        type: d.type,
        payload: d.payload,
        author: ctx.author,
        session_id: ctx.session_id ?? null,
        source_artifact: d.source_artifact ?? null,
        idempotency_key: keyFor(i),
        created_at: now,
        supersedes: d.supersedes ?? null,
        target: d.target ?? null,
      };
      ins.run(e.id, e.incident_id, e.seq, e.type, JSON.stringify(e.payload), e.author, e.session_id,
        e.source_artifact, e.idempotency_key, e.created_at, e.supersedes, e.target);
      out.push(e);
    });
    this.db.prepare("UPDATE incidents SET seq = ?, last_activity = ? WHERE id = ?").run(seq, now, incidentId);
    return out;
  }

  /** Re-folds and refreshes the incidents row (the list-page cache). Returns the new seq. */
  private refreshIncidentRow(incidentId: string): number {
    this.cache.delete(incidentId);
    const st = this.state(incidentId);
    const i = st.incident;
    this.db
      .prepare("UPDATE incidents SET title = ?, priority = ?, status = ?, lead = ?, detected_at = ?, last_activity = ? WHERE id = ?")
      .run(i.title, i.priority, i.status, i.lead, i.detected_at, i.last_activity, incidentId);
    return i.seq;
  }

  // ---------- server-derived events (same transaction) ----------

  private derive(incidentId: string, events: StoredEvent[], key: string): StoredEvent[] {
    const sys: WriteCtx = { author: SYSTEM };
    const derived: StoredEvent[] = [];
    let n = 0;
    const own = (drafts: Draft[]) => {
      const evs = this.insert(incidentId, drafts, sys, () => `${key}#d${n++}`);
      derived.push(...evs);
    };

    for (const e of events) {
      // --- correlation indexes + flags ---
      if (e.type === "ioc.added") {
        const matches = this.db
          .prepare(
            `SELECT DISTINCT i.incident_id AS id FROM iocs_index i JOIN incidents x ON x.id = i.incident_id
             WHERE i.type = ? AND i.value_norm = ? AND i.incident_id != ? AND x.opened_at >= ?`,
          )
          .all(e.payload.type, e.payload.value, incidentId, iso(this.clock.now().getTime() - 180 * 86_400_000)) as { id: string }[];
        this.db
          .prepare("INSERT INTO iocs_index (type, value_norm, incident_id, event_id, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(e.payload.type, e.payload.value, incidentId, e.id, e.created_at);
        for (const m of matches) this.flagPair(incidentId, m.id, "ioc_exact", `${e.payload.type} ${e.payload.value}`, own);
      }
      if (e.type === "asset.added") {
        for (const kind of ["host", "user"] as const) {
          const v = e.payload[kind];
          if (!v) continue;
          const norm = String(v).toLowerCase();
          const matches = this.db
            .prepare(
              `SELECT DISTINCT a.incident_id AS id FROM assets_index a JOIN incidents x ON x.id = a.incident_id
               WHERE a.kind = ? AND a.value_norm = ? AND a.incident_id != ? AND x.status != 'Closed'`,
            )
            .all(kind, norm, incidentId) as { id: string }[];
          this.db.prepare("INSERT INTO assets_index (kind, value_norm, incident_id, event_id) VALUES (?, ?, ?, ?)").run(kind, norm, incidentId, e.id);
          for (const m of matches) this.flagPair(incidentId, m.id, `shared_${kind}`, norm, own);
        }
      }
    }

    // --- engagement suggestions from teams.yml suggest_when ---
    const triggers = events.flatMap((e) => triggerNames(e).map((name) => ({ name, e })));
    if (triggers.length) {
      this.cache.delete(incidentId);
      const st = this.state(incidentId);
      const suggested = new Set<string>();
      for (const team of this.cfg.teams.teams) {
        if (st.engagements.some((g) => g.team_id === team.id)) continue; // one suggestion per team
        for (const rule of team.suggest_when) {
          const hit = triggers.find((t) => t.name === rule.event && conditionHolds(rule.condition, t.e, st.incident.priority));
          if (hit && !suggested.has(team.id)) {
            suggested.add(team.id);
            own([
              {
                type: "engagement.updated",
                payload: {
                  engagement_id: ulid(),
                  team_id: team.id,
                  status: "suggested",
                  reason: `Suggested by rule "${rule.event}${rule.condition ? ` when ${rule.condition}` : ""}" after: ${shortLabel(hit.e)}`,
                  trigger_event: hit.e.id,
                },
              },
            ]);
          }
        }
      }
    }
    return derived;
  }

  private flagPair(
    incidentId: string,
    otherId: string,
    kind: string,
    value: string,
    own: (d: Draft[]) => void,
  ) {
    const [a, b] = [incidentId, otherId].sort();
    const exists = this.db
      .prepare("SELECT 1 FROM correlation_pairs WHERE incident_a = ? AND incident_b = ? AND kind = ? AND value = ?")
      .get(a, b, kind, value);
    if (exists) return;
    const pair_id = `pair_${ulid()}`;
    this.db
      .prepare("INSERT INTO correlation_pairs (pair_id, incident_a, incident_b, kind, value) VALUES (?, ?, ?, ?, ?)")
      .run(pair_id, a, b, kind, value);
    const here = this.incidentRow(incidentId);
    const there = this.incidentRow(otherId);
    own([{ type: "correlation.flagged", payload: { pair_id, other_incident_id: otherId, other_codename: there.codename, kind, value } }]);
    // Mirror flag in the other incident, with its own sequence number.
    const mirrored = this.insert(otherId, [
      { type: "correlation.flagged", payload: { pair_id, other_incident_id: incidentId, other_codename: here.codename, kind, value } },
    ], { author: SYSTEM }, () => `corr:${pair_id}`);
    this.refreshIncidentRow(otherId);
    this.pendingOther.push({ incident_id: otherId, events: mirrored });
  }

  private pendingOther: { incident_id: string; events: StoredEvent[] }[] = [];

  /** Drops cross-incident notifications queued by a transaction that rolled back. */
  private guarded<T>(fn: () => T): T {
    this.pendingOther.length = 0;
    try {
      return fn();
    } catch (e) {
      for (const o of this.pendingOther.splice(0)) this.cache.delete(o.incident_id);
      throw e;
    }
  }

  private afterCommit(r: AppendResult) {
    if (!r.replayed) this.emit("committed", { incident_id: r.incident_id, events: [...r.events, ...r.derived] });
    for (const o of this.pendingOther.splice(0)) {
      this.cache.delete(o.incident_id);
      this.emit("committed", o);
    }
  }

  // ---------- sessions & seen ----------

  lastSeen(author: string, incidentId: string): number {
    const r = this.db.prepare("SELECT last_seen_seq FROM seen WHERE author = ? AND incident_id = ?").get(author, incidentId) as
      | { last_seen_seq: number }
      | undefined;
    return r?.last_seen_seq ?? 0;
  }

  markSeen(author: string, incidentId: string, seq: number) {
    this.db
      .prepare(
        `INSERT INTO seen (author, incident_id, last_seen_seq) VALUES (?, ?, ?)
         ON CONFLICT(author, incident_id) DO UPDATE SET last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq)`,
      )
      .run(author, incidentId, seq);
  }
}

function rowToEvent(r: any): StoredEvent {
  return {
    id: r.id,
    incident_id: r.incident_id,
    seq: r.seq,
    type: r.type as EventType,
    payload: JSON.parse(r.payload_json),
    author: r.author,
    session_id: r.session_id,
    source_artifact: r.source_artifact,
    idempotency_key: r.idempotency_key,
    created_at: r.created_at,
    supersedes: r.supersedes,
    target: r.target,
  };
}

/** Maps a stored event to the trigger names used in teams.yml. */
function triggerNames(e: StoredEvent): string[] {
  if (e.type === "field.changed") return e.payload.field === "priority" ? ["priority.changed"] : [];
  if (e.type === "incident.opened") return ["priority.changed"];
  if (["ioc.added", "ttp.added", "cve.added", "asset.added", "task.added"].includes(e.type)) return [e.type];
  return [];
}

/** POC condition language: `field == value`, `priority >= P2`, `external == true`, `no_matching_rule`. */
export function conditionHolds(cond: string | undefined, e: StoredEvent, currentPriority: string): boolean {
  if (!cond) return true;
  const c = cond.trim();
  if (c === "no_matching_rule") return true; // real check needs a SIEM MCP
  const m = /^(\w+)\s*(==|>=)\s*(\S+)$/.exec(c);
  if (!m) return false;
  const [, field, op, raw] = m;
  if (field === "priority") {
    const p = e.type === "field.changed" ? e.payload.new : e.type === "incident.opened" ? e.payload.priority : currentPriority;
    return op === ">=" ? priorityRank(p) >= priorityRank(raw) : p === raw;
  }
  const v = e.payload[field];
  const want = raw === "true" ? true : raw === "false" ? false : raw;
  return op === "==" ? v === want || String(v) === raw : Number(v) >= Number(raw);
}

function shortLabel(e: StoredEvent): string {
  const p = e.payload;
  switch (e.type) {
    case "ioc.added":
      return `IOC ${p.type} ${defang(p.type, p.value)}`;
    case "asset.added":
      return `asset ${p.host ?? p.user}`;
    case "ttp.added":
      return `technique ${p.technique_id}`;
    case "cve.added":
      return `${p.cve_id}`;
    case "field.changed":
      return `priority set to ${p.new}`;
    case "incident.opened":
      return `opened at ${p.priority}`;
    default:
      return e.type;
  }
}
