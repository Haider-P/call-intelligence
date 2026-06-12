/**
 * ZAPIER STEP 5 — Find HubSpot Deal by Associated Contact
 * --------------------------------------------------------
 * Type: Zapier Code step (JavaScript)
 *
 * Replaces the native HubSpot "Find Deal" action, which does not support
 * filtering by associated contact ID. Uses the HubSpot CRM Search API instead.
 *
 * Required Zapier fields:
 *   - inputData.contactId        → HubSpot contact ID (from Step 6 Find Contact)
 *   - inputData.hubspotToken     → HubSpot Private App token (store as Zapier secret)
 *
 * Returns the most recently active open deal associated to the contact.
 * If no deal is found, returns dealId: "" so the downstream Filter can stop the Zap.
 */

const contactId = inputData.contactId;
const token = inputData.hubspotToken;

if (!contactId) {
  throw new Error("No contact ID provided — check Step 6 Find Contact output");
}

// Search for deals associated to this contact, sorted by last activity descending
const searchBody = {
  filters: [
    {
      propertyName: "associations.contact",
      operator: "EQ",
      value: contactId
    }
  ],
  sorts: [
    {
      propertyName: "notes_last_updated",
      direction: "DESCENDING"
    }
  ],
  properties: ["dealname", "dealstage", "closedate", "hs_lastmodifieddate"],
  limit: 5
};

const response = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  },
  body: JSON.stringify(searchBody)
});

if (!response.ok) {
  const errorText = await response.text();
  throw new Error(`HubSpot search API error: ${response.status} — ${errorText}`);
}

const data = await response.json();
const results = data.results || [];

if (results.length === 0) {
  return {
    dealId: "",
    dealName: "",
    dealStage: ""
  };
}

// Take the first result (most recently modified open deal)
const deal = results[0];

return {
  dealId: deal.id,
  dealName: deal.properties.dealname || "",
  dealStage: deal.properties.dealstage || ""
};
