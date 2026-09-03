# Zapier Setup Guide — Call Intelligence v2 (Partner-Sync Pipeline)

## Current Status (2026-09-03)

**Fully built and wired in Zapier.** All 11 core pipeline steps are live in the Zap
builder:

1. Schedule by Zapier (hourly trigger)
2. Code by Zapier — Filter (`01-filter-partner-calls.js`)
3. Filter by Zapier (**added 2026-09-01**) — only continue if `candidateCalls`
   is non-empty; stops the run cleanly instead of the next step (Looping by Zapier)
   erroring on a missing "Values to Loop" field. See "Recently fixed" below.
4. Looping by Zapier — the one outer loop, over `candidateCalls` (unchanged since
   before 2026-09-01 — only its position in this list shifted, to make room for the
   new Step 3)
5. Storage by Zapier → Get Value — dedup check (Step A below)
6. Filter by Zapier — only continue if not already processed (Step B below)
7. Code by Zapier — Transcript (`02-fetch-transcript.js`, Step C below)
8. Filter by Zapier (**NEW, added 2026-09-03**) — only continue if Step C's
   `transcriptReady` is true; stops the run cleanly for a call whose transcript Apollo
   hasn't finished generating yet (Step C.1 below). See "Recently fixed" below.
9. Code by Zapier — Enrichment (`03-claude-enrichment.js`, Step D below)
10. Code by Zapier — Match + Write (`04-match-and-write-companies.js`, Step E below)
11. Storage by Zapier → Set Value — dedup mark (Step G below)

**Validated end-to-end against real production data.** Run live against the
2026-08-26/27 Socure/Markaaz Partnership call, including a full dedup round-trip
proof — the same call was correctly detected as already-processed on a second check,
confirming steps 5, 6, and 10 above work together as designed in the live Zap, not
just individually.

**Status: DRAFT, not published — as of 2026-08-29.** This is a deliberate pause for a
final confidence check, not an unfinished task. **What's needed before publishing:**
essentially nothing technical. Every issue found during today's live testing
(rate-limit throttling, the Haiku model swap, the `companiesJson` transport fix, the
sentiment-casing fix, and the company-name matching aliases/root-causes) has been
applied to the source, re-validated, and is already live in the Zap's Code steps.
Publishing from here is a go/no-go judgment call for the pipeline owner, not a
blocked technical task.

### Recently fixed

- **2026-09-01 — empty-`candidateCalls` run crashed the Zap.** An hourly poll that
  found 0 partner-matched calls (empty `candidateCalls` array from Step 2) made
  Looping by Zapier (then Step 3, now Step 4) fail with `Required field 'Values to
  Loop' (loop_values) is missing` — Zapier's line-item loop can't resolve an empty
  array reference. **Root cause:** nothing gated the loop on `candidateCalls` actually
  having entries; every prior test run happened to have at least one matching call, so
  this was never exercised until a real hourly poll came up empty in production.
  **Fix:** added a new Filter by Zapier step (`candidateCalls` **Exists**) between the
  Filter Code step and the Looping step — see the new Step 3 above and in "Zap 1 —
  Trigger + Filter" below. **Confirmed via Replay** against the failing run
  (2026-09-01, 3:15pm): the new filter step showed "This filter successfully stopped
  your run" and the Looping step showed "Did not attempt to send new Loop" — the fix
  stops the run cleanly at the filter instead of the loop erroring out.

- **2026-09-03 — premature transcript fetch risked repeated Zap errors (race
  condition), a second and related but distinct issue from the one above.** Apollo
  takes roughly 30-40 minutes after a call ends to finish generating its
  transcript/insights. Step 2 (`01-filter-partner-calls.js`) surfaces a call as a
  candidate as soon as it's inside the `LOOKBACK_HOURS` window — that only means the
  call *happened* recently, not that Apollo has finished processing it. Step C
  (`02-fetch-transcript.js`) previously assumed the transcript was always ready and
  threw `"No transcriptText in inputData"` when it wasn't, erroring the whole Zap run
  for that call — repeated often enough, this risks Zapier auto-pausing the Zap, the
  same failure mode as the 2026-09-01 incident above. **Root cause, same general
  pattern as 2026-09-01 but a different specific cause:** 2026-09-01 was an
  empty-array edge case being treated as an error; this is a premature-fetch race
  condition (fetching before an asynchronous, several-minutes-long external process
  finishes) — both are cases of an expected, non-error condition being treated as a
  hard failure. **Fix:** Step C now checks the fetched conversation's `state` field —
  confirmed against real production data (see the READINESS CHECK section of
  `02-fetch-transcript.js`'s header comment) that `state === "insights_generated"` is
  the one value meaning "fully processed and ready"; any other value returns
  `{ transcriptReady: false, ..., reason: "transcript not yet generated" }` instead of
  throwing. **The new Step 8 Filter by Zapier** (`transcriptReady` is `true`) then
  stops the run cleanly for that call — see the new Troubleshooting entry below.

### Known minor gaps (not blockers)

- **`startTime` is not yet wired all the way through the chain end-to-end.**
  Cosmetic — it doesn't affect matching, writes, or dedup correctness, only precision
  of the `last_call_date` property on edge cases (falls back to "now" if missing, see
  `writeCompanyUpdate()` in `04-match-and-write-companies.js`). Worth a pass to
  confirm the field mapping at every step before publishing, but not a blocker.
- **The original HubSpot rate-limit incident's specific `correlationId` values were
  never retroactively added** to the "Why Phase 1 is throttled" evidence further
  below — already flagged as a gap when that section was written (2026-08-28), not a
  new finding today. The throttling fix doesn't depend on having them; they'd only
  make the evidence trail more precise if ever revisited.
- **The Digest by Zapier reporting layer (Zap 2, plus the optional unlisted-partner
  flag branch documented below) was not part of today's confirmed build/test scope.**
  The core 10-step pipeline above (trigger through dedup mark) is what's been
  validated end-to-end. Confirm Zap 2 is actually wired and firing on a schedule
  before relying on it for the run report.

---

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
| 3 | **Filter by Zapier** (NEW, added 2026-09-01) | Condition: **"Candidate Calls Partner" Exists** (the field Zapier's picker shows for Step 2's `candidateCalls` array). Stops the run cleanly when `candidateCalls` comes back empty (e.g. an hourly poll with 0 partner-matched calls) — without this, an empty `candidateCalls` array makes the next step, Looping by Zapier, error out with a missing "Values to Loop" field instead of just ending the run with nothing to do. See the Troubleshooting entry below and "Recently fixed" above for the incident this fixed. |

Step 2 outputs `candidateCalls` (array) and `unlistedPartnerFlags` (array). Step 3 gates
on `candidateCalls` being non-empty before the run reaches the outer loop.

### Unlisted-partner flag branch (optional but recommended)
- **Looping by Zapier** → loop over Step 2's `unlistedPartnerFlags`
- **Digest by Zapier** → "Add to Digest" — digest name e.g. `call-intel-run-report`,
  fields: conversationId, topic, startTime, reason

---

## The one outer loop — one iteration per matching call

- **Looping by Zapier** (Step 4) → Create Loop From Line Items, looping over Step 2's
  `candidateCalls`. Values to loop: `conversationId`, `partner`, `topic`, `startTime`.
  Runs only when Step 3's filter has passed (i.e. `candidateCalls` is non-empty). This
  is otherwise unchanged from before 2026-09-01 — only its position in the overall
  numbering shifted, to make room for the new Step 3 filter.

This is the **only** "Looping by Zapier" step in the whole Zap — see "Why only one
native loop" above before adding anything that looks like a second one.

Inside this loop, in order (lettered Steps A–G below are unchanged since before
2026-09-01, with one addition — **Step C.1, new 2026-09-03** — inserted between Steps
C and D; see "Current Status" at the top of this doc for how these letters map onto
the full numbered step list):

| Step | App / Type | Config |
|---|---|---|
| A | **Storage by Zapier** → Get Value | Key: the loop's `conversationId` |
| B | **Filter by Zapier** | Only continue if Step A's value **does not exist** (i.e. this call hasn't been processed yet) |
| C | **Code by Zapier** → Run Javascript | Paste `02-fetch-transcript.js`. inputData: `conversationId`, `partner`, `topic`, `startTime` (map from the loop item). Environment Variables: `APOLLO_API_KEY`. |
| C.1 | **Filter by Zapier** (**NEW, added 2026-09-03**) | Condition: **`transcriptReady` (Step C's output) is `true`**. Apollo takes 30-40 minutes after a call ends to finish generating its transcript/insights — a call can reach Step C well inside that window. Step C now checks the fetched conversation's `state` and returns `transcriptReady: false` (not an error) when Apollo hasn't finished yet; this filter stops the run cleanly for that call **before Storage by Zapier → Set Value (Step G)**, so an unready call is never marked "processed" — it will be picked up and retried on a later hourly poll once Apollo finishes. See the Troubleshooting entry below and "Recently fixed" above. |
| D | **Code by Zapier** → Run Javascript | Paste `03-claude-enrichment.js`. inputData: `transcriptText`, `partner`, `topic`, `startTime` (map from Step C). Environment Variables: `ANTHROPIC_API_KEY`. |
| E | **Code by Zapier** → Run Javascript | Paste `04-match-and-write-companies.js`. inputData: `companiesJson` (**map Step D's "Companies Json" output field specifically — a plain string pill — NOT "Step Output {...}"**; see the callout below), `partner`, `startTime` (carry forward from the outer loop item — Zapier lets you reference fields from any earlier step in the same branch, not just the immediately preceding one). Environment Variables: `HUBSPOT_ACCESS_TOKEN`. |
| F | **Digest by Zapier** → Add to Digest | Digest name e.g. `call-intel-run-report` (same digest as the unlisted-partner branch). Fields: `partner`, `startTime`, `companiesProcessed`, `companiesMatched`, `companiesCreated`, `companiesNoMatch`, `companiesSkippedTimeout`, `companiesErrored`, and `results` (Zapier will store the array as a single field — see note below if your digest needs it human-readable). |

Step E does the job the old inner loop + Steps E/F used to do (deal matching + property
write + note, per company) — but as one Code step that loops over the companies array
in plain JavaScript instead of a second native Zapier loop. It returns one aggregated
`results` array (plus summary counts) for the **whole call**, so Step F fires **once
per call**, not once per company — that's what makes a single, non-nested outer loop
enough to get every company's outcome into the digest.

**Field mapping gotcha: map `companiesJson`, not "Step Output {...}".** Zapier's
"Step Output {...}" data-picker inserts a step's ENTIRE output as one stringified
object when mapped into a downstream Input Data field — it does not let you pick out
just one nested array field within that output. Confirmed live: mapping Step D's Step
Output into Step E's `companies` field resulted in `inputData.companies` being the
*whole* `{ companies, companiesJson, partner, startTime, companyCount }` object,
stringified — not the companies array alone — and Step E failed with "No companies
array in inputData". **The fix:** Step D outputs a dedicated field, `companiesJson`
— a JSON string of *just* the companies array, nothing else — which shows up in
Zapier's field picker as its own plain string pill ("Companies Json"), unambiguous to
map. Map that specific field to Step E's `companiesJson` input, and Step E
`JSON.parse()`s it explicitly (see `resolveCompanies()` in `04-match-and-write-
companies.js`) rather than relying on Zapier's array-vs-object-vs-string field-picker
behavior. If a future field mapping mistake reintroduces this (e.g. someone maps Step
Output again out of habit), Step E's error message names both fields it checked
(`companiesJson`, `companies`) so it's fast to diagnose rather than a silent failure.

**Why Phase 1 (deal matching) is throttled, not fully parallel.** Step E's own header
comment covers this in detail; the short version for wiring purposes: a live dry run
(2026-08-28) confirmed that firing all of a call's HubSpot deal searches at once via
an unthrottled `Promise.all` — the original Phase 1 design — hits a real limit.
**Evidence:** a 14-company call fired 14 simultaneous `POST
/crm/v3/objects/deals/search` requests; 10 of the 14 came back HTTP 429, HubSpot's
"SECONDLY" rate-limit category (`Traffic.SECONDLY` in the response body's
`subCategory`; specific `correlationId` values from that run were not preserved —
capture and add them here if you have them in Zapier's task history or HubSpot's own
error logs, for a future adjustment to cite directly). This lines up with HubSpot's
own published limit: **the CRM Search API is rate limited to 5 requests/second per
account** (confirmed via
[developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm](https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm),
"Limits" section) — a separate, more restrictive limit than HubSpot's general
100-requests/10-seconds API limit, and account-wide (not scoped per integration or
per Zap). Step E now batches deal searches at `SEARCH_BATCH_SIZE = 3` companies per
batch, with a `SEARCH_BATCH_DELAY_MS = 1000` (1 second) delay between the start of
each batch — a sustained 3 requests/second, ~40% margin under HubSpot's 5 req/s
limit. Phase 2 (property writes + notes) was **not** touched by this fix — it was
already fully sequential (one company at a time) and wasn't implicated in the 429s.
**If you ever need to retune these constants** (e.g. HubSpot raises the limit, or a
different rate-limit category shows up), change `SEARCH_BATCH_SIZE` /
`SEARCH_BATCH_DELAY_MS` at the top of the "Throttled batch matching" section in
`04-match-and-write-companies.js` — don't just revert to an unthrottled `Promise.all`,
that's exactly what caused this.

**Knock-on effect on the soft time budget.** The batch delays add real wall-clock
time to Phase 1 that wasn't there before (up to several seconds for a large company
count — e.g. a 14-company call now takes ~4 seconds of pure batch-delay time across 4
between-batch waits, on top of actual request latency). `SOFT_TIME_BUDGET_MS` (~25s)
was deliberately left unchanged rather than shrunk further — shrinking it would just
make *more* calls hit the `"skipped-timeout"` path without buying any real protection
against Zapier's 30s hard cutoff, since 25s already carries a ~5s margin against that.
Practically: **expect `companiesSkippedTimeout` to show up more often now on calls
with a large company count than it did before this throttling fix** — that's an
accepted trade-off (correctness over speed), not a regression. The
`"skipped-timeout"` degradation path itself is unchanged and was re-verified against
this exact change (see `zapier-v2-steps/tests/04-match-and-write-companies.test.js`)
— it still stops cleanly and labels every unattempted company correctly, it just may
trigger at a somewhat lower company-count threshold than before.

**Company-name matching: alias list and two root-caused fixes (2026-08-29).**
`COMPANY_NAME_ALIASES` in Step E (`04-match-and-write-companies.js`) currently covers:

| Transcribed (confirmed live) | Real HubSpot deal name |
|---|---|
| PayMeadow / Pay Meadow (any spacing) | Paymitto |
| Valera | Velera |
| Green Sky | Greensky |
| Open FX | OpenFx |
| Poly Market | Polymarket |
| Weeble | WeBull |
| Paros | Partos |
| Partos | Partos AI |

(Note "Paros" → "Partos" and "Partos" → "Partos AI" are two distinct real companies
and two distinct alias keys — the transcript drops a different piece of each name,
not a typo in this table. "Fuse Finance" was also tested live and confirmed as a
genuinely non-existent deal — correctly stays unmatched, no alias needed.) This is a
living list — see the
maintenance comment directly above `COMPANY_NAME_ALIASES` in the source file before
adding a new entry.

Two real bugs, not new transcription quirks, were found and fixed while confirming
these — both are the kind of thing that's tempting to "fix" by just adding another
alias entry, which would have papered over the actual gap instead of closing it:

- **Whitespace-insensitive alias lookup was broken.** "Pay Meadow" (transcribed WITH
  a space) failed to match the already-existing "paymeadow" (no space) alias for the
  exact same company. Root cause: `normalizeCompanyKey()` only *collapsed* whitespace
  runs down to a single space, it never *stripped* it — so "Pay Meadow" normalized to
  `"pay meadow"` (one space), a different string from the stored `"paymeadow"` key
  (zero spaces). Fixed by stripping whitespace entirely in that function, and by
  rewriting every `COMPANY_NAME_ALIASES` key in that same fully-stripped form (e.g.
  `"green sky"` → `"greensky"`) so incoming names and stored keys can't diverge on
  spacing again, for any alias — not a fix scoped to this one pair.
- **The existing fuzzy-match fallback (`normalize()`) wasn't actually being applied to
  the HubSpot search query.** "U.S. Bank" (transcribed) failed to match the real "US
  Bank" deal, even though `normalize("U.S. Bank")` and `normalize("US Bank")` already
  produced the identical string — that comparison logic was never broken. The real gap:
  the *raw, still-punctuated* company name was sent as the literal HubSpot search
  query, so if HubSpot's own search relevance is sensitive to the periods, the real
  deal could come back with zero candidates — `normalize()`'s (correct) comparison
  never got a chance to run on a candidate the search never returned. Fixed by
  searching with an already-normalized (lowercased, punctuation-stripped) query
  instead of the raw name — this closes the gap for any punctuation/casing variant
  generally, not just "U.S. Bank" specifically, and cannot return fewer candidates than
  the raw query would have.

**HubSpot dropdown option casing (`last_call_sentiment`).** Live testing hit a
different real error, unrelated to matching or rate-limiting: HubSpot 400
`INVALID_OPTION` on every write. Cause: the `last_call_sentiment` property is a
HubSpot dropdown whose options are capitalized — **`"Positive"`, `"Neutral"`,
`"At-Risk"`** — but the enrichment step (Step D / `03-claude-enrichment.js`) outputs
lowercase sentiment values (`"positive"`, `"neutral"`, `"at-risk"`), which is the more
natural JS/JSON convention and is left as-is there deliberately (that value may be
used elsewhere; it isn't HubSpot-specific). The casing conversion is applied only at
write time, in Step E, via `mapSentimentToHubSpotOption()` — see the "HUBSPOT DROPDOWN
CASING" section of that file's header comment. An unrecognized sentiment value (a typo
from a future prompt change, unexpected casing, etc.) defaults to `"Neutral"` rather
than failing the write, and that fallback shows up as a non-null `reason` on an
otherwise-successful `"written"` result entry — worth scanning for occasionally even
though it's not a failure. **If you add a new HubSpot dropdown property to this
pipeline later, check its exact option casing against what gets written before
shipping — this exact mismatch is easy to hit again with any new dropdown field.**

**Deal auto-creation for unmatched companies (added 2026-09-01).** When Phase 1 finds
no existing `{Partner} - {Company}` deal for a company, Step E now **creates one**
instead of just reporting `"no-match"` — unless the call's partner isn't yet
configured for auto-creation (see the fallback note below), in which case the
original `"no-match"` behavior still applies. A newly created deal gets result status
`"created"`, distinct from `"written"` (an existing deal that got matched and
updated) — both are success outcomes, just starting from a different state.

The new deal is created in the **Partner Deal Lifecycle** pipeline's starting stage
(`"Partner Lead Registration"` — the pipeline's first stage by display order, and the
one whose label most directly matches "deal registered" semantics; see
`resolvePipelines()`'s header comment in `04-match-and-write-companies.js` for the
full reasoning), with `child_deals` (see correction below) set to `"true"`, then
associated to: the Partner's own HubSpot Company record (label "Partner"), the
end-user Company record if one can be found by exact name match (label "End User" —
skipped, not guessed, if the search returns zero or more than one candidate; flagged
in the result's `reason` when skipped), and the partner's top-level partnership deal
in the Channel Partners pipeline (label "Parent Deal"). The same
`hs_next_step`/`last_call_sentiment`/`last_call_date`/`last_call_unresolved_objections`
property write + summary note that a matched deal gets is then applied to the new
deal too, so it doesn't end up a bare shell.

**Three corrections against the originally-assumed HubSpot schema, confirmed live
2026-09-01 rather than guessed:**

1. **No partner's real deal is actually named `"{Partner} Program"`.** Real names vary
   per partner with no consistent formula: `"Socure - Channel Partnership"`,
   `"Signicat - Partnership Deal"`, `"Oscilar - reseller partnership"`, `"ZoomInfo -
   Strategic Partnership"`, `"Zenoo - Channel Partnership"`. For ZoomInfo specifically,
   the Channel Partners pipeline also holds several other ZoomInfo-named deals
   (Maintenance Fee FY26/FY27, Revenue Share FY26, two "Grade C lead expansion"
   variants, two "Global Expansion" variants, "ZI Studio Yr 2") that a name-based
   search could not safely disambiguate from the real one — a live per-run search, as
   originally scoped, would either match nothing for most partners or risk linking new
   deals to the wrong parent for ZoomInfo. That's a real data-integrity risk, not a
   style preference. **`PARTNER_PROGRAM_DEAL_IDS`** in `04-match-and-write-companies.js`
   is hardcoded instead — each ID confirmed empirically: every existing
   `{Partner} - {Company}` deal already in the Partner Deal Lifecycle pipeline that
   carries a "Parent Deal" association already points at exactly one of these IDs, per
   partner (confirmed this way for Socure, ZoomInfo, Signicat, Oscilar). **Zenoo is the
   one exception** — its 5 sampled existing children are not currently linked via the
   "Parent Deal" label at all (only the plain default association exists), so Zenoo's
   ID is inferred by naming-pattern consistency with Socure's, not confirmed via an
   existing link — flagged for the pipeline owner to sanity-check. New deals created by
   this step use the proper "Parent Deal" label for every partner going forward
   regardless. **Living list** — same maintenance pattern as `COMPANY_NAME_ALIASES`: a
   new `KNOWN_PARTNERS` entry, or a replaced Program-equivalent deal, must be manually
   re-confirmed and added here.
2. **The Channel Partners pipeline's real label is `"Channel Partners"`, not "Channel
   Partner Pipeline."** Both pipeline IDs (Partner Deal Lifecycle and Channel
   Partners) are resolved dynamically via `GET /crm/v3/pipelines/deals` once per run
   (see `resolvePipelines()`), matched by exact label — not hardcoded IDs, since
   pipeline IDs are portal-specific.
3. **`GET /crm/v3/properties/deals/child_deal` returns 404** — that exact property
   name doesn't exist in this portal. The real property is **`child_deals`** (plural),
   type enumeration / fieldType booleancheckbox, and its accepted values are the
   literal strings `"true"` / `"false"` (displayed in HubSpot's UI as "Yes"/"No" — that
   display label is not the stored value). `CHILD_DEALS_PROPERTY_NAME` /
   `CHILD_DEALS_TRUE_VALUE` in the source file are hardcoded + documented, the same
   convention this file already uses for `last_call_sentiment`'s dropdown casing (see
   "HubSpot dropdown option casing" above) — confirmed once, not re-checked live every
   run, since property internal names/enum values are stable schema metadata.

**Unconfigured-partner fallback.** `PARTNER_COMPANY_IDS` and `PARTNER_PROGRAM_DEAL_IDS`
in `04-match-and-write-companies.js` are living lists covering the 5 current
`KNOWN_PARTNERS`. If a company's partner isn't in both maps (e.g. a partner just added
to `KNOWN_PARTNERS` in `01-filter-partner-calls.js` but not yet confirmed and added
here), deal auto-creation is skipped for that company and it falls back to the
original `"no-match"` result — the `reason` names the unconfigured partner explicitly.
This never creates a deal with a missing or guessed association.

**Rate-limit / timeout impact.** Creating a deal adds real write-call volume beyond
what a matched deal already needed: one Company search (to resolve the End User
association) plus the deal-create call itself, before the same property-write + note
calls a matched deal gets. `SOFT_TIME_BUDGET_MS` (~25s) is **unchanged** — this is the
same "correctness over speed" trade-off already accepted for
`SEARCH_BATCH_SIZE`/`SEARCH_BATCH_DELAY_MS` (see "Why Phase 1 is throttled" above).
**Expect `companiesSkippedTimeout` to show up more often after this ships**,
especially on high-company-count calls with several unmatched companies.

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
written. It must also run **after Step C.1's filter has passed** (`transcriptReady`
is `true`) — a call whose transcript wasn't ready yet was already stopped at C.1 and
never reaches Step E or this step, so it's never marked "processed" and will be
retried on a later poll. Do not move Step G ahead of C.1 or attempt to mark a call
processed on the not-ready branch.

---

## Zap 2 — the report digest

Digest by Zapier needs a separate scheduled release. Set this up as its own tiny Zap:

| Step | App / Type | Config |
|---|---|---|
| 1 | **Digest by Zapier** | Trigger: Digest Ready — digest name `call-intel-run-report`, schedule hourly (or daily, your call) |
| 2 | **Email by Zapier** or **Slack** | Send the digest's combined content — calls found, companies extracted, deals matched/written, no-match cases, and unlisted-partner flags all in one message |

---

## Native HubSpot workflow — deal-desk notification on new partner deals (added 2026-09-01)

**Built and maintained directly in HubSpot's own workflow builder — not part of this
Zap, and has no code artifact in this repo.** Complements the deal auto-creation
described above ("Deal auto-creation for unmatched companies," in "The one outer
loop — one iteration per matching call" above): every deal that Step E auto-creates
lands in the **Partner Deal Lifecycle pipeline** (same pipeline both pieces depend
on), and this workflow's trigger fires on exactly that event.

| | |
|---|---|
| **Where it lives** | HubSpot → Automation → Workflows (portal-native, not Zapier) |
| **Trigger** | Deal created, pipeline = Partner Deal Lifecycle |
| **Action** | Send Email to `dealdesk@markaaz.com` |
| **Email contents** | Deal name, partner, company name, and a link to the deal |

Since this workflow fires on *any* new deal in that pipeline (not specifically ones
Step E created), it will also notify on deals created by other means — that's expected
and not scoped to this Zap's auto-creation feature specifically. There is nothing to
maintain here from this repo's side; changes to the trigger, recipient, or email
content are made directly in HubSpot's workflow builder by whoever owns that portal
config. If the Partner Deal Lifecycle pipeline is ever renamed or replaced, both this
workflow's trigger AND `PARTNER_DEAL_LIFECYCLE_PIPELINE_LABEL` in
`04-match-and-write-companies.js` need updating together, or new auto-created deals
and their deal-desk notification will drift out of sync silently.

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
- [ ] Confirm Step D → Step E's `companiesJson` field is mapped from Step D's dedicated
      "Companies Json" pill, not "Step Output {...}" — if it's wrong, Step E throws
      `"No companies array found in inputData"` immediately (see Troubleshooting)
- [ ] Confirm a company with no matching HubSpot deal produces a clean "no matching
      deal found" result in Step E's `results` array and makes zero HubSpot write calls
      for that company
- [ ] Run against a real call with a large company count (10+) and confirm Step E
      completes within Zapier's 30s Code-step limit — check `companiesSkippedTimeout`
      in the output is `0`. If it's not, the ~25s soft budget in
      `04-match-and-write-companies.js` did its job (no crash, clean partial result) but
      the batch is genuinely too large for one Code step run — see that file's header
      comment for the built-in mitigations before changing anything.
- [ ] On that same large-company-count run, confirm no `results` entry's `reason`
      mentions a `429` or rate limit — this is what the Phase 1 batching
      (`SEARCH_BATCH_SIZE` / `SEARCH_BATCH_DELAY_MS`) exists to prevent (see "Why
      Phase 1 is throttled" above). If it shows up, do not just re-widen batches to
      save time without re-checking HubSpot's current published Search API limit first.
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
| A company's `results` entry has `reason` containing `429` / mentions a rate limit | Deal-search throttling wasn't enough for this run's request pattern — check `SEARCH_BATCH_SIZE` / `SEARCH_BATCH_DELAY_MS` in `04-match-and-write-companies.js` are still what they should be (3 companies / 1000ms, ~3 req/s, under HubSpot's published 5 req/s CRM Search API limit — see "Why Phase 1 is throttled" above). If someone tightened the delay or widened the batch size to save time, that's the likely cause — revert, don't remove throttling entirely. |
| HubSpot returns `400 INVALID_OPTION` on a deal write, or a `results` entry's `reason` mentions a sentiment value that "did not match a known HubSpot option" | `last_call_sentiment` needs a capitalized value (`Positive`/`Neutral`/`At-Risk`); `mapSentimentToHubSpotOption()` in `04-match-and-write-companies.js` should already be converting this at write time — see the "HubSpot dropdown option casing" note above. If the error is on a *different* HubSpot dropdown property, that property needs the same kind of casing check/mapping added — it's not automatic for new properties. |
| Step E throws `"No companies array found in inputData"` | You mapped Step D's "Step Output {...}" (or the `companies` field) into Step E's `companiesJson` input instead of Step D's dedicated **"Companies Json"** output field. Zapier's Step Output picker stringifies the whole upstream object, not just the nested array — re-map to the specific `companiesJson` field. See the "Field mapping gotcha" callout above. |
| Step E throws `"inputData.companiesJson could not be parsed as JSON"` | `companiesJson` is present but isn't valid JSON — most likely something other than Step D's `companiesJson` output got mapped there (e.g. `topic` or `transcriptText`). Check the field mapping. |
| Same call processed twice | Confirm Step G (Storage Set Value) is actually wired after Step E, and Step A/B (Storage Get + Filter) are wired before Step C in every run |
| Someone added a second "Looping by Zapier" step and the Zap won't turn on | This is expected — Zapier enforces "no more than one Looping by Zapier step per Zap." Remove the second loop; the per-company fan-out belongs inside `04-match-and-write-companies.js`'s plain-JS `for...of` loop, not a second native loop. See "Why only one native loop" above. |
| Looping by Zapier step errors with "Required field 'Values to Loop' (loop_values) is missing" | This happens when candidateCalls comes back empty (e.g. an hourly poll with 0 partner-matched calls) — Zapier's line-item loop can't resolve an empty array reference. Fixed 2026-09-01 by adding a Filter by Zapier step (checking candidateCalls Exists) between the filter Code step and the Looping step. If this error reappears, confirm that filter step is still present and still ordered before the loop. |
| Step C's Data out shows `transcriptReady: false` | Expected and not an error — Apollo hadn't finished processing the call yet (30-40 min typical lag). The new Filter step (C.1) after Step C stops this call cleanly for this run; it'll be picked up again on a later poll since it was never marked processed in Storage by Zapier. |
