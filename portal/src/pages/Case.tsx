import { useCallback, useState } from "react";
import { api } from "../api";
import { Celebration } from "../celebrate";
import { Chip, initials, prettyTimes, Prio, dayTime, hhmm, relative, timeLeft, useAction, useData, useNow } from "../lib";
import { pendingSuggestions, teamName } from "../data";
import { ErrorBox, Loading } from "./Overview";

const PHASE_KIND: Record<string, string> = {
  "Initial access": "bad",
  Exfiltration: "bad",
  Impact: "bad",
  Persistence: "warn",
  "Lateral movement": "warn",
  "Credential access": "warn",
  Collection: "purple",
  Containment: "good",
  Eradication: "good",
  Recovery: "good",
};

async function loadCase(id: string) {
  const [c, status, events, config] = await Promise.all([api.caseView(id), api.status(id).catch(() => null), api.events(id), api.config()]);
  return { c, status, events, config };
}

export function Case({ id }: { id: string }) {
  const { data, error, reload } = useData(() => loadCase(id), [id]);
  const now = useNow();
  const act = useAction();
  const [who, setWho] = useState("Everyone");
  const [celebrate, setCelebrate] = useState(false);
  const done = useCallback(() => setCelebrate(false), []);
  if (error) return <ErrorBox text={error} />;
  if (!data) return <Loading />;

  const { c, status, events, config } = data;
  const inc = c.incident;
  const seq = inc.seq;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    const r = await act(fn, ok);
    reload();
    return r;
  };

  const setStatus = async (value: string) => {
    const r = await run(() => api.setField(inc.id, "status", value, seq), `${inc.codename} is ${value}`);
    if (r && value === "Resolved") setCelebrate(true);
  };
  const setPriority = (value: string) => run(() => api.setField(inc.id, "priority", value, seq), `Priority set to ${value}`);

  const markStep = async (s: any, statusTo: string) => {
    let evidence: Record<string, string> | undefined;
    if (statusTo === "done" && s.evidence_required?.length) {
      evidence = {};
      for (const k of s.evidence_required) {
        const v = window.prompt(`${s.title}: ${k.replace(/_/g, " ")}?`, s.evidence?.[k] ?? "");
        if (!v) return;
        evidence[k] = v;
      }
    }
    await run(() => api.setStep(inc.id, s.track_id, s.step_id, { status: statusTo, evidence }), `${s.title}: ${statusTo.replace("_", " ")}`);
  };

  const people = Object.entries<any>(c.analysts ?? {})
    .filter(([, a]) => now - Date.parse(a.last_at) < 2 * 3_600_000)
    .map(([n]) => n);
  const authors = ["Everyone", ...new Set<string>(c.timeline.map((t: any) => t.author))];
  const timeline = [...c.timeline].filter((t: any) => who === "Everyone" || t.author === who).sort((a: any, b: any) => a.time_utc.localeCompare(b.time_utc));
  const tracks = c.compliance.map((t: any) => ({
    ...t,
    name: c.derived.compliance_steps.find((s: any) => s.track_id === t.track_id)?.track_name ?? t.track_id,
    steps: c.derived.compliance_steps.filter((s: any) => s.track_id === t.track_id),
  }));
  const actions = c.derived.meeting_actions ?? [];
  const next = c.derived.next_meeting;
  const review = pendingSuggestions(c);
  const mail = [...(c.correspondence ?? [])].sort((a: any, b: any) => b.sent_at.localeCompare(a.sent_at));
  const recent = [...events].reverse().filter((e: any) => e.type !== "analyst.connected").slice(0, 8);

  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="crumbs">
        <a href="#/incidents">Incidents</a> / {inc.codename}
      </nav>

      <section className="case-head">
        <div className="stack-8 grow">
          <div className="row-gap baseline">
            <h1 className="case-title">{inc.codename}</h1>
            <span className="mono muted">{inc.id}</span>
          </div>
          <p className="case-sub">{inc.title}</p>
          <div className="row-gap wrap">
            <Prio p={inc.priority} />
            <span className="tag">{inc.status}</span>
            <span className="tag muted">Lead: {inc.lead ?? "unassigned"}</span>
            <span className="tag muted">Detected {dayTime(inc.detected_at)} UTC</span>
            {c.compliance.length > 0 && <span className="tag muted">{c.compliance.map((t: any) => t.track_id.toUpperCase()).join(" · ")}</span>}
          </div>
        </div>
        <div className="stack-8 end">
          <div className="row-gap wrap end">
            <label className="select-btn">
              <span className="sr-only">Change priority</span>
              <select value={inc.priority} onChange={(e) => setPriority(e.target.value)} disabled={inc.status === "Closed"}>
                {["P1", "P2", "P3", "P4"].map((p) => (
                  <option key={p} value={p}>
                    Priority {p}
                  </option>
                ))}
              </select>
            </label>
            {inc.status === "Open" && (
              <button type="button" className="btn btn-primary" onClick={() => setStatus("Resolved")}>
                Mark resolved
              </button>
            )}
            {inc.status === "Resolved" && (
              <>
                <button type="button" className="btn btn-ghost" onClick={() => setStatus("Open")}>
                  Reopen
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setStatus("Closed")}>
                  Close incident
                </button>
              </>
            )}
            {inc.status === "Closed" && (
              <button type="button" className="btn btn-ghost" onClick={() => setStatus("Open")}>
                Reopen
              </button>
            )}
          </div>
          {people.length > 0 && (
            <div className="row-gap">
              <span className="avatars">
                {people.map((p) => (
                  <span key={p} className="avatar" title={p}>
                    {initials(p)}
                  </span>
                ))}
              </span>
              <span className="muted small">{people.length} working now</span>
            </div>
          )}
        </div>
      </section>

      {inc.status === "Resolved" && c.derived.close_blockers.length > 0 && (
        <div className="card accent-warn small">
          <strong>Before this can close:</strong> {c.derived.close_blockers.join("; ")}.
        </div>
      )}

      <section className="card">
        <span className="label">Executive summary</span>
        <p className="summary">{inc.summary || <span className="muted">No summary yet. Ask Claude to write one.</span>}</p>
      </section>

      {status?.needs_action?.length > 0 && (
        <section className="card accent-warn">
          <div className="card-head">
            <h2>Needs action</h2>
            <span className="muted small">{status.needs_action.length} item(s)</span>
          </div>
          <ul className="needs">
            {status.needs_action.map((n: string, i: number) => (
              <li key={i}>{prettyTimes(n)}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="split stretch">
        <section className="card grow-7">
          <div className="card-head">
            <h2>Compliance</h2>
            <span className="muted small">Deadlines are examples; check with legal</span>
          </div>
          {tracks.length === 0 && <p className="muted">No compliance tracks attached.</p>}
          {tracks.map((t: any) => (
            <div key={t.track_id} className="stack-8 track">
              <span className="strong">
                {t.name} <span className="muted small">· clock from {dayTime(t.trigger_at)}</span>
              </span>
              {t.steps.map((s: any) => {
                const isDone = s.status === "done" || s.status === "not_applicable";
                return (
                  <div key={s.step_id} className="step">
                    <span className={`dot dot-${isDone ? "good" : s.status === "in_progress" ? "info" : "idle"}`} aria-hidden="true" />
                    <span className="stack-2 grow">
                      <span>{s.title}</span>
                      <span className="muted small">
                        {Object.entries(s.evidence ?? {}).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ") || s.condition || (s.owner_role ? `Owner: ${s.owner_role}` : "")}
                      </span>
                    </span>
                    <span className="stack-2 due">
                      <span className={isDone ? "muted" : s.overdue ? "bad strong" : s.hours_left !== null && s.hours_left <= 24 ? "warn strong" : "strong"}>
                        {isDone ? "Done" : s.due_at ? timeLeft(s.due_at, now) : s.due_note}
                      </span>
                      <span className="muted small">{s.due_at ? dayTime(s.due_at) : ""}</span>
                    </span>
                    <span className="step-actions">
                      {!isDone && s.status !== "in_progress" && (
                        <button type="button" className="btn-sm btn-ghost" onClick={() => markStep(s, "in_progress")}>
                          Start
                        </button>
                      )}
                      {!isDone && (
                        <button type="button" className="btn-sm btn-primary" onClick={() => markStep(s, "done")}>
                          Mark done
                        </button>
                      )}
                      {isDone && <Chip kind="good">{s.status === "done" ? "Done" : "N/A"}</Chip>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </section>

        <section className="card grow-5">
          <div className="card-head">
            <h2>Incident meeting</h2>
            <span className="muted small">{c.rhythm ? (c.derived.cadence_minutes ? `Every ${c.derived.cadence_minutes} min` : "Ad hoc") : "No meetings"}{c.rhythm?.chair ? ` · chair ${c.rhythm.chair}` : ""}</span>
          </div>
          {next ? (
            <div className="meeting">
              <span className="stack-2">
                <span className="small info">Next meeting{c.rhythm?.channel_name ? ` · ${c.rhythm.channel_name}` : ""}</span>
                <span className="meeting-time">
                  {hhmm(next)} UTC <span className="small info">{relative(next, now)}</span>
                </span>
              </span>
              {c.rhythm?.join_url && (
                <a className="btn btn-primary" href={c.rhythm.join_url} target="_blank" rel="noreferrer">
                  Join in Teams
                </a>
              )}
            </div>
          ) : (
            <p className="muted">No meeting scheduled. Ask Claude to set an incident meeting.</p>
          )}
          <span className="label">Open actions</span>
          {actions.length === 0 && <p className="muted small">No open meeting actions.</p>}
          <div className="stack-6">
            {actions.map((a: any) => (
              <div key={a.event_id} className="action">
                <span className="strong small">{a.assignee ?? "unassigned"}</span>
                <span className="grow">{a.title}</span>
                {a.carried_over ? <Chip kind="warn">Carried over</Chip> : <Chip kind="neutral">Due {hhmm(a.due)}</Chip>}
              </div>
            ))}
          </div>
          <p className="muted small">Record outcomes in Claude: "record the meeting". Anything without an outcome carries over.</p>
        </section>
      </div>

      <div className="split">
        <div className="col grow-8">
          <section className="card">
            <div className="card-head">
              <h2>
                Timeline <span className="muted small">· UTC</span>
              </h2>
              <div className="row-gap wrap" role="group" aria-label="Filter by analyst">
                {authors.map((a) => (
                  <button key={a} type="button" className={`pill ${who === a ? "active" : ""}`} aria-pressed={who === a} onClick={() => setWho(a)}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
            {timeline.length === 0 && <p className="muted">Nothing on the timeline yet. Paste evidence into Claude.</p>}
            <ol className="timeline">
              {timeline.map((t: any) => (
                <li key={t.event_id}>
                  <span className="mono t-time">{hhmm(t.time_utc)}</span>
                  <span className={`t-dot dot-${PHASE_KIND[t.phase] ?? "info"}`} aria-hidden="true" />
                  <span className="stack-6 t-body">
                    <span>{t.description}</span>
                    <span className="row-gap wrap small">
                      {t.phase && <Chip kind={PHASE_KIND[t.phase] ?? "neutral"}>{t.phase}</Chip>}
                      {t.confidence < 100 && <Chip kind={t.confidence >= 80 ? "neutral" : "warn"}>{t.confidence}% sure</Chip>}
                      {t.source && <span className="mono muted">{t.source}</span>}
                      <span className="muted">· {t.author}</span>
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>
                Indicators <span className="muted small">· {c.iocs.length}</span>
              </h2>
              <span className="muted small">Defanged for display</span>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Value</th>
                    <th>Sources</th>
                    <th>Verdict</th>
                    <th>Added by</th>
                  </tr>
                </thead>
                <tbody>
                  {c.iocs.map((i: any) => (
                    <tr key={i.event_id}>
                      <td className="muted">{i.type}</td>
                      <td className="mono break">{defang(i.type, i.value)}</td>
                      <td className="muted small">{i.sources.join(", ") || "–"}</td>
                      <td>
                        <Chip kind={i.verdict === "malicious" ? "bad" : i.verdict === "suspicious" ? "warn" : i.verdict === "benign" ? "good" : "neutral"}>{i.verdict}</Chip>
                      </td>
                      <td className="muted">{i.author}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>
                Correspondence <span className="muted small">· {mail.length}</span>
              </h2>
              <span className="muted small">Emails in and out</span>
            </div>
            {mail.length === 0 && <p className="muted">No correspondence logged.</p>}
            {mail.map((m: any) => (
              <div key={m.event_id} className="mail">
                <span className="mono small">{hhmm(m.sent_at)}</span>
                <Chip kind={m.direction === "inbound" ? "info" : "good"}>{m.direction === "inbound" ? "In" : "Out"}</Chip>
                <span className="stack-2 grow">
                  <span className="strong">{m.subject}</span>
                  <span className="small">{m.summary}</span>
                  <span className="muted small">{m.direction === "inbound" ? `From ${m.from}` : `To ${m.to.join(", ")}`}</span>
                </span>
                <span className="stack-2 end">
                  <Chip kind="neutral">{m.party}</Chip>
                  {m.related_step && <span className="info small">{m.related_step}</span>}
                </span>
              </div>
            ))}
          </section>
        </div>

        <div className="col grow-4">
          <section className="card accent-info">
            <div className="card-head">
              <h2>Waiting for review</h2>
              <span className="count">{review.length}</span>
            </div>
            <p className="muted small">Not in the case until someone accepts it.</p>
            {review.length === 0 && <p className="muted small">Nothing waiting.</p>}
            {review.map((p: any) => (
              <div key={p.proposal_id} className="suggestion">
                <span className="row-between small">
                  <span className="info strong">{viaLabel(p)}</span>
                  <span className="muted">{hhmm(p.created_at)}</span>
                </span>
                <span className="strong">{p.summary}</span>
                {p.quote && <span className="quote">"{p.quote}"</span>}
                <span className="muted small">
                  {p.from} · would add {describeItems(p.items)}
                  {p.link && (
                    <>
                      {" · "}
                      <a href={p.link} target="_blank" rel="noreferrer">
                        message
                      </a>
                    </>
                  )}
                </span>
                <span className="row-gap">
                  <button type="button" className="btn-sm btn-primary" onClick={() => run(() => api.decide(inc.id, p.proposal_id, "accepted"), "Suggestion added to the case")}>
                    Accept
                  </button>
                  <button type="button" className="btn-sm btn-ghost" onClick={() => run(() => api.decide(inc.id, p.proposal_id, "rejected"), "Suggestion rejected")}>
                    Reject
                  </button>
                </span>
              </div>
            ))}
          </section>

          {c.flags.length > 0 && (
            <section className="card accent-warn">
              <h2>Correlation</h2>
              {c.flags.map((f: any) => (
                <div key={f.flag_id} className="stack-4 flag">
                  <span className="mono warn">{f.value}</span>
                  <span>
                    Also in <a href={`#/case/${f.other_incident_id}`}>{f.other_codename ?? f.other_incident_id}</a> ({f.other_incident_id})
                  </span>
                  <span className="muted small">{f.decision ? `Decision: ${f.decision}` : "Not decided yet"} · {f.kind.replace("_", " ")}</span>
                </div>
              ))}
            </section>
          )}

          <section className="card">
            <h2>Team engagements</h2>
            {c.engagements.length === 0 && <p className="muted small">No teams engaged.</p>}
            <div className="stack-6">
              {c.engagements.map((g: any) => {
                const due = c.derived.engagement_due[g.engagement_id];
                const late = (g.status === "requested" || g.status === "engaged") && due && Date.parse(due) < now;
                return (
                  <div key={g.engagement_id} className="engagement">
                    <span className="row-between">
                      <span className="strong">{teamName(config, g.team_id)}</span>
                      <Chip kind={g.status === "delivered" ? "good" : g.status === "engaged" ? "info" : g.status === "suggested" ? "warn" : g.status === "not_needed" ? "neutral" : "neutral"}>{g.status.replace("_", " ")}</Chip>
                    </span>
                    <span className="small">{g.recommendations[0]?.title ?? g.request_type ?? g.reason ?? ""}</span>
                    <span className={`small ${late ? "bad strong" : "muted"}`}>
                      {g.outcome ? g.outcome : late ? `Overdue since ${dayTime(due)}` : due ? `Respond by ${dayTime(due)}` : g.status === "suggested" ? "Decide: request or not needed" : ""}
                    </span>
                    {g.status === "suggested" && (
                      <span className="row-gap">
                        <button type="button" className="btn-sm btn-primary" onClick={() => run(() => api.setEngagement(inc.id, g.team_id, { engagement_id: g.engagement_id, status: "requested" }), "Team requested")}>
                          Request
                        </button>
                        <button
                          type="button"
                          className="btn-sm btn-ghost"
                          onClick={() => {
                            const reason = window.prompt("Why is this team not needed?");
                            if (reason) run(() => api.setEngagement(inc.id, g.team_id, { engagement_id: g.engagement_id, status: "not_needed", reason }), "Marked not needed");
                          }}
                        >
                          Not needed
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <h2>Affected assets</h2>
            {c.assets.length === 0 && <p className="muted small">No assets yet.</p>}
            {c.assets.map((a: any) => (
              <div key={a.event_id} className="asset">
                <span className="stack-2 grow">
                  <span className="mono small">{a.host ?? a.user}</span>
                  <span className="muted small">{a.host ? a.user ?? a.owner ?? "" : a.owner ?? ""}</span>
                </span>
                <Chip kind={a.state === "compromised" ? "bad" : a.state === "suspected" ? "warn" : "good"}>{a.state}</Chip>
                {(a.state === "compromised" || a.state === "suspected") && (
                  <button type="button" className="btn-sm btn-ghost" onClick={() => run(() => api.updateItem(inc.id, "asset", a.event_id, { state: "contained" }), `${a.host ?? a.user} contained`)}>
                    Contain
                  </button>
                )}
              </div>
            ))}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Activity</h2>
              <span className="live small">
                <span className="live-dot" />
                Live
              </span>
            </div>
            {recent.map((e: any) => (
              <div key={e.id} className="activity">
                <span>
                  <strong>{e.author}</strong> <span className="muted-strong">{e.summary}</span>
                </span>
                <span className="muted small">{relative(e.created_at, now)}</span>
              </div>
            ))}
          </section>
        </div>
      </div>

      <Celebration show={celebrate} line={`${inc.codename} is resolved. ${c.timeline.length} timeline entries, ${people.length || Object.keys(c.analysts).length} people.`} onDone={done} />
    </div>
  );
}

function viaLabel(p: any) {
  if (p.source === "teams-chat") return "Teams chat";
  if (p.source === "teams-meeting") return `Meeting bot${p.context ? ` · ${p.context}` : ""}`;
  if (p.source === "email") return "Incident mailbox";
  return p.source;
}

function describeItems(items: any[]) {
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.type] = (counts[i.type] ?? 0) + 1;
  const words: Record<string, string> = { timeline: "timeline entry", ioc: "IOC", asset: "asset", note: "note", task: "task", correspondence: "email", ttp: "technique", cve: "CVE" };
  return Object.entries(counts)
    .map(([t, n]) => `${n} ${words[t] ?? t}${n > 1 ? "s" : ""}`)
    .join(", ");
}

function defang(type: string, v: string) {
  if (type === "ipv4" || type === "domain") return v.replace(/\.(?=[^.]*$)/, "[.]");
  if (type === "url") return v.replace(/^http/i, "hxxp").replace(/\.(?=[^./]*\/)/, "[.]");
  if (type === "email") return v.replace("@", "[@]");
  return v;
}
