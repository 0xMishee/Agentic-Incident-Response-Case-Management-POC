import { useState } from "react";
import { api, type User } from "../api";
import { Chip, Prio, hhmm, timeLeft, useAction, useData, useNow } from "../lib";
import { ErrorBox, Loading } from "./Overview";

export function Queue({ user }: { user: User }) {
  const [team, setTeam] = useState(user.team ?? "detection-eng");
  const { data, error, reload } = useData(async () => ({ q: await api.queue(team), config: await api.config() }), [team]);
  const now = useNow();
  const act = useAction();
  const [picked, setPicked] = useState<string | null>(null);
  const [outcome, setOutcome] = useState("");
  if (error) return <ErrorBox text={error} />;
  if (!data) return <Loading />;

  const items: any[] = data.q.items;
  const sel = items.find((i) => i.engagement_id === picked) ?? items[0];
  const teams: any[] = data.config?.teams?.teams ?? [];
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    await act(fn, ok);
    setOutcome("");
    reload();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{data.q.team.name} queue</h1>
          <p className="muted">Requests from live incidents, most urgent first, with draft recommendations and the evidence behind them.</p>
        </div>
        <label className="select-btn">
          <span className="sr-only">Team</span>
          <select value={team} onChange={(e) => { setTeam(e.target.value); setPicked(null); }}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="split">
        <section className="col queue-list">
          <span className="label">{items.length} open request{items.length === 1 ? "" : "s"}</span>
          {items.length === 0 && <p className="muted">Nothing in this queue. Analysts request this team from Claude.</p>}
          {items.map((it) => (
            <button key={it.engagement_id} type="button" className={`queue-item ${sel?.engagement_id === it.engagement_id ? "selected" : ""}`} aria-pressed={sel?.engagement_id === it.engagement_id} onClick={() => setPicked(it.engagement_id)}>
              <span className="row-between">
                <span className="row-gap">
                  <Prio p={it.incident.priority} />
                  <span className="strong">{it.incident.codename}</span>
                </span>
                <Chip kind={it.status === "engaged" ? "info" : "neutral"}>{it.status}</Chip>
              </span>
              <span className="queue-title">{it.recommendations[0]?.title ?? it.request_type ?? "Request"}</span>
              <span className="row-between small">
                <span className="muted">{it.request_type?.replace("_", " ")}</span>
                <span className={it.overdue ? "bad strong" : "muted"}>{it.deadline_at ? timeLeft(it.deadline_at, now) : ""}</span>
              </span>
            </button>
          ))}
        </section>

        {sel && (
          <section className="card grow-1 stack-16">
            <div className="row-between wrap">
              <span className="stack-4">
                <span className="muted small">
                  {sel.incident.codename} · <span className="mono">{sel.incident.id}</span>
                </span>
                <h2 className="detail-title">{sel.recommendations[0]?.title ?? sel.request_type}</h2>
              </span>
              <a className="btn btn-ghost" href={`#/case/${sel.incident.id}`}>
                Open case
              </a>
            </div>

            {sel.recommendations.map((r: any, i: number) => (
              <div key={i} className="stack-8">
                <span className="label">Why</span>
                <p className="summary">{r.rationale || "No rationale given."}</p>
                {r.mitre?.length > 0 && <span className="muted small">MITRE {r.mitre.join(", ")}</span>}
                {r.draft?.query && (
                  <>
                    <span className="row-between">
                      <span className="label">Draft from the analyst's Claude · {r.draft.language?.toUpperCase()}</span>
                      <span className="warn small">Draft, not run against live data</span>
                    </span>
                    <pre className="code">{r.draft.query}</pre>
                  </>
                )}
                {r.draft?.panels?.length > 0 && (
                  <>
                    <span className="label">Dashboard panels</span>
                    {r.draft.panels.map((p: any, j: number) => (
                      <div key={j} className="panel-row">
                        <span className="strong small">
                          {p.title} <span className="muted">· {p.viz}</span>
                        </span>
                        <pre className="code small">{p.query}</pre>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ))}

            <div className="stack-8">
              <span className="label">Evidence from the case</span>
              {sel.context.timeline.map((t: any) => (
                <div key={t.event_id} className="evidence">
                  <span className="mono">{hhmm(t.time_utc)}</span>
                  <span className="mono muted">{t.source ?? ""}</span>
                  <span>{t.description}</span>
                </div>
              ))}
            </div>

            <form
              className="deliver"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => api.setEngagement(sel.incident.id, data.q.team.id, { engagement_id: sel.engagement_id, status: "delivered", outcome }), "Delivered: analysts see it in their next digest");
              }}
            >
              <label className="field grow">
                <span>Rule id or dashboard link</span>
                <input required value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="e.g. DET-1043" />
              </label>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  const reason = window.prompt("Why is this not needed?");
                  if (reason) run(() => api.setEngagement(sel.incident.id, data.q.team.id, { engagement_id: sel.engagement_id, status: "not_needed", reason }), "Marked not needed");
                }}
              >
                Not needed…
              </button>
              {sel.status !== "engaged" && (
                <button type="button" className="btn btn-ghost" onClick={() => run(() => api.setEngagement(sel.incident.id, data.q.team.id, { engagement_id: sel.engagement_id, status: "engaged" }), "Marked engaged")}>
                  Mark engaged
                </button>
              )}
              <button type="submit" className="btn btn-primary">
                Mark delivered
              </button>
            </form>
          </section>
        )}
      </div>
    </div>
  );
}
