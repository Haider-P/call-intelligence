# Zapier Setup Guide — Call Intelligence

Step-by-step instructions for building the Apollo → HubSpot call intelligence Zap.

---

## Prerequisites

Before building:
- [ ] Apollo API key (Settings → API in Apollo)
- [ ] Anthropic API key (console.anthropic.com)
- [ ] HubSpot Private App Token with scopes: `crm.objects.deals.write`, `crm.objects.contacts.read`, `crm.objects.notes.write`
- [ ] Confirm HubSpot deal has `Next Steps` and `Next Step Date` properties

---

## Zap Structure Overview

| # | Step Type | Tool | Purpose |
|---|---|---|---|
| 1 | Trigger | Zapier Webhook (Catch Hook) | Receive Apollo call completed event |
| 2 | Action | Code by Zapier (JS) | Fetch transcript from Apollo API |
| 3 | Action | Code by Zapier (JS) | Claude AI signal extraction |
| 4 | Action | Code by Zapier (JS) | Format HubSpot note |
| 5 | Action | Code by Zapier (JS) | Parse next step date |
| 6 | Action | HubSpot | Find contact by email |
| 7 | Filter | Zapier Filter | Stop if no contact found |
| 8 | Action | HubSpot | Find deal associated to contact |
| 9 | Filter | Zapier Filter | Stop if no deal found |
| 10 | Action | HubSpot | Create note on deal |
| 11 | Action | HubSpot | Update deal — Next Steps property |
| 12 | Filter | Zapier Filter | Only continue if next step date exists |
| 13 | Action | HubSpot | Update deal — Next Step Date property |

---

## Step-by-Step Build

### Step 1 — Trigger: Webhook (Catch Hook)
1. Choose **Webhooks by Zapier** → **Catch Hook**
2. Copy the webhook URL Zapier generates
3. Go to Apollo → Settings → Integrations → Webhooks
4. Add new webhook, paste the URL, select event: **Conversation Completed**
5. Test by running a call in Apollo — the payload should appear in Zapier

**Key fields from Apollo webhook payload to map:**
- Conversation ID → `conversationId`
- Contact email → `contactEmail` (may need to extract from participants array)

---

### Step 2 — Code: Fetch Transcript
1. Add **Code by Zapier** → **Run JavaScript**
2. Input data:
   - `conversationId` → map from Step 1 webhook payload
   - `apolloApiKey` → paste your Apollo API key (store as secret)
3. Paste contents of `zapier-steps/01-fetch-transcript.js`
4. Test — confirm `transcript`, `recordingUrl`, `duration`, `participants`, `contactEmail` are returned

---

### Step 3 — Code: Claude Extraction
1. Add **Code by Zapier** → **Run JavaScript**
2. Input data:
   - `transcript` → map from Step 2 output
   - `claudeApiKey` → paste your Anthropic API key (store as secret)
3. Paste contents of `zapier-steps/02-claude-extraction.js`
4. Test — confirm all 7 fields returned as clean values

---

### Step 4 — Code: Format Note
1. Add **Code by Zapier** → **Run JavaScript**
2. Input data — map all fields from Steps 1, 2, 3:
   - `callDate` → Step 2 output
   - `duration` → Step 2 output
   - `participants` → Step 2 output
   - `sentimentEmoji` → Step 3 output
   - `sentiment` → Step 3 output
   - `summary` → Step 3 output
   - `objections` → Step 3 output
   - `competitors` → Step 3 output
   - `pricing` → Step 3 output
   - `nextSteps` → Step 3 output
   - `recordingUrl` → Step 2 output
   - `transcript` → Step 2 output
3. Paste contents of `zapier-steps/03-format-note.js`
4. Test — confirm `formattedNote` returns the full formatted note

---

### Step 5 — Code: Parse Next Step Date
1. Add **Code by Zapier** → **Run JavaScript**
2. Input data:
   - `nextStepDate` → map from Step 3 output
3. Paste contents of `zapier-steps/04-parse-next-step-date.js`
4. Test — confirm `hasNextStepDate` and `nextStepDateMs` returned

---

### Step 6 — HubSpot: Find Contact
1. Add **HubSpot** → **Find Contact**
2. Search by: **Email**
3. Email value: map `contactEmail` from Step 2

---

### Step 7 — Filter: Stop if No Contact
1. Add **Filter by Zapier**
2. Condition: Step 6 Contact ID **exists**
3. If false → stop (add a Slack/email notification here optionally)

---

### Step 8 — HubSpot: Find Deal
1. Add **HubSpot** → **Find Deal**
2. Search by associated contact ID from Step 6
3. If multiple deals — filter to most recently active

---

### Step 9 — Filter: Stop if No Deal
1. Add **Filter by Zapier**
2. Condition: Step 8 Deal ID **exists**

---

### Step 10 — HubSpot: Create Note
1. Add **HubSpot** → **Create Note**
2. Note body: map `formattedNote` from Step 4
3. Associate to: Deal ID from Step 8
4. Associate to: Contact ID from Step 6

---

### Step 11 — HubSpot: Update Deal (Next Steps)
1. Add **HubSpot** → **Update Deal**
2. Deal ID: map from Step 8
3. Property: `Next Steps` → map `nextSteps` from Step 3

---

### Step 12 — Filter: Only if Date Exists
1. Add **Filter by Zapier**
2. Condition: Step 5 `hasNextStepDate` **equals** `true`

---

### Step 13 — HubSpot: Update Deal (Next Step Date)
1. Add **HubSpot** → **Update Deal**
2. Deal ID: map from Step 8
3. Property: `Next Step Date` → map `nextStepDateMs` from Step 5

---

## Testing Checklist

- [ ] Run a real Apollo call end-to-end
- [ ] Confirm transcript appears in Zapier Step 2 output
- [ ] Confirm Claude returns valid JSON in Step 3
- [ ] Confirm note appears on correct HubSpot deal
- [ ] Confirm Next Steps property updated on deal
- [ ] Confirm Next Step Date updated if date was mentioned on call
- [ ] Test edge case: contact not in HubSpot → flow stops at Step 7
- [ ] Test edge case: no deal associated → flow stops at Step 9
