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
 * matching in matchPartnerFromTopic() below tolerates the whitespace fine, and as of
 * 2026-08-27 also tolerates the "Patnership" typo — RESOLVED, see the sync-keyword
 * alias map and the Levenshtein fuzzy check in matchPartnerFromTopic() below), an `id`,
 * and a `start_time` (ISO 8601). Real `state` values include
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
// Partner names are matched with an exact substring check (not fuzzy) — they're short
// and distinctive enough that Levenshtein-fuzzing them risks false positives against
// unrelated calls (e.g. a 1-edit fuzz on "Socure" could catch unrelated words).
const KNOWN_PARTNERS = ["Socure", "Zenoo", "ZoomInfo", "Signicat", "Oscilar"];
const SYNC_KEYWORDS = ["partnership", "sync", "weekly", "bi-weekly"];

// Known human typos of a sync keyword, confirmed live in production data (real topic:
// "ZoomInfo/Markaaz Patnership", 2026-08-27 — missing the "r" in "Partnership"). Checked
// as an exact, cheap lookup before falling back to the Levenshtein fuzzy check below —
// belt and suspenders: guarantees this exact confirmed typo always matches even if the
// fuzzy-distance threshold logic ever changes.
const SYNC_KEYWORD_ALIASES = {
  patnership: "partnership"
};

// Max Levenshtein edit distance to tolerate between a topic token and a sync keyword.
// Kept at 1 deliberately: wide enough to catch a single missing/swapped/extra letter
// (real-world typos like "Patnership") without loosening so much that unrelated short
// words start colliding with keywords like "sync".
const MAX_KEYWORD_EDIT_DISTANCE = 1;

// Standard dynamic-programming edit distance (insert/delete/substitute, cost 1 each).
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n];
}

// Tokenizes the topic and checks each token against SYNC_KEYWORDS: first via the exact
// alias map (cheap, guarantees the confirmed "Patnership" typo), then via Levenshtein
// distance <= MAX_KEYWORD_EDIT_DISTANCE (catches other single-letter typos of the same
// shape). Token-based rather than whole-string `.includes()` because edit distance on
// the full topic string against a short keyword isn't meaningful — a topic is many
// words, a keyword is one.
function hasFuzzySyncKeyword(topicLower) {
  const tokens = topicLower.split(/[^a-z0-9-]+/).filter(Boolean);
  for (const rawToken of tokens) {
    const token = SYNC_KEYWORD_ALIASES[rawToken] || rawToken;
    for (const keyword of SYNC_KEYWORDS) {
      if (token === keyword) return true;
      if (
        Math.abs(token.length - keyword.length) <= MAX_KEYWORD_EDIT_DISTANCE &&
        levenshtein(token, keyword) <= MAX_KEYWORD_EDIT_DISTANCE
      ) {
        return true;
      }
    }
  }
  return false;
}

// How far back to search on each hourly poll. Deliberately wider than the 1-hour
// trigger interval so a slow Apollo sync or a missed/late poll doesn't drop a call —
// Storage by Zapier dedup (wired natively around the outer loop, see setup guide)
// is what actually prevents reprocessing, not this window being narrow.
const LOOKBACK_HOURS = 3;

function matchPartnerFromTopic(topic) {
  const topicLower = (topic || "").toLowerCase();
  if (!topicLower.includes("markaaz")) return null;
  // Sync-keyword match tolerates a single-character typo (alias map + Levenshtein
  // fuzzy check, see hasFuzzySyncKeyword above) — computed once per topic, not once
  // per partner, since it doesn't depend on which partner we're checking.
  const hasSyncKeyword = hasFuzzySyncKeyword(topicLower);
  if (!hasSyncKeyword) return null;
  for (const partner of KNOWN_PARTNERS) {
    const partnerLower = partner.toLowerCase();
    // Partner name matching stays an exact substring check — no fuzzing here, see the
    // KNOWN_PARTNERS comment above.
    if (topicLower.includes(partnerLower)) {
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
