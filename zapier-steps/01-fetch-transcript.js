/**
 * ZAPIER STEP 1 — Fetch Transcript from Apollo API
 * -------------------------------------------------
 * Type: Zapier Code step (JavaScript)
 * Trigger input: Apollo webhook payload (call completed)
 *
 * Required Zapier fields mapped from webhook:
 *   - inputData.conversationId  → Apollo conversation/call ID
 *   - inputData.apolloApiKey    → Apollo API key (store as Zapier secret)
 */

const conversationId = inputData.conversationId;
const apiKey = inputData.apolloApiKey;

if (!conversationId) {
  throw new Error("No conversation ID found in Apollo webhook payload");
}

// Fetch full conversation details including transcript
const response = await fetch(
  `https://api.apollo.io/v1/conversations/${conversationId}`,
  {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey
    }
  }
);

if (!response.ok) {
  throw new Error(`Apollo API error: ${response.status} ${response.statusText}`);
}

const data = await response.json();
const conversation = data.conversation || data;

// Extract key fields from the Apollo response
const transcript = conversation.transcript || conversation.transcription || "";
const recordingUrl = conversation.recording_url || conversation.url || "";
const duration = conversation.duration_seconds
  ? `${Math.floor(conversation.duration_seconds / 60)}m ${conversation.duration_seconds % 60}s`
  : "Unknown";

// Participants: flatten all speakers into a comma-separated string
const participants = (conversation.participants || [])
  .map(p => p.name || p.email || "Unknown")
  .join(", ");

const contactEmail = (conversation.participants || []).find(
  p => p.role !== "host"
)?.email || "";

if (!transcript) {
  throw new Error("No transcript found for this conversation. Check Apollo plan supports transcription.");
}

return {
  transcript,
  recordingUrl,
  duration,
  participants,
  contactEmail,
  conversationId,
  callDate: conversation.created_at || new Date().toISOString()
};
