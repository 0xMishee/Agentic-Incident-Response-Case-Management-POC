---
name: case-digest
description: Catch up on an incident. Use when an analyst asks "anything new?", "what did the others find?", "what should I do next?", or a manager or lead asks "what's going on with <incident>?", "status", "what's overdue?", "give me the numbers". Gives analysts a ranked digest plus next steps, and managers a needs-action status view.
---

# Case digest

The analyst's role is `${user_config.analyst_role}`. Pick the mode from the question, not only the role: a manager asking "anything new" still wants the analyst digest.

## Analyst mode ("anything new?", "what should I do next?")

1. `get_updates`. Lead with tier-1 items (correlation flags, engineering deliveries), then items whose `why` says they touch the analyst's own IOCs, hosts or users. Max 5 items, one line each, naming who added it.
2. Reminders: a meeting within 15 minutes (with join link), the analyst's open actions (say if carried over), compliance due within 12 h, and suggestions waiting for review (from the Teams bot, the mailbox or people without Claude). Offer to go through them with `list_suggestions` / `decide_suggestion`.
3. `get_next_steps`, then give **at most 3 recommended next steps**. Each must point at a fact from the result: "RND-LT-007 is still *compromised*: isolate it or ask IT Ops", "3 IOCs have no verdict", "Detection Engineering was suggested and nobody decided". No generic advice.

If nothing is new, say so in one line and still give the next steps.

## Manager mode ("what's going on?", "status")

1. `get_status`.
2. Start with **Needs action** (the `needs_action` list, most urgent first). If it is empty, say "Nothing needs you right now."
3. Then a five-line picture: priority and status, what is known (counts, compromised assets, malicious IOCs), next meeting and actions per person, compliance (each open step with due time and hours left), engagements (status, any overdue).
4. Offer the obvious actions: mark a compliance step done (needs the submission reference), change priority, chase an engagement.

## Manager actions

- **Compliance**: `set_compliance_step`. Done needs the evidence the track lists, usually `submission_reference`. Ask for it; never make one up.
- **Priority or status**: `update_field` with `expected_seq` from your last read. On `conflict`, show both values and ask.
- **Closing**: only from Resolved. If refused, read out the blockers.

Keep it short: managers read this on a phone between calls.
