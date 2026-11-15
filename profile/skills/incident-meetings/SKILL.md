---
name: incident-meetings
description: Run the incident's recurring meetings (brief before, actions and outcomes after). Use when someone asks for the meeting brief or agenda, says "meeting in 5 minutes", "prep the sync", or after a meeting says "record the meeting", "here are the notes", "log the actions", or wants to change the meeting cadence, Teams channel or link.
---

# Incident meetings

Meetings run on a fixed cadence (P1 default: every 60 min). Each meeting reviews last meeting's actions, then hands out new ones. Every action has exactly one owner.

## Before the meeting: the brief

Call `get_meeting_brief` and format it for screen-share, in this order:

1. **Header**: codename, priority, status, meeting time, join link.
2. **Actions from last meeting**, grouped by person: `analyst-b: Revoke CocoaInvoice Sync (due 11:00)`. Mark carried-over ones **(carried over)**.
3. **Since last meeting**: the count, then the 5–8 most important changes, one line each with who added them.
4. **Deadlines before the following meeting**: compliance steps and engagement deadlines, overdue ones first.
5. **Open questions**: unassigned tasks, correlation flags to decide, suggested engagements to decide.
6. **Waiting for review**: suggestions from the Teams meeting bot, the incident mailbox and people without Claude (`open_questions.waiting_for_review`). For each: who said it, the quote, what it would add. The meeting decides them.

## Deciding suggestions

The Teams bot listens in the meeting and reads the incident chat, and suggests what sounded worth adding: a plant manager saying a laptop was plugged into a factory PC, or treasury writing in the chat that the bank blocked a fake payee. Each suggestion has the quote and, for chat, a link to the message. Nothing is in the case until someone accepts it. When the chair decides, call `decide_suggestion` with `accepted` (optionally only some `item_indexes`) or `rejected` with a short reason. Never accept without the chair's or analyst's yes.

## After the meeting: record it

The chair gives you notes in any shape. Turn them into one `record_meeting` call:

- `attendees`: names as they appear in the case.
- `outcomes`: for **every** open action from the brief, a `task_id`, `status` (done, in_progress, cancelled, or open if nothing happened) and a one-line `outcome`. If the notes do not say, ask. Do not invent outcomes. Actions left out are carried over and flagged.
- `actions`: new actions, each with exactly one `assignee`. Split "b and c check the laptops" into two actions. `due` defaults to the next meeting; set it only if the chair gave a time.
- `notes`: decisions in two or three lines.

Show the analyst what you will record (outcomes and new actions per person), write on yes with a fresh UUID `idempotency_key`, then confirm the next meeting time.

## Changing the schedule

`set_meeting_schedule` with `cadence_minutes` (0 = ad hoc), `next_at`, `channel_name`, `join_url`, `chair`. A pasted Teams invite is enough: pull the join link and meeting title out of it. A meeting that did not happen → `skip_meeting` with a reason.
