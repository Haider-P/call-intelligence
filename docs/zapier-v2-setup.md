# Zapier Setup Guide — Call Intelligence v2 (Partner-Sync Pipeline)

Step-by-step guide to wiring `../zapier-v2-steps/*.js` into a real Zap. This is a
multi-company pipeline (one call → many companies → many independent deal writes), so
the wiring is more involved than the old Pipedream pipeline's single linear chain — read
the "Why two nested loops, and why Digest by Zapier for the report" section before
building, it explains the two judgment calls this design makes.

---

## Prerequisites

- [ ] Apollo account with Conversation Intelligence / call recording enabled, and an
      Apollo API key with access to it
- [ ] **Verify Apollo's Conversations API endpoints before building** — see the
      "Endpoints that need verification" section in `../zapier-v2-steps/README.md`. The
      code assumes `/api/v1/conversations/search` and
      `/api/v1/conversations/{id}/transcript`; confirm against developer.apollo.io.
- [ ] HubSpot Private App with scopes: `crm.objects.deals.read`,
      `crm.objects.deals.write`, `crm.objects.notes.write`
- [ ] Anthropic API key
- [ ] Zapier plan with **Code by Zapier Environment Variables** support (Code step →
      Settings → Environment Variables — available on Zapier's paid plans). If your plan
      doesn't have this, pass secrets in via `inputData` from an upstream Storage by
      Zapier "Get Value" step instead, and adjust `process.env.X` references in the code
      to `inputData.X`.
- [ ] Confirm the 4 HubSpot deal properties this pipeline writes already exist:
      `hs_next_step` (built-in), `last_call_sentiment`, `last_call_date`,
      `last_call_unresolved_objections` — see `../README.md` for their verified status.

---

## Why two nested loops, and why Digest by Zapier for the report

Two design choices worth understanding before you start clicking:

**1. Two nested "Looping by Zapier" steps.** One call can name many companies, and each
company needs its own independent deal search + write — one company's miss must never
block another's write. Zapier doesn't have native fan-out inside a single Code step's
*downstream* steps, so the fan-out happens via two levels of the native "Looping by
Zapier" action: the outer loop iterates matching calls (from Step 1's output), the inner
loop iterates the companies extracted from each call (from Step 3's output). Nesting a
second Looping by Zapier step inside the first is a standard, supported Zapier pattern —
just add it as an action inside the outer loop's branch, pointed at Step 3's
`companies` array.

**2. Digest by Zapier for the report, not a single end-of-run Code step.** Because the
outer and inner loops each run their downstream steps once *per item*, there is no
single "last step of the whole hourly run" that can see every call's and every
company's results at once to build one combined report object — that's a real Zapier
platform constraint with nested loops, not a design preference. **Digest by Zapier** is
Zapier's own native app built exactly for this: collect items across a time period, then
release one combined summary on a schedule. Feed every outcome (a write, a no-match, an
unlisted-partner flag) into a Digest by Zapier "Add to Digest" action wherever it's
produced, and let Digest release the combined run report automatically. No custom
aggregation code needed, and it's honest about what Zapier can and can't do natively.

---

## Zap 1 — Trigger + Filter

| Step | App / Type | Config |
|---|---|---|
| 1 | **Schedule by Zapier** | Trigger: Every Hour |
| 2 | **Code by Zapier** → Run Javascript | Paste `01-filter-partner-calls.js`. inputData: none. Environment Variables: `APOLLO_API_KEY`. |

Step 2 outputs `candidateCalls` (array) and `unlistedPartnerFlags` (array).

### Unlisted-partner flag branch (optional but recommended)
- **Looping by Zapier** → loop over Step 2's `unlistedPartnerFlags`
- **Digest by Zapier** → "Add to Digest" — digest name e.g. `call-intel-run-report`,
  fields: conversationId, topic, startTime, reason

---

## Outer loop — one iteration per matching call

- **Looping by Zapier** → loop over Step 2's `candidateCalls`. Values to loop:
  `conversationId`, `partner`, `topic`, `startTime`.

Inside this loop, in order:

| Step | App / Type | Config |
|---|---|---|
| A | **Storage by Zapier** → Get Value | Key: the loop's `conversationId` |
| B | **Filter by Zapier** | Only continue if Step A's value **does not exist** (i.e. this call hasn't been processed yet) |
| C | **Code by Zapier** → Run Javascript | Paste `02-fetch-transcript.js`. inputData: `conversationId`, `partner`, `topic`, `startTime` (map from the loop item). Environment Variables: `APOLLO_API_KEY`. |
| D | **Code by Zapier** → Run Javascript | Paste `03-claude-enrichment.js`. inputData: `transcriptText`, `partner`, `topic`, `startTime` (map from Step C). Environment Variables: `ANTHROPIC_API_KEY`. |

Step D outputs `companies` (array) — this feeds the inner loop next.

---

## Inner loop — one iteration per extracted company

- **Looping by Zapier** (a second, nested instance) → loop over Step D's `companies`.
  Values to loop: `companyName`, `sentiment`, `nextStep`, `unresolvedObjections`,
  `rawSummary`. Also carry forward `partner` and `startTime` from the outer loop's
  context (Zapier lets you reference fields from any earlier step in the same branch,
  not just the immediately preceding one).

Inside this inner loop, in order:

| Step | App / Type | Config |
|---|---|---|
| E | **Code by Zapier** → Run Javascript | Paste `04-deal-matching.js`. inputData: `companyName`, `sentiment`, `nextStep`, `unresolvedObjections`, `rawSummary`, `partner`, `startTime`. Environment Variables: `HUBSPOT_ACCESS_TOKEN`. |
| F | **Code by Zapier** → Run Javascript | Paste `05-write-deal-and-note.js`. inputData: `matched`, `dealId`, `companyName`, `sentiment`, `nextStep`, `unresolvedObjections`, `rawSummary`, `partner`, `startTime` (map from Step E). Environment Variables: `HUBSPOT_ACCESS_TOKEN`. |
| G | **Digest by Zapier** → Add to Digest | Same digest as the unlisted-partner branch (`call-intel-run-report`). Fields: `written`, `dealId`, `companyName`, `partner`, `updatedProperties`, `noteId`, `reason`. |

Step G fires for every company outcome — written, or "mentioned in call, no matching
deal found" — so both show up in the eventual digest.

---

## After the inner loop ends — mark the call as processed

Back in the outer loop, after the inner loop over companies finishes:

| Step | App / Type | Config |
|---|---|---|
| H | **Storage by Zapier** → Set Value | Key: `conversationId` (from the outer loop item). Value: current timestamp. |

This must run after all of that call's companies have been through Steps E–G — setting
it earlier risks marking a call "processed" while its companies are still being written.

---

## Zap 2 — the report digest

Digest by Zapier needs a separate scheduled release. Set this up as its own tiny Zap:

| Step | App / Type | Config |
|---|---|---|
| 1 | **Digest by Zapier** | Trigger: Digest Ready — digest name `call-intel-run-report`, schedule hourly (or daily, your call) |
| 2 | **Email by Zapier** or **Slack** | Send the digest's combined content — calls found, companies extracted, deals matched/written, no-match cases, and unlisted-partner flags all in one message |

---

## Testing checklist

- [ ] Run Step 1 manually against a known partner-sync call topic — confirm it's
      correctly matched and NOT flagged as unlisted
- [ ] Run Step 1 against a direct 1:1 sales call topic — confirm it's skipped entirely
      (not in `candidateCalls`, not in `unlistedPartnerFlags`)
- [ ] Run Step 1 against a topic containing "Markaaz" + an unlisted company name —
      confirm it lands in `unlistedPartnerFlags`
- [ ] Run the full chain against one real partner-sync call — confirm the company count
      and quality roughly matches the validated Socure test (specific, not generic,
      per-company extraction)
- [ ] Confirm a company with no matching HubSpot deal produces a clean "no matching
      deal found" digest row and makes zero HubSpot write calls
- [ ] Confirm re-running the same call a second time (simulating a re-poll) is skipped
      by the Storage by Zapier dedup check and does not duplicate notes or overwrite
      properties again
- [ ] Confirm Apollo's native Calls/Engagements entries for the test call are completely
      unchanged after a run

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Apollo search/transcript calls 404 or return unexpected shape | The Conversations endpoint paths weren't independently verified — check against developer.apollo.io and adjust the fetch URLs in `01-filter-partner-calls.js` / `02-fetch-transcript.js` |
| A known partner call isn't matching | Check the topic actually contains the partner name, "markaaz", and one of partnership/sync/weekly/bi-weekly — all three, any order, case-insensitive |
| Claude enrichment returns generic ("follow up", "pricing concerns") instead of specifics | Check the transcript quality/length reaching Step D — a short or garbled transcript gives Claude nothing specific to extract |
| Deal Matching reports "no matching deal found" for a deal you know exists | Check the deal name is exactly `{Partner} - {Company}` — the matcher tolerates punctuation/case variance but not a structurally different name |
| Same call processed twice | Confirm Step H (Storage Set Value) is actually wired after the inner loop, and Step A/B (Storage Get + Filter) are wired before Step C in every run |
