/**
 * SUPERSEDED — merged into 04-match-and-write-companies.js due to Zapier's
 * no-nested-loops constraint ("You cannot turn on a Zap with more than one Looping by
 * Zapier step", confirmed live 2026-08-28), see that date. This file assumed a second,
 * nested "Looping by Zapier" step over each call's `companies` array, which Zapier does
 * not support. Kept for reference only — not used in the live Zap. Its zapier-ready
 * mirror (zapier-ready/05-write-deal-and-note.zapier.js) has been removed since it no
 * longer matches the real Zap structure; see
 * zapier-ready/04-match-and-write-companies.zapier.js instead.
 */

/**
 * ZAPIER STEP — WRITE: update the deal + add a note (Code by Zapier, "Run Javascript")
 * ----------------------------------------------------------------------------------------
 * Runs once per company, immediately after Deal Matching (04) in the same inner loop.
 * If no deal was matched, this makes NO HubSpot calls at all — it just passes through
 * a "no matching deal found" result for the report. Property-write logic ported from
 * the old Pipedream pipeline's update-deal-properties step
 * (pipedream-steps/04-update-deal-properties.js), narrowed to the 4 properties this
 * design calls for (no next_step_date, no last_call_number — dropped from this design).
 *
 * Apollo's own native call-logging (its Calls/Engagements entries) is never touched by
 * this step or any other step in this pipeline — this only writes deal properties and
 * adds a new note.
 *
 * Zapier wiring:
 *   Step type: Code by Zapier → "Run Javascript"
 *   inputData (map from Step 4's output):
 *     matched, dealId, matchedDealName, companyName, sentiment, nextStep,
 *     unresolvedObjections, rawSummary, partner, startTime
 *   Requires Zapier Environment Variables: HUBSPOT_ACCESS_TOKEN
 *   output: { written, dealId, companyName, partner, updatedProperties, noteId, reason }
 *
 * Feed this step's output into Digest by Zapier (see docs/zapier-v2-setup.md) so every
 * outcome — written, no-match, or otherwise — shows up in the run report.
 */

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

const token = process.env.HUBSPOT_ACCESS_TOKEN;
if (!token) {
  throw new Error("HUBSPOT_ACCESS_TOKEN is not set in this Zap's environment variables");
}

const {
  matched,
  dealId,
  companyName,
  partner,
  sentiment,
  nextStep,
  unresolvedObjections,
  rawSummary,
  startTime
} = inputData;

if (!matched || !dealId) {
  output = {
    written: false,
    dealId: null,
    companyName,
    partner,
    updatedProperties: [],
    noteId: null,
    reason: "mentioned in call, no matching deal found"
  };
} else {
  const callDate = startTime ? new Date(startTime) : new Date();
  const callDateStr = callDate.toISOString().split("T")[0];

  const properties = {
    hs_next_step: nextStep,
    last_call_sentiment: sentiment,
    last_call_date: callDateStr,
    last_call_unresolved_objections:
      unresolvedObjections && unresolvedObjections !== "None" ? unresolvedObjections : ""
  };

  await patchDeal(token, dealId, properties);

  const noteBody = `📞 ${partner} / Markaaz Partnership sync — ${callDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  })}
Company: ${companyName}
Sentiment: ${sentiment}
Next step: ${nextStep}
Unresolved objections: ${unresolvedObjections}

Summary:
${rawSummary}`;

  const noteId = await createNote(token, dealId, noteBody, callDate.getTime());

  output = {
    written: true,
    dealId,
    companyName,
    partner,
    updatedProperties: Object.keys(properties),
    noteId,
    reason: null
  };
}
