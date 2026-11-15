---
id: INC-2026-0010
codename: "Amber Heron"
title: "Truffle Thief: invoice phish and recipe theft"
priority: P1
status: Open
lead: analyst-a
detected_at: 2026-11-14T07:12:00Z
opened_at: 2026-11-14T07:12:00Z
opened_by: analyst-a
template: default@1
compliance: [nis2, gdpr]
next_meeting: 2026-11-14T10:00:00Z
seq: 89
---

# Amber Heron (INC-2026-0010)

**Truffle Thief: invoice phish and recipe theft** · P1 · Open · Lead: analyst-a

## Executive summary

A finance clerk opened a fake Golden Pod Cocoa Traders invoice and granted the app "CocoaInvoice Sync" access to their mailbox. The attacker forwarded invoice mail outside the company, reached the R&D chocolatier's laptop with the stolen token and sent recipe_no7.zip to truffle-cdn.test. The app is revoked for the clerk; the laptop is not yet isolated. The same IP hit the web shop last month (Quiet Lynx).

## Incident meetings

:::meetings
- Cadence: every 60 min
- Next meeting: 2026-11-14 10:00Z
- Channel: IR - Amber Heron · [Join](https://teams.example/meet/amber-heron)
- Chair: analyst-a

**Open actions**

| Owner | Action | Due | Status | Carried over |
| --- | --- | --- | --- | --- |
| analyst-b | Revoke CocoaInvoice Sync tenant-wide | 2026-11-14 10:00Z | open | no |
| analyst-c | Isolate RND-LT-007 (chocolatier laptop) | 2026-11-14 09:00Z | open | yes |
| analyst-d | Block truffle-cdn.test and goldenpod-invoices.test at the proxy | 2026-11-14 10:00Z | open | no |
| engineer | Ship detection for OAuth consent to unverified apps | 2026-11-14 10:00Z | open | no |
| manager | Warn Golden Pod about the fake bank-change request | 2026-11-14 10:00Z | open | no |

**Meeting log**

| Time (UTC) | Held | Chair | Attendees | Notes | Actions closed |
| --- | --- | --- | --- | --- | --- |
| 2026-11-14 08:00Z | yes | analyst-a | analyst-a, analyst-b, analyst-c, analyst-d | Scope: one finance mailbox so far. Check whether the token was used elsewhere. | – |
| 2026-11-14 09:00Z | yes | analyst-a | analyst-a, analyst-b, analyst-d, manager | Recipe No. 7 confirmed exfiltrated. Raised to P1. Linked to Quiet Lynx via 203.0.113.66. Finance warned about bank-change requests. | Revoke CocoaInvoice Sync for the clerk: Revoked for the clerk; tenant-wide check still needed; Pull proxy logs for goldenpod and anything new from finance and R&D: Found the 48 MB upload to truffle-cdn.test |
:::

## Compliance

:::compliance
**NIS2 significant incident (Art. 23)** · clock from 2026-11-14 07:12Z

| Step | Due (UTC) | Status | Evidence |
| --- | --- | --- | --- |
| Early warning to CSIRT / competent authority | 2026-11-15 07:12Z | done | submission_reference: CSIRT-2026-1187 |
| Incident notification with initial assessment | 2026-11-17 07:12Z | todo | – |
| Final report | 1mo after "notification" is done | todo | – |

**GDPR personal data breach (Art. 33/34)** · clock from 2026-11-14 07:12Z

| Step | Due (UTC) | Status | Evidence |
| --- | --- | --- | --- |
| Assess risk to individuals | 2026-11-15 07:12Z | in_progress | – |
| Notify supervisory authority | 2026-11-17 07:12Z | todo | – |
| Inform affected individuals | without undue delay | todo | – |

:::

## Waiting for review

:::proposals
- **R&D laptop was connected to a Trondheim factory line PC on Thursday** · from Plant manager (Trondheim) via teams-meeting · Incident meeting 09:00 · 2 item(s)
  > That R&D laptop was plugged into one of our line PCs in Trondheim on Thursday, for the new praline mould settings.
- **Bank blocked an attempt to add a fake Golden Pod payee at 09:12** · from Treasury (Oslo) via teams-chat · Teams chat: IR - Amber Heron · 2 item(s) · [message](https://teams.example/l/message/ir-amber-heron/1731575820)
  > FYI our bank just called. Someone tried to add a new payee 'Golden Pod Cocoa Traders Ltd' with a foreign IBAN to our account at 09:12. They blocked it and want us to confirm.
- **Email from security@goldenpod.example: RE: Invoices sent in your name from goldenpod-invoices.test** · from security@goldenpod.example via email · Email: RE: Invoices sent in your name from goldenpod-invoices.test · 1 item(s)
  > Thank you. We did not send invoice 7731 and we have not changed bank details. Our only domain is goldenpod.example. Two other customers reported the same mails this morning.

| Decided (UTC) | From | Via | Suggestion | Decision | By |
| --- | --- | --- | --- | --- | --- |
| 2026-11-14 09:04Z | Finance controller | teams-meeting | No payment has gone to new bank details | accepted | analyst-a |
| 2026-11-14 09:42Z | intake@csirt.example | email | Email from intake@csirt.example: Receipt CSIRT-2026-1187: early warning received | accepted | manager |
:::

## Timeline

:::timeline
| Time (UTC) | Source | Actor | Description | Phase | Confidence | Added by |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-14 06:41:37Z | ALRT-881 | billing@goldenpod-invoices.test | Phishing mail "Golden Pod Cocoa Traders invoice 7731 - overdue" delivered to the finance clerk | Initial access | 100% | analyst-b |
| 2026-11-14 06:58:11Z | ALRT-881 | clerk@bittersweet.example | Clerk clicks the fake invoice link to goldenpod-invoices.test | Initial access | 100% | analyst-b |
| 2026-11-14 07:03:22Z | ALRT-884 | clerk@bittersweet.example | Clerk consents to unverified OAuth app "CocoaInvoice Sync" with Mail.ReadWrite and Mail.Send | Persistence | 100% | analyst-b |
| 2026-11-14 07:09:48Z | ALRT-890 | CocoaInvoice Sync | App creates inbox rule forwarding mail with "invoice" or "bank details" to ledger-copy@truffle-mail.test | Collection | 100% | analyst-b |
| 2026-11-14 07:30Z | EDR-5521 | – | Attacker probably browsed the Recipe Vault site before syncing it | Collection | 90% | analyst-c |
| 2026-11-14 07:41:15Z | EDR-5521 | 192.0.2.14 | Clerk's stolen token used on RND-LT-007, the R&D chocolatier laptop syncing the Recipe Vault | Lateral movement | 100% | analyst-c |
| 2026-11-14 08:15:02Z | EDR-5527 | 7z.exe | recipe_no7.zip (48 MB, label "Bittersweet Secret - Recipes") created in the vault sync folder | Collection | 100% | analyst-c |
| 2026-11-14 08:22:05Z | PROXY-77120 | RND-LT-007 | 48 MB upload from RND-LT-007 to truffle-cdn.test (203.0.113.66) | Exfiltration | 100% | analyst-d |
| 2026-11-14 09:05Z | Manual | – | CocoaInvoice Sync consent revoked for the clerk; inbox rule removed | Containment | 100% | analyst-b |
| 2026-11-14 09:31Z | Email | billing@goldenpod-invoices.test | Fake "new bank details" request for invoice 7731 arrives in finance; caught before payment | Impact | 100% | analyst-b |
:::

## Indicators

| Type | Value | First seen | Sources | Verdict | External |
| --- | --- | --- | --- | --- | --- |
| domain | `goldenpod-invoices[.]test` | – | ALRT-881, PROXY-77101 | malicious | yes |
| url | `hxxps://goldenpod-invoices[.]test/inv/7731` | – | ALRT-881 | malicious | yes |
| email | `billing[@]goldenpod-invoices.test` | – | ALRT-881 | malicious | yes |
| ipv4 | `198.51.100[.]23` | – | ALRT-881 | suspicious | yes |
| email | `ledger-copy[@]truffle-mail.test` | – | ALRT-890 | malicious | yes |
| ipv4 | `192.0.2[.]14` | – | ALRT-884 | malicious | yes |
| sha256 | `9f2c7d1e6a4b8c03f5e2d17a9b6c4e81d0f3a2b5c7e9d1f4a6b8c0e2d4f6b04a` | – | EDR-5527 | suspicious | no |
| domain | `truffle-cdn[.]test` | – | PROXY-77120 | malicious | yes |
| ipv4 | `203.0.113[.]66` | – | PROXY-77120 | malicious | yes |

## Techniques and vulnerabilities

| Kind | Id | Name / product | Notes | Added by |
| --- | --- | --- | --- | --- |
| Technique | T1566.002 | Phishing: spearphishing link | – | analyst-b |
| Technique | T1528 | Steal application access token | – | analyst-b |
| Technique | T1114.003 | Email forwarding rule | – | analyst-b |
| Technique | T1560.001 | Archive via utility | – | analyst-c |
| Technique | T1567 | Exfiltration over web service | – | analyst-d |

## Affected assets

| Host | User | Owner | State |
| --- | --- | --- | --- |
| FIN-LT-042 | clerk@bittersweet.example | Finance | compromised |
| RND-LT-007 | chocolatier@bittersweet.example | R&D | compromised |
| Recipe Vault (SharePoint) | – | R&D | compromised |

## Correlation flags

:::correlations
| Kind | Match | Other incident | Decision |
| --- | --- | --- | --- |
| ioc_exact | `ipv4 203.0.113.66` | INC-2026-0002 (Quiet Lynx) | linked |
:::

## Team engagements

:::engagements
| Team | Request | Status | Requested | Outcome / reason |
| --- | --- | --- | --- | --- |
| CTI | enrichment | engaged | 2026-11-14 08:50Z | Enrich truffle-cdn.test, goldenpod-invoices.test and 203.0.113.66; link to Quiet Lynx |
| Detection Engineering | detection_rule | delivered | 2026-11-14 07:35Z | Rule DET-1042 "Inbox rule forwarding finance mail externally" deployed to Sentinel |
| Vulnerability Management | asset_exposure | requested | 2026-11-14 08:55Z | Exposure of RND-LT-007 and FIN-LT-042 |
| Communications | – | suggested | – | Suggested by rule "priority.changed when priority >= P1" after: priority set to P1 |
| Detection Engineering | detection_rule | engaged | 2026-11-14 09:10Z | OAuth consent to an unverified app with Mail.ReadWrite |
| Detection Engineering | dashboard | requested | 2026-11-14 09:20Z | Recipe Vault access dashboard |

**Recommendations**

- **Inbox rule forwarding invoices externally** (detection_rule, for Detection Engineering, by analyst-b) · T1114.003
  An attacker-controlled app created a rule forwarding invoice and bank-detail mail outside the company. Nothing alerted on the rule itself until the app alert fired.

  ```kql
  OfficeActivity
  | where Operation in ("New-InboxRule", "Set-InboxRule")
  | where Parameters has_any ("ForwardTo", "RedirectTo", "ForwardAsAttachmentTo")
  | where Parameters has_any ("invoice", "bank", "payment")
  | project TimeGenerated, UserId, ClientIP, Parameters
  ```

- **OAuth consent to an unverified app with Mail.ReadWrite** (detection_rule, for Detection Engineering, by analyst-b) · T1528, T1550.001
  The Truffle Thief got in through one consent to "CocoaInvoice Sync". No rule fired on the consent itself; we caught it only from the phishing alert.

  ```kql
  AuditLogs
  | where OperationName == "Consent to application"
  | extend App = tostring(TargetResources[0].displayName)
  | extend Perms = tostring(TargetResources[0].modifiedProperties)
  | where Perms has_any ("Mail.ReadWrite", "Mail.Send")
  | where tostring(AdditionalDetails) !has "verifiedPublisher"
  | project TimeGenerated, InitiatedBy, App, Perms
  ```

- **Recipe Vault access dashboard** (dashboard, for Detection Engineering, by analyst-c) · T1213.002, T1567
  recipe_no7.zip was staged from the Recipe Vault sync folder. Leadership wants to see who touches the vault and how much leaves it, per day.
  - Panel "Vault file access by user, per hour" (timechart): `OfficeActivity | where Site_Url has "/sites/recipe-vault" | summarize Files = dcount(OfficeObjectId) by UserId, bin(TimeGenerated, 1h)`
  - Panel "Downloads and syncs over 20 files in an hour" (table): `OfficeActivity | where Site_Url has "/sites/recipe-vault" and Operation in ("FileDownloaded", "FileSyncDownloadedFull") | summarize n = count() by UserId, bin(TimeGenerated, 1h) | where n > 20`
  - Panel "Vault users signing in from new devices" (table): `SigninLogs | where UserPrincipalName in (vault_users) | where DeviceDetail.deviceId !in (known_devices)`
:::

## Correspondence

:::correspondence
| Sent (UTC) | In/out | Party | From / to | Subject | Summary | Compliance step |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-14 08:58Z | Out | supplier | security@goldenpod.example | Invoices sent in your name from goldenpod-invoices.test | Warned Golden Pod that a look-alike domain sends fake invoices and bank-change requests; asked them to confirm their real domain. | – |
| 2026-11-14 09:20Z | Out | legal | counsel@lawfirm.example | Privileged: theft of recipe trade secret | Asked outside counsel whether to report the recipe theft to the police and how to preserve evidence. | – |
| 2026-11-14 09:33Z | Out | csirt | intake@csirt.example | NIS2 early warning: significant incident at Bittersweet Fjord Chocolate Co. | Early warning: suspected criminal act, possible impact on payments to suppliers; no cross-border impact known yet. | nis2/early-warning |
| 2026-11-14 09:39Z | In | csirt | intake@csirt.example | Receipt CSIRT-2026-1187: early warning received | CSIRT confirms receipt, reference CSIRT-2026-1187; notification due within 72 h. | – |
:::

## Tasks

_None yet._

## Analyst notes

- 2026-11-14 07:30Z **analyst-b**: OAuth app id 11111111-2222-3333-4444-555555555555, publisher not verified, reply URL on goldenpod-invoices.test.
- 2026-11-14 09:04Z **analyst-a**: Finance controller: invoice 7724 to Golden Pod was paid last week to the usual account; no payment to new bank details so far.

## Artifacts

| Id | Kind | File | SHA-256 | Added by | Added |
| --- | --- | --- | --- | --- | --- |
| art_01M7FWHS2GGJ7KPVQF69Z3R3A9 | alert | ALRT-881.json | fe047ac557b7d6e8… | analyst-b | 2026-11-14 07:20Z |
| art_01M7FWHS2XYMARQKK2GPV4XKRX | alert | ALRT-884.json | d5d78f27bf1d8568… | analyst-b | 2026-11-14 07:30Z |
| art_01M7FWHS332XJRC8DV4CWT8QX3 | alert | ALRT-890.json | 8a8b8767cbb09431… | analyst-b | 2026-11-14 07:30Z |
| art_01M7FWHS41PM4A570B9QWD2F3N | alert | EDR-5521.json | 8c58910e52f1f17a… | analyst-c | 2026-11-14 08:30Z |
| art_01M7FWHS479G1PVPZD4Q6E7W90 | alert | EDR-5527.json | 55bea576aba7b9d9… | analyst-c | 2026-11-14 08:30Z |
| art_01M7FWHS4RWVMFS0NTTPWCE0SV | log | PROXY-77120.log | 9471e25218f6520d… | analyst-d | 2026-11-14 08:40Z |
| art_01M7FWHS7SR61GESB6ZTV441C9 | email | bank-change-request.eml | cbd36d08f6939e17… | analyst-b | 2026-11-14 09:31Z |
| art_01M7FWHS8TWPAA1NSPNGDKGGV5 | email | Receipt_CSIRT-2026-1187_early_warning_received.eml | 419919e16110669a… | mail-connector | 2026-11-14 09:40Z |
| art_01M7FWHS9C11VED1M8974HPQP5 | email | RE_Invoices_sent_in_your_name_from_goldenpod-invoices.test.eml | a7e7100830b24f86… | mail-connector | 2026-11-14 09:44Z |
