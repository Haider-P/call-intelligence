# Pipedream Setup Guide — Call Intelligence

Step-by-step guide to building the Apollo → HubSpot call intelligence workflow in Pipedream.

---

## Prerequisites

- [ ] Apollo ↔ HubSpot native sync enabled (Settings → Integrations → HubSpot)
- [ ] "Push meeting summaries" checked under Activities in Apollo
- [ ] Apollo deal sync complete (wait 24hrs after first enabling)
- [ ] HubSpot Private App created with scopes:
  - `crm.objects.notes.read`
  - `crm.objects.notes.write`
  - `crm.objects.deals.read`
  - `crm.objects.deals.write`
- [ ] 6 custom deal properties created in HubSpot (see README)
- [ ] Anthropic API key ready

---

## Pipedream Environment Variables

In Pipedream → Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Your HubSpot Private App token |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

---

## Workflow Structure

| Step | Name | Type | Purpose |
|---|---|---|---|
| 1 | Trigger | HTTP Webhook | Receive HubSpot note creation event |
| 2 | parse_hubspot_webhook | Code (Node.js) | Parse note + fetch prior call history |
| 3 | claude_enrichment | Code (Node.js) | Claude AI signal extraction |
| 4 | update_hubspot_note | Code (Node.js) | Update existing note with enriched format |
| 5 | update_deal_properties | Code (Node.js) | Update deal Next Steps, Date, Sentiment |

---

## Step-by-Step Build

### Step 1 — HTTP Trigger
Pipedream creates this automatically when you create a new workflow. Copy the webhook URL.

### Step 2 — HubSpot Webhook Configuration
1. Go to HubSpot → Settings → Integrations → Private Apps
2. Select your Private App → **Webhooks** tab
3. Click **Add subscription**
4. Object: **Notes** | Event: **Note creation**
5. Target URL: paste your Pipedream webhook URL
6. Save

### Step 3 — parse_hubspot_webhook (Code step)
1. Add a **Node.js Code** step, name it `parse_hubspot_webhook`
2. Paste contents of `pipedream-steps/01-parse-hubspot-webhook.js`
3. Test with a real Apollo call note

### Step 4 — claude_enrichment (Code step)
1. Add a **Node.js Code** step, name it `claude_enrichment`
2. Paste contents of `pipedream-steps/02-claude-enrichment.js`
3. Test — confirm all signal fields return correctly

### Step 5 — update_hubspot_note (Code step)
1. Add a **Node.js Code** step, name it `update_hubspot_note`
2. Paste contents of `pipedream-steps/03-update-hubspot-note.js`
3. Test — confirm note in HubSpot is updated in place

### Step 6 — update_deal_properties (Code step)
1. Add a **Node.js Code** step, name it `update_deal_properties`
2. Paste contents of `pipedream-steps/04-update-deal-properties.js`
3. Test — confirm deal properties updated in HubSpot

---

## Testing Checklist

- [ ] Run a real Apollo call on a deal that exists in HubSpot
- [ ] Confirm Apollo pushes summary note to HubSpot deal
- [ ] Confirm Pipedream webhook fires
- [ ] Confirm note is updated in place (not duplicated)
- [ ] Confirm enriched format appears correctly in HubSpot
- [ ] Confirm Next Steps property updated on deal
- [ ] Confirm Next Step Date updated if date mentioned on call
- [ ] Confirm Last Call Sentiment updated
- [ ] Confirm Last Call Number increments correctly on 2nd call
- [ ] Test objection tracking: run 2 calls, confirm unresolved objections carry forward

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Webhook not firing | Check HubSpot Private App webhook subscription is active |
| Note not found | Confirm `crm.objects.notes.read` scope on Private App |
| Deal not found | Confirm Apollo deal sync completed (24hr wait) |
| Claude returns invalid JSON | Check transcript isn't empty; add console.log(rawText) to debug |
| Date not updating | Confirm `next_step_date` property internal name matches exactly |
