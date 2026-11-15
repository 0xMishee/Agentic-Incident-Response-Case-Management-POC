import { useState } from "react";
import { PRIO_MEANING, initials, prettyTimes, Prio, dayTime, prioRank, timeLeft, useData, useNow } from "../lib";
import { loadAll, pendingSuggestions, teamName } from "../data";

export function Overview() {
  const { data, error } = useData(loadAll);
  const now = useNow();
  const [page, setPage] = useState(0);
  const [focus, setFocus] = useState<string | null>(null); // priority filter for the whole front page
  if (error) return <ErrorBox text={error} />;
  if (!data) return <Loading />;

  const { list, cases, statuses, config } = data;
  const open = list.filter((r) => r.status === "Open");
  const byPrio = ["P1", "P2", "P3", "P4"].map((p) => ({ p, items: open.filter((r) => r.priority === p) }));
  // Everything below the priority cards follows the filter.
  const inScope = focus ? open.filter((r) => r.priority === focus) : open;
  const pickFocus = (p: string | null) => {
    setFocus(p === focus ? null : p);
    setPage(0);
  };

  // Needs a decision: every incident's needs-action list, most urgent incident first
  const decisions = inScope
    .slice()
    .sort((a, b) => prioRank(b.priority) - prioRank(a.priority))
    .flatMap((r) => (statuses[r.id]?.needs_action ?? []).map((text: string) => ({ r, text })));

  const PER_PAGE = 5;
  const pages = Math.max(1, Math.ceil(decisions.length / PER_PAGE));
  const pageNo = Math.min(page, pages - 1); // the list can shrink under us when the live stream reloads

  const steps = inScope.flatMap((r) =>
    (statuses[r.id]?.compliance ?? [])
      .filter((s: any) => s.due_at && Date.parse(s.due_at) - now <= 72 * 3_600_000)
      .map((s: any) => ({ ...s, r })),
  );
  steps.sort((a: any, b: any) => a.due_at.localeCompare(b.due_at));
  const due24 = steps.filter((s: any) => Date.parse(s.due_at) - now <= 24 * 3_600_000);

  const engagements = inScope.flatMap((r) => (cases[r.id]?.engagements ?? []).map((g: any) => ({ g, r, due: cases[r.id].derived.engagement_due[g.engagement_id] })));
  const isOpenReq = (g: any) => g.status === "requested" || g.status === "engaged";
  const overdueReqs = engagements.filter((e) => isOpenReq(e.g) && e.due && Date.parse(e.due) < now);
  const waiting = inScope.reduce((n, r) => n + pendingSuggestions(cases[r.id]).length, 0);

  const teams = (config?.teams?.teams ?? []).map((t: any) => {
    const mine = engagements.filter((e) => e.g.team_id === t.id);
    return {
      t,
      open: mine.filter((e) => isOpenReq(e.g)).length,
      overdue: mine.filter((e) => isOpenReq(e.g) && e.due && Date.parse(e.due) < now).length,
      suggested: mine.filter((e) => e.g.status === "suggested").length,
    };
  });

  // Who is on what: people active in the last 2 hours, per incident
  const people: Record<string, { leads: string[]; on: string[] }> = {};
  for (const r of inScope) {
    const c = cases[r.id];
    for (const [name, a] of Object.entries<any>(c.analysts ?? {})) {
      if (now - Date.parse(a.last_at) > 2 * 3_600_000) continue;
      (people[name] ??= { leads: [], on: [] }).on.push(r.codename);
    }
    if (r.lead) (people[r.lead] ??= { leads: [], on: [] }).leads.push(r.codename);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">Where the SOC stands: what is open, what needs a decision, and what is due.</p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>{open.length} open incidents</h2>
          {focus ? (
            <button type="button" className="btn-sm btn-ghost" onClick={() => pickFocus(null)}>
              Showing {focus} only · Show all
            </button>
          ) : (
            <span className="muted small">Click a priority to filter this page</span>
          )}
          <span className="muted small">
            {list.filter((r) => r.status === "Resolved").length} resolved · {list.filter((r) => r.status === "Closed").length} closed
          </span>
        </div>
        <div className="prio-grid">
          {byPrio.map(({ p, items }) => (
            <button key={p} type="button" aria-pressed={focus === p} onClick={() => pickFocus(p)} className={`prio-card prio-top-${p.toLowerCase()} ${focus === p ? "focused" : focus ? "dimmed" : ""}`}>
              <span className="row-between">
                <Prio p={p} />
                <span className="muted small">{PRIO_MEANING[p]}</span>
              </span>
              <span className="kpi">{items.length}</span>
              <span className="stack-4 prio-items">
                {items.length ? items.map((r) => (
                  <span key={r.id} className="small">
                    <strong>{r.codename}</strong> <span className="muted">· {r.title}</span>
                  </span>
                )) : <span className="muted small">None</span>}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="kpi-grid">
        <Kpi label="Decisions waiting" value={decisions.length} tone="warn" />
        <Kpi label="Regulatory steps due in 24 h" value={due24.length} tone="warn" note={due24[0] ? `Next: ${due24[0].r.codename}, ${timeLeft(due24[0].due_at, now)}` : "None"} />
        <Kpi label="Team requests overdue" value={overdueReqs.length} tone="bad" note={overdueReqs.map((e) => teamName(config, e.g.team_id)).join(", ") || "None"} />
        <Kpi label="Waiting for review" value={waiting} tone="info" note="From bots, the mailbox and people without Claude" />
      </section>

      <div className="split">
        <section className="card grow-7 accent-warn box box-tall">
          <div className="card-head">
            <h2>Needs a decision</h2>
            <span className="muted small">Most urgent incident first</span>
          </div>
          {decisions.length === 0 && <p className="muted">Nothing needs a decision right now.</p>}
          <div className="decision-list">
            {decisions.slice(pageNo * PER_PAGE, (pageNo + 1) * PER_PAGE).map((d, i) => (
              <a key={i} href={`#/case/${d.r.id}`} className="row-card">
                <span className="stack-4">
                  <span className="row-gap">
                    <Prio p={d.r.priority} />
                    <span className="muted small">{d.r.codename}</span>
                  </span>
                  <span>{prettyTimes(d.text)}</span>
                </span>
                <span className="btn btn-ghost">Open</span>
              </a>
            ))}
          </div>
          {decisions.length > 0 && (
            <nav className="pager" aria-label="Needs a decision pages">
              <button type="button" className="btn-sm btn-ghost" disabled={pageNo === 0} onClick={() => setPage(pageNo - 1)}>
                ← Previous
              </button>
              <span className="muted small">
                {pageNo * PER_PAGE + 1}–{Math.min((pageNo + 1) * PER_PAGE, decisions.length)} of {decisions.length}
              </span>
              <button type="button" className="btn-sm btn-ghost" disabled={pageNo >= pages - 1} onClick={() => setPage(pageNo + 1)}>
                Next →
              </button>
            </nav>
          )}
        </section>

        <section className="card grow-5 box box-tall">
          <div className="card-head">
            <h2>Regulatory deadlines</h2>
            <span className="muted small">Next 72 h</span>
          </div>
          <div className="box-body">
          {steps.length === 0 && <p className="muted">No regulatory deadlines in the next 72 hours.</p>}
          {steps.map((s: any, i: number) => (
            <a key={i} href={`#/case/${s.r.id}`} className="deadline-row">
              <span className="stack-2">
                <span className={s.overdue ? "bad strong" : s.hours_left <= 24 ? "warn strong" : "strong"}>{timeLeft(s.due_at, now)}</span>
                <span className="muted small">{dayTime(s.due_at)}</span>
              </span>
              <span className="stack-2">
                <span>
                  {s.track.toUpperCase()}: {s.title}
                </span>
                <span className="muted small">
                  {s.r.codename} · {s.r.priority} · {s.status.replace("_", " ")}
                </span>
              </span>
            </a>
          ))}
          </div>
        </section>
      </div>

      <section className="card box box-progress">
        <div className="card-head">
          <h2>Response progress</h2>
          <span className="muted small">Open incidents</span>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Incident</th>
                <th>Priority</th>
                <th>Assets contained</th>
                <th>Compliance steps</th>
                <th>Meeting actions on time</th>
                <th>Lead · next meeting</th>
              </tr>
            </thead>
            <tbody>
              {inScope
                .slice()
                .sort((a, b) => prioRank(b.priority) - prioRank(a.priority))
                .map((r) => {
                  const c = cases[r.id];
                  const assets = c.assets ?? [];
                  const contained = assets.filter((a: any) => a.state === "contained" || a.state === "clean").length;
                  const st = c.derived.compliance_steps ?? [];
                  const done = st.filter((s: any) => s.status === "done" || s.status === "not_applicable").length;
                  const acts = c.derived.meeting_actions ?? [];
                  const onTime = acts.filter((a: any) => !a.carried_over).length;
                  return (
                    <tr key={r.id} className="clickable" onClick={() => (location.hash = `#/case/${r.id}`)}>
                      <td>
                        <a href={`#/case/${r.id}`} className="strong">
                          {r.codename}
                        </a>
                        <div className="muted small">{r.title}</div>
                      </td>
                      <td>
                        <Prio p={r.priority} />
                      </td>
                      <td>
                        <Bar done={contained} total={assets.length} label={assets.length ? `${contained} of ${assets.length}` : "No assets"} color="good" />
                      </td>
                      <td>
                        <Bar done={done} total={st.length} label={st.length ? `${done} of ${st.length}` : "No track"} color="info" />
                      </td>
                      <td>
                        <Bar done={onTime} total={acts.length} label={acts.length ? `${onTime} of ${acts.length}` : "No meetings"} color="info" />
                      </td>
                      <td>
                        <div>{r.lead ?? "–"}</div>
                        <div className="muted small">{r.next_meeting ? `Next meeting ${dayTime(r.next_meeting)}` : "Ad hoc"}</div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split">
        <section className="card grow-1 box box-short">
          <div className="card-head">
            <h2>Supporting teams</h2>
            <span className="muted small">Requests from incidents</span>
          </div>
          <div className="box-body">
          {teams.map(({ t, open, overdue, suggested }: any) => (
            <div key={t.id} className="list-row">
              <span className="stack-2">
                <span className="strong">{t.name}</span>
                <span className="muted small">Responds within {t.respond_within}</span>
              </span>
              <span className="small">
                {open} open{suggested ? ` · ${suggested} suggested` : ""}
              </span>
              {overdue ? <span className="chip chip-bad">{overdue} overdue</span> : suggested ? <span className="chip chip-warn">Awaiting decision</span> : open ? <span className="chip chip-good">On time</span> : <span className="chip chip-neutral">Idle</span>}
            </div>
          ))}
          </div>
        </section>

        <section className="card grow-1 box box-short">
          <div className="card-head">
            <h2>Who is on what</h2>
            <span className="muted small">Active in the last 2 h</span>
          </div>
          <div className="box-body">
          {Object.keys(people).length === 0 && <p className="muted">Nobody active in the last two hours.</p>}
          {Object.entries(people).map(([name, p]) => (
            <div key={name} className="list-row">
              <span className="avatar">{initials(name)}</span>
              <span className="strong">{name}</span>
              <span className="small muted">
                {p.leads.length ? `Leads ${p.leads.join(", ")}` : ""}
                {p.leads.length && p.on.length ? " · " : ""}
                {p.on.length ? `Active on ${[...new Set(p.on)].join(", ")}` : ""}
              </span>
            </div>
          ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone, note }: { label: string; value: number; tone: string; note?: string }) {
  return (
    <div className="card kpi-card">
      <span className="muted small">{label}</span>
      <span className={`kpi ${tone}`}>{value}</span>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}

function Bar({ done, total, label, color }: { done: number; total: number; label: string; color: string }) {
  return (
    <div className="bar-cell">
      <span className="small">{label}</span>
      <span className="bar">
        <span className={`bar-fill ${color}`} style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
      </span>
    </div>
  );
}

export function Loading() {
  return <div className="page muted">Loading…</div>;
}

export function ErrorBox({ text }: { text: string }) {
  return (
    <div className="page">
      <div className="card accent-bad">
        <h2>Can't reach the case server</h2>
        <p className="muted">{text}</p>
        <p className="muted small">
          Start it with <code>cd incident-mcp && npm run demo:start</code> (or <code>npm start</code>), then reload.
        </p>
      </div>
    </div>
  );
}
