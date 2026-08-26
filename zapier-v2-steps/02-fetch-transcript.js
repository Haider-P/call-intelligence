/**
 * ZAPIER STEP — TRANSCRIPT: fetch the full call transcript (Code by Zapier, "Run Javascript")
 * ------------------------------------------------------------------------------------------
 * Runs once per matching call, inside the outer "Looping by Zapier" loop over
 * candidateCalls (after the Storage-by-Zapier dedup check — see setup guide). Fetches
 * the transcript for one conversation from Apollo.
 *
 * WARNING — endpoint not independently verified, same caveat as Step 1: this calls
 * `https://api.apollo.io/api/v1/conversations/{id}/transcript`, mirroring this repo's
 * established Apollo auth convention (X-Api-Key + User-Agent) but not independently
 * confirmed against Apollo's live API docs. Verify before deploying.
 *
 * Zapier wiring:
 *   Step type: Code by Zapier → "Run Javascript"
 *   inputData (map these fields from the current loop item, via the Zapier UI):
 *     conversationId, partner, topic, startTime
 *   Requires Zapier Environment Variables: APOLLO_API_KEY
 *   output: { conversationId, transcriptText, partner, topic, startTime }
 */

async function fetchApolloTranscript(apiKey, conversationId) {
  const url = `https://api.apollo.io/api/v1/conversations/${conversationId}/transcript`;

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
    throw new Error(`Apollo transcript fetch failed for ${conversationId}: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  // Normalize to a plain string transcript regardless of exact response shape —
  // adjust this fallback chain if Apollo returns segments/speakers instead of raw text.
  if (typeof data.transcript === "string") return data.transcript;
  if (Array.isArray(data.segments)) {
    return data.segments
      .map((seg) => `${seg.speaker ? seg.speaker + ": " : ""}${seg.text || ""}`)
      .join("\n");
  }
  if (typeof data === "string") return data;
  throw new Error(`Unrecognized transcript response shape for ${conversationId}`);
}

const apiKey = process.env.APOLLO_API_KEY;
if (!apiKey) {
  throw new Error("APOLLO_API_KEY is not set in this Zap's environment variables");
}

const conversationId = inputData.conversationId;
if (!conversationId) {
  throw new Error("No conversationId in inputData — check the loop item field mapping");
}

const transcriptText = await fetchApolloTranscript(apiKey, conversationId);

output = {
  conversationId,
  transcriptText,
  partner: inputData.partner,
  topic: inputData.topic,
  startTime: inputData.startTime
};
