import { useEffect, useState } from "react";
import { USERS, getUser, setUser, type User } from "./api";
import { hhmm, useNow } from "./lib";
import { Overview } from "./pages/Overview";
import { Incidents } from "./pages/Incidents";
import { Case } from "./pages/Case";
import { Queue } from "./pages/Queue";

// Hash routes: #/overview, #/incidents, #/case/INC-2026-0010, #/queue
function useRoute() {
  const [hash, setHash] = useState(location.hash || "#/overview");
  useEffect(() => {
    const on = () => {
      setHash(location.hash || "#/overview");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [, page, arg] = hash.split("/");
  return { page: page || "overview", arg: arg ? decodeURIComponent(arg) : undefined };
}

export function App() {
  const { page, arg } = useRoute();
  const [user, setU] = useState<User>(getUser());
  const now = useNow(15_000);
  const choose = (name: string) => {
    const u = USERS.find((x) => x.name === name)!;
    setUser(u);
    setU(u);
  };

  const nav = [
    { id: "overview", label: "Overview" },
    { id: "incidents", label: "Incidents" },
    { id: "queue", label: "Engineering queue" },
  ];
  const active = page === "case" ? "incidents" : page;

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/overview" className="brand">
          <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
            <rect x="1" y="1" width="26" height="26" rx="7" fill="none" stroke="#5B9BFF" strokeWidth="2" />
            <path d="M8 15l4 4 8-10" fill="none" stroke="#5B9BFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="brand-name">IR Case Portal</span>
          <span className="brand-org">Bittersweet Fjord SOC</span>
        </a>
        <nav aria-label="Main" className="nav">
          {nav.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={active === n.id ? "nav-link active" : "nav-link"}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="live">
            <span className="live-dot" />
            Live · {hhmm(new Date(now).toISOString())} UTC
          </span>
          <label className="who">
            <span className="sr-only">Signed in as</span>
            <select value={user.name} onChange={(e) => choose(e.target.value)}>
              {USERS.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name} · {u.role}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <main className="main" key={user.name}>
        {page === "overview" && <Overview />}
        {page === "incidents" && <Incidents />}
        {page === "case" && arg && <Case id={arg} />}
        {page === "queue" && <Queue user={user} />}
      </main>
    </div>
  );
}
