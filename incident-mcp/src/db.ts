// SQLite schema. The events table is the source of truth; everything else is an index or cache.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id            TEXT PRIMARY KEY,
  year          INTEGER NOT NULL,
  number        INTEGER NOT NULL,
  codename      TEXT NOT NULL,
  codename_slug TEXT NOT NULL,
  title         TEXT NOT NULL,
  priority      TEXT NOT NULL,
  status        TEXT NOT NULL,
  lead          TEXT,
  template      TEXT NOT NULL,
  detected_at   TEXT NOT NULL,
  opened_at     TEXT NOT NULL,
  opened_by     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  last_activity TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  incident_id     TEXT NOT NULL REFERENCES incidents(id),
  seq             INTEGER NOT NULL,
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  author          TEXT NOT NULL,
  session_id      TEXT,
  source_artifact TEXT,
  idempotency_key TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  supersedes      TEXT,
  target          TEXT,
  UNIQUE (incident_id, seq),
  UNIQUE (incident_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS events_target ON events (incident_id, target, seq);
CREATE INDEX IF NOT EXISTS events_key ON events (idempotency_key);

CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  filename    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  path        TEXT NOT NULL,
  added_by    TEXT NOT NULL,
  added_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_sha ON artifacts (incident_id, sha256);

-- Correlation indexes
CREATE TABLE IF NOT EXISTS iocs_index (
  type        TEXT NOT NULL,
  value_norm  TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS iocs_lookup ON iocs_index (type, value_norm);

CREATE TABLE IF NOT EXISTS assets_index (
  kind        TEXT NOT NULL,      -- host | user
  value_norm  TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  event_id    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_lookup ON assets_index (kind, value_norm);

CREATE TABLE IF NOT EXISTS correlation_pairs (
  pair_id    TEXT PRIMARY KEY,
  incident_a TEXT NOT NULL,
  incident_b TEXT NOT NULL,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  UNIQUE (incident_a, incident_b, kind, value)
);

-- What each analyst has already seen, per incident (drives "what's new")
CREATE TABLE IF NOT EXISTS seen (
  author        TEXT NOT NULL,
  incident_id   TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL,
  PRIMARY KEY (author, incident_id)
);

-- Which incident each MCP session is linked to
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  author       TEXT NOT NULL,
  role         TEXT NOT NULL,
  team         TEXT,
  incident_id  TEXT,
  connected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  year        INTEGER PRIMARY KEY,
  last_number INTEGER NOT NULL
);
`;

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/**
 * Runs fn inside BEGIN IMMEDIATE ... COMMIT. IMMEDIATE takes the write lock up front,
 * so a second process (if anyone starts one by mistake) waits instead of interleaving.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
