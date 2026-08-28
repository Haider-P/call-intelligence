# Zapier Setup Guide — Call Intelligence v2 (Partner-Sync Pipeline)

Step-by-step guide to wiring `../zapier-v2-steps/*.js` into a real Zap. This is a
multi-company pipeline (one call → many companies → many independent deal writes), so
the wiring is more involved than the old Pipedream pipeline's single linear chain — read
the "Why only one native loop, and why Digest by Zapier for the report" section before
building, it explains the two judgment calls this design makes.

**Architecture corrected 2026-08-28.** An earlier version of this guide described two
nested "Looping by Zapier" steps (an outer loop over calls, an inner loop over each
call's companies). That does not work — confirmed live against Zapier's own
documentation: **"You cannot turn on a Zap with more than one Looping by Zapier
step."** There is exactly one native loop in this design now (the outer loop over
`candidateCalls`); the former inner loop's job (matching + writing each company) is
done inside a single combined Code step,
`04-match-and-write-companies.js`, which loops over that call's `companies` array in
plain JavaScript instead. **Do not "fix" this by adding a second Looping by Zapier
step** — that is the exact constraint this design works around. The two old per-company
files (`04-deal-matching.js`, `05-write-deal-and-note.js`) are kept in the repo marked
SUPERSEDED, for reference only.

---

## Prerequisites

- [ ] Apollo account with Conversation Intelligence / call recording enabled, and an
      Apollo API key **with Conversations API scope specifically** — confirm this
      before building, since none of markaaz-gtm's existing Apollo keys have it (all
      three returned a scoped `403 API_INACCESSIBLE` when tested against
      `/api/v1/conversations/search`). See "Apollo endpoints — confirmed 2026-08-26" in
      `../zapier-v2-steps/README.md` for the confirmed request/response contract —
      `POST /api/v1/conversations/search` (0 credits) and
      `GET /api/v1/conversations/{id}` (0-1 credit; there's no separate
      `/transcript` path). No server-side topic search exists — that's a real API
      constraint the code already accounts for by filtering client-side, not something
      left to fix.
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

## Why only one native loop, and why Digest by Zapier for the report

Two design choices worth understanding before you start clicking:

**1. Only one "Looping by Zapier" step, total, for the whole Zap.** One call can name
many companies, and each company needs its own independent deal search + write — one
company's miss must never block another's write. The natural Zapier pattern for that
fan-out would be a second "Looping by Zapier" step nested inside the first (outer loop
over calls, inner loop over that call's companies) — **this does not work.** Confirmed
live against Zapier's own documentation: *"You cannot turn on a Zap with more than one
Looping by Zapier step."* It's a hard platform limit, not something that can be worked
around with a different nesting arrangement.

So the fan-out over companies happens entirely in plain JavaScript, inside
`04-match-and-write-companies.js` — a single Code step that runs once per call (inside
the one remaining outer loop) and internally `for...of`-loops over that call's
`companies` array, matching and writing each one in code rather than via a second native
Zapier loop. See the header comment in that file for the full rationale, including the
timeout mitigations (parallel deal-matching, sequential writes, a ~25s soft time budget)
made necessary by folding what used to be two separate per-company Code steps into one.
**Do not "fix" this design by adding a second Looping by Zapier step** — Zapier will
refuse to let the Zap be turned on.

**2. Digest by Zapier for the report, not a single end-of-run Code step.** Because the
outer loop runs its downstream steps once *per call* (not once per company — there's no
company-level loop anymore), there is no single "last step of the whole hourly run" that
can see every call's results at once to build one combined report object — that's a real
Zapier platform constraint, not a design preference. **Digest by Zapier** is Zapier's own
native app built exactly for this: collect items across a time period, then release one
combined summary on a schedule. `04-match-and-write-companies.js` already returns one
aggregated `results` array (plus summary counts) per call, so exactly one "Add to
Digest" action per call — not per company — is enough to get every company's outcome
into the eventual digest. No custom aggregation code needed, and no second loop needed
either.

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

## The one outer loop — one iteration per matching call

- **Looping by Zapier** → loop over Step 2's `candidateCalls`. Values to loop:
  `conversationId`, `partner`, `topic`, `startTime`.

This is the **only** "Looping by Zapier" step in the whole Zap — see "Why only one
native loop" above before adding anything that looks like a second one.

Inside this loop, in order:

| Step | App / Type | Config |
|---|---|---|
| A | **Storage by Zapier** → Get Value | Key: the loop's `conversationId` |
| B | **Filter by Zapier** | Only continue if Step A's value **does not exist** (i.e. this call hasn't been processed yet) |
| C | **Code by Zapier** → Run Javascript | Paste `02-fetch-transcript.js`. inputData: `conversationId`, `partner`, `topic`, `startTime` (map from the loop item). Environment Variables: `APOLLO_API_KEY`. |
| D | **Code by Zapier** → Run Javascript | Paste `03-claude-enrichment.js`. inputData: `transcriptText`, `partner`, `topic`, `startTime` (map from Step C). Environment Variables: `ANTHROPIC_API_KEY`. |
| E | **Code by Zapier** → Run Javascript | Paste `04-match-and-write-companies.js`. inputData: `companies` (Step D's array output), `partner`, `startTime` (carry forward from the outer loop item — Zapier lets you reference fields from any earlier step in the same branch, not just the immediately preceding one). Environment Variables: `HUBSPOT_ACCESS_TOKEN`. |
| F | **Digest by Zapier** → Add to Digest | Digest name e.g. `call-intel-run-report` (same digest as the unlisted-partner branch). Fields: `partner`, `startTime`, `companiesProcessed`, `companiesMatched`, `companiesNoMatch`, `companiesSkippedTimeout`, `companiesErrored`, and `results` (Zapier will store the array as a single field — see note below if your digest needs it human-readable). |

Step E does the job the old inner loop + Steps E/F used to do (deal matching + property
write + note, per company) — but as one Code step that loops over `companies` in plain
JavaScript instead of a second native Zapier loop. It returns one aggregated `results`
array (plus summary counts) for the **whole call**, so Step F fires **once per call**,
not once per company — that's what makes a single, non-nested outer loop enough to get
every company's outcome into the digest.

**Making `results` readable in the digest.** `results` is an array of objects
(`{ companyName, status, dealId, noteId, updatedProperties, reason, ... }` — see Step
E's header comment for the full shape). Digest by Zapier fields generally expect
scalar text, not a raw array/object. If your digest doesn't render it usefully as-is,
insert a **Formatter by Zapier → Utilities → Line Itemizer** (or a **Text → Split**
transform) step between E and F to turn `results` into a readable multi-line block
(e.g. one line per company: `{status}: {companyName}{reason ? " — " + reason : ""}`)
before feeding it to Step F. Formatter steps have no "only one per Zap" limit the way
Looping by Zapier does — use as many as needed here.

---

## After the outer loop's per-call steps finish — mark the call as processed

Still inside the one outer loop, after Steps C–F for that call have all completed:

| Step | App / Type | Config |
|---|---|---|
| G | **Storage by Zapier** → Set Value | Key: `conversationId` (from the outer loop item). Value: current timestamp. |

This must run after Step E has fully finished writing that call's companies — setting
it earlier risks marking a call "processed" while its companies are still being
written.

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
      deal found" result in Step E's `results` array and makes zero HubSpot write calls
      for that company
- [ ] Run against a real call with a large company count (10+) and confirm Step E
      completes within Zapier's 30s Code-step limit — check `companiesSkippedTimeout`
      in the output is `0`. If it's not, the ~25s soft budget in
      `04-match-and-write-companies.js` did its job (no crash, clean partial result) but
      the batch is genuinely too large for one Code step run — see that file's header
      comment for the built-in mitigations before changing anything.
- [ ] Confirm re-running the same call a second time (simulating a re-poll) is skipped
      by the Storage by Zapier dedup check and does not duplicate notes or overwrite
      properties again
- [ ] Confirm Apollo's native Calls/Engagements entries for the test call are completely
      unchanged after a run

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Apollo search/conversation calls return `403 API_INACCESSIBLE` | Your Apollo key doesn't have Conversations API scope — this is the same error every markaaz-gtm key returned during verification. Request a key/scope grant from whoever administers the Apollo account. |
| Apollo calls return an unexpected response shape | The exact envelope key (`conversations` vs `results`/`data`) and transcript field shape were confirmed via real production data through a different Apollo integration channel, not a raw `fetch()` with a scoped key — see the "What's still not fully closed the loop" note in `../zapier-v2-steps/README.md`. If the shape differs, only the small parsing helpers in `01-filter-partner-calls.js` / `02-fetch-transcript.js` need adjusting. |
| A known partner call isn't matching | Check the topic actually contains the partner name, "markaaz", and one of partnership/sync/weekly/bi-weekly — all three, any order, case-insensitive |
| Claude enrichment returns generic ("follow up", "pricing concerns") instead of specifics | Check the transcript quality/length reaching Step D — a short or garbled transcript gives Claude nothing specific to extract |
| A company's `results` entry says "no matching deal found" for a deal you know exists | Check the deal name is exactly `{Partner} - {Company}`. The matcher tolerates punctuation/case variance (e.g. "US Bank" vs "U.S. Bank") via `normalize()`, and known transcription mismatches (e.g. "PayMeadow" vs "Paymitto") via `COMPANY_NAME_ALIASES` — if it's a recurring real company hitting a transcription gap, add it to that map (see the living-list comment above it in `04-match-and-write-companies.js`) rather than widening the fuzzy-match tolerance. |
| A company's `results` entry has `status: "skipped-timeout"` | The call's company count was too large to finish inside Zapier's 30s Code-step limit even with parallel matching + a soft budget. Check `companiesSkippedTimeout` in Step E's output — those companies were never attempted (not a false "no match"). No automatic retry exists yet; re-running the call (once the Storage dedup key is cleared) will reprocess all its companies from scratch, including ones already written on the prior partial run — check `results` from the prior run before manually re-triggering. |
| A company's `results` entry has `status: "error"` | An unexpected HubSpot failure (network blip, transient 5xx) on that one company's search or write — check the entry's `reason` for the underlying error. Per-company try/catch means this does not abort the rest of the call's companies (see `companiesErrored` in Step E's header comment for why this exists in the merged single-step design). |
| Same call processed twice | Confirm Step G (Storage Set Value) is actually wired after Step E, and Step A/B (Storage Get + Filter) are wired before Step C in every run |
| Someone added a second "Looping by Zapier" step and the Zap won't turn on | This is expected — Zapier enforces "no more than one Looping by Zapier step per Zap." Remove the second loop; the per-company fan-out belongs inside `04-match-and-write-companies.js`'s plain-JS `for...of` loop, not a second native loop. See "Why only one native loop" above. |
