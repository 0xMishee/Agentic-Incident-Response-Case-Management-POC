// Criterion 1: two Claude sessions writing at the same time over MCP lose nothing.
import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http.js";
import { setup } from "./helpers.js";

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function startServer() {
  const ctx = setup();
  const { app } = createApp(ctx.svc);
  const server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { ...ctx, url: `http://127.0.0.1:${port}` };
}

async function mcpClient(url: string, name: string, role = "analyst", team?: string) {
  const headers: Record<string, string> = { "x-analyst-name": name, "x-analyst-role": role };
  if (team) headers["x-analyst-team"] = team;
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: `test-${name}`, version: "0.0.1" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r: any = await client.callTool({ name, arguments: args });
  const body = JSON.parse(r.content[0].text);
  if (r.isError) throw Object.assign(new Error(body.message), body);
  return body;
}

describe("concurrency over MCP", () => {
  it("1: two sessions x 50 concurrent writes -> no gaps, nothing lost", async () => {
    const { url, svc } = await startServer();
    const a = await mcpClient(url, "analyst-a");
    const b = await mcpClient(url, "analyst-b");

    const tools = await a.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("add_events");

    const opened = await call(a, "open_incident", { title: "Concurrency test", priority: "P3" });
    await call(b, "connect_incident", { query: opened.codename });

    const writes = (client: Client, who: string) =>
      Array.from({ length: 50 }, (_, i) =>
        call(client, "add_events", {
          items: [{ type: "timeline", time: `2026-11-14T07:${String(i).padStart(2, "0")}:00Z`, description: `${who} event ${i}` }],
          idempotency_key: `${who}-${i}`,
        }),
      );
    await Promise.all([...writes(a, "A"), ...writes(b, "B")]);

    const events = svc.store.events(opened.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1)); // 1..N, no gaps
    const st = svc.store.state(opened.id);
    expect(st.timeline).toHaveLength(100);

    svc.flushRenders();
    const report = readFileSync(svc.reportPath(opened.id), "utf8");
    for (let i = 0; i < 50; i++) {
      expect(report).toContain(`A event ${i}`);
      expect(report).toContain(`B event ${i}`);
    }

    // retry of one call with the same key is a no-op
    const again = await call(a, "add_events", {
      items: [{ type: "timeline", time: "2026-11-14T07:00:00Z", description: "A event 0" }],
      idempotency_key: "A-0",
    });
    expect(again.replayed).toBe(true);
    expect(svc.store.state(opened.id).timeline).toHaveLength(100);

    await a.close();
    await b.close();
  }, 60_000);

  it("session identity, defaults and errors come through MCP", async () => {
    const { url } = await startServer();
    const eng = await mcpClient(url, "engineer", "engineer", "detection-eng");
    const q = await call(eng, "get_team_queue", {});
    expect(q.team.id).toBe("detection-eng");
    await expect(call(eng, "add_events", { items: [{ type: "note", text: "x" }] })).rejects.toMatchObject({ error: "not_connected" });
    await expect(call(eng, "connect_incident", { query: "Nonexistent Name" })).rejects.toMatchObject({ error: "not_found" });
    await eng.close();
  });

  it("REST API and MCP share one write path", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/api/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-analyst": "portal-user" },
      body: JSON.stringify({ title: "Opened from portal", priority: "P2", compliance: ["nis2"] }),
    });
    expect(res.status).toBe(201);
    const inc = await res.json();
    const c = await mcpClient(url, "analyst-c");
    const brief = await call(c, "connect_incident", { query: inc.codename });
    expect(brief.incident.id).toBe(inc.id);
    expect(brief.compliance_due_next[0].step).toBe("early-warning");
    const bad = await fetch(`${url}/api/incidents/${inc.id}/engagements/detection-eng`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "delivered" }),
    });
    expect(bad.status).toBe(422);
    await c.close();
  });
});
