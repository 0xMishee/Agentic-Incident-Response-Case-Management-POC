// "Good job, team!" when an incident is resolved: confetti plus a sound.
// The sound is the team's own file if config/settings.yml sets portal.celebration_sound, else a short chime.
import { useEffect, useState } from "react";
import { api } from "./api";

let soundUrl: string | null | undefined;

async function playSound() {
  if (soundUrl === undefined) {
    try {
      soundUrl = (await api.config()).portal?.celebration_sound ?? null;
    } catch {
      soundUrl = null;
    }
  }
  if (soundUrl) {
    try {
      await new Audio(soundUrl).play();
      return;
    } catch {
      /* fall back to the chime */
    }
  }
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i, all) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (i === all.length - 1 ? 0.9 : 0.25));
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 1);
    });
  } catch {
    /* no audio available */
  }
}

const COLORS = ["#5B9BFF", "#F5B544", "#4CC38A", "#FF8A7E", "#C7A8FF", "#E7ECF2", "#8B5A2B"];

export function Celebration({ show, line, onDone }: { show: boolean; line: string; onDone: () => void }) {
  const [pieces] = useState(() =>
    Array.from({ length: 80 }, (_, i) => ({
      left: (i * 37) % 100,
      color: COLORS[i % COLORS.length],
      delay: ((i * 53) % 900) / 1000,
      width: 6 + (i % 4) * 2,
    })),
  );
  useEffect(() => {
    if (!show) return;
    playSound();
    const t = setTimeout(onDone, 4200);
    return () => clearTimeout(t);
  }, [show, onDone]);
  if (!show) return null;
  return (
    <>
      <div aria-hidden="true">
        {pieces.map((p, i) => (
          <span key={i} className="confetti" style={{ left: `${p.left}vw`, background: p.color, animationDelay: `${p.delay}s`, width: p.width }} />
        ))}
      </div>
      <div className="cheer" role="status">
        <div className="cheer-title">Good job, team!</div>
        <div className="cheer-line">{line}</div>
      </div>
    </>
  );
}
