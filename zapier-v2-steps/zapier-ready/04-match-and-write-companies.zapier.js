/**
 * ZAPIER-READY VERSION — paste this directly into the Zapier "Code by Zapier" →
 * "Run Javascript" editor for Step 4 (the ONLY per-company step — see below).
 *
 * Derived from ../04-match-and-write-companies.js (the source of truth / Node-testable
 * version — edit logic there, then re-generate this file). Only two things differ:
 *
 *   1. The HubSpot token is read from `inputData.hubspotAccessToken` instead of
 *      `process.env.HUBSPOT_ACCESS_TOKEN` — map it in this step's Input Data panel
 *      alongside `companies`, `partner`, `startTime` below.
 *   2. The step ends with `return {...}` instead of assigning to the bare `output`
 *      global.
 *
 * No other logic changed. Confirmed clean for Zapier's sandbox: no module.exports,
 * no require()/import, no npm dependency.
 *
 * ---------------------------------------------------------------------------------------
 * ZAPIER STEP — MATCH + WRITE: resolve each extracted company's deal and write it
 * (Code by Zapier, "Run Javascript")
 * ---------------------------------------------------------------------------------------
 * REPLACES the two-step design of 04-deal-matching.js + 05-write-deal-and-note.js (both
 * now marked SUPERSEDED, kept for reference only — and their zapier-ready mirrors
 * removed, since they no longer match the real Zap structure). Those two files assumed
 * a second, nested "Looping by Zapier" step over each call's `companies` array —
 * confirmed during live testing that Zapier does NOT support this: "You cannot turn on
 * a Zap with more than one Looping by Zapier step" (Zapier's own documentation). The
 * existing outer loop already iterates `candidateCalls` (one call at a time) — a second
 * native loop over that call's companies is not available.
 *
 * FIX: this single step runs once per call (inside the one remaining outer loop) and
 * loops over `inputData.companies` itself, in plain JavaScript (`for...of`), instead of
 * a second Zapier-level loop.
 *
 * TIMEOUT RISK — Zapier's standard Code step has a hard 30-second limit. A single call
 * can have 14+ companies, each needing 1 HubSpot search (match) + up to 2 HubSpot
 * writes (property PATCH + note POST) — up to 40+ sequential API calls in the worst
 * case. Two mitigations, both below:
 *
 *   1. PARALLEL READS, SEQUENTIAL WRITES. Phase 1 (deal matching) is read-only and
 *      independent per company, so all companies are matched concurrently via
 *      Promise.all. Phase 2 (writes) stays sequential, one company at a time — not
 *      parallelized, to avoid firing concurrent writes at HubSpot for potentially-
 *      related records.
 *   2. SOFT TIME BUDGET. SOFT_TIME_BUDGET_MS (~25s) is checked before each company's
 *      write in Phase 2, measured from the top of the whole step. If exceeded, the loop
 *      stops immediately. Every company never reached is explicitly recorded with
 *      status "skipped-timeout" — NOT folded into "no matching deal found" — so a
 *      partial run is diagnosable rather than silently incomplete.
 *
 * Zapier wiring:
 *   Step type: Code by Zapier → "Run Javascript"
 *   inputData: companies (array, mapped from Step 3/enrichment's output), partner,
 *     startTime, hubspotAccessToken
 *   output: { results: [...], companiesProcessed, companiesMatched, companiesNoMatch,
 *             companiesSkippedTimeout, companiesErrored, partner, startTime }
 *
 * companiesErrored is one field beyond the originally-specified output shape: a
 * per-company try/catch around both the match and write calls means one company's
 * unexpected HubSpot failure can no longer silently abort every other company's
 * results the way a single uncaught throw would in this merged single-step design.
 *
 * See "Why only one native loop" in ../../docs/zapier-v2-setup.md for the full
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
  }
  // exactMatches.length === 0 (no candidate) or > 1 (ambiguous — do not guess) both
  // fall through as unmatched, same "don't guess" rule as the original step.

  const reason = matched
    ? null
    : "no matching deal found — possible transcription mismatch: consider adding to COMPANY_NAME_ALIASES if this is a recurring real company";

  return { companyName, matched, dealId, matchedDealName, candidateCount: exactMatches.length, reason };
}

// ---- Deal + note write (ported from 05-write-deal-and-note.js, unchanged) ---------

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

  const properties = {
    hs_next_step: nextStep,
    last_call_sentiment: sentiment,
    last_call_date: callDateStr,
    last_call_unresolved_objections:
      unresolvedObjections && unresolvedObjections !== "None" ? unresolvedObjections : ""
  };

  await patchDeal(token, matchResult.dealId, properties);

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

  return { updatedProperties: Object.keys(properties), noteId };
}

// ---- Main: one call's worth of companies, processed in plain JS ------------------

// ~25s soft budget, leaving ~5s margin before Zapier's 30s hard Code-step cutoff.
// Measured from the very top of this step (below), so it covers both the parallel
// matching phase and the sequential write phase — not just the write loop.
const SOFT_TIME_BUDGET_MS = 25000;

const token = inputData.hubspotAccessToken;
if (!token) {
  throw new Error("hubspotAccessToken is missing from inputData — map it in this step's Input Data panel");
}

const companies = inputData.companies;
if (!Array.isArray(companies)) {
  throw new Error("No companies array in inputData — check Step 3 (enrichment)'s field mapping");
}

const partner = inputData.partner;
const startTime = inputData.startTime;
if (!partner) {
  throw new Error("No partner in inputData — Step 1/2/3 should have carried this through");
}

const startedAt = Date.now();

// Phase 1: match every company's deal in parallel. Deal search is read-only, so
// there's no rate-limit/consistency risk in firing all of these concurrently — this
// collapses what would be up to N sequential search round-trips into roughly one.
// Each entry is individually .catch()-guarded so one company's search failure can't
// reject the whole Promise.all and drop every other company's match result.
const matchResults = await Promise.all(
  companies.map((company) =>
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

// Phase 2: process sequentially, one company at a time. Writes (property PATCH + note
// POST) touch live HubSpot records — kept sequential rather than parallelized, unlike
// Phase 1's reads, to avoid firing concurrent writes at potentially-related deals (the
// safer choice per this step's explicit design, even though it's the slower phase and
// therefore the one actually at risk of the 30s hard cutoff — hence the time check
// below).
const results = [];
let timedOut = false;

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
    results.push({
      companyName: matchResult.companyName,
      status: "no-match",
      dealId: null,
      matchedDealName: null,
      updatedProperties: [],
      noteId: null,
      candidateCount: matchResult.candidateCount,
      reason: matchResult.reason
    });
    continue;
  }

  try {
    const { updatedProperties, noteId } = await writeCompanyUpdate(token, partner, startTime, matchResult, company);
    results.push({
      companyName: matchResult.companyName,
      status: "written",
      dealId: matchResult.dealId,
      matchedDealName: matchResult.matchedDealName,
      updatedProperties,
      noteId,
      candidateCount: matchResult.candidateCount,
      reason: null
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
const companiesNoMatch = results.filter((r) => r.status === "no-match").length;
const companiesSkippedTimeout = results.filter((r) => r.status === "skipped-timeout").length;
const companiesErrored = results.filter((r) => r.status === "error").length;
// "Processed" = actually attempted (regardless of outcome) — excludes companies never
// reached due to the time budget. companiesProcessed + companiesSkippedTimeout should
// always equal companies.length.
const companiesProcessed = companiesMatched + companiesNoMatch + companiesErrored;

return {
  results,
  companiesProcessed,
  companiesMatched,
  companiesNoMatch,
  companiesSkippedTimeout,
  companiesErrored,
  partner,
  startTime
};
