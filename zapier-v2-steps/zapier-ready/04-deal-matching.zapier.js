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
 *             unresolvedObjections, rawSummary, partner, startTime }
 */

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

const companyName = inputData.companyName;
const partner = inputData.partner;

if (!companyName || !partner) {
  throw new Error("Missing companyName or partner in inputData");
}

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
  candidateCount: exactMatches.length
};
