/**
 * PIPEDREAM STEP 4 — Update HubSpot Deal Properties (Granola-inspired)
 * --------------------------------------------------------------------
 * Type: Pipedream Code step (Node.js)
 *
 * Updates deal properties with latest call intelligence.
 * Tracks call count and sentiment momentum across the deal lifecycle.
 */

export default defineComponent({
  async run({ steps, $ }) {
    const dealId = steps.parse_hubspot_webhook.$return_value.dealId;
    const callNumber = steps.parse_hubspot_webhook.$return_value.callNumber;
    const signals = steps.claude_enrichment.$return_value;
    const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

    if (!dealId) {
      console.log("No deal ID — skipping deal property update");
      return { success: false, reason: "No deal ID" };
    }

    // Core properties — always update
    const properties = {
      next_steps: signals.nextSteps,
      last_call_sentiment: signals.sentiment,
      last_call_date: new Date(steps.parse_hubspot_webhook.$return_value.timestamp)
        .toISOString().split("T")[0],
      last_call_number: callNumber.toString(),
      last_call_unresolved_objections: signals.objectionsUnresolved !== "None"
        ? signals.objectionsUnresolved
        : ""
    };

    // Only update next step date if Claude found one
    if (signals.nextStepDate) {
      try {
        const date = new Date(signals.nextStepDate + "T12:00:00.000Z");
        if (!isNaN(date.getTime())) {
          properties.next_step_date = date.getTime().toString();
        }
      } catch (e) {
        console.log(`Could not parse next step date: ${signals.nextStepDate}`);
      }
    }

    const updateResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${hubspotToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ properties })
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      throw new Error(`Failed to update deal: ${updateResponse.status} — ${error}`);
    }

    return {
      success: true,
      dealId,
      callNumber,
      updatedProperties: Object.keys(properties),
      message: `Deal ${dealId} updated after call #${callNumber}`
    };
  }
});
