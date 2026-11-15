---
name: ingest-evidence
description: Add evidence to the connected incident. Use whenever the analyst pastes or drops an alert, log excerpt, email, EDR/SIEM output, IOC list, screenshot description or a finding while connected to an incident, or says "add this", "put this in the case", "log this". Extracts timeline entries, IOCs, assets, techniques and CVEs per the team template, previews, then writes.
---

# Ingest evidence

The server is the source of truth and checks what you send. Your job is to read the messy input and turn it into clean, typed facts that follow the team's template.

## Steps

1. **Store the raw input first.** `add_artifact` with a sensible `kind` (alert, log, email, screenshot, note, ioc_list, other) and `filename` (e.g. `ALRT-881.json`). Keep the returned `artifact_id`.

2. **Read the rules.** `get_template` once per session. Follow each section's `instructions`, the allowed `phases` and IOC `types`.

3. **Extract.**
   - **Timeline**: one entry per thing that happened. `time` = the event's own timestamp from the data, with its timezone exactly as given (the server converts to UTC). Never use the time it was pasted. `source` = alert or log id. `actor` = user, host or process. `phase` = one of the template phases, or leave it out if unsure. `confidence` = how sure the analyst is, 0–100 (see below).
   - **IOCs**: every IP, domain, URL, hash and email that matters. Defanged is fine. Set `verdict` only when the evidence supports it; otherwise leave it out. `external: true` for things outside the organisation.
   - **Assets**: hosts and accounts involved, with `state` (suspected, compromised, contained, clean).
   - **Techniques** (`ttp`) when the behaviour clearly maps to MITRE ATT&CK, and **CVEs** when named.
   - **Emails** (pasted mail, `.eml`, a forwarded thread): one `correspondence` item per email with `direction`, `party` (regulator, csirt, supplier, customer, legal, law_enforcement, insurer, internal, other), `from`, `to`, `subject`, `sent_at` and a one- or two-line `summary`. Set `related_step` (e.g. `nis2/early-warning`) when the email serves a compliance step. Then extract any facts in the email body as usual (IOCs, timeline).
   - **Notes** for findings that do not fit elsewhere. Tasks only when the analyst asks for one.
   - Put `source_artifact: <artifact_id>` on every item.

4. **Preview** in one line plus a compact list: "4 timeline entries, 6 IOCs (2 external), 2 assets, 1 technique. Add?" Skip the preview only if the template says `confirm_before_write: false` or the source is in `trusted_sources`.

5. **Write everything in one `add_events` call** with a fresh UUID `idempotency_key`.

6. **Report back in a few lines**:
   - What was added and what was deduplicated (a colleague already had it).
   - **Correlation flags**: say clearly "203.0.113.66 was also seen in Quiet Lynx (INC-2026-0031)". This matters.
   - **Suggested engagements**: name the team and the reason, and ask whether to request it.

## Confidence on timeline entries

Every timeline entry carries how sure the analyst is. Leave it at **100** (omit it) when the entry comes straight from an alert or log, or the analyst states it as fact. Lower it only when the analyst hedges, and say in the preview what you set:

| The analyst says | Confidence |
| --- | --- |
| "very likely", "almost certainly", "pretty sure" | 85 |
| "I think it was…", "probably", "looks like" | 70 |
| "maybe", "might have", "possibly", "could be" | 50 |
| "just a guess", "no idea, but", "worst case" | 25 |

If they give a number ("60% sure"), use it. When a later finding confirms or weakens an entry, offer to update it: `update_item` with `kind: timeline`, the entry's id, `changes: {confidence, reason}` ("Confirmed by proxy logs").

## Requesting Detection Engineering

When the evidence shows behaviour that should be detected in future (a malicious inbox rule, an OAuth consent to an unknown app, exfil to a new domain), offer to request Detection Engineering. On yes, call `set_engagement` with `team_id: detection-eng`, `status: requested`, `request_type` (detection_rule, dashboard, hunt_query or tuning) and a `recommendations` entry:

- `title`: what to detect, in plain words.
- `rationale`: two sentences on why, from this incident.
- `evidence`: the event ids from your `add_events` result (and alert ids).
- `draft`: a first query in the team's language (KQL for Microsoft Sentinel/Defender unless told otherwise), or `panels` for a dashboard. Mark it a draft; the engineer owns the final version.
- `mitre`: technique ids.

## Rules

- Never fabricate timestamps, IOCs or verdicts. If a time has no timezone, ask, or say which zone you assumed.
- If `add_events` returns `invalid`, fix that item and resend the whole call with a new key.
- Mistakes are corrected with `retract_event` (with a reason), never by pretending they did not happen.
