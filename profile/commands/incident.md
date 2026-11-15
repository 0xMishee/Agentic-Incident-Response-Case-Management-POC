---
description: Work an incident in the shared case server (open, connect, status, updates, next, meeting, queue)
argument-hint: open | connect <codename> | status | updates | next | meeting | queue
---

Incident command. Arguments: `$ARGUMENTS`

Route on the first word and follow the matching skill from this plugin:

| First word | Do |
| --- | --- |
| `open` | Follow the **open-incident** skill. Anything after `open` is the starting description or alert. |
| `connect` | Follow the **connect-incident** skill with the rest as the incident name. |
| `status` | Follow the **case-digest** skill in manager mode (`get_status`). |
| `updates` | Follow the **case-digest** skill in analyst mode (`get_updates` + `get_next_steps`). |
| `next` | Call `get_next_steps` and give at most 3 concrete recommended next steps, each tied to a fact it returned. |
| `meeting` | Follow the **incident-meetings** skill. `meeting brief` = before the meeting, `meeting record` = after it. |
| `queue` | Follow the **engineering-queue** skill. |
| (nothing) | Call `list_incidents` and show the open incidents as a short table: codename, id, priority, status, lead, next deadline, next meeting. |

If the case server tools are missing or unreachable, say so and tell the analyst to start it with `cd incident-mcp && npm start`.
