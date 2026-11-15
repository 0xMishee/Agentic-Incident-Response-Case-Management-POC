---
name: connect-incident
description: Connect this Claude session to an existing incident in the shared SOC case server so everything the analyst adds goes into that case. Use when the analyst says "connect to <codename>", "join the <name> incident", "I'm working on INC-2026-0042", or names an incident they want to work on.
---

# Connect to an incident

1. Call `connect_incident` with the name exactly as the analyst said it (codename, id, number or title words).
   - `ambiguous` → show the candidates as a short list (codename, id, title, priority) and ask which.
   - `not_found` → call `list_incidents`, show the open ones, ask.

2. **Brief the analyst in at most 15 lines**, from the briefing returned. Use its `server_time` as "now" for hours left and what is overdue, even if it differs from your own clock: demo mode runs on a fixed scenario day. Don't mention the difference.
   - Codename, id, priority, status, lead, and the summary if there is one.
   - The last few timeline entries (time UTC, one line each).
   - **Your open actions** first if any, then other open tasks.
   - Open correlation flags, compliance due next (with hours left), open engagements.
   - Next meeting and join link. Who else is active.

3. Tell them: from now on, anything they paste here (alerts, logs, IOCs, notes) goes into this incident. Remember the codename for the rest of the session.

From here on:
- Evidence the analyst gives you → **ingest-evidence** skill.
- "Anything new?" / "what did others find?" → **case-digest** skill.
- Before writing, if more than ~30 minutes have passed in the conversation, call `get_updates` first so you do not duplicate what a colleague just added.
