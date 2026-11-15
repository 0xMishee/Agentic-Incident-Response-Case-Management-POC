---
name: open-incident
description: Open a new security incident in the shared SOC case server. Use when the analyst says "open an incident", "start a case", "this needs an incident", or pastes an alert and asks to track it. Proposes title, P1–P4 priority, compliance tracks and incident meetings, then opens it and ingests the first evidence.
---

# Open an incident

You are opening a case that the whole SOC will work in. Everything goes through the `incident-mcp` tools.

## Steps

1. **Read the template.** Call `get_template` (no incident yet). Note `priorities`, `default_meeting_minutes`, `compliance_offer` and `teams`.

2. **Propose, in one short message:**
   - **Title**, max 60 characters, says what happened and to what: "Invoice phish and recipe theft, finance + R&D".
   - **Priority** P1 (highest) to P4, with one line why. P1 = active compromise of crown jewels or business stop; P2 = confirmed compromise, contained scope; P3 = suspicious, unconfirmed; P4 = low impact.
   - **detected_at**: the earliest time the SOC knew, from the input, with timezone.
   - **Compliance**: ask each `compliance_offer` question as a yes/no (e.g. "Is personal data involved?" for gdpr). Do not guess legal answers.
   - **Incident meetings**: offer the template default for the priority ("P1: meetings every 60 min"). Ask for the Teams channel name and join link if they have one; a pasted Teams invite is enough, pull the link out of it.
   - **Teams to engage now** (optional), from `teams`.

3. **Wait for the analyst's yes or edits.** Then call `open_incident` with a fresh UUID as `idempotency_key`. Include `meeting_schedule` only if the analyst changed the default or gave a channel/link.

4. **Announce it** in two lines: codename and id ("**Amber Heron** (INC-2026-0042) is open, P2"), and tell them colleagues join with "connect to Amber Heron". Mention any `suggested_engagements` and `compliance_not_attached` questions still open.

5. **Ingest the starting evidence.** If the analyst pasted an alert or description, follow the **ingest-evidence** skill on it now.

6. **Engagements.** For each team the analyst chose, call `set_engagement` with `status: requested`. For Detection Engineering, attach a recommendation (see ingest-evidence).

## Rules

- Never invent facts for the title or summary. If the input is thin, say what is missing.
- One incident per real-world event. If `list_incidents` shows an open incident that looks like the same event, ask whether to connect to it instead.
