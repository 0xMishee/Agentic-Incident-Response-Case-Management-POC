---
name: engineering-queue
description: Work a supporting team's queue of requests from live incidents. Use when an engineer (detection engineering, SIEM, platform) asks "what's in my queue?", "any requests?", "/incident queue", or wants to turn a recommendation into a detection rule, hunt query or dashboard and mark it delivered.
---

# Engineering queue

The engineer's team is `${user_config.analyst_team}`. Requests come from analysts working incidents. Each carries draft recommendations and a context pack, so the engineer does not need to open the case.

## Steps

1. `get_team_queue` (team defaults to the engineer's own). Show a short table, most urgent first: incident codename and priority, request type, title of the first recommendation, waiting time, **overdue** if so.

2. When the engineer picks one:
   - Restate the ask: what to detect and why, from `recommendations[].rationale`.
   - Show the relevant evidence from `context.timeline` (time, source, description) and the IOCs/techniques involved.
   - **Refine the draft** into a production-quality rule in the team's language (KQL unless told otherwise): name, description, query, entity mapping, MITRE techniques, suggested severity, and false-positive notes. For a dashboard: panels with title, query and visual type.
   - **Check it against the evidence**: walk through why each evidence row would match, and name anything that would not. Say plainly that it has not been run against live data.

3. `set_engagement` with the `engagement_id`, `team_id`, and:
   - `status: engaged` when the engineer starts on it (so analysts see someone has it),
   - `status: delivered` with `outcome` = the rule id or dashboard link once deployed. Ask the engineer for the real id; never invent one.
   - `status: not_needed` with a `reason` if existing coverage already handles it.

Analysts on the case see the delivery in their next digest.

## Rules

- Do not write directly into incidents beyond the engagement. Findings for the case go back through the analyst, or as a note via `add_events` if the engineer asks.
- Queries are drafts until the engineer deploys them.
