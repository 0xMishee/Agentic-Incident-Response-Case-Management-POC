// SessionStart hook: tells Claude (and the analyst) which incidents they are on, what is unread,
// their open actions and when the next incident meeting is. Never fails the session.
// IR_* env vars win (the demo persona launchers set them), then the plugin options.
const opt = (k) =>
  process.env[`IR_${k.toUpperCase()}`] || process.env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`] || process.env[k.toUpperCase()] || "";
const server = (opt("server_url") || "http://127.0.0.1:7400").replace(/\/$/, "");
const name = opt("analyst_name");
const team = opt("analyst_team");

function out(text) {
  process.stdout.write(text.trim() + "\n");
  process.exit(0);
}

if (!name) out("[incident-mcp] No analyst name set. Run /plugin and configure soc-ir-profile (analyst_name).");

try {
  const url = `${server}/api/analysts/${encodeURIComponent(name)}/summary${team ? `?team=${encodeURIComponent(team)}` : ""}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) out(`[incident-mcp] Case server answered ${res.status} at ${server}.`);
  const s = await res.json();
  const lines = [`[incident-mcp] Signed in as ${s.author}. ${s.open_incidents_total} open incident(s) in the SOC.`];
  for (const i of s.incidents) {
    const bits = [`${i.codename} (${i.id}, ${i.priority}, ${i.status})`];
    if (i.unread) bits.push(`${i.unread} new item(s) from others`);
    if (i.next_meeting) {
      const m = i.next_meeting.minutes_until;
      bits.push(m >= 0 ? `next meeting in ${m} min` : `meeting was due ${-m} min ago`);
    }
    if (i.your_open_actions.length) bits.push(`your actions: ${i.your_open_actions.join("; ")}`);
    if (i.waiting_for_review) bits.push(`${i.waiting_for_review} suggestion(s) waiting for review`);
    lines.push(`- ${bits.join(" · ")}`);
  }
  if (s.team_queue !== null && s.team_queue !== undefined) lines.push(`Team queue (${team}): ${s.team_queue} open request(s). Use /incident queue.`);
  if (!s.incidents.length) lines.push("You are not on any open incident. Use /incident open or /incident connect <name>.");
  else lines.push("This session is not connected yet. Say \"connect to <codename>\" or use /incident connect <codename>.");
  out(lines.join("\n"));
} catch {
  out(`[incident-mcp] Case server not reachable at ${server}. Start it with: cd incident-mcp && npm start`);
}
