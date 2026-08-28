/**
 * ZAPIER-READY VERSION — paste this directly into the Zapier "Code by Zapier" →
 * "Run Javascript" editor for Step 3.
 *
 * Derived from ../03-claude-enrichment.js (the source of truth / Node-testable
 * version — edit logic there, then re-generate this file). Only two things differ:
 *
 *   1. The Anthropic API key is read from `inputData.anthropicApiKey` instead of
 *      `process.env.ANTHROPIC_API_KEY` — map it in this step's Input Data panel
 *      alongside the loop-item fields below.
 *   2. The step ends with `return {...}` instead of assigning to the bare `output`
 *      global.
 *
 * No other logic changed. Confirmed clean for Zapier's sandbox: no module.exports,
 * no require()/import, no npm dependency.
 *
 * ---------------------------------------------------------------------------------------------
 * ZAPIER STEP — ENRICHMENT: extract every company mentioned (Code by Zapier, "Run Javascript")
 * ---------------------------------------------------------------------------------------------
 * Runs once per matching call. This is the core logic ported from the old Pipedream
 * pipeline's claude-enrichment step (pipedream-steps/02-claude-enrichment.js) — same
 * JSON-schema-extraction approach and sentiment guide — rewritten for the
 * multi-company model: a partner-sync call discusses MANY end-customer companies, and
 * the old one-call-equals-one-deal assumption is removed entirely. One call in, an
 * array of company records out (confirmed live against the 2026-08-26 Socure/Markaaz
 * Partnership call, conversation 6a8f11e33a32c300204a75e7 — 12 companies extracted from
 * one transcript with per-company sentiment/next-step/objection accuracy, including
 * catching the Swipe Jobs $11M vs $300K contract-figure discrepancy as a real objection
 * detail rather than a generic note. Match that bar.).
 *
 * Zapier wiring:
 *   Step type: Code by Zapier → "Run Javascript"
 *   inputData: transcriptText, partner, topic, startTime (from Step 2's output),
 *     anthropicApiKey
 *   output: { companies: [...], partner, startTime, companyCount }
 *
 * companies feeds Step 4 (04-match-and-write-companies.js) directly — that step loops
 * over `companies` internally in plain JavaScript, not via a second "Looping by
 * Zapier" step (Zapier does not support more than one per Zap; see "Why only one
 * native loop" in ../../docs/zapier-v2-setup.md).
 */

function buildPrompt(transcriptText, partner) {
  return `You are a sales intelligence assistant extracting per-company signals from a partner-sync call transcript.

This is a "${partner} / Markaaz Partnership" call — ${partner} and Markaaz reviewing shared pipeline. The transcript will mention MANY distinct end-customer companies that ${partner} is discussing as prospects or in-flight deals. Extract EVERY end-customer company mentioned as its own separate record.

Do NOT include "${partner}" itself or "Markaaz" as one of the extracted companies — only the end-customer companies being discussed as prospects/pipeline.

For each company, extract real specifics from what was actually said — numbers, dates, named stakeholders, contract figures, discrepancies. A next step of "follow up" or an objection of "pricing concerns" is not acceptable if the transcript contains something more specific (e.g. "CFO sign-off needed by end of month", "quoted $11M but customer expects $300K — reconcile before next call"). Generic filler is a failure; specific extraction is the bar.

Return ONLY valid JSON, no preamble, no markdown, no backticks. Use exactly this structure — an array, one object per company:

[
  {
    "company_name": "the end-customer company's name as stated in the transcript",
    "sentiment": "positive" | "neutral" | "at-risk",
    "next_step": "the specific next step agreed for this company, or 'None identified'",
    "unresolved_objections": "specific unresolved objections/concerns for this company, or 'None'",
    "summary": "2-4 sentence summary of what was actually said about this company on this call — specifics, not generalities"
  }
]

Sentiment guide:
- positive: engaged, moving forward, clear next steps, no material blockers
- neutral: informational update, no strong signal either way
- at-risk: unresolved objections, contract/figure discrepancies, stalling, competitor threat, disengagement

If the transcript mentions no end-customer companies at all, return an empty array: []

Transcript:
${transcriptText}`;
}

async function callClaude(apiKey, prompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      // Model swapped from claude-sonnet-4-6 -> claude-haiku-4-5-20251001 2026-08-28,
      // confirmed live in Zapier's Code editor (this backports that change into the
      // source file). Zapier's Code step has a hard 30-second timeout; Sonnet exceeded
      // it on a full-length partner-sync transcript (~6000 words). Haiku completed in
      // ~16.5s with no confirmed quality regression — validated live against the
      // 2026-08-26 Socure/Markaaz Partnership call: all 14 companies correctly
      // extracted, specific details preserved (e.g. the Swipe Jobs $11M-vs-$300K
      // contract-figure discrepancy, not flattened into a generic "pricing concerns").
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const rawText = data.content[0].text.trim();
  const clean = rawText.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error(`Failed to parse Claude response as JSON: ${rawText}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array of companies, got: ${rawText}`);
  }

  return parsed;
}

const apiKey = inputData.anthropicApiKey;
if (!apiKey) {
  throw new Error("anthropicApiKey is missing from inputData — map it in this step's Input Data panel");
}

const transcriptText = inputData.transcriptText;
const partner = inputData.partner;

if (!transcriptText) {
  throw new Error("No transcriptText in inputData");
}
if (!partner) {
  throw new Error("No partner in inputData — Step 1/2 should have carried this through");
}

const prompt = buildPrompt(transcriptText, partner);
const parsedCompanies = await callClaude(apiKey, prompt);

const companies = parsedCompanies
  .filter((c) => c.company_name && c.company_name.trim())
  .map((c) => ({
    companyName: c.company_name.trim(),
    sentiment: c.sentiment || "neutral",
    nextStep: c.next_step || "None identified",
    unresolvedObjections: c.unresolved_objections || "None",
    rawSummary: c.summary || ""
  }));

return {
  companies,
  partner,
  startTime: inputData.startTime,
  companyCount: companies.length
};
