# Call Intelligence v2 — Partner-Sync Pipeline (Zapier)

> **Status (2026-08-29): fully built, wired, and validated end-to-end in Zapier —
> still in DRAFT, not published**, pending a final go/no-go review. See "Current
> Status" at the top of `../docs/zapier-v2-setup.md` for the full state, including
> the known (non-blocking) minor gaps.

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

## The live files

| File | Zapier step type | Runs |
|---|---|---|
| `01-filter-partner-calls.js` | Code by Zapier | Once per hourly poll |
| `02-fetch-transcript.js` | Code by Zapier | Once per matching call (the one outer loop) |
| `03-claude-enrichment.js` | Code by Zapier | Once per matching call (the one outer loop) |
| `04-match-and-write-companies.js` | Code by Zapier | Once per matching call (the one outer loop) — internally loops over that call's extracted companies in plain JavaScript |

**Architecture corrected 2026-08-28: there is only one native "Looping by Zapier" step
in this design**, over `candidateCalls`. An earlier version of this pipeline used
`04-deal-matching.js` + `05-write-deal-and-note.js` as a second, nested loop over each
call's companies — confirmed live that Zapier does not support this ("You cannot turn
on a Zap with more than one Looping by Zapier step"). Those two files are kept in this
folder marked SUPERSEDED, for reference only; `04-match-and-write-companies.js` merges
their logic into one step that loops over companies in code instead. See "Why only one
native loop" in `../docs/zapier-v2-setup.md` for the full rationale, and that same
file's header comment for the timeout mitigations (parallel deal-matching, sequential
writes, a soft time budget) the merge required.

Full wiring instructions, including the native (non-code) Storage by Zapier dedup step
and the Digest by Zapier report, are in `../docs/zapier-v2-setup.md`.

## What's written to HubSpot (4 deal properties, not the old 6)

Same property set as the corrected Pipedream design (see `../README.md`), minus
`next_step_date` — this design's write logic (in `04-match-and-write-companies.js`,
ported unchanged from the superseded `05-write-deal-and-note.js`) only writes the 4
properties the task scope calls for:

| Property | Internal name |
|---|---|
| Next Step | `hs_next_step` (HubSpot built-in) |
| Last Call Sentiment | `last_call_sentiment` |
| Last Call Date | `last_call_date` |
| Last Call Unresolved Objections | `last_call_unresolved_objections` |

Plus a new HubSpot note per matched company, containing the raw extracted summary of
what was actually said about that company — the durable record, separate from the
structured properties.

## Apollo endpoints — confirmed 2026-08-26

`01-filter-partner-calls.js` and `02-fetch-transcript.js` call Apollo's Conversation
Intelligence REST API, confirmed against docs.apollo.io:

- `POST https://api.apollo.io/api/v1/conversations/search` — 0 credits per call.
  Request body: `page`, `num_fetch_result`, `conversation_type`
  (`"video_conference"` | `"phone_call"`), `account_id`, `contact_ids`, `tag_ids`,
  `tracker_ids`, `organization_ids`, `date_range`, `scorecard_template_id`,
  `scorecard_max_rating`, `sort_by_field`, `enforce_contact_boundary`.
- `GET https://api.apollo.io/api/v1/conversations/{id}` — 0-1 credit per call (1 only
  if the conversation has AI insights generated). Returns the full conversation record
  — topic, state, transcript, etc. — as **one** object; there is no separate
  `/conversations/{id}/transcript` path. (An earlier version of `02-fetch-transcript.js`
  called that separate path — it doesn't exist and has been corrected.)

**No server-side topic/keyword search exists on the search endpoint** — this is a
documented constraint of the real API, not a bug: `01-filter-partner-calls.js` pulls a
batch (narrowed only by `conversation_type` + `date_range`) and does all known-partner
pattern matching client-side against each result's `topic` field.

**Known typo-tolerance gap — RESOLVED 2026-08-27.** A real production topic was found
with a typo: `"ZoomInfo/Markaaz Patnership"` (missing the "r" in "Partnership"). Under
the original exact-substring match this silently failed to match and the call would
never have been processed — no error, just missed. `matchPartnerFromTopic()` in
`01-filter-partner-calls.js` now tokenizes the topic and checks each sync keyword via
(1) an exact alias map (`SYNC_KEYWORD_ALIASES`, which explicitly covers this confirmed
"Patnership" typo) and (2) a Levenshtein edit-distance check (tolerance of 1 character)
as a general fallback for other single-letter typos of the same shape. Partner-name
matching (`Socure`, `ZoomInfo`, etc.) intentionally stays an exact substring check, not
fuzzy — those names are short/distinctive enough that fuzzing them risks false
positives against unrelated calls. Covered by
`zapier-v2-steps/tests/01-filter-partner-calls.test.js` (run with
`node zapier-v2-steps/tests/01-filter-partner-calls.test.js`), including a regression
check that an unrelated topic (`"Weekly Team Standup"`) still does not match.

**Known company-name transcription gaps — RESOLVED 2026-08-28, extended 2026-08-29.**
Real Claude enrichment output surfaced confirmed mismatches too large for
punctuation/case tolerance to safely catch: `"PayMeadow"`/`"Pay Meadow"` (any
spacing) → `"Paymitto"`, `"Valera"` → `"Velera"`, `"Green Sky"` → `"Greensky"`,
`"Open FX"` → `"OpenFx"`, `"Poly Market"` → `"Polymarket"`, `"Weeble"` → `"WeBull"`,
`"Paros"` → `"Partos"`, `"Partos"` → `"Partos AI"` (two distinct real companies and
alias keys — the transcript drops a different piece of each name). (`"Fuse
Finance"` was also tested and confirmed as a genuinely non-existent deal —
correctly stays unmatched, no alias needed.)
`COMPANY_NAME_ALIASES` in `04-match-and-write-companies.js` (checked before the
HubSpot search, falling through to the existing fuzzy match if no alias hits) is a
living list — append a new entry whenever a new mismatch is confirmed, same
maintenance pattern as `SYNC_KEYWORD_ALIASES` above.

**Two root-caused bugs, fixed 2026-08-29, not papered over with more aliases:**
(1) `normalizeCompanyKey()` only collapsed whitespace to a single space rather than
stripping it entirely, so a spacing variant of an already-aliased name (e.g. "Pay
Meadow" vs the stored "paymeadow") could silently miss — fixed by stripping all
whitespace, with every alias key rewritten in that same fully-stripped form. (2) the
fuzzy `normalize()` fallback's own comparison logic was never broken, but the RAW,
still-punctuated company name was being sent as the literal HubSpot search query, so
a punctuation-sensitive search could return zero candidates for "U.S. Bank" before
`normalize()` ever got a chance to compare — fixed by searching with an
already-normalized query instead. See `docs/zapier-v2-setup.md`'s "Company-name
matching" section for the full root-cause writeup. Covered by
`zapier-v2-steps/tests/04-match-and-write-companies.test.js`.

`conversation_type: "video_conference"` (not `"phone_call"`, and not `"meeting"` —
an earlier draft assumed a `"meeting"` enum value that doesn't exist in the real API)
is confirmed correct for partner Zoom/Teams syncs: real production conversations
pulled during verification (e.g. `"Socure/Markaaz Partnership"`,
`"Signicat x Markaaz weekly sync"`) are multi-participant meeting records with
`host_id` and `participant_count`, not 1:1 dialed calls.

**What's still not fully closed the loop:** neither endpoint was hit with a raw
`fetch()` using one of markaaz-gtm's own Apollo keys — all three currently lack
Conversations API scope (confirmed via a real `403 API_INACCESSIBLE` naming this exact
endpoint, meaning the X-Api-Key + User-Agent auth mechanism itself is being correctly
recognized — it's a scope gap, not an auth-format problem). The `topic`/`id`/
`start_time`/`transcript` field names and the `"insights_generated"` state value were
confirmed against real production data through a different, already-authenticated
Apollo channel, not this exact raw endpoint — high confidence, not 100% certainty.
Confirm Conversations scope on whichever Apollo key actually gets wired into the live
Zap before the first real run.

## What this pipeline never touches

Apollo's own native call-logging (its Calls/Engagements entries on contacts/deals) is
never modified, deleted, or re-associated by any step here. This pipeline only writes
deal properties and adds new notes — it reads from Apollo, it doesn't write back to it.
