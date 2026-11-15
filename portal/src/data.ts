// Loads every incident with its full case and, for open ones, the manager status view.
// Fine for a POC with a handful of incidents; a real build would add an aggregate endpoint.
import { api } from "./api";

export interface Loaded {
  list: any[];
  cases: Record<string, any>;
  statuses: Record<string, any>;
  config: any;
}

export async function loadAll(): Promise<Loaded> {
  const [list, config] = await Promise.all([api.incidents(), api.config()]);
  const cases: Record<string, any> = {};
  const statuses: Record<string, any> = {};
  await Promise.all(
    list.map(async (r) => {
      cases[r.id] = await api.caseView(r.id);
      if (r.status !== "Closed") statuses[r.id] = await api.status(r.id);
    }),
  );
  return { list, cases, statuses, config };
}

export const pendingSuggestions = (c: any) => (c?.proposals ?? []).filter((p: any) => p.status === "pending");
export const openFlags = (c: any) => (c?.flags ?? []).filter((f: any) => !f.decision);
export const teamName = (config: any, id: string) => config?.teams?.teams?.find((t: any) => t.id === id)?.name ?? id;
