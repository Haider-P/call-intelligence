/**
 * ZAPIER-READY VERSION — paste this directly into the Zapier "Code by Zapier" →
 * "Run Javascript" editor for Step 4.
 *
 * Derived from ../04-deal-matching.js (the source of truth / Node-testable version —
 * edit logic there, then re-generate this file). Only two things differ:
 *
 *   1. The HubSpot token is read from `inputData.hubspotAccessToken` instead of
 *      `process.env.HUBSPOT_ACCESS_TOKEN` — map it in this step's Input Data panel
 *      alongside the loop-item fields below.
 *   2. The step ends with `return {...}` instead of assigning to the bare `output`
 *      global.
 *
 * No other logic changed. Confirmed clean for Zapier's sandbox: no module.exports,
 * no require()/import, no npm dependency.
 *
 * -------------------------------------------------------------------------------------------------------
 * ZAPIER STEP — DEAL MATCHING: find the "{Partner} - {Company}" deal (Code by Zapier, "Run Javascript")
 * -------------------------------------------------------------------------------------------------------
 * Runs once per extracted company, inside the inner "Looping by Zapier" loop over
 * companies (from Step 3's output). Searches HubSpot for the exact-pattern deal name
 * "{Partner} - {Company}", case-insensitive and tolerant of minor naming variance
 * (e.g. "US Bank" vs "U.S. Bank"), consistent with the canonical-company resolution
 * used in the Socure partner-deal hygiene-fix work (see markaaz-gtm's
 * socure_partner_writes_2026-08-26.md). Never creates a deal — a miss is logged as
 * "mentioned in call, no matching deal found" for manual review.
 *
 * Zapier wiring:
 *   Step type: Code by Zapier → "Run Javascript"
 *   inputData (map from the current loop item, via the Zapier UI):
 *     companyName, sentiment, nextStep, unresolvedObjections, rawSummary, partner,
 *     startTime, hubspotAccessToken
 *   output: { matched, dealId, matchedDealName, companyName, sentiment, nextStep,
 *             unresolvedObjections, rawSummary, partner, startTime, candidateCount,
 *             reason }
 *
 * companyName is checked against COMPANY_NAME_ALIASES before searching HubSpot (see
 * that map below) to catch known Claude-transcription mismatches (e.g. "PayMeadow"
 * -> "Paymitto") that are too large a gap for the normalize()-based tolerance to
 * safely catch. reason is null when matched, otherwise flags a possible
 * transcription mismatch for manual review — see the `reason` assignment near the
 * bottom of this file.
 */

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
// normalizeCompanyKey() below (lowercase, trimmed, whitespace-collapsed) so a lookup
// matches regardless of how the alias happens to be capitalized/spaced.
const COMPANY_NAME_ALIASES = {
  paymeadow: "Paymitto", // confirmed 2026-08-28, Socure/Markaaz Partnership call
  valera: "Velera", // confirmed 2026-08-28, Socure/Markaaz Partnership call
  "green sky": "Greensky" // confirmed 2026-08-28, Socure/Markaaz Partnership call
};

// Lowercase + trim + collapse whitespace — used only to key into
// COMPANY_NAME_ALIASES, so "Green Sky", "green sky", and "  Green   Sky " all hit the
// same "green sky" alias regardless of case or spacing. Distinct from normalize()
// below, which additionally strips punctuation for comparing against real HubSpot
// deal names once a company name (aliased or not) is being searched for.
function normalizeCompanyKey(str) {
  return (str || "").toLowerCase().trim().replace(/\s+/g, " ");
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

const token = inputData.hubspotAccessToken;
if (!token) {
  throw new Error("hubspotAccessToken is missing from inputData — map it in this step's Input Data panel");
}

const rawCompanyName = inputData.companyName;
const partner = inputData.partner;

if (!rawCompanyName || !partner) {
  throw new Error("Missing companyName or partner in inputData");
}

// Alias map is checked first — it's the first-line fix for transcription gaps too
// large for normalize()'s tolerance to safely catch (see COMPANY_NAME_ALIASES
// comment above). Falls through to the existing normalize()-based search unchanged
// when no alias hits, exactly as before this change.
const aliasedCompanyName = COMPANY_NAME_ALIASES[normalizeCompanyKey(rawCompanyName)];
const companyName = aliasedCompanyName || rawCompanyName;

const targetDealName = `${partner} - ${companyName}`;
const targetNormalized = normalize(targetDealName);

const candidates = await searchHubSpotDeals(token, companyName);

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
} else if (exactMatches.length > 1) {
  // Ambiguous — more than one deal normalizes to the same target name. Do not guess;
  // treat as unmatched so it surfaces in the report for manual review instead of
  // silently writing to the wrong (or an arbitrary) deal.
  matched = false;
} else {
  matched = false;
}

// Surfaces in this step's own Zapier run output regardless of what any downstream
// step does with it — so a human scanning run history can spot a recurring
// transcription gap and add it to COMPANY_NAME_ALIASES, instead of the same real
// company silently failing to match on every future call.
const reason = matched
  ? null
  : "no matching deal found — possible transcription mismatch: consider adding to COMPANY_NAME_ALIASES if this is a recurring real company";

return {
  matched,
  dealId,
  matchedDealName,
  companyName,
  sentiment: inputData.sentiment,
  nextStep: inputData.nextStep,
  unresolvedObjections: inputData.unresolvedObjections,
  rawSummary: inputData.rawSummary,
  partner,
  startTime: inputData.startTime,
  candidateCount: exactMatches.length,
  reason
};
