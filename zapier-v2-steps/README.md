# Call Intelligence v2 — Partner-Sync Pipeline (Zapier)

Replaces the Pipedream architecture in `../pipedream-steps/` for a specific, narrower
job: partner-sync calls (Socure, Zenoo, ZoomInfo, Signicat, Oscilar) that each discuss
many end-customer companies in one call. The Pipedream pipeline assumed one call maps
to one HubSpot deal — that assumption doesn't hold for these calls and is removed
entirely in this design.

**Scope: partner-sync calls only.** Direct 1:1 sales calls already log correctly via
Apollo's native HubSpot integration and this pipeline must never touch them. The Filter
step (01) only acts on calls whose topic matches a known-partner pattern — everything
else is left completely alone.

## Why this exists — the multi-company extraction model

A partner-sync call (e.g. "Socure / Markaaz Partnership") is Markaaz and a partner
reviewing shared pipeline together. One call transcript can name a dozen or more
distinct end-customer companies, each with its own sentiment, next step, and
objections — none of which have anything to do with each other. Validated live against
the 2026-08-26 Socure/Markaaz Partnership call (conversation
`6a8f11e33a32c300204a75e7`): **12 companies extracted from one transcript**, each with
independently accurate sentiment/next-step/objection extraction — including catching
the Swipe Jobs $11M-vs-$300K contract-figure discrepancy as a real, specific objection
rather than a generic "pricing concerns" note. That's the bar the enrichment prompt
(Step 3) is written to hit.

So the pipeline fans out: **one call in → many company records out → each company
independently matched to its own `{Partner} - {Company}` deal and written
independently.** A miss on one company (no matching deal) never blocks or corrupts the
others.

## Known partners (hardcoded match list)

```
Socure, Zenoo, ZoomInfo, Signicat, Oscilar
```

Defined at the top of `01-filter-partner-calls.js` as `KNOWN_PARTNERS`. A call's topic
matches a partner when, case-insensitively and in any order, it contains: the partner's
name, **and** "markaaz", **and** one of `partnership | sync | weekly | bi-weekly`. So
all of these match Socure:

- "Socure / Markaaz Partnership"
- "Socure x Markaaz weekly sync"
- "Markaaz bi-weekly — Socure"

**To add a new partner:** add its name to the `KNOWN_PARTNERS` array in
`01-filter-partner-calls.js`. Nothing else needs to change — the pattern matching is
name + "markaaz" + sync-keyword, independent of the specific partner name.

## Unlisted-partner detection

If a call's topic contains "Markaaz" but doesn't match any known partner's pattern
(new partner not yet added to the list, a naming variant, or just an unrelated
"Markaaz" mention), the Filter step does **not** process it automatically. It's added
to `unlistedPartnerFlags` in the run report as "possible unlisted partner call — needs
review", with the raw topic and conversation ID, so it surfaces for a human rather than
silently getting dropped as the partner roster grows. This deliberately over-flags
(any "Markaaz" mention that isn't a clean known-partner match gets flagged, even
without a sync keyword) — a false-positive flag costs a human one glance at a report
row; a missed real partner call costs nothing being noticed until someone goes looking.

## The 5 files

| File | Zapier step type | Runs |
|---|---|---|
| `01-filter-partner-calls.js` | Code by Zapier | Once per hourly poll |
| `02-fetch-transcript.js` | Code by Zapier | Once per matching call (outer loop) |
| `03-claude-enrichment.js` | Code by Zapier | Once per matching call (outer loop) |
| `04-deal-matching.js` | Code by Zapier | Once per extracted company (inner loop) |
| `05-write-deal-and-note.js` | Code by Zapier | Once per extracted company (inner loop) |

Full wiring instructions, including the native (non-code) Storage by Zapier dedup step,
the two nested Looping by Zapier steps, and the Digest by Zapier report, are in
`../docs/zapier-v2-setup.md`.

## What's written to HubSpot (4 deal properties, not the old 6)

Same property set as the corrected Pipedream design (see `../README.md`), minus
`next_step_date` — this design's Write step (05) only writes the 4 properties the task
scope calls for:

| Property | Internal name |
|---|---|
| Next Step | `hs_next_step` (HubSpot built-in) |
| Last Call Sentiment | `last_call_sentiment` |
| Last Call Date | `last_call_date` |
| Last Call Unresolved Objections | `last_call_unresolved_objections` |

Plus a new HubSpot note per matched company, containing the raw extracted summary of
what was actually said about that company — the durable record, separate from the
structured properties.

## Endpoints that need verification before deploying

`01-filter-partner-calls.js` and `02-fetch-transcript.js` call Apollo's Conversation
Intelligence REST API (`/api/v1/conversations/search`,
`/api/v1/conversations/{id}/transcript`). These paths were **not independently
confirmed** against Apollo's live API docs in the session that built this pipeline —
they mirror this repo's established Apollo auth convention (X-Api-Key + User-Agent,
same base URL as the Organizations API already used elsewhere in markaaz-gtm) but the
Conversations paths themselves need a check against developer.apollo.io (or Apollo
support) before the first live run. If the real paths differ, only the two fetch
helper functions in those two files need to change — everything downstream consumes
their already-normalized output and doesn't care about the wire format.

## What this pipeline never touches

Apollo's own native call-logging (its Calls/Engagements entries on contacts/deals) is
never modified, deleted, or re-associated by any step here. This pipeline only writes
deal properties and adds new notes — it reads from Apollo, it doesn't write back to it.
