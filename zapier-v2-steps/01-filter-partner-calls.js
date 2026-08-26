/**
 * ZAPIER STEP — FILTER: find new partner-sync calls (Code by Zapier, "Run Javascript")
 * ---------------------------------------------------------------------------------------
 * Runs once per Zap trigger (hourly). Searches Apollo for conversations in a lookback
 * window, matches each call's topic against the known-partner patterns, and separates
 * matches from "possible unlisted partner" flags. Everything else (direct 1:1 sales
 * calls, internal calls, etc.) is left completely alone — Apollo's native HubSpot
 * logging already handles those and this pipeline must not touch them.
 *
 * WARNING — endpoint not independently verified: this file calls
 * `https://api.apollo.io/api/v1/conversations/search`, mirroring the base URL and auth
 * convention this repo already uses for Apollo's Organizations API (X-Api-Key header +
 * User-Agent, see markaaz-gtm/CLAUDE.md). The Conversation Intelligence endpoints were
 * NOT independently confirmed against Apollo's live API docs in this session — verify
 * the exact path/params at developer.apollo.io (or with Apollo support) before wiring
 * this into a live Zap. If the path differs, only the `searchApolloConversations()`
 * helper below needs to change — everything downstream consumes its normalized output.
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

async function searchApolloConversations(apiKey, sinceIso) {
  const url = new URL("https://api.apollo.io/api/v1/conversations/search");
  url.searchParams.set("start_time_min", sinceIso);
  url.searchParams.set("per_page", "50");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-Api-Key": apiKey,
      "User-Agent": "markaaz-call-intelligence/2.0",
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Apollo conversations search failed: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  // Normalize to a flat array regardless of exact response envelope shape —
  // adjust the fallback chain here if Apollo's real response nests differently.
  return data.conversations || data.results || data.data || [];
}

const apiKey = process.env.APOLLO_API_KEY;
if (!apiKey) {
  throw new Error("APOLLO_API_KEY is not set in this Zap's environment variables");
}

const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
const rawConversations = await searchApolloConversations(apiKey, sinceIso);

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
