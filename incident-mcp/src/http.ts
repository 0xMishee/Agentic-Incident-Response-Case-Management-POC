// HTTP: MCP Streamable HTTP on /mcp (Claude sessions), JSON REST on /api (portal, SIEM connector),
// and server-sent events for live updates.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localhostHostValidation, hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp.js";
import { ROLES, type Actor, type CaseService, type Role } from "./service.js";
import { describe, type StoredEvent } from "./events.js";
import { AppError, HTTP_STATUS } from "./util.js";

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() && !/^\$\{.*\}$/.test(s.trim()) ? s.trim() : undefined; // ignore unexpanded ${VAR}
}

export function actorFromRequest(req: Request, session_id: string | null): Actor {
  const role = (header(req, "x-analyst-role") ?? "analyst").toLowerCase();
  return {
    author: header(req, "x-analyst-name") ?? header(req, "x-analyst") ?? "unknown-analyst",
    role: (ROLES as readonly string[]).includes(role) ? (role as Role) : "analyst",
    team: header(req, "x-analyst-team") ?? null,
    session_id,
  };
}

export function createApp(svc: CaseService, opts: { host?: string } = {}) {
  const app = express();
  const host = opts.host ?? "127.0.0.1";
  app.use(["127.0.0.1", "localhost", "::1"].includes(host) ? localhostHostValidation() : hostHeaderValidation([host, "localhost", "127.0.0.1"]));
  app.use(express.json({ limit: "15mb" }));

  // CORS for the local portal dev server (Vite etc. on another localhost port).
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-analyst, x-analyst-name, x-analyst-role, x-analyst-team");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  // ---------------- MCP ----------------
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req, res) => {
    const sid = header(req, "mcp-session-id");
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      if (sid) {
        // Unknown session (e.g. daemon restarted): 404 tells the client to start a new session.
        return void res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found. Reconnect." }, id: null });
      }
      if (!isInitializeRequest(req.body)) {
        return void res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Send an initialize request first." }, id: null });
      }
      const actor = actorFromRequest(req, null);
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, t);
          actor.session_id = id;
          svc.registerSession(actor);
        },
      });
      t.onclose = () => {
        if (t.sessionId) transports.delete(t.sessionId);
      };
      await createMcpServer(svc, actor).connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const sid = header(req, "mcp-session-id");
    const t = sid ? transports.get(sid) : undefined;
    if (!t) return void res.status(sid ? 404 : 400).send("Unknown or missing mcp-session-id");
    await t.handleRequest(req, res);
  };
  app.get("/mcp", sessionRequest);
  app.delete("/mcp", sessionRequest);

  // ---------------- REST ----------------
  const actor = (req: Request): Actor => ({ ...actorFromRequest(req, null), session_id: "portal" });
  const withIncident = (req: Request) => ({ ...req.body, incident: req.params.id });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, server_time: new Date(svc.clock.now()).toISOString(), mcp_sessions: transports.size });
  });
  app.get("/api/config", (_req, res) => {
    res.json({
      templates: [...svc.cfg.templates.values()],
      tracks: [...svc.cfg.tracks.values()],
      teams: svc.cfg.teams,
      demo: svc.cfg.settings.demo,
      portal: { celebration_sound: svc.cfg.settings.portal.celebration_sound ? "/api/sound" : null },
      warnings: svc.cfg.warnings,
    });
  });
  // The team's own "incident resolved" sound (config/sounds/, git-ignored). 404 when none is set.
  app.get("/api/sound", (_req, res) => {
    const rel = svc.cfg.settings.portal.celebration_sound;
    if (!rel) return void res.sendStatus(404);
    const file = resolve(svc.cfg.rootDir, rel);
    if (!file.startsWith(resolve(svc.cfg.rootDir, "config", "sounds")) || !existsSync(file)) return void res.sendStatus(404);
    res.sendFile(file);
  });

  app.get("/api/incidents", (req, res) => {
    res.json(svc.listIncidents({ status: req.query.status as any, limit: req.query.limit ? Number(req.query.limit) : undefined }));
  });
  app.post("/api/incidents", (req, res) => {
    res.status(201).json(svc.openIncident(actor(req), req.body));
  });
  app.get("/api/incidents/:id", (req, res) => {
    res.json(svc.caseView(req.params.id));
  });
  app.get("/api/incidents/:id/report.md", (req, res) => {
    res.type("text/markdown").send(svc.getReport(actor(req), { incident: req.params.id }).markdown);
  });
  app.get("/api/incidents/:id/status", (req, res) => {
    res.json(svc.getStatus(actor(req), { incident: req.params.id }));
  });
  app.get("/api/incidents/:id/events", (req, res) => {
    const id = svc.resolve(req.params.id);
    const since = req.query.since ? Number(req.query.since) : 0;
    res.json({ events: svc.store.events(id, since).map((e) => ({ ...e, summary: describe(e) })) });
  });
  app.post("/api/incidents/:id/artifacts", (req, res) => {
    res.status(201).json(svc.addArtifact(actor(req), withIncident(req)));
  });
  app.get("/api/incidents/:id/artifacts/:artifact", (req, res) => {
    const { meta, content } = svc.artifactContent(svc.resolve(req.params.id), req.params.artifact);
    res.setHeader("Content-Disposition", `attachment; filename="${String(meta.filename).replace(/"/g, "")}"`);
    res.type("application/octet-stream").send(content);
  });
  app.post("/api/incidents/:id/events", (req, res) => {
    res.status(201).json(svc.addEvents(actor(req), withIncident(req)));
  });
  app.patch("/api/incidents/:id", (req, res) => {
    res.json(svc.updateField(actor(req), withIncident(req)));
  });
  app.post("/api/incidents/:id/items/:kind/:item", (req, res) => {
    res.json(svc.updateItem(actor(req), { ...withIncident(req), kind: req.params.kind, item_id: req.params.item }));
  });
  app.post("/api/incidents/:id/compliance", (req, res) => {
    res.status(201).json(svc.attachCompliance(actor(req), withIncident(req)));
  });
  app.post("/api/incidents/:id/compliance/:track/:step", (req, res) => {
    res.json(svc.setComplianceStep(actor(req), { ...withIncident(req), track_id: req.params.track, step_id: req.params.step }));
  });
  app.post("/api/incidents/:id/engagements/:team", (req, res) => {
    res.json(svc.setEngagement(actor(req), { ...withIncident(req), team_id: req.params.team }));
  });
  app.post("/api/incidents/:id/correlations/:flag", (req, res) => {
    res.json(svc.resolveCorrelation(actor(req), { ...withIncident(req), flag_id: req.params.flag }));
  });
  app.put("/api/incidents/:id/meetings/schedule", (req, res) => {
    res.json(svc.setMeetingSchedule(actor(req), withIncident(req)));
  });
  app.get("/api/incidents/:id/meetings/brief", (req, res) => {
    res.json(svc.getMeetingBrief(actor(req), { incident: req.params.id }));
  });
  app.post("/api/incidents/:id/meetings", (req, res) => {
    res.status(201).json(svc.recordMeeting(actor(req), withIncident(req)));
  });
  app.post("/api/incidents/:id/meetings/skip", (req, res) => {
    res.status(201).json(svc.skipMeeting(actor(req), withIncident(req)));
  });
  app.get("/api/analysts/:name/summary", (req, res) => {
    res.json(svc.analystSummary(String(req.params.name), req.query.team ? String(req.query.team) : null));
  });
  app.get("/api/teams/:team/queue", (req, res) => {
    res.json(svc.getTeamQueue(actor(req), { team_id: req.params.team }));
  });

  // Suggestions waiting for review: Teams meeting bot, people without Claude (portal form), other connectors.
  app.get("/api/incidents/:id/suggestions", (req, res) => {
    res.json(svc.listProposals(actor(req), { incident: req.params.id }));
  });
  app.post("/api/incidents/:id/suggestions", (req, res) => {
    res.status(201).json(svc.propose(actor(req), withIncident(req)));
  });
  app.post("/api/incidents/:id/suggestions/:pid/decision", (req, res) => {
    res.json(svc.decideProposal(actor(req), { ...withIncident(req), proposal_id: req.params.pid }));
  });
  // Email connector (future: a shared mailbox per incident forwards here).
  app.post("/api/ingest/email", (req, res) => {
    res.status(201).json(svc.ingestEmail({ ...actor(req), author: req.body?.connector ?? "mail-connector" }, req.body));
  });

  // Future SIEM connector contract (docs/FEATURES.md): tagged alerts enter like a pasted alert.
  app.post("/api/ingest/alert", (req, res) => {
    const { incident, source, alert_id, raw } = req.body ?? {};
    if (!incident || !raw) throw new AppError("invalid", "Body needs incident and raw.");
    const a = svc.addArtifact(
      { author: source ?? "siem-connector", role: "analyst", team: null, session_id: "siem" },
      { incident, kind: "alert", filename: `${alert_id ?? "alert"}.json`, content: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2), idempotency_key: alert_id ? `siem:${alert_id}` : undefined },
    );
    res.status(201).json({ ...a, note: "Stored as an artifact. Extraction into the timeline happens in an analyst's Claude session." });
  });

  // ---------------- live stream (SSE) ----------------
  const stream = (filter: string | null) => (req: Request, res: Response) => {
    const id = filter ? svc.resolve(String(req.params.id)) : null;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const onCommit = (msg: { incident_id: string; events: StoredEvent[] }) => {
      if (id && msg.incident_id !== id) return;
      for (const e of msg.events) {
        res.write(`event: case-event\ndata: ${JSON.stringify({ incident_id: msg.incident_id, seq: e.seq, type: e.type, author: e.author, at: e.created_at, summary: describe(e) })}\n\n`);
      }
    };
    svc.store.on("committed", onCommit);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      svc.store.off("committed", onCommit);
    });
  };
  app.get("/api/stream", stream(null));
  app.get("/api/incidents/:id/stream", stream("id"));

  // ---------------- errors ----------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return void res.status(HTTP_STATUS[err.code]).json(err.toJSON());
    if ((err as any)?.type === "entity.too.large") return void res.status(413).json({ error: "invalid", message: "Request body too large." });
    console.error(err);
    res.status(500).json({ error: "internal", message: (err as Error)?.message ?? "Internal error" });
  });

  return { app, transports };
}
