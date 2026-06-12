/**
 * PIPEDREAM STEP 3 — Update HubSpot Note (Granola-inspired format)
 * ----------------------------------------------------------------
 * Type: Pipedream Code step (Node.js)
 *
 * Rewrites Apollo's basic note with a structured intelligence brief.
 * Includes deal momentum context (call #, sentiment change, objection tracking)
 * inspired by Granola's approach to meeting memory.
 */

export default defineComponent({
  async run({ steps, $ }) {
    const noteId = steps.parse_hubspot_webhook.$return_value.noteId;
    const timestamp = steps.parse_hubspot_webhook.$return_value.timestamp;
    const callNumber = steps.parse_hubspot_webhook.$return_value.callNumber;
    const previousSentiment = steps.parse_hubspot_webhook.$return_value.previousSentiment;
    const signals = steps.claude_enrichment.$return_value;
    const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

    const callDate = new Date(timestamp).toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric"
    });

    // Meeting type label
    const meetingTypeLabel = {
      sales: "Sales Call",
      partner: "Partner Call",
      customer_success: "Customer Success Call",
      onboarding: "Onboarding Call",
      internal: "Internal Review"
    }[signals.meetingType] || "Call";

    // Sentiment change line — only show if not first call
    const sentimentChangeLine = signals.sentimentChange !== "first_call" && previousSentiment
      ? `Sentiment change: ${previousSentiment} → ${signals.sentiment} ${signals.sentimentChangeEmoji}`
      : "";

    // Objection tracking section
    const objectionSection = [
      signals.objectionsNew !== "None" ? `• 🆕 New: ${signals.objectionsNew}` : "",
      signals.objectionsResolved !== "None" ? `• ✅ Resolved: ${signals.objectionsResolved}` : "",
      signals.objectionsUnresolved !== "None" ? `• ⚠️ Still open: ${signals.objectionsUnresolved}` : ""
    ].filter(Boolean).join("\n") || "• None identified";

    // Operational signals section — only show if something flagged
    const operationalSection = signals.operationalSignals !== "None"
      ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚡ Operational Signals:\n${signals.operationalSignals}`
      : "";

    const enrichedNote = `📞 ${meetingTypeLabel} #${callNumber} — ${callDate}
Duration: ${signals.duration} | Sentiment: ${signals.sentimentEmoji} ${signals.sentiment}${sentimentChangeLine ? `\n${sentimentChangeLine}` : ""}
Participants: ${signals.participants}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Summary:
${signals.summary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Key Signals:
• Competitors: ${signals.competitors}
• Pricing: ${signals.pricing}
• Next Steps: ${signals.nextSteps}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Objections:
${objectionSection}

Unresolved Objections: ${signals.objectionsUnresolved}${operationalSection}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎙 Recording: ${signals.recordingUrl || "Not available"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Full Transcript:
${steps.parse_hubspot_webhook.$return_value.noteBody}`;

    const updateResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/notes/${noteId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${hubspotToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: { hs_note_body: enrichedNote }
        })
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      throw new Error(`Failed to update note: ${updateResponse.status} — ${error}`);
    }

    return {
      success: true,
      noteId,
      callNumber,
      meetingType: signals.meetingType,
      message: `Note ${noteId} enriched as ${meetingTypeLabel} #${callNumber}`
    };
  }
});
