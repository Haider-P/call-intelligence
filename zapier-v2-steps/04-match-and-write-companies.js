/**
 * ZAPIER STEP — MATCH + WRITE: resolve each extracted company's deal and write it
 * (Code by Zapier, "Run Javascript")
 * ---------------------------------------------------------------------------------------
 * REPLACES the two-step design of 04-deal-matching.js + 05-write-deal-and-note.js (both
 * now marked SUPERSEDED, kept for reference only). Those two files assumed a second,
 * nested "Looping by Zapier" step over each call's `companies` array — confirmed during
 * live testing that Zapier does NOT support this: "You cannot turn on a Zap with more
 * than one Looping by Zapier step" (Zapier's own documentation). The existing outer loop
 * already iterates `candidateCalls` (one call at a time) — a second native loop over
 * that call's companies is not available.
 *
 * FIX: this single step runs once per call (inside the one remaining outer loop) and
 * loops over the companies array itself, in plain JavaScript (`for...of`), instead of
 * a second Zapier-level loop. All per-company deal-matching and write logic from the two
 * superseded files is ported here unchanged in substance — see the phase comments below
 * for exactly what moved where.
 *
 * FIELD MAPPING GOTCHA — the companies array must come in via `inputData.companiesJson`
 * (a JSON string), not `inputData.companies` directly. Zapier's "Step Output {...}"
 * data-picker inserts an ENTIRE step's output as one stringified object when mapped
 * into a downstream Input Data field, not just one nested array within it — confirmed
 * live, mapping Step Output to `companies` produced the whole Step 3 output object
 * stringified, not the array alone, and this step failed with "No companies array in
 * inputData". See resolveCompanies() below for the fix and the fallback order.
 *
 * TIMEOUT RISK — Zapier's standard Code step has a hard 30-second limit (confirmed live;
 * this is the same constraint that motivates keeping the enrichment step's model choice
 * fast). A single call can have 14+ companies, each needing 1 HubSpot search (match) +
 * up to 2 HubSpot writes (property PATCH + note POST) — up to 40+ sequential API calls
 * in the worst case, a real risk of exceeding 30s. Two mitigations, both below:
 *
 *   1. THROTTLED PARALLEL READS, SEQUENTIAL WRITES. Phase 1 (deal matching) is
 *      read-only and independent per company, so companies are matched in small
 *      concurrent batches (see SEARCH_BATCH_SIZE / SEARCH_BATCH_DELAY_MS below) rather
 *      than sequentially one at a time. This was originally a single unthrottled
 *      Promise.all over every company at once — confirmed live 2026-08-28 that this
 *      hits HubSpot's real CRM Search API rate limit (5 requests/second per account,
 *      per HubSpot's own docs): a 14-company dry run firing all 14 searches at once
 *      got 429s (HubSpot's "SECONDLY" rate-limit category) on 10 of the 14. The batched
 *      version stays safely under that limit with margin — see the comment on those
 *      constants for the exact numbers and reasoning. Phase 2 (writes) stays fully
 *      sequential, one company at a time — property PATCHes and note POSTs are NOT
 *      batched/parallelized at all, to avoid firing concurrent writes at HubSpot for
 *      potentially-related records (this is the actual bottleneck phase, and the
 *      slower/safer tradeoff is intentional here, not an oversight — and it wasn't
 *      implicated in the 429s, so it isn't touched by this throttling fix).
 *   2. SOFT TIME BUDGET. SOFT_TIME_BUDGET_MS (~25s) is checked before each company's
 *      write in Phase 2, measured from the top of the whole step (covers Phase 1 too,
 *      including the batch delays now built into it — see note on that constant).
 *      If exceeded, the loop stops immediately — no further companies are attempted.
 *      Every company never reached is explicitly recorded with
 *      status "skipped-timeout" and reason "skipped — time budget exceeded, not
 *      attempted" — NOT folded into "no matching deal found" — so a partial run is
 *      diagnosable (which companies were actually attempted vs. never reached) rather
 *      than silently incomplete. Throttling Phase 1 makes this path more likely to
 *      trigger on calls with a large company count than before — that's an accepted,
 *      already-tested tradeoff (see the constant's comment), not a regression to fix
 *      by shrinking the budget further, which would just make MORE calls hit this path
 *      without buying real safety against Zapier's 30s hard cutoff.
 *
 * Zapier wiring:
 *   Step type: Code by Zapier → "Run Javascript"
 *   inputData: companiesJson (string, from Step 3/enrichment's dedicated
 *     "Companies Json" output field — NOT Step Output {...}, see the field-mapping
 *     gotcha above), partner, startTime
 *   Requires Zapier Environment Variables: HUBSPOT_ACCESS_TOKEN
 *   output: { results: [...], companiesProcessed, companiesMatched, companiesCreated,
 *             companiesNoMatch, companiesSkippedTimeout, companiesErrored, partner,
 *             startTime }
 *
 * companiesErrored is one field beyond the originally-specified output shape: a
 * per-company try/catch around both the match and write calls means one company's
 * unexpected HubSpot failure (network blip, transient 5xx) can no longer silently
 * abort every other company's results the way a single uncaught throw would in this
 * merged single-step design — the two superseded steps had this isolation for free
 * because Zapier ran them once per company. companiesErrored (and each such company's
 * "error" status + reason in `results`) is what replaces that isolation here.
 *
 * HUBSPOT DROPDOWN CASING — the last_call_sentiment property's dropdown options are
 * capitalized ("Positive", "Neutral", "At-Risk"), but the enrichment step's sentiment
 * values are lowercase — confirmed live: writing the lowercase value directly caused
 * a HubSpot 400 INVALID_OPTION error on every write. mapSentimentToHubSpotOption()
 * below converts it at write time; an unrecognized value defaults to "Neutral" rather
 * than failing the write, and that fallback is surfaced as a non-null `reason` on an
 * otherwise-successful "written" result entry (not folded into "error" — it's a
 * data-quality note on a write that still succeeded). If a future HubSpot dropdown
 * property gets added to this pipeline, check its exact option casing the same way.
 *
 * DEAL AUTO-CREATION (added 2026-09-01) — when Phase 1 finds no existing deal for a
 * company, this step now CREATES one instead of just reporting "no-match" (see the
 * "Deal auto-creation" section below for the full mechanics: pipeline/stage
 * resolution, associations, and several corrections to the originally-assumed HubSpot
 * schema — confirmed live against this portal, not guessed). A newly created deal
 * gets a status of "created" in `results`, distinct from "written" (an existing deal
 * that got matched and updated) — both are success outcomes, just for different
 * starting states. This adds real write-call volume on top of the existing ~25s
 * SOFT_TIME_BUDGET_MS (unchanged) — see the note near that constant below.
 *
 * See "Why only one native loop" in ../docs/zapier-v2-setup.md for the full
 * architecture rationale — do not "fix" this by adding a second Looping by Zapier step;
 * that is the exact constraint this file works around.
 */

// ---- Deal matching (ported from 04-deal-matching.js, unchanged) -------------------

// Known company-name transcription mismatches, confirmed from real Claude enrichment
// output against live call transcripts (e.g. "PayMeadow" extracted for the actual
// customer "Paymitto" on the 2026-08-26 Socure/Markaaz Partnership call). These gaps
// are too large for normalize()'s case/punctuation/whitespace tolerance below to
// safely catch — widening that further (e.g. edit-distance fuzzing) risks false
// positives across unrelated companies, which is exactly why this alias map exists as
// the first-line fix instead.
//
// LIVING LIST: append a new entry here whenever a new transcription mismatch is
// confirmed against a real company/deal — same maintenance pattern as
// SYNC_KEYWORD_ALIASES in 01-filter-partner-calls.js. Keys must be normalized via
// normalizeCompanyKey() below (lowercase, trimmed, ALL whitespace stripped — not just
// collapsed, see that function's comment) so a lookup matches regardless of how the
// alias happens to be capitalized or spaced. Write new keys with NO spaces at all
// (e.g. "openfx", not "open fx") — normalizeCompanyKey() strips whitespace from the
// incoming name before lookup, so a key containing a space could never be reached.
const COMPANY_NAME_ALIASES = {
  paymeadow: "Paymitto", // confirmed 2026-08-28, Socure/Markaaz Partnership call — also covers "Pay Meadow" (with a space) as of 2026-08-29, see normalizeCompanyKey()'s root-cause comment below
  valera: "Velera", // confirmed 2026-08-28, Socure/Markaaz Partnership call
  greensky: "Greensky", // confirmed 2026-08-28, Socure/Markaaz Partnership call — key changed from "green sky" to "greensky" 2026-08-29 to match the fixed normalizeCompanyKey() output format (see below); same alias, same pair, key format only
  openfx: "OpenFx", // confirmed 2026-08-29
  polymarket: "Polymarket", // confirmed 2026-08-29
  weeble: "WeBull", // confirmed 2026-08-29
  paros: "Partos", // confirmed 2026-08-29
  partos: "Partos AI" // confirmed 2026-08-29 via direct lookup ("Socure - Partos AI") — distinct from the "paros" entry above (transcript drops the "t"); this one drops "AI"
};

// Lowercase + trim + strip ALL internal whitespace (not just collapse runs down to a
// single space) — used only to key into COMPANY_NAME_ALIASES, so "Pay Meadow",
// "PayMeadow", "pay   meadow", and "paymeadow" all normalize to the exact same
// "paymeadow" key regardless of spacing. Distinct from normalize() below, which
// additionally strips punctuation and is used for comparing against real HubSpot deal
// names, not for alias-map lookups.
//
// ROOT CAUSE (2026-08-29): a live "Pay Meadow" (transcribed WITH a space) failed to
// match the existing "paymeadow" (no space) alias, even though that alias was already
// confirmed to cover this exact real company. The prior version of this function only
// COLLAPSED whitespace (`replace(/\s+/g, " ")`) rather than stripping it entirely —
// "Pay Meadow" normalized to "pay meadow" (one space), a different string from the
// stored "paymeadow" key (zero spaces), so the lookup silently missed. Stripping
// whitespace entirely fixes this generally, for any alias, not just this one pair —
// every COMPANY_NAME_ALIASES key above is written in this same fully-stripped form so
// incoming names and stored keys can never diverge on spacing again.
function normalizeCompanyKey(str) {
  return (str || "").toLowerCase().trim().replace(/\s+/g, "");
}

function normalize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/\./g, "") // "U.S. Bank" -> "us bank"
    .replace(/[^a-z0-9\s-]/g, "") // strip other punctuation
    .replace(/\s+/g, " ")
    .trim();
}

async function searchHubSpotDeals(token, companyName) {
  const response = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: companyName,
      properties: ["dealname"],
      limit: 25
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HubSpot deal search failed: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  return data.results || [];
}

// Resolves one company's deal: alias check first, then the existing normalize()-based
// fuzzy fallback (case/punctuation/whitespace tolerance, e.g. "US Bank" vs
// "U.S. Bank") — exactly the two-tier logic from 04-deal-matching.js, just extracted
// into a function so it can run once per company from the loop below. Never creates a
// deal, only matches existing ones, per the original design.
async function matchCompanyDeal(token, partner, rawCompanyName) {
  const aliasedCompanyName = COMPANY_NAME_ALIASES[normalizeCompanyKey(rawCompanyName)];
  const companyName = aliasedCompanyName || rawCompanyName;

  const targetDealName = `${partner} - ${companyName}`;
  const targetNormalized = normalize(targetDealName);

  // ROOT CAUSE (2026-08-29): a live "U.S. Bank" -> "US Bank" match failed even though
  // normalize() itself was never the problem — normalize("U.S. Bank") and
  // normalize("US Bank") both already produce "us bank", so the post-search
  // comparison below was always correct in isolation. The actual gap: the RAW,
  // still-punctuated companyName used to be sent as the search query itself
  // (searchHubSpotDeals(token, companyName)). If HubSpot's own search relevance is
  // sensitive to the literal periods in "U.S. Bank", the real deal ("Socure - US
  // Bank") may never come back as a candidate at all — normalize()'s comparison never
  // gets a chance to run on a candidate the search never returned in the first place.
  // Searching with an already-normalized (lowercased, punctuation-stripped) query
  // instead closes that gap for any punctuation/casing variant, not just this one
  // pair — and can only ever return the same or more candidates than the raw,
  // punctuated query would, never fewer.
  const searchQuery = normalize(companyName);
  const candidates = await searchHubSpotDeals(token, searchQuery);

  const exactMatches = candidates.filter(
    (d) => normalize(d.properties.dealname) === targetNormalized
  );

  let matched = false;
  let dealId = null;
  let matchedDealName = null;

  if (exactMatches.length === 1) {
    matched = true;
    dealId = exactMatches[0].id;
    matchedDealName = exactMatches[0].properties.dealname;
  }
  // exactMatches.length === 0 (no candidate) or > 1 (ambiguous — do not guess) both
  // fall through as unmatched, same "don't guess" rule as the original step.

  const reason = matched
    ? null
    : "no matching deal found — possible transcription mismatch: consider adding to COMPANY_NAME_ALIASES if this is a recurring real company";

  return { companyName, matched, dealId, matchedDealName, candidateCount: exactMatches.length, reason };
}

// ---- Deal + note write (ported from 05-write-deal-and-note.js, unchanged) ---------

// HubSpot's last_call_sentiment dropdown property options are capitalized
// ("Positive", "Neutral", "At-Risk"), but the enrichment step's sentiment values
// (company.sentiment, from 03-claude-enrichment.js) are lowercase ("positive",
// "neutral", "at-risk") — confirmed live: writing the lowercase value directly to
// this property caused a HubSpot 400 INVALID_OPTION error on every write. Deliberately
// NOT fixed by changing the enrichment step's output format — lowercase is the more
// natural JS/JSON convention and that value may be used elsewhere — the
// HubSpot-specific casing requirement is kept isolated to this one write step, where
// it belongs. If a future HubSpot dropdown property gets added to this pipeline,
// check its exact option casing the same way rather than assuming any lowercase
// value will be accepted as-is.
const SENTIMENT_TO_HUBSPOT_OPTION = {
  positive: "Positive",
  neutral: "Neutral",
  "at-risk": "At-Risk"
};

// Falls back to "Neutral" for anything unrecognized (unexpected casing, a typo from
// a future prompt change, an entirely new sentiment value, etc.) rather than sending
// an invalid option and failing the whole write. usedFallback is surfaced by the
// caller into the company's `results` entry so a silent default doesn't go unnoticed.
function mapSentimentToHubSpotOption(sentiment) {
  const key = (sentiment || "").toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(SENTIMENT_TO_HUBSPOT_OPTION, key)) {
    return { value: SENTIMENT_TO_HUBSPOT_OPTION[key], usedFallback: false };
  }
  return { value: "Neutral", usedFallback: true };
}

async function patchDeal(token, dealId, properties) {
  const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ properties })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update deal ${dealId}: ${response.status} — ${errorText}`);
  }

  return response.json();
}

async function createNote(token, dealId, noteBody, timestampMs) {
  const response = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      properties: {
        hs_note_body: noteBody,
        hs_timestamp: String(timestampMs)
      },
      associations: [
        {
          to: { id: dealId },
          // HUBSPOT_DEFINED note-to-deal association, typeId 214 — confirmed via
          // /crm/v4/associations/notes/deals/labels during the prior hygiene-fix session.
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }]
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create note on deal ${dealId}: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  return data.id;
}

// Writes the 4 deal properties + adds the summary note for one matched company. Only
// called once matchCompanyDeal() has confirmed a dealId — no HubSpot write calls are
// ever made for an unmatched company.
async function writeCompanyUpdate(token, partner, startTime, matchResult, company) {
  const { sentiment, nextStep, unresolvedObjections, rawSummary } = company;
  const callDate = startTime ? new Date(startTime) : new Date();
  const callDateStr = callDate.toISOString().split("T")[0];

  const { value: hubspotSentiment, usedFallback: sentimentFallbackUsed } = mapSentimentToHubSpotOption(sentiment);

  const properties = {
    hs_next_step: nextStep,
    last_call_sentiment: hubspotSentiment,
    last_call_date: callDateStr,
    last_call_unresolved_objections:
      unresolvedObjections && unresolvedObjections !== "None" ? unresolvedObjections : ""
  };

  await patchDeal(token, matchResult.dealId, properties);

  // Note body keeps the original (lowercase) sentiment as free text — it's not a
  // HubSpot dropdown field, so the casing mapping above doesn't apply here.
  const noteBody = `📞 ${partner} / Markaaz Partnership sync — ${callDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  })}
Company: ${matchResult.companyName}
Sentiment: ${sentiment}
Next step: ${nextStep}
Unresolved objections: ${unresolvedObjections}

Summary:
${rawSummary}`;

  const noteId = await createNote(token, matchResult.dealId, noteBody, callDate.getTime());

  return { updatedProperties: Object.keys(properties), noteId, sentimentFallbackUsed };
}

// ---- Deal auto-creation for unmatched companies (added 2026-09-01) ---------------
//
// Several details below were originally assumed (a "{Partner} Program" deal-naming
// convention, a "Channel Partner Pipeline" label, a "child_deal" property accepting
// "Yes") and turned out not to match this portal's real schema — confirmed live via
// GET calls against the actual portal on 2026-09-01, documented at each correction
// below rather than silently "fixed." See the session report for the full evidence
// trail; the summary is captured in the comments on the constants themselves.

// Pipeline labels, resolved dynamically (not hardcoded IDs — see resolvePipelines()
// below) since pipeline IDs are portal-specific and this keeps the step portable if
// it's ever pointed at a different portal/sandbox. CORRECTION: the Channel Partners
// pipeline's real label is "Channel Partners", not "Channel Partner Pipeline".
const PARTNER_DEAL_LIFECYCLE_PIPELINE_LABEL = "Partner Deal Lifecycle";
const CHANNEL_PARTNER_PIPELINE_LABEL = "Channel Partners";

// Starting stage for every auto-created deal. Confirmed live 2026-09-01: the Partner
// Deal Lifecycle pipeline's first (displayOrder 0) stage is literally named "Partner
// Lead Registration" (metadata: isClosed false, probability 0.05) — the clearest
// available match for "deal registered" semantics, not an arbitrary first stage
// picked by position. Matched by exact label (see resolvePipelines()), not
// displayOrder, so a future stage reorder can't silently misfile new deals into the
// wrong stage — if this label is ever renamed, resolution fails loudly instead of
// guessing a different stage.
const PARTNER_DEAL_LIFECYCLE_START_STAGE_LABEL = "Partner Lead Registration";

// CORRECTION: GET /crm/v3/properties/deals/child_deal returned 404 — that exact
// property name doesn't exist in this portal. The real property is `child_deals`
// (plural), type enumeration / fieldType booleancheckbox, with options
// {value: "true", label: "Yes"} / {value: "false", label: "No"} — the value actually
// stored is the literal string "true", "Yes" is only the checkbox's display label.
// Hardcoded + documented here rather than looked up live every run, same pattern this
// file already uses for last_call_sentiment's dropdown casing (see
// SENTIMENT_TO_HUBSPOT_OPTION above) — property internal names and enum values are
// stable schema metadata, not something that changes portal-to-portal or run-to-run.
const CHILD_DEALS_PROPERTY_NAME = "child_deals";
const CHILD_DEALS_TRUE_VALUE = "true";

// Deal<->company association labels. Confirmed live 2026-09-01 via GET
// /crm/v4/associations/deals/companies/labels: "Partner" = USER_DEFINED typeId 88,
// "End User" = USER_DEFINED typeId 90 (HubSpot's real label is "End User", not "End
// user"). Hardcoded + documented, same convention as the note-to-deal association
// (HUBSPOT_DEFINED typeId 214) already used in createNote() above — this file's
// established pattern is "confirm once via the labels endpoint, hardcode with a
// comment," not a live lookup on every run.
const PARTNER_COMPANY_ASSOCIATION_TYPE_ID = 88;
const END_USER_COMPANY_ASSOCIATION_TYPE_ID = 90;

// Deal<->deal "Parent Deal" association label. Confirmed live 2026-09-01 via GET
// /crm/v4/associations/deals/deals/labels: "Parent Deal" = USER_DEFINED typeId 84.
// Its reciprocal, "Child Deal" (typeId 85), auto-applies on the other side — no
// second call needed, confirmed against this portal's existing Parent Deal/Child
// Deal pairs.
const PARENT_DEAL_ASSOCIATION_TYPE_ID = 84;

// Each of the 5 KNOWN_PARTNERS' own HubSpot Company record ID (see KNOWN_PARTNERS in
// 01-filter-partner-calls.js). Confirmed live 2026-09-01 via company search — each
// partner has exactly one company record with this exact name, no ambiguity found.
// Hardcoded rather than searched per-run: (a) it's a small, fixed, well-known set,
// nowhere near the scale that justifies a live search, and (b) a live search would
// add Search API load to the same rate-limit budget Phase 1's deal-matching batches
// already have to stay under (see SEARCH_BATCH_SIZE below). LIVING LIST — same
// maintenance pattern as COMPANY_NAME_ALIASES above: if a new partner is ever added
// to KNOWN_PARTNERS, its company ID must be looked up and added here before this file
// can auto-create deals for that partner — see resolvePartnerContext() below for what
// happens if it's missing (falls back to the old "no-match" behavior, does not crash
// the run).
const PARTNER_COMPANY_IDS = {
  Socure: "16736354190",
  Zenoo: "46903583569",
  ZoomInfo: "18325500821",
  Signicat: "19395102132",
  Oscilar: "21867603006"
};

// Each of the 5 KNOWN_PARTNERS' top-level partnership deal in the Channel Partners
// pipeline — the "Parent Deal" every new {Partner} - {Company} deal gets linked to.
//
// CORRECTION — no partner's real deal is actually named "{Partner} Program".
// Confirmed live 2026-09-01: real names vary per partner with no consistent formula
// ("Socure - Channel Partnership", "Signicat - Partnership Deal", "Oscilar - reseller
// partnership", "ZoomInfo - Strategic Partnership", "Zenoo - Channel Partnership"),
// and for ZoomInfo specifically the Channel Partners pipeline also holds several
// OTHER ZoomInfo-named deals (Maintenance Fee FY26/FY27, Revenue Share FY26, Grade C
// lead expansion x2, Global Expansion x2, ZI Studio Yr 2) that a name-based search
// could not safely disambiguate from the real one — a per-run search, as originally
// scoped, would either match nothing for most partners or risk linking new deals to
// the wrong parent for ZoomInfo. That's a real data-integrity risk, not a style
// preference, so this is hardcoded instead (same rationale as PARTNER_COMPANY_IDS).
//
// Each ID below was confirmed empirically, not guessed: every existing
// {Partner} - {Company} deal already in the Partner Deal Lifecycle pipeline that
// carries a "Parent Deal" (typeId 84) association already points at exactly one of
// these IDs, per partner — i.e. this is the parent every human-created deal for that
// partner is already actually using in production. Confirmed this way for Socure,
// ZoomInfo, Signicat, and Oscilar. Zenoo's existing children (5 sampled) are NOT
// currently linked via the "Parent Deal" label at all — only the plain default
// association exists — so Zenoo's ID below (its one "Channel Partnership" deal,
// matching the same naming pattern used for Socure) is inferred by naming-pattern
// consistency, not confirmed via an existing "Parent Deal" link. Flagged to the
// pipeline owner to sanity-check; new deals created by this step will use the proper
// "Parent Deal" label for every partner going forward regardless.
//
// LIVING LIST — same maintenance pattern as PARTNER_COMPANY_IDS above: if a new
// partner is added to KNOWN_PARTNERS, or a partner's canonical Program-equivalent
// deal is ever replaced, this must be manually re-confirmed and updated — there is no
// reliable automatic way to (re)discover it given the inconsistent naming.
const PARTNER_PROGRAM_DEAL_IDS = {
  Socure: "22010293408", // "Socure - Channel Partnership"
  Zenoo: "51514482999", // "Zenoo - Channel Partnership" — inferred by naming pattern, not an existing Parent Deal link, see note above
  ZoomInfo: "22678525001", // "ZoomInfo - Strategic Partnership"
  Signicat: "21779255895", // "Signicat - Partnership Deal"
  Oscilar: "21799341680" // "Oscilar - reseller partnership"
};

// Returns { partnerCompanyId, programDealId } for a configured partner, or null if
// the partner isn't in both maps above — the caller falls back to the old "no-match"
// behavior for an unconfigured partner rather than crashing the whole run or creating
// a deal with a missing/guessed association.
function resolvePartnerContext(partner) {
  const partnerCompanyId = PARTNER_COMPANY_IDS[partner];
  const programDealId = PARTNER_PROGRAM_DEAL_IDS[partner];
  if (!partnerCompanyId || !programDealId) {
    return null;
  }
  return { partnerCompanyId, programDealId };
}

// Fetches the portal's deal pipelines ONCE per run — called lazily, only the first
// time Phase 2 actually needs it (i.e. only on a call with at least one unmatched,
// auto-creatable company), not unconditionally on every run and not per-company. This
// is a plain GET, not a CRM Search API call, so it doesn't touch the 5 req/s search
// rate limit Phase 1's batches already have to stay under (see SEARCH_BATCH_SIZE
// below) — but it's still kept to once per run rather than once per company, both to
// minimize load and because pipeline/stage IDs don't vary per company within a run.
//
// Resolves both pipelines this step needs by exact label match and throws a clear,
// named error if either the pipeline or the expected starting stage isn't found —
// rather than silently falling back to a guess (e.g. the first stage by display
// order). Placing a new deal in the wrong stage or pipeline is a real data-integrity
// mistake, not a cosmetic one, so this fails loud instead of guessing.
async function resolvePipelines(token) {
  const response = await fetch("https://api.hubapi.com/crm/v3/pipelines/deals", {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch deal pipelines: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  const pipelines = data.results || [];

  const lifecyclePipeline = pipelines.find((p) => p.label === PARTNER_DEAL_LIFECYCLE_PIPELINE_LABEL);
  if (!lifecyclePipeline) {
    throw new Error(
      `Could not find a deal pipeline labeled "${PARTNER_DEAL_LIFECYCLE_PIPELINE_LABEL}" — check the pipeline still exists with this exact label`
    );
  }
  const startStage = (lifecyclePipeline.stages || []).find(
    (s) => s.label === PARTNER_DEAL_LIFECYCLE_START_STAGE_LABEL
  );
  if (!startStage) {
    throw new Error(
      `Could not find a stage labeled "${PARTNER_DEAL_LIFECYCLE_START_STAGE_LABEL}" in the "${PARTNER_DEAL_LIFECYCLE_PIPELINE_LABEL}" pipeline — check the stage still exists with this exact label`
    );
  }

  const channelPartnerPipeline = pipelines.find((p) => p.label === CHANNEL_PARTNER_PIPELINE_LABEL);
  if (!channelPartnerPipeline) {
    throw new Error(
      `Could not find a deal pipeline labeled "${CHANNEL_PARTNER_PIPELINE_LABEL}" — check the pipeline still exists with this exact label`
    );
  }

  return {
    lifecyclePipelineId: lifecyclePipeline.id,
    startStageId: startStage.id,
    channelPartnerPipelineId: channelPartnerPipeline.id
  };
}

// Only called from createPartnerDeal() below, i.e. only for a company that already
// failed to match an existing deal in Phase 1 — never adds Search API load for
// companies that already matched there. Runs sequentially within Phase 2 (already
// single-company-at-a-time, see the Phase 2 comment above), so it doesn't need its
// own throttling on top of that existing sequential safety.
//
// Exact-match only, same "don't guess" rule as matchCompanyDeal() above: if the
// search returns zero or more than one company whose normalize()'d name matches, this
// returns null rather than guessing — the deal still gets created (see
// createPartnerDeal()), just without an "End User" company association, and that gap
// is surfaced in the result's `reason` for a human to fix manually.
async function resolveEndUserCompanyId(token, companyName) {
  const response = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: companyName,
      properties: ["name"],
      limit: 10
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HubSpot company search failed: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  const candidates = data.results || [];
  const targetNormalized = normalize(companyName);
  const exactMatches = candidates.filter((c) => normalize(c.properties.name) === targetNormalized);

  return exactMatches.length === 1 ? exactMatches[0].id : null;
}

// Creates the new {Partner} - {Company} deal in the Partner Deal Lifecycle pipeline's
// starting stage, associating the Partner company + (if resolved) the End User
// company + the partner's Program-equivalent deal all in ONE create call, via the
// `associations` array on POST /crm/v3/objects/deals — not a separate v4 PUT
// afterward. Deliberate: this repo has already been bitten once by the v4
// PUT-replaces-not-merges gotcha (PUTting a partial label list onto an object that
// already has other labels silently drops the ones you didn't include) — that risk is
// specific to modifying an EXISTING object's associations. A brand-new deal has no
// pre-existing associations to accidentally clobber, so setting them inline at
// creation sidesteps that whole class of bug entirely, more simply than a v4 PUT
// would.
//
// Only sets the properties explicitly in scope here (dealname, pipeline, dealstage,
// child_deals) — the caller (see the main loop below) runs writeCompanyUpdate()
// against the newly created deal right afterward, the exact same call used for an
// existing matched deal, so a newly created deal ends up with the same
// hs_next_step/last_call_sentiment/last_call_date/last_call_unresolved_objections +
// summary note as one that already existed and got matched, not a bare shell.
async function createPartnerDeal(token, { partner, companyName, pipelineId, stageId, partnerCompanyId, programDealId }) {
  const dealname = `${partner} - ${companyName}`;
  const endUserCompanyId = await resolveEndUserCompanyId(token, companyName);

  const associations = [
    {
      to: { id: partnerCompanyId },
      types: [{ associationCategory: "USER_DEFINED", associationTypeId: PARTNER_COMPANY_ASSOCIATION_TYPE_ID }]
    },
    {
      to: { id: programDealId },
      types: [{ associationCategory: "USER_DEFINED", associationTypeId: PARENT_DEAL_ASSOCIATION_TYPE_ID }]
    }
  ];
  if (endUserCompanyId) {
    associations.push({
      to: { id: endUserCompanyId },
      types: [{ associationCategory: "USER_DEFINED", associationTypeId: END_USER_COMPANY_ASSOCIATION_TYPE_ID }]
    });
  }

  const response = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      properties: {
        dealname,
        pipeline: pipelineId,
        dealstage: stageId,
        [CHILD_DEALS_PROPERTY_NAME]: CHILD_DEALS_TRUE_VALUE
      },
      associations
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create deal "${dealname}": ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  return { dealId: data.id, dealname, endUserCompanyResolved: Boolean(endUserCompanyId) };
}

// ---- Reading the companies array (Zapier field-mapping gotcha) -------------------

// Zapier's "Step Output {...}" data-picker inserts an ENTIRE step's output as one
// stringified object when mapped into a downstream Input Data field, not just one
// nested array field within it — confirmed live: mapping Step 3's Step Output to
// `companies` here resulted in inputData.companies being the FULL Step 3 output
// object stringified (partner + startTime + companies all together), not the
// companies array alone, causing "No companies array in inputData" below.
//
// Fix: Step 3 (03-claude-enrichment.js) now also outputs `companiesJson` — a
// dedicated JSON string of JUST the companies array, a plain string pill in
// Zapier's field picker with no array-vs-object-vs-string ambiguity. That's the
// primary path here. inputData.companies (a genuine array, e.g. from this repo's
// own tests, or if Zapier's picker behavior ever changes) is a secondary fallback,
// not the primary path — don't rely on it in the live Zap wiring.
function resolveCompanies(inputData) {
  if (inputData.companiesJson !== undefined && inputData.companiesJson !== null) {
    let parsed;
    try {
      parsed = JSON.parse(inputData.companiesJson);
    } catch (err) {
      throw new Error(`inputData.companiesJson could not be parsed as JSON: ${err.message}`);
    }
    if (Array.isArray(parsed)) {
      return parsed;
    }
  }

  if (Array.isArray(inputData.companies)) {
    return inputData.companies;
  }

  throw new Error(
    "No companies array found in inputData — checked inputData.companiesJson (parsed as JSON) " +
      "and inputData.companies (as a genuine array); neither yielded one. Check the Step 3 -> " +
      "Step 4 field mapping: map Step 3's \"Companies Json\" output field to companiesJson here, " +
      "not Step Output {...} (which stringifies the whole Step 3 output object, not just the array)."
  );
}

// ---- Throttled batch matching (HubSpot Search API rate limit) --------------------

// HubSpot's CRM Search API (used by searchHubSpotDeals above) is rate limited to
// 5 requests/second per account — confirmed via HubSpot's own docs
// (developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm, "Limits"
// section: "The search endpoints are rate limited to five requests per second per
// account."). This is a separate, more restrictive limit than HubSpot's general
// 100-requests/10-seconds API limit, and it's account-wide — not per-integration.
//
// A live dry run confirmed hitting it directly: the original design fired every
// company's search concurrently via a single Promise.all (no batching at all). For
// a 14-company call, that's 14 simultaneous search requests — 10 of the 14 came back
// 429, HubSpot's "SECONDLY" rate-limit category, in one real test run.
//
// SEARCH_BATCH_SIZE / SEARCH_BATCH_DELAY_MS below throttle this to 3 requests
// every 1000ms — a sustained 3 req/s, ~40% margin under HubSpot's 5 req/s limit
// (the delay is measured from the START of one batch to the START of the next, so
// a batch's 3 near-simultaneous requests plus the next batch's 3 never land in the
// same 1-second window). Since "Looping by Zapier" processes the outer loop's calls
// one at a time — never concurrently — this step's own batching is the only source
// of concurrent HubSpot search traffic to budget for; no cross-call coordination is
// needed.
//
// Trade-off: this adds real wall-clock time to Phase 1 that wasn't there before
// (SEARCH_BATCH_DELAY_MS between every batch), which eats into the soft time budget
// below. A call with a large company count is now more likely to hit the
// "skipped-timeout" path than before this fix — that's an accepted, already-tested
// degradation path (see SOFT_TIME_BUDGET_MS's comment), not a bug: correctness
// (not getting 429'd, not silently dropping company results) took priority over
// speed here.
const SEARCH_BATCH_SIZE = 3;
const SEARCH_BATCH_DELAY_MS = 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Matches every company's deal in small concurrent batches instead of one big
// Promise.all — see the constants above for the rate-limit reasoning. Each entry is
// individually .catch()-guarded, same as before, so one company's search failure
// can't drop any other company's result (within its batch or any other).
async function matchCompaniesThrottled(token, partner, companies) {
  const matchResults = [];

  for (let i = 0; i < companies.length; i += SEARCH_BATCH_SIZE) {
    const batch = companies.slice(i, i + SEARCH_BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map((company) =>
        matchCompanyDeal(token, partner, company.companyName).catch((err) => ({
          companyName: company.companyName,
          matched: false,
          dealId: null,
          matchedDealName: null,
          candidateCount: 0,
          reason: `deal search failed: ${err.message}`,
          searchError: true
        }))
      )
    );
    matchResults.push(...batchResults);

    const isLastBatch = i + SEARCH_BATCH_SIZE >= companies.length;
    if (!isLastBatch) {
      await delay(SEARCH_BATCH_DELAY_MS);
    }
  }

  return matchResults;
}

// ---- Main: one call's worth of companies, processed in plain JS ------------------

// ~25s soft budget, leaving ~5s margin before Zapier's 30s hard Code-step cutoff.
// Measured from the very top of this step (below), so it covers both the throttled
// matching phase (including its batch delays, see SEARCH_BATCH_DELAY_MS above) and
// the sequential write phase — not just the write loop.
const SOFT_TIME_BUDGET_MS = 25000;

const token = process.env.HUBSPOT_ACCESS_TOKEN;
if (!token) {
  throw new Error("HUBSPOT_ACCESS_TOKEN is not set in this Zap's environment variables");
}

const companies = resolveCompanies(inputData);

const partner = inputData.partner;
const startTime = inputData.startTime;
if (!partner) {
  throw new Error("No partner in inputData — Step 1/2/3 should have carried this through");
}

const startedAt = Date.now();

// Phase 1: match every company's deal, throttled in small batches (see
// matchCompaniesThrottled() and the SEARCH_BATCH_SIZE/SEARCH_BATCH_DELAY_MS comment
// above) to stay under HubSpot's real 5 req/s CRM Search API rate limit — the
// original single unthrottled Promise.all here got 429'd on a live 14-company call.
const matchResults = await matchCompaniesThrottled(token, partner, companies);

// Phase 2: process sequentially, one company at a time. Writes (property PATCH + note
// POST) touch live HubSpot records — kept sequential rather than parallelized, unlike
// Phase 1's reads, to avoid firing concurrent writes at potentially-related deals (the
// safer choice per this step's explicit design, even though it's the slower phase and
// therefore the one actually at risk of the 30s hard cutoff — hence the time check
// below).
const results = [];
let timedOut = false;

// Resolved lazily, at most once for the whole run — see resolvePipelines()'s comment
// for why this isn't fetched unconditionally up front. Stays null for the entire run
// on a call where every company matches an existing deal.
let pipelineContext = null;

for (let i = 0; i < companies.length; i++) {
  if (Date.now() - startedAt > SOFT_TIME_BUDGET_MS) {
    timedOut = true;
    break;
  }

  const company = companies[i];
  const matchResult = matchResults[i];

  if (matchResult.searchError) {
    results.push({
      companyName: matchResult.companyName,
      status: "error",
      dealId: null,
      matchedDealName: null,
      updatedProperties: [],
      noteId: null,
      candidateCount: 0,
      reason: matchResult.reason
    });
    continue;
  }

  if (!matchResult.matched) {
    // DEAL AUTO-CREATION (added 2026-09-01) — no existing deal found, so create one
    // instead of just reporting "no-match", UNLESS this call's partner isn't
    // configured in PARTNER_COMPANY_IDS/PARTNER_PROGRAM_DEAL_IDS above (a partner
    // added to KNOWN_PARTNERS in 01-filter-partner-calls.js but not yet added to
    // those living lists here) — that case still falls back to the original
    // "no-match" behavior rather than creating a deal with a missing/guessed
    // association. NOTE: this branch adds real write-call volume (a company search +
    // a deal create, on top of the same property-write + note calls a matched deal
    // already gets) on top of the existing ~25s SOFT_TIME_BUDGET_MS above (left
    // unchanged) — expect companiesSkippedTimeout to show up more often after this
    // ships, especially on high-company-count calls with several unmatched
    // companies, for the same "correctness over speed" reason SEARCH_BATCH_SIZE /
    // SEARCH_BATCH_DELAY_MS was accepted for Phase 1 (see that comment above).
    const partnerContext = resolvePartnerContext(partner);

    if (!partnerContext) {
      results.push({
        companyName: matchResult.companyName,
        status: "no-match",
        dealId: null,
        matchedDealName: null,
        updatedProperties: [],
        noteId: null,
        candidateCount: matchResult.candidateCount,
        reason: `${matchResult.reason} — deal auto-creation skipped: "${partner}" is not yet configured in PARTNER_COMPANY_IDS/PARTNER_PROGRAM_DEAL_IDS`
      });
      continue;
    }

    try {
      if (!pipelineContext) {
        pipelineContext = await resolvePipelines(token);
      }

      const created = await createPartnerDeal(token, {
        partner,
        companyName: matchResult.companyName,
        pipelineId: pipelineContext.lifecyclePipelineId,
        stageId: pipelineContext.startStageId,
        partnerCompanyId: partnerContext.partnerCompanyId,
        programDealId: partnerContext.programDealId
      });

      // Run the SAME property-write + note logic a matched deal gets, against the
      // deal we just created — see createPartnerDeal()'s comment for why.
      const syntheticMatchResult = {
        companyName: matchResult.companyName,
        matched: true,
        dealId: created.dealId,
        matchedDealName: created.dealname,
        candidateCount: 0,
        reason: null
      };
      const { updatedProperties, noteId, sentimentFallbackUsed } = await writeCompanyUpdate(
        token,
        partner,
        startTime,
        syntheticMatchResult,
        company
      );

      const notes = [];
      if (!created.endUserCompanyResolved) {
        notes.push(
          `no matching Company record found for "${matchResult.companyName}" — End User association not added, link manually`
        );
      }
      if (sentimentFallbackUsed) {
        notes.push(`sentiment value "${company.sentiment}" did not match a known HubSpot option — defaulted to "Neutral"`);
      }

      results.push({
        companyName: matchResult.companyName,
        status: "created",
        dealId: created.dealId,
        matchedDealName: created.dealname,
        updatedProperties,
        noteId,
        candidateCount: matchResult.candidateCount,
        reason: notes.length > 0 ? notes.join("; ") : null
      });
    } catch (err) {
      results.push({
        companyName: matchResult.companyName,
        status: "error",
        dealId: null,
        matchedDealName: null,
        updatedProperties: [],
        noteId: null,
        candidateCount: matchResult.candidateCount,
        reason: `deal creation failed: ${err.message}`
      });
    }
    continue;
  }

  try {
    const { updatedProperties, noteId, sentimentFallbackUsed } = await writeCompanyUpdate(
      token,
      partner,
      startTime,
      matchResult,
      company
    );
    results.push({
      companyName: matchResult.companyName,
      status: "written",
      dealId: matchResult.dealId,
      matchedDealName: matchResult.matchedDealName,
      updatedProperties,
      noteId,
      candidateCount: matchResult.candidateCount,
      // Still a successful write — reason is only non-null here to flag a data-quality
      // note (an unrecognized sentiment value defaulted to "Neutral"), not a failure.
      reason: sentimentFallbackUsed
        ? `sentiment value "${company.sentiment}" did not match a known HubSpot option — defaulted to "Neutral"`
        : null
    });
  } catch (err) {
    results.push({
      companyName: matchResult.companyName,
      status: "error",
      dealId: matchResult.dealId,
      matchedDealName: matchResult.matchedDealName,
      updatedProperties: [],
      noteId: null,
      candidateCount: matchResult.candidateCount,
      reason: `write failed: ${err.message}`
    });
  }
}

// Every company never reached because the loop above hit the time budget is flagged
// explicitly — NOT folded into "no matching deal found" — so a partial run is
// diagnosable (which companies were actually attempted) rather than silently looking
// like a clean "no match" result for companies it never got to.
if (timedOut) {
  for (let i = results.length; i < companies.length; i++) {
    results.push({
      companyName: companies[i].companyName,
      status: "skipped-timeout",
      dealId: null,
      matchedDealName: null,
      updatedProperties: [],
      noteId: null,
      candidateCount: 0,
      reason: "skipped — time budget exceeded, not attempted"
    });
  }
}

const companiesMatched = results.filter((r) => r.status === "written").length;
const companiesCreated = results.filter((r) => r.status === "created").length;
const companiesNoMatch = results.filter((r) => r.status === "no-match").length;
const companiesSkippedTimeout = results.filter((r) => r.status === "skipped-timeout").length;
const companiesErrored = results.filter((r) => r.status === "error").length;
// "Processed" = actually attempted (regardless of outcome) — excludes companies never
// reached due to the time budget. companiesProcessed + companiesSkippedTimeout should
// always equal companies.length.
const companiesProcessed = companiesMatched + companiesCreated + companiesNoMatch + companiesErrored;

output = {
  results,
  companiesProcessed,
  companiesMatched,
  companiesCreated,
  companiesNoMatch,
  companiesSkippedTimeout,
  companiesErrored,
  partner,
  startTime
};
