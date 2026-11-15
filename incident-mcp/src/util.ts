// Small shared helpers: clock, durations, errors, ids.
import { monotonicFactory } from "ulid";

export const ulid = monotonicFactory();

// ---------- clock ----------

export interface Clock {
  now(): Date;
}

/** System clock, optionally shifted (demo mode). */
export function systemClock(offsetMinutes = 0): Clock {
  return { now: () => new Date(Date.now() + offsetMinutes * 60_000) };
}

/** A clock tests can move by hand. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: string | Date) {
    this.t = new Date(start).getTime();
  }
  now() {
    return new Date(this.t);
  }
  set(to: string | Date) {
    this.t = new Date(to).getTime();
  }
  advance(minutes: number) {
    this.t += minutes * 60_000;
  }
}

/** ISO 8601 UTC with second precision: 2026-11-14T06:58:00Z */
export function iso(d: Date | number): string {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------- durations ----------

export interface Duration {
  months: number;
  ms: number;
  text: string;
}

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses "30m", "24h", "7d", "2w", "1mo". */
export function parseDuration(text: string): Duration {
  const m = /^(\d+)\s*(mo|min|m|h|d|w)$/.exec(String(text).trim());
  if (!m) throw new AppError("invalid", `Not a duration: "${text}". Use e.g. 30m, 24h, 7d, 1mo.`);
  const n = Number(m[1]);
  if (m[2] === "mo") return { months: n, ms: 0, text };
  return { months: 0, ms: n * UNIT_MS[m[2]], text };
}

export function addDuration(from: Date | string, d: Duration): Date {
  const r = new Date(from);
  if (d.months) r.setUTCMonth(r.getUTCMonth() + d.months);
  return new Date(r.getTime() + d.ms);
}

// ---------- errors ----------

export type ErrorCode =
  | "not_found"
  | "ambiguous"
  | "not_connected"
  | "conflict"
  | "invalid"
  | "closed";

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
  toJSON() {
    return { error: this.code, message: this.message, ...this.details };
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  ambiguous: 409,
  not_connected: 400,
  conflict: 409,
  invalid: 422,
  closed: 409,
};

// ---------- priorities ----------

export const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Higher number = more urgent. P1 -> 4, P4 -> 1. */
export function priorityRank(p: string): number {
  const i = PRIORITIES.indexOf(p as Priority);
  return i < 0 ? 0 : 4 - i;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
