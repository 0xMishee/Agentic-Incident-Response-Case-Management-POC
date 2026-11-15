import { useState } from "react";
import { api } from "../api";
import { PRIO_MEANING, Prio, dayTime, prioRank, relative, timeLeft, useAction, useData, useNow } from "../lib";
import { loadAll, openFlags, pendingSuggestions } from "../data";
import { ErrorBox, Loading } from "./Overview";

const STATUSES = ["Open", "Resolved", "Closed", "All"] as const;

export function Incidents() {
  const { data, error, reload } = useData(loadAll);
  const now = useNow();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("Open");
  const [prio, setPrio] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  if (error) return <ErrorBox text={error} />;
  if (!data) return <Loading />;

  const { list, cases } = data;
  const needle = q.trim().toLowerCase();
  const matches = (r: any) => {
    if (!needle) return true;
    const c = cases[r.id];
    const hay = [r.id, r.codename, r.title, ...(c?.iocs ?? []).map((i: any) => i.value), ...(c?.assets ?? []).map((a: any) => `${a.host ?? ""} ${a.user ?? ""}`)].join(" ").toLowerCase();
    return hay.includes(needle);
  };
  const rows = list
    .filter((r) => (status === "All" || r.status === status) && (!prio || r.priority === prio) && matches(r))
    .sort((a, b) => (a.status === "Open" ? 0 : 1) - (b.status === "Open" ? 0 : 1) || prioRank(b.priority) - prioRank(a.priority) || (a.next_deadline?.at ?? "9").localeCompare(b.next_deadline?.at ?? "9"));
  const open = list.filter((r) => r.status === "Open");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p className="muted">Most urgent first: priority, then the next deadline.</p>
        </div>
        <div className="row-gap">
          <label className="search">
            <span className="sr-only">Search incidents</span>
            <input type="search" placeholder="Codename, id, IOC, host…" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            + New incident
          </button>
        </div>
      </div>

      <section className="prio-grid">
        {["P1", "P2", "P3", "P4"].map((p) => {
          const items = open.filter((r) => r.priority === p);
          const on = prio === p;
          return (
            <button key={p} type="button" className={`prio-card prio-top-${p.toLowerCase()} ${on ? "selected" : ""}`} aria-pressed={on} onClick={() => setPrio(on ? null : p)}>
              <span className="row-between">
                <Prio p={p} />
                <span className="muted small">{PRIO_MEANING[p]}</span>
              </span>
              <span className="kpi">
                {items.length} <span className="muted small">open</span>
              </span>
              <span className="small muted">{items.map((r) => r.codename).join(", ") || "None"}</span>
            </button>
          );
        })}
      </section>

      <div className="row-between wrap">
        <div className="row-gap" role="group" aria-label="Filter by status">
          {STATUSES.map((s) => (
            <button key={s} type="button" className={`pill ${status === s ? "active" : ""}`} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s} <span className="muted">{s === "All" ? list.length : list.filter((r) => r.status === s).length}</span>
            </button>
          ))}
        </div>
        {prio && (
          <button type="button" className="pill" onClick={() => setPrio(null)}>
            Showing {prio} only · clear
          </button>
        )}
      </div>

      <div className="card no-pad table-scroll">
        <table className="table incidents">
          <thead>
            <tr>
              <th aria-label="Priority colour" />
              <th>Incident</th>
              <th>Title</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Lead</th>
              <th>Next deadline</th>
              <th>Next meeting</th>
              <th>Activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = cases[r.id];
              const flags = openFlags(c).length;
              const linked = (c?.flags ?? []).filter((f: any) => f.decision === "linked").map((f: any) => f.other_codename);
              const review = pendingSuggestions(c).length;
              const late = (c?.engagements ?? []).some((g: any) => (g.status === "requested" || g.status === "engaged") && c.derived.engagement_due[g.engagement_id] && Date.parse(c.derived.engagement_due[g.engagement_id]) < now);
              const people = Object.keys(c?.analysts ?? {}).length;
              return (
                <tr key={r.id} className="clickable" onClick={() => (location.hash = `#/case/${r.id}`)}>
                  <td className={`prio-bar ${r.status === "Open" ? `bg-${r.priority.toLowerCase()}` : ""}`} />
                  <td>
                    <a href={`#/case/${r.id}`} className="codename">
                      {r.codename}
                    </a>
                    <div className="mono muted small">{r.id}</div>
                  </td>
                  <td>
                    <div>{r.title}</div>
                    <div className="row-gap small">
                      {linked.length > 0 && <span className="warn">Linked to {linked.join(", ")}</span>}
                      {flags > 0 && <span className="warn">{flags} correlation flag(s)</span>}
                      {review > 0 && <span className="info">{review} waiting for review</span>}
                      {late && <span className="bad">Team request overdue</span>}
                    </div>
                  </td>
                  <td>
                    <Prio p={r.priority} />
                  </td>
                  <td className={`status-${r.status.toLowerCase()}`}>{r.status}</td>
                  <td className="nowrap">{r.lead ?? "–"}</td>
                  <td>
                    {r.next_deadline ? (
                      <>
                        <div className={Date.parse(r.next_deadline.at) - now < 24 * 3_600_000 ? "warn strong" : ""}>{timeLeft(r.next_deadline.at, now)}</div>
                        <div className="muted small">{r.next_deadline.what}</div>
                      </>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td>{r.next_meeting ? dayTime(r.next_meeting) : <span className="muted">Ad hoc</span>}</td>
                  <td>
                    <div>{relative(r.last_activity, now)}</div>
                    <div className="muted small">
                      {people} {people === 1 ? "person" : "people"}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No incidents match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted small">Colleagues join a case from Claude with "connect to &lt;codename&gt;".</p>

      {creating && (
        <NewIncident
          tracks={data.config?.tracks ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            reload();
            location.hash = `#/case/${id}`;
          }}
        />
      )}
    </div>
  );
}

function NewIncident({ tracks, onClose, onCreated }: { tracks: any[]; onClose: () => void; onCreated: (id: string) => void }) {
  const act = useAction();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("P3");
  const [compliance, setCompliance] = useState<string[]>([]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r: any = await act(() => api.open({ title, priority, compliance }));
    if (r?.id) onCreated(r.id);
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={submit} aria-label="New incident">
        <h2>New incident</h2>
        <label className="field">
          <span>Title</span>
          <input required minLength={3} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What happened, to what" autoFocus />
        </label>
        <label className="field">
          <span>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {["P1", "P2", "P3", "P4"].map((p) => (
              <option key={p} value={p}>
                {p} · {PRIO_MEANING[p]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend>Compliance tracks</legend>
          {tracks.map((t: any) => (
            <label key={t.id} className="check">
              <input type="checkbox" checked={compliance.includes(t.id)} onChange={(e) => setCompliance((c) => (e.target.checked ? [...c, t.id] : c.filter((x) => x !== t.id)))} />
              <span>
                <strong>{t.id.toUpperCase()}</strong> <span className="muted small">{t.ask_at_open}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="row-gap end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Open incident
          </button>
        </div>
      </form>
    </div>
  );
}
