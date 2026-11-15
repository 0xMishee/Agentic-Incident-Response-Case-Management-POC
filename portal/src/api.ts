// Thin client for the case server's REST API. All calls go through the Vite proxy (/api).
export type Role = "analyst" | "lead" | "manager" | "engineer";
export interface User {
  name: string;
  role: Role;
  team?: string;
}

// The POC has no sign-in. Pick who you are; it is sent as headers and shows up in the case log.
export const USERS: User[] = [
  { name: "analyst-a", role: "lead" },
  { name: "analyst-b", role: "analyst" },
  { name: "analyst-c", role: "analyst" },
  { name: "analyst-d", role: "analyst" },
  { name: "manager", role: "manager" },
  { name: "engineer", role: "engineer", team: "detection-eng" },
];

const KEY = "ir-portal-user";
let current: User = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return USERS.find((u) => u.name === saved?.name) ?? USERS[0];
  } catch {
    return USERS[0];
  }
})();

export const getUser = () => current;
export function setUser(u: User) {
  current = u;
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    /* storage unavailable: keep in memory */
  }
}

export class ApiError extends Error {
  constructor(message: string, public details: any = {}) {
    super(message);
  }
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-analyst-name": current.name,
      "x-analyst-role": current.role,
      ...(current.team ? { "x-analyst-team": current.team } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) : null;
  if (!res.ok) throw new ApiError(data?.message ?? `${res.status} ${res.statusText}`, data ?? {});
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  health: () => req("GET", "/api/health"),
  config: () => req("GET", "/api/config"),
  incidents: () => req("GET", "/api/incidents").then((r) => r.incidents as any[]),
  caseView: (id: string) => req("GET", `/api/incidents/${enc(id)}`),
  status: (id: string) => req("GET", `/api/incidents/${enc(id)}/status`),
  events: (id: string) => req("GET", `/api/incidents/${enc(id)}/events`).then((r) => r.events as any[]),
  queue: (team: string) => req("GET", `/api/teams/${enc(team)}/queue`),
  open: (body: unknown) => req("POST", "/api/incidents", body),
  setField: (id: string, field: string, value: string, expected_seq: number) =>
    req("PATCH", `/api/incidents/${enc(id)}`, { field, value, expected_seq }),
  decide: (id: string, proposalId: string, decision: "accepted" | "rejected") =>
    req("POST", `/api/incidents/${enc(id)}/suggestions/${enc(proposalId)}/decision`, { decision }),
  setStep: (id: string, track: string, step: string, body: unknown) =>
    req("POST", `/api/incidents/${enc(id)}/compliance/${enc(track)}/${enc(step)}`, body),
  setEngagement: (id: string, team: string, body: unknown) =>
    req("POST", `/api/incidents/${enc(id)}/engagements/${enc(team)}`, body),
  updateItem: (id: string, kind: string, item: string, changes: unknown) =>
    req("POST", `/api/incidents/${enc(id)}/items/${enc(kind)}/${enc(item)}`, { changes }),
};
