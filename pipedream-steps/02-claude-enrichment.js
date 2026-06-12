/**
 * PIPEDREAM STEP 2 — Claude AI Enrichment (Granola-inspired)
 * ----------------------------------------------------------
 * Type: Pipedream Code step (Node.js)
 *
 * Inspired by Granola's "enterprise context layer" approach:
 * - Extracts structured signals from Apollo call note
 * - Tracks objection resolution across calls (new vs unresolved)
 * - Detects call sequence number for deal momentum context
 * - Supports multiple meeting types (sales, partner, CS, onboarding)
 * - Lays foundation for cross-deal pattern intelligence (Phase 2)
 *
 * Input from Step 1:
 *   - steps.parse_hubspot_webhook.noteBody     → Apollo's raw note
 *   - steps.parse_hubspot_webhook.dealId       → for prior call lookup
 *   - steps.parse_hubspot_webhook.priorNotes   → previous call notes on deal
 *   - steps.parse_hubspot_webhook.callNumber   → which call # this is
 */

export default defineComponent({
  async run({ steps, $ }) {
    const noteBody = steps.parse_hubspot_webhook.$return_value.noteBody;
    const priorNotes = steps.parse_hubspot_webhook.$return_value.priorNotes || [];
    const callNumber = steps.parse_hubspot_webhook.$return_value.callNumber || 1;
    const previousSentiment = steps.parse_hubspot_webhook.$return_value.previousSentiment || null;
    const previousObjections = steps.parse_hubspot_webhook.$return_value.previousObjections || "";
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!noteBody) {
      throw new Error("No note body to enrich");
    }

    // Extract recording URL from Apollo's note
    const recordingUrlMatch = noteBody.match(
      /https?:\/\/[^\s]+(?:recording|replay|watch|video)[^\s]*/i
    ) || noteBody.match(/https?:\/\/app\.apollo\.io[^\s]*/i);
    const recordingUrl = recordingUrlMatch ? recordingUrlMatch[0] : "";

    // Build prior objections context for Claude
    const priorObjectionsContext = previousObjections
      ? `\nPrevious unresolved objections from prior calls: ${previousObjections}\nIdentify which of these were addressed this call and which remain open.`
      : "";

    const prompt = `You are a sales intelligence assistant building a deal memory layer, similar to how Granola tracks meeting context over time.

Below is a call summary and transcript pushed from Apollo to HubSpot. This is call #${callNumber} for this deal.${priorObjectionsContext}

Analyze it and extract the following. Return ONLY valid JSON, no preamble, no markdown, no backticks:

{
  "summary": "2-3 sentence summary — what was discussed, where the deal stands, key outcome",
  "meeting_type": "sales" | "partner" | "customer_success" | "onboarding" | "internal",
  "sentiment": "positive" | "neutral" | "at-risk",
  "sentiment_change": "improved" | "unchanged" | "declined" | "first_call",
  "objections_new": "NEW objections raised this call, comma-separated, or 'None'",
  "objections_resolved": "objections from prior calls resolved this call, comma-separated, or 'None'",
  "objections_unresolved": "objections still open after this call, comma-separated, or 'None'",
  "competitors": "competitors or tools mentioned, comma-separated, or 'None mentioned'",
  "pricing": "pricing, budget or commercial details discussed, or 'Not discussed'",
  "next_steps": "specific next steps agreed on the call, or 'None identified'",
  "next_step_date": "date of next step if mentioned (YYYY-MM-DD), or null",
  "participants": "participant names, comma-separated, or 'Unknown'",
  "duration": "call duration if mentioned, or 'Unknown'",
  "operational_signals": "any operational flags — blockers, escalations, resource needs, churn risk, expansion opportunity, or 'None'"
}

Sentiment guide:
- positive: prospect engaged, moving forward, clear next steps
- neutral: informational, no strong signal either way
- at-risk: unresolved objections, competitor threat, stalling, disengagement

Meeting type guide:
- sales: prospect/new business call
- partner: call with a channel or referral partner
- customer_success: existing customer check-in or QBR
- onboarding: implementation or go-live call
- internal: internal team review or deal debrief

Apollo Note:
${noteBody}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rawText = data.content[0].text.trim();

    let parsed;
    try {
      const clean = rawText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      throw new Error(`Failed to parse Claude response: ${rawText}`);
    }

    const sentimentEmoji = {
      positive: "🟢",
      neutral: "🟡",
      "at-risk": "🔴"
    }[parsed.sentiment] || "🟡";

    const sentimentChangeEmoji = {
      improved: "↑",
      declined: "↓",
      unchanged: "→",
      first_call: ""
    }[parsed.sentiment_change] || "";

    return {
      summary: parsed.summary || "",
      meetingType: parsed.meeting_type || "sales",
      sentiment: parsed.sentiment || "neutral",
      sentimentEmoji,
      sentimentChange: parsed.sentiment_change || "first_call",
      sentimentChangeEmoji,
      objectionsNew: parsed.objections_new || "None",
      objectionsResolved: parsed.objections_resolved || "None",
      objectionsUnresolved: parsed.objections_unresolved || "None",
      competitors: parsed.competitors || "None mentioned",
      pricing: parsed.pricing || "Not discussed",
      nextSteps: parsed.next_steps || "None identified",
      nextStepDate: parsed.next_step_date || "",
      participants: parsed.participants || "Unknown",
      duration: parsed.duration || "Unknown",
      operationalSignals: parsed.operational_signals || "None",
      recordingUrl,
      callNumber,
      previousSentiment
    };
  }
});
