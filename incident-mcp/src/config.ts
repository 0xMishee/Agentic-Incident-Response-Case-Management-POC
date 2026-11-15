// Loads and validates the team-editable YAML config in /config.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { PRIORITIES, parseDuration, type Duration } from "./util.js";

const Priority = z.enum(PRIORITIES);

export const SettingsSchema = z.object({
  port: z.number().int().default(7400),
  host: z.string().default("127.0.0.1"),
  data_dir: z.string().default("./data"),
  confirm_before_write: z.boolean().default(true),
  trusted_sources: z.array(z.string()).default([]),
  digest_window_hours: z.number().default(2),
  default_template: z.string().default("default"),
  demo: z
    .object({
      enabled: z.boolean().default(false),
      clock_offset_minutes: z.number().default(0),
      anchor: z.string().nullable().default(null),
      meeting_minutes: z.number().default(5),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SECTION_KINDS = [
  "prose",
  "timeline",
  "table",
  "tasks",
  "log",
  "compliance",
  "engagements",
  "correlations",
  "meetings",
  "correspondence",
  "proposals",
] as const;

export const TemplateSchema = z.object({
  name: z.string(),
  version: z.number().int(),
  priorities: z.array(Priority).default(["P4", "P3", "P2", "P1"]),
  default_meeting_minutes: z.partialRecord(Priority, z.number().int().min(0)).default({}),
  compliance_offer: z.array(z.string()).default([]),
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      kind: z.enum(SECTION_KINDS),
      instructions: z.string().default(""),
      fields: z.array(z.string()).optional(),
      phases: z.array(z.string()).optional(),
      types: z.array(z.string()).optional(),
    }),
  ),
});
export type Template = z.infer<typeof TemplateSchema>;

export const TrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  ask_at_open: z.string().default(""),
  trigger: z.string().default("aware_at"),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      due: z.string().nullable().default(null),
      due_from: z.string().default("trigger"),
      owner_role: z.string().optional(),
      evidence: z.array(z.string()).default([]),
      condition: z.string().optional(),
    }),
  ),
});
export type Track = z.infer<typeof TrackSchema>;

export const TeamsSchema = z.object({
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      contact: z.string().default(""),
      request_via: z.string().optional(),
      respond_within: z.string(),
      request_types: z.array(z.string()).default([]),
      suggest_when: z
        .array(z.object({ event: z.string(), condition: z.string().optional() }))
        .default([]),
    }),
  ),
  closure_rule: z.enum(["all_engagements_resolved", "none"]).default("none"),
});
export type Teams = z.infer<typeof TeamsSchema>;
export type Team = Teams["teams"][number];

export interface Config {
  rootDir: string;
  dataDir: string;
  settings: Settings;
  templates: Map<string, Template>;
  tracks: Map<string, Track>;
  teams: Teams;
  codenames: { adjectives: string[]; nouns: string[] };
  /** Pre-parsed durations, keyed "track:step" and "team:<id>". */
  durations: Map<string, Duration | null>;
  warnings: string[];
}

function readYaml(file: string): unknown {
  return parse(readFileSync(file, "utf8"));
}

function readList(file: string): string[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ConfigOverrides {
  dataDir?: string;
  settings?: Partial<Settings>;
}

/** Repo root = the folder holding /config. */
export function defaultRootDir(): string {
  return resolve(import.meta.dirname, "..", "..");
}

export function loadConfig(rootDir = defaultRootDir(), overrides: ConfigOverrides = {}): Config {
  const cfgDir = join(rootDir, "config");
  const warnings: string[] = [];

  const rawSettings = existsSync(join(cfgDir, "settings.yml"))
    ? (readYaml(join(cfgDir, "settings.yml")) as object)
    : {};
  const settings = SettingsSchema.parse({ ...rawSettings, ...overrides.settings });

  const templates = new Map<string, Template>();
  for (const f of listYaml(join(cfgDir, "templates"))) {
    const r = TemplateSchema.safeParse(readYaml(f));
    if (r.success) templates.set(r.data.name, r.data);
    else warnings.push(`Template ${f} skipped: ${z.prettifyError(r.error)}`);
  }

  const durations = new Map<string, Duration | null>();
  const tracks = new Map<string, Track>();
  for (const f of listYaml(join(cfgDir, "compliance"))) {
    const r = TrackSchema.safeParse(readYaml(f));
    if (!r.success) {
      warnings.push(`Compliance track ${f} skipped: ${z.prettifyError(r.error)}`);
      continue;
    }
    try {
      for (const s of r.data.steps) {
        durations.set(`${r.data.id}:${s.id}`, s.due ? parseDuration(s.due) : null);
      }
      tracks.set(r.data.id, r.data);
    } catch (e) {
      warnings.push(`Compliance track ${f} skipped: ${(e as Error).message}`);
    }
  }

  const teamsFile = join(cfgDir, "org", "teams.yml");
  const teams = existsSync(teamsFile)
    ? TeamsSchema.parse(readYaml(teamsFile))
    : { teams: [], closure_rule: "none" as const };
  for (const t of teams.teams) durations.set(`team:${t.id}`, parseDuration(t.respond_within));

  const codenames = {
    adjectives: readList(join(cfgDir, "codenames", "adjectives.txt")),
    nouns: readList(join(cfgDir, "codenames", "nouns.txt")),
  };

  if (!templates.has(settings.default_template)) {
    throw new Error(`Default template "${settings.default_template}" not found in config/templates`);
  }

  return {
    rootDir,
    dataDir: resolve(rootDir, overrides.dataDir ?? settings.data_dir),
    settings,
    templates,
    tracks,
    teams,
    codenames,
    durations,
    warnings,
  };
}

function listYaml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}
