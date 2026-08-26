/**
 * ZAPIER STEP — FILTER: find new partner-sync calls (Code by Zapier, "Run Javascript")
 * ---------------------------------------------------------------------------------------
 * Runs once per Zap trigger (hourly). Searches Apollo for conversations in a lookback
 * window, matches each call's topic against the known-partner patterns, and separates
 * matches from "possible unlisted partner" flags. Everything else (direct 1:1 sales
 * calls, internal calls, etc.) is left completely alone — Apollo's native HubSpot
 * logging already handles those and this pipeline must not touch them.
 *
 * ENDPOINT — confirmed 2026-08-26 against docs.apollo.io:
 *   POST https://api.apollo.io/api/v1/conversations/search
 *   Request body params (official): page, num_fetch_result, conversation_type
 *   ("video_conference" | "phone_call"), account_id, contact_ids, tag_ids, tracker_ids,
 *   organization_ids, date_range, scorecard_template_id, scorecard_max_rating,
 *   sort_by_field, enforce_contact_boundary. 0 credits per call.
 *
 *   IMPORTANT — there is NO documented topic/keyword search param (no "q_keywords" or
 *   equivalent). This is a real API constraint, not a bug to fix later: the request
 *   below only narrows by conversation_type + date_range; ALL partner-pattern matching
 *   happens client-side in this file against each result's `topic` field.
 *
 *   conversation_type is set to "video_conference" (not "phone_call") — confirmed
 *   correct for partner Zoom/Teams syncs: real production conversations pulled during
 *   verification (e.g. "Socure/Markaaz Partnership", "Signicat x Markaaz weekly sync")
 *   are multi-participant, host_id + participant_count-bearing meeting records, not
 *   1:1 dialed calls.
 *
 * RESPONSE SHAPE — verified indirectly, not from a raw fetch() with our own key (see
 * "Auth note" below): real conversation records definitely include a `topic` field
 * (directly usable for client-side matching, confirmed against real production data —
 * e.g. `"topic": "ZoomInfo/Markaaz Patnership"`, `"topic": "Socure/Markaaz Partnership "`
 * — note real topics carry trailing whitespace and even typos; substring `.includes()`
 * matching in matchPartnerFromTopic() below tolerates the whitespace fine, but a typo
 * like "Patnership" would NOT match the "partnership" keyword — a real gap, left as-is
 * per this task's scope (matching logic unchanged), flagged in the README instead),
 * an `id`, and a `start_time` (ISO 8601). Real `state` values include
 * "insights_generated" — richer than the four-value enum assumed in an earlier pass
 * (created/downloaded/transcribed/processed). This pipeline doesn't filter on state,
 * so it's informational only.
 *
 * The response envelope's exact top-level key (`conversations` vs `results` vs `data`)
 * was not independently confirmed for the raw REST endpoint — the fallback chain in
 * searchApolloConversations() below handles the most likely candidates defensively.
 *
 * Auth note: X-Api-Key + User-Agent (this repo's established Apollo convention) is
 * confirmed to be RECOGNIZED by this exact endpoint — every markaaz-gtm Apollo key
 * tested against it returned a scoped `403 API_INACCESSIBLE` naming this specific
 * endpoint, not a generic 401 or a 404, which means Apollo's server parsed the header
 * and evaluated that key's permissions. None of the three keys in markaaz-gtm's .env
 * currently have the Conversations scope, so a full end-to-end request/response cycle
 * with our own key was NOT completed — confirm with whoever provisions the Zapier
 * deployment's Apollo key that it has Conversations API access before the first live run.
 *
 * Zapier wiring:
 *   Step type: Code by Zapier → "Run Javascript"
 *   inputData: none required (Trigger is Schedule by Zapier, hourly — no fields to map)
 *   Requires Zapier Environment Variables (Code step Settings → Environment Variables,
 *   available on Zapier's paid plans) or an equivalent secret-injection step upstream:
 *     APOLLO_API_KEY
 *   output: { candidateCalls: [...], unlistedPartnerFlags: [...], totalCallsScanned, skippedCount }
 *
 * candidateCalls feeds the outer "Looping by Zapier" step (one iteration per call).
 * unlistedPartnerFlags can optionally feed a second, parallel loop straight into
 * Digest by Zapier so those flags show up in the run report even though nothing
 * downstream processes them automatically. See docs/zapier-v2-setup.md.
 */

// ---- Config: known partners + topic pattern -------------------------------------
// To add a new partner later: just add its name to this array. No pattern-string
// changes needed — matching is name + "markaaz" + a sync keyword, all order-independent.
const KNOWN_PARTNERS = ["Socure", "Zenoo", "ZoomInfo", "Signicat", "Oscilar"];
const SYNC_KEYWORDS = ["partnership", "sync", "weekly", "bi-weekly"];

// How far back to search on each hourly poll. Deliberately wider than the 1-hour
// trigger interval so a slow Apollo sync or a missed/late poll doesn't drop a call —
// Storage by Zapier dedup (wired natively around the outer loop, see setup guide)
// is what actually prevents reprocessing, not this window being narrow.
const LOOKBACK_HOURS = 3;

function matchPartnerFromTopic(topic) {
  const topicLower = (topic || "").toLowerCase();
  if (!topicLower.includes("markaaz")) return null;
  for (const partner of KNOWN_PARTNERS) {
    const partnerLower = partner.toLowerCase();
    const hasPartnerName = topicLower.includes(partnerLower);
    const hasSyncKeyword = SYNC_KEYWORDS.some((kw) => topicLower.includes(kw));
    if (hasPartnerName && hasSyncKeyword) {
      return partner;
    }
  }
  return null;
}

async function searchApolloConversations(apiKey, sinceIso, nowIso) {
  // POST with a JSON body, per the confirmed official request contract — this was
  // previously (wrongly) a GET with query-string params. No topic/keyword param exists
  // server-side; num_fetch_result + date_range narrow the batch, everything else is
  // filtered client-side below against each result's `topic` field.
  const response = await fetch("https://api.apollo.io/api/v1/conversations/search", {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "User-Agent": "markaaz-call-intelligence/2.0",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      page: 1,
      num_fetch_result: 50, // batch size per poll; add pagination here if a single
                             // polling window ever needs more than 50 conversations
      conversation_type: "video_conference", // not "phone_call" — confirmed correct
                                              // for partner Zoom/Teams syncs, see header
      date_range: { min: sinceIso, max: nowIso }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Apollo conversations search failed: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  // Envelope key not independently confirmed for the raw REST response — `conversations`
  // is the best-evidenced candidate (seen in real production data via a different,
  // already-authenticated Apollo integration channel during verification), kept as a
  // defensive fallback chain since that evidence wasn't from this exact raw endpoint.
  return data.conversations || data.results || data.data || [];
}

const apiKey = process.env.APOLLO_API_KEY;
if (!apiKey) {
  throw new Error("APOLLO_API_KEY is not set in this Zap's environment variables");
}

const nowIso = new Date().toISOString();
const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
const rawConversations = await searchApolloConversations(apiKey, sinceIso, nowIso);

const candidateCalls = [];
const unlistedPartnerFlags = [];
let skippedCount = 0;

for (const conv of rawConversations) {
  const conversationId = conv.id || conv.conversation_id;
  const topic = conv.topic || conv.title || "";
  const startTime = conv.start_time || conv.startTime || "";

  const partner = matchPartnerFromTopic(topic);

  if (partner) {
    candidateCalls.push({ conversationId, partner, topic, startTime });
  } else if (topic.toLowerCase().includes("markaaz")) {
    // Contains "Markaaz" but didn't match a known partner + sync-keyword pattern.
    // Erring toward over-flagging here on purpose — a false-positive flag just adds
    // a row to the report for a human to dismiss; a missed real partner call does not
    // get a second chance until someone notices the roster is stale.
    unlistedPartnerFlags.push({
      conversationId,
      topic,
      startTime,
      reason: "topic contains 'Markaaz' but no known-partner + sync-keyword pattern matched"
    });
  } else {
    skippedCount += 1; // ordinary direct 1:1 call or unrelated — leave to Apollo's native logging
  }
}

output = {
  candidateCalls,
  unlistedPartnerFlags,
  totalCallsScanned: rawConversations.length,
  skippedCount
};
