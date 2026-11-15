# soc-ir-profile

The Claude Code plugin every SOC member installs. It connects their Claude session to the shared
`incident-mcp` case server, so everyone opens, joins and adds evidence to the same incidents through
the same tools and the same rules.

## What it contains

| Part | Purpose |
| --- | --- |
| `.mcp.json` | The `incident-mcp` server over HTTP, sending your name, role and team with each session |
| `skills/open-incident` | Propose title, P1–P4 priority, compliance tracks and incident meetings; open; ingest first evidence |
| `skills/connect-incident` | Resolve "connect to Amber Heron" and brief you in 15 lines |
| `skills/ingest-evidence` | Store raw input, extract timeline, IOCs, assets, techniques per the template, preview, write |
| `skills/case-digest` | Analyst catch-up with next steps; manager status with a needs-action list |
| `skills/incident-meetings` | Meeting brief before, outcomes and new actions after |
| `skills/engineering-queue` | Detection engineers work requests and recommendations from live incidents |
| `commands/incident.md` | `/incident open \| connect <name> \| status \| updates \| next \| meeting \| queue` |
| `hooks/` | On session start: your incidents, unread items, your actions, next meeting |

## Install

1. Start the case server (see the repository README).
2. In Claude Code:
   ```
   /plugin marketplace add <path or git URL of this repository>
   /plugin install soc-ir-profile@agentic-ir
   ```
3. When asked, set your options: `analyst_name` (e.g. `analyst-b`), `analyst_role` (`analyst`, `lead`,
   `manager` or `engineer`), `analyst_team` (engineers only, e.g. `detection-eng`) and `server_url`
   (default `http://127.0.0.1:7400`).
4. Start a new session. The session-start message tells you which incidents you are on.

## Privacy

The plugin talks only to the case server URL you configure. In the POC that is a server on your own
machine, and nothing is sent anywhere else.
