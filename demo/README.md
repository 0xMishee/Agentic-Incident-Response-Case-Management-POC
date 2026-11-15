# Demo: the Truffle Thief

Everything in this folder is **fictional**. Bittersweet Fjord Chocolate Co., the Truffle Thief, Golden
Pod Cocoa Traders and every person, host and account are made up. Domains use the reserved `.test` and
`.example` names; IP addresses come from the documentation ranges (192.0.2.0/24, 198.51.100.0/24,
203.0.113.0/24). Nothing here points at anything real.

## The story

A mid-size EU chocolate maker. The Truffle Thief wants **Recipe No. 7**, the secret praline recipe in
the R&D "Recipe Vault", and on the side tries to divert cocoa-bean payments.

1. 06:41 UTC: a fake invoice from "Golden Pod Cocoa Traders" reaches a finance clerk. At 06:58 they click.
2. 07:03: the clerk consents to an OAuth app, "CocoaInvoice Sync", with mail read/write.
3. 07:09: the app adds an inbox rule forwarding every "invoice" or "bank details" mail outside.
4. 07:41: the stolen token is used on the R&D chocolatier's laptop, which syncs the Recipe Vault.
5. 08:15: `recipe_no7.zip` is staged. 08:22: 48 MB goes to `truffle-cdn.test` (203.0.113.66).
6. 09:31: a fake "new bank details" request arrives in finance.

203.0.113.66 was already seen last month in a credential-stuffing attack on the web shop (**Quiet
Lynx**), so the case server flags the two incidents as related.

## Run it

```sh
cd incident-mcp
npm run demo:seed -- --reset   # writes ../data (the server must be stopped)
npm run demo:start             # server clock starts at 14 Nov 2026 09:48 UTC, then runs normally
```

On Windows PowerShell with scripts disabled, use `npm.cmd` instead of `npm`.

`--stage full` (default) seeds five incidents, including **Amber Heron** already worked by six people.
`--stage video` seeds only the four background incidents, so Amber Heron can be opened live.

| Incident | Priority | Status | What it shows |
| --- | --- | --- | --- |
| Amber Heron | P1 | Open | The full case: 4 analysts, manager, engineer, NIS2 + GDPR, two meetings, a carried-over action, correlation, confidence |
| Cobalt Otter | P3 | Open | A Detection Engineering request overdue |
| Sable Wren | P4 | Open | GDPR clock on a lost laptop; a 50%-confidence timeline entry |
| Quiet Lynx | P3 | Resolved | Last month's incident that Amber Heron correlates with |
| Velvet Pine | P2 | Closed | A finished case |

`sample-report.md` is what `data/incidents/<id>/report.md` looks like for Amber Heron.

## Six people on one machine

The plugin's options set one identity for your whole user account. For the demo, start each terminal
as a persona instead (the plugin still provides the skills, `/incident` and the session hook):

```
demo\personas\persona.cmd analyst-a lead
demo\personas\persona.cmd analyst-b analyst
demo\personas\persona.cmd analyst-c analyst
demo\personas\persona.cmd analyst-d analyst
demo\personas\persona.cmd manager manager
demo\personas\persona.cmd engineer engineer detection-eng
```

macOS/Linux/Git Bash: `demo/personas/persona.sh analyst-b analyst`.

## Evidence to paste

`alerts/` holds the raw evidence the analysts paste in the video. Paste a file into a persona's session
after "connect to Amber Heron", or drop its path in:

| File | Who pastes it | What Claude should find |
| --- | --- | --- |
| `ALRT-881.json` | analyst-a (opens the incident) | phishing click, sender, URL, clerk's laptop |
| `ALRT-884.json`, `ALRT-890.json` | analyst-b | OAuth consent, forwarding rule, attacker IP |
| `EDR-5521.json`, `EDR-5527.json` | analyst-c | token reuse on the R&D laptop, recipe archive |
| `PROXY-77120.log` | analyst-d | exfil to truffle-cdn.test; times in CET, converted to UTC; flags Quiet Lynx |
| `bank-change-request.eml` | analyst-b | the payment-diversion attempt |
| `quiet-lynx-waf.log`, `supplier-portal-signins.json` | seed only | background incidents |

## Video script (about 7 minutes)

1. **Open** (analyst-a): paste `ALRT-881.json`, "open an incident for this". P2, NIS2 and GDPR yes, default meeting cadence.
2. **Swarm** (b, c, d at the same time): "connect to Amber Heron", paste their files.
3. **Correlation** (d): Claude reports 203.0.113.66 also in Quiet Lynx. Lead raises priority to P1.
4. **Recommendations** (c): "anything new?" Claude surfaces b's OAuth app as the way onto c's laptop.
5. **Engineering** (b, then engineer): b requests a detection for the forwarding rule; the engineer runs `/incident queue`, refines the KQL, delivers it as DET-1042.
6. **Incident meetings** (a): `/incident meeting brief`, then record actions per person. Next meeting: outcomes, one carried over.
7. **Manager**: "What's going on with Amber Heron?" Marks the NIS2 early warning done with reference CSIRT-2026-1187.
8. **Resolve** (a): set Resolved, then try Closed. Refused: GDPR steps still open.

For a short video set `demo.meeting_minutes: 5` in `config/settings.yml` so two meetings fit.
