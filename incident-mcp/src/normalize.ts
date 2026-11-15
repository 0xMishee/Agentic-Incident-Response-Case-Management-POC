// Server-side normalisation. Claude extracts; the server checks and cleans.
import { isIPv4, isIPv6 } from "node:net";
import { AppError, iso } from "./util.js";

export type IocTypeName = "ipv4" | "ipv6" | "domain" | "url" | "sha256" | "sha1" | "md5" | "email";

/** Undo common defanging: hxxp, [.], (.), [:], [at]. */
export function refang(v: string): string {
  return v
    .trim()
    .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]/gi, ".")
    .replace(/\[:\]/g, ":")
    .replace(/^hxxp/i, "http")
    .replace(/^fxp/i, "ftp")
    .replace(/\[at\]|\(at\)|\[@\]/gi, "@");
}

/** Defang for display in reports so nothing in report.md is clickable. */
export function defang(type: string, v: string): string {
  if (type === "ipv4" || type === "domain") return v.replace(/\.(?=[^.]*$)/, "[.]");
  if (type === "url") {
    try {
      const host = new URL(v).host;
      return v.replace(/^http/i, "hxxp").replace(host, host.replace(/\.(?=[^.]*$)/, "[.]"));
    } catch {
      return v;
    }
  }
  if (type === "email") return v.replace("@", "[@]");
  return v;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX = /^[a-f0-9]+$/;

export function detectIocType(raw: string): IocTypeName | null {
  const v = refang(raw);
  const lower = v.toLowerCase();
  if (isIPv4(v)) return "ipv4";
  if (isIPv6(v)) return "ipv6";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return "url";
  if (EMAIL.test(v)) return "email";
  if (HEX.test(lower)) {
    if (lower.length === 64) return "sha256";
    if (lower.length === 40) return "sha1";
    if (lower.length === 32) return "md5";
  }
  if (DOMAIN.test(lower)) return "domain";
  return null;
}

export interface NormalizedIoc {
  type: IocTypeName;
  value: string; // normalised, refanged
}

export function normalizeIoc(raw: string, declared?: string): NormalizedIoc {
  const v = refang(String(raw));
  const type = (declared as IocTypeName | undefined) ?? detectIocType(v);
  if (!type) throw new AppError("invalid", `Cannot tell what kind of indicator "${raw}" is. Pass a type.`);
  const lower = v.toLowerCase();
  const bad = () => new AppError("invalid", `"${raw}" is not a valid ${type}.`, { field: "value" });
  switch (type) {
    case "ipv4":
      if (!isIPv4(v)) throw bad();
      return { type, value: v };
    case "ipv6":
      if (!isIPv6(v)) throw bad();
      return { type, value: new URL(`http://[${v}]`).hostname.slice(1, -1) };
    case "domain":
      if (!DOMAIN.test(lower.replace(/\.$/, ""))) throw bad();
      return { type, value: lower.replace(/\.$/, "") };
    case "url": {
      try {
        const u = new URL(v);
        return { type, value: u.toString() };
      } catch {
        throw bad();
      }
    }
    case "email":
      if (!EMAIL.test(lower)) throw bad();
      return { type, value: lower };
    case "sha256":
    case "sha1":
    case "md5": {
      const len = { sha256: 64, sha1: 40, md5: 32 }[type];
      if (!HEX.test(lower) || lower.length !== len) throw bad();
      return { type, value: lower };
    }
  }
}

const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** Accepts ISO 8601 with an explicit offset; returns UTC ISO with seconds. */
export function normalizeTime(raw: string, field = "time"): string {
  const s = String(raw).trim().replace(" ", "T");
  if (!HAS_OFFSET.test(s)) {
    throw new AppError(
      "invalid",
      `${field} "${raw}" has no timezone. Give it as ISO 8601 with Z or an offset, e.g. 2026-11-14T06:58:00Z.`,
      { field },
    );
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new AppError("invalid", `${field} "${raw}" is not a valid time.`, { field });
  return iso(t);
}
