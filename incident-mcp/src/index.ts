// Entry point: `npm start`, or `npm run demo:start` for demo mode (docs/FEATURES.md section 13).
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./http.js";
import { CaseService } from "./service.js";
import { systemClock } from "./util.js";

const demoFlag = process.argv.includes("--demo") || process.env.IR_DEMO === "1";
const base = loadConfig(process.env.IR_ROOT ?? undefined);
const cfg = loadConfig(process.env.IR_ROOT ?? undefined, {
  dataDir: process.env.IR_DATA_DIR,
  settings: {
    ...(process.env.IR_PORT ? { port: Number(process.env.IR_PORT) } : {}),
    ...(demoFlag ? { demo: { ...base.settings.demo, enabled: true } } : {}),
  },
});
for (const w of cfg.warnings) console.warn(`[config] ${w}`);

const demo = cfg.settings.demo;
let offsetMinutes = 0;
if (demo.enabled) {
  offsetMinutes = demo.anchor ? (Date.parse(demo.anchor) - Date.now()) / 60_000 : demo.clock_offset_minutes;
}
const clock = systemClock(offsetMinutes);
const db = openDb(join(cfg.dataDir, "cases.db"));
const svc = new CaseService(db, cfg, clock);
svc.renderAll(); // reports are projections: rebuild them on start

const { app } = createApp(svc, { host: cfg.settings.host });
const server = app.listen(cfg.settings.port, cfg.settings.host, () => {
  console.log(`incident-mcp listening on http://${cfg.settings.host}:${cfg.settings.port}`);
  console.log(`  MCP:  http://${cfg.settings.host}:${cfg.settings.port}/mcp`);
  console.log(`  REST: http://${cfg.settings.host}:${cfg.settings.port}/api/incidents`);
  console.log(`  Data: ${cfg.dataDir}`);
  if (demo.enabled) {
    console.log(`  DEMO MODE: server clock starts at ${clock.now().toISOString()}, incident meetings every ${demo.meeting_minutes} min`);
  }
});

function shutdown() {
  svc.flushRenders();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
