# Postmortem: <title>

> Blameless. The goal is to understand how the system — code, tooling, process — made the failure possible,
> not who pressed which button.

| | |
|---|---|
| **Date / duration** | YYYY-MM-DD HH:MM–HH:MM UTC (N min) |
| **Severity** | SEV1 / SEV2 / SEV3 |
| **Authors** | |
| **Status** | Draft / Reviewed / Actions complete |
| **Lab / scenario** | e.g. `payment-limbo` during `gameday-psp-brownout` |

## Summary

Two or three sentences a non-engineer can read: what customers experienced, for how long, and the business impact.

## Customer and business impact

| Measure | Value | Source |
|---|---|---|
| Customers unable to check out | | loadgen sessions failed / War Room |
| Peak error rate / p99 latency | | Grafana war room |
| Oversold units | | integrity panel |
| Duplicate / orphan charges (refunds owed) | | integrity panel |
| Orders not fulfilled | | integrity panel (lost events) |
| GMV lost (estimate) | | GMV/min before vs during |

## Timeline (UTC)

| Time | Event |
|---|---|
| | First symptom (metric / customer report) |
| | First alert |
| | Incident declared |
| | Mitigation applied |
| | Customer impact ends |
| | Root cause identified |
| | Data repaired |

## Root cause

What failed, and why the system allowed it. Include the code path (`server/src/...`) and the mechanism
(race, lock cycle, retry amplification…). Use the "5 whys" if it helps.

## Detection

- How was it detected? How long after it started?
- Which alert *should* have fired first? Did it? Was it actionable?
- Were dashboards showing it before anyone looked?

## Response and mitigation

What was tried, what worked, what made it worse. Was the mitigation a flag, a capacity change, a rollback?

## What went well / what went poorly / where we got lucky

-
-
-

## Action items

| Action | Type (prevent / detect / mitigate) | Owner | Due |
|---|---|---|---|
| | | | |

## Data repair

How the damage was reconciled: refunds for orphan/duplicate charges, cancelled oversold orders, re-published events,
corrected prices. Which queries found the affected rows.
