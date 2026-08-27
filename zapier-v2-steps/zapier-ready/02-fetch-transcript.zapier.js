/**
 * ZAPIER-READY VERSION — paste this directly into the Zapier "Code by Zapier" →
 * "Run Javascript" editor for Step 2.
 *
 * Derived from ../02-fetch-transcript.js (the source of truth / Node-testable
 * version — edit logic there, then re-generate this file). Only two things differ:
 *
 *   1. The Apollo API key is read from `inputData.apolloApiKey` instead of
 *      `process.env.APOLLO_API_KEY` — map it in this step's Input Data panel
 *      alongside the loop-item fields below.
 *   2. The step ends with `return {...}` instead of assigning to the bare `output`
 *      global.
 *
 * No other logic changed. Confirmed clean for Zapier's sandbox: no module.exports,
 * no require()/import, no npm dependency.
 *
 * ------------------------------------------------------------------------------------------
 * ZAPIER STEP — TRANSCRIPT: fetch the full call transcript (Code by Zapier, "Run Javascript")
 * ------------------------------------------------------------------------------------------
 * Runs once per matching call, inside the outer "Looping by Zapier" loop over
 * candidateCalls (after the Storage-by-Zapier dedup check — see setup guide). Fetches
 * the full conversation record — including its transcript — for one conversation.
 *
 * ENDPOINT — confirmed 2026-08-26 against docs.apollo.io:
 *   GET https://api.apollo.io/api/v1/conversations/{id}
 *   Path param: id (also accepts the "id_shareid" share-ID format, not used here).
 *   This is ONE endpoint returning the full conversation record, NOT a separate
 *   `/conversations/{id}/transcript` path — a prior version of this file called that
 *   separate path, which does not exist in the official docs. Confirmed structurally
 *   correct against real production data pulled during verification: a conversation
 *   fetch's response carries `topic`, `state`, `start_time`, etc. AND a `transcript`
 *   field together in the same object — exactly the "one endpoint, full details"
 *   shape the docs describe.
 *
 *   CREDIT COST — differs from Step 1's free search: 0-1 credit per call, charged
 *   only if the conversation has AI insights generated (1 credit); 0 if it doesn't.
 *   This step runs once per matching call (not once per extracted company), so cost
 *   scales with call volume, not with the number of companies discussed per call.
 *
 * RESPONSE SHAPE — verified indirectly, not from a raw fetch() with our own key (no
 * available markaaz-gtm Apollo key has Conversations scope — see Step 1's header for
 * the full auth-verification note, which applies identically here). Real conversation
 * fetches (via a different, already-authenticated Apollo integration channel) showed
 * the `transcript` field taking two different shapes depending on requested format:
 *   - A plain string, already speaker-labeled and readable (e.g. "GREG BANY: I know.")
 *     — the simplest and most directly usable case.
 *   - A JSON-encoded STRING containing an array of segment objects, each with a
 *     `spoken_sentence` field (not `text`) and a `conversation_participant_id`
 *     (an opaque ID, not a resolved participant name — resolving it to a real name
 *     would need a separate API call, out of scope here; segments are labeled by
 *     that ID as a fallback).
 * Both shapes are handled defensively below. If the raw REST endpoint's actual shape
 * turns out to be neither, the error message names the conversation ID so it's easy
 * to spot in Zapier's run history and extend the parser.
 *
 * Zapier wiring:
 *   Step type: Code by Zapier → "Run Javascript"
 *   inputData (map these fields from the current loop item, via the Zapier UI):
 *     conversationId, partner, topic, startTime, apolloApiKey
 *   output: { conversationId, transcriptText, partner, topic, startTime }
 */

function segmentsToText(segments) {
  return segments
    .map((seg) => {
      const label = seg.speaker || seg.participant_name || seg.conversation_participant_id;
      const sentence = seg.spoken_sentence || seg.text || "";
      return label ? `${label}: ${sentence}` : sentence;
    })
    .filter(Boolean)
    .join("\n");
}

async function fetchApolloConversation(apiKey, conversationId) {
  const url = `https://api.apollo.io/api/v1/conversations/${conversationId}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Api-Key": apiKey,
      "User-Agent": "markaaz-call-intelligence/2.0",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Apollo conversation fetch failed for ${conversationId}: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  const rawTranscript = data.transcript;

  // Case 1: already a plain, speaker-labeled string — use as-is.
  if (typeof rawTranscript === "string") {
    const trimmed = rawTranscript.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      // Case 2: a JSON-encoded string containing segment objects — parse, then flatten.
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return segmentsToText(parsed);
      } catch (e) {
        // fall through — not actually JSON, treat as plain text below
      }
    }
    return rawTranscript;
  }

  // Case 3: a native (already-parsed) array of segment objects.
  if (Array.isArray(rawTranscript)) {
    return segmentsToText(rawTranscript);
  }

  throw new Error(`Unrecognized transcript shape on conversation ${conversationId}`);
}

const apiKey = inputData.apolloApiKey;
if (!apiKey) {
  throw new Error("apolloApiKey is missing from inputData — map it in this step's Input Data panel");
}

const conversationId = inputData.conversationId;
if (!conversationId) {
  throw new Error("No conversationId in inputData — check the loop item field mapping");
}

const transcriptText = await fetchApolloConversation(apiKey, conversationId);

return {
  conversationId,
  transcriptText,
  partner: inputData.partner,
  topic: inputData.topic,
  startTime: inputData.startTime
};
