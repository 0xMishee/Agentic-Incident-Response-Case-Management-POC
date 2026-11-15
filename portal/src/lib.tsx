// Shared hooks and small UI helpers.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";

// ---------- time (the server's clock is the truth: demo mode runs on a fixed scenario day) ----------

let offsetMs = 0;
export async function syncClock() {
  try {
    const h = await api.health();
    offsetMs = Date.parse(h.server_time) - Date.now();
  } catch {
    /* server down: keep local time */
  }
}
export const serverNow = () => Date.now() + offsetMs;

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const hhmm = (iso?: string | null) => (iso ? iso.slice(11, 16) : "–");
export const dayTime = (iso?: string | null) => {
  if (!iso) return "–";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hhmm(iso)}`;
};

export function relative(iso: string | null | undefined, now: number) {
  if (!iso) return "–";
  const diff = Date.parse(iso) - now;
  const mins = Math.round(Math.abs(diff) / 60_000);
  const text = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} m` : ""}` : `${Math.round(mins / 1440)} d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function timeLeft(iso: string | null | undefined, now: number) {
  if (!iso) return "–";
  const diff = Date.parse(iso) - now;
  const mins = Math.round(Math.abs(diff) / 60_000);
  const text = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} m`;
  return diff >= 0 ? `${text} left` : `${text} overdue`;
}

// ---------- data ----------

/** Loads something, reloads it when the server reports a change (live stream) or when deps change. */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    loadRef
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message ?? String(e)));
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  useLive(reload);
  return { data, error, reload };
}

const listeners = new Set<() => void>();
let source: EventSource | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
export const liveStatus = { connected: false };

function ensureStream() {
  // ?nolive turns the stream off (used for headless screenshots, which wait for the network to go idle).
  if (source || new URLSearchParams(location.search).has("nolive")) return;
  source = new EventSource("/api/stream");
  source.onopen = () => (liveStatus.connected = true);
  source.onerror = () => (liveStatus.connected = false);
  source.addEventListener("case-event", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => listeners.forEach((l) => l()), 300);
  });
}

export function useLive(onChange: () => void) {
  useEffect(() => {
    ensureStream();
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, [onChange]);
}

// ---------- toasts ----------

type Toast = { id: number; text: string; kind: "ok" | "error" };
const ToastCtx = createContext<(text: string, kind?: "ok" | "error") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Runs an action, shows the server's message on failure, and a short confirmation on success. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        const r = await fn();
        if (ok) toast(ok, "ok");
        return r;
      } catch (e: any) {
        toast(e.message ?? String(e), "error");
        return undefined;
      }
    },
    [toast],
  );
}

// ---------- small presentational pieces ----------

export function Prio({ p }: { p: string }) {
  return <span className={`prio prio-${p.toLowerCase()}`}>{p}</span>;
}

export function Chip({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`chip chip-${kind}`}>{children}</span>;
}

export const PRIO_MEANING: Record<string, string> = {
  P1: "Business at risk",
  P2: "Confirmed compromise",
  P3: "Suspicious",
  P4: "Low impact",
};
export const prioRank = (p: string) => ({ P1: 4, P2: 3, P3: 2, P4: 1 })[p as "P1"] ?? 0;

/** Server messages carry raw ISO times ("due 2026-11-14T09:00:00Z"); show them as "14 Nov 09:00". */
export const prettyTimes = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z/g, (m) => dayTime(m));

/** "analyst-b" -> "AB", "Plant manager" -> "PM", "dpo" -> "DP". */
export const initials = (name: string) => {
  const parts = name.split(/[\s\-_.]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase();
};
