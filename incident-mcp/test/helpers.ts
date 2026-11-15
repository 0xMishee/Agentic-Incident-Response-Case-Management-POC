import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, type ConfigOverrides } from "../src/config.js";
import { openDb } from "../src/db.js";
import { CaseService, type Actor, type Role } from "../src/service.js";
import { ManualClock } from "../src/util.js";

export const ROOT = resolve(import.meta.dirname, "..", "..");

export function setup(opts: { start?: string; overrides?: ConfigOverrides } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "ir-test-"));
  const cfg = loadConfig(ROOT, { dataDir, ...opts.overrides });
  const db = openDb(join(dataDir, "cases.db"));
  const clock = new ManualClock(opts.start ?? "2026-11-14T08:00:00Z");
  const svc = new CaseService(db, cfg, clock, { renderDelayMs: 0 });
  return { svc, cfg, db, clock, dataDir };
}

let n = 0;
export function actor(author: string, role: Role = "analyst", team: string | null = null): Actor {
  return { author, role, team, session_id: `sess-${author}-${++n}` };
}
