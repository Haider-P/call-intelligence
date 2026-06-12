/**
 * PIPEDREAM STEP 1 — HubSpot Webhook Trigger Handler (Granola-inspired)
 * ----------------------------------------------------------------------
 * Type: Pipedream Code step (Node.js)
 *
 * Enhanced to support Granola-style deal memory:
 * - Fetches prior call notes on the same deal
 * - Tracks call sequence number (#1, #2, #3...)
 * - Passes previous sentiment + objections to Claude for continuity
 *
 * HubSpot Webhook Setup:
 *   1. HubSpot Settings → Integrations → Private Apps
 *   2. Select your Private App → Webhooks tab
 *   3. Add subscription: object=notes, event=note.creation
 *   4. Set target URL to your Pipedream workflow URL
 */

export default defineComponent({
  async run({ steps, $ }) {
    const payload = steps.trigger.event.body;
    const event = Array.isArray(payload) ? payload[0] : payload;
    const noteId = event.objectId?.toString() || "";
    const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

    if (!noteId) {
      throw new Error("No note ID found in HubSpot webhook payload");
    }

    // Fetch full note details
    const noteResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/notes/${noteId}?properties=hs_note_body,hs_timestamp,hubspot_owner_id`,
      {
        headers: {
          Authorization: `Bearer ${hubspotToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!noteResponse.ok) {
      throw new Error(`Failed to fetch note: ${noteResponse.status}`);
    }

    const noteData = await noteResponse.json();
    const noteBody = noteData.properties?.hs_note_body || "";
    const timestamp = noteData.properties?.hs_timestamp || new Date().toISOString();

    // Guard: only process Apollo call summary notes
    const isApolloCallNote =
      noteBody.toLowerCase().includes("recording") ||
      noteBody.toLowerCase().includes("transcript") ||
      noteBody.toLowerCase().includes("summary") ||
      noteBody.toLowerCase().includes("call");

    if (!isApolloCallNote) {
      throw new Error("Note does not appear to be an Apollo call summary — skipping");
    }

    // Get associated deal ID
    const assocResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/deals`,
      { headers: { Authorization: `Bearer ${hubspotToken}` } }
    );

    let dealId = event.associatedObjectId?.toString() || "";
    if (!dealId && assocResponse.ok) {
      const assocData = await assocResponse.json();
      dealId = assocData.results?.[0]?.id || "";
    }

    // Granola-inspired: fetch prior call notes on this deal for memory/continuity
    let priorNotes = [];
    let callNumber = 1;
    let previousSentiment = null;
    let previousObjections = "";

    if (dealId) {
      const priorNotesResponse = await fetch(
        `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/notes`,
        { headers: { Authorization: `Bearer ${hubspotToken}` } }
      );

      if (priorNotesResponse.ok) {
        const priorNotesData = await priorNotesResponse.json();
        const priorNoteIds = (priorNotesData.results || [])
          .map(n => n.id)
          .filter(id => id !== noteId)
          .slice(0, 5); // last 5 calls max

        callNumber = priorNoteIds.length + 1;

        // Fetch the most recent prior note for sentiment + objections continuity
        if (priorNoteIds.length > 0) {
          const lastNoteResponse = await fetch(
            `https://api.hubapi.com/crm/v3/objects/notes/${priorNoteIds[0]}?properties=hs_note_body`,
            { headers: { Authorization: `Bearer ${hubspotToken}` } }
          );

          if (lastNoteResponse.ok) {
            const lastNoteData = await lastNoteResponse.json();
            const lastNoteBody = lastNoteData.properties?.hs_note_body || "";

            // Extract previous sentiment from our enriched note format
            const sentimentMatch = lastNoteBody.match(/Sentiment:\s*(🟢|🟡|🔴)\s*(positive|neutral|at-risk)/i);
            if (sentimentMatch) previousSentiment = sentimentMatch[2];

            // Extract previous unresolved objections
            const unresolvedMatch = lastNoteBody.match(/Unresolved Objections:\s*([^\n]+)/i);
            if (unresolvedMatch) previousObjections = unresolvedMatch[1].trim();
          }
        }
      }
    }

    return {
      noteId,
      noteBody,
      dealId,
      timestamp,
      callNumber,
      previousSentiment,
      previousObjections,
      priorNotes
    };
  }
});
