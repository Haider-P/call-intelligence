# 📞 Call Intelligence — Apollo → HubSpot

Automated pipeline that captures Apollo call summaries, enriches them with Claude AI, and builds a compounding intelligence layer on every HubSpot deal — inspired by Granola's approach to meeting memory.

## What It Does

After every Apollo call:
1. Apollo pushes call summary + transcript to HubSpot deal (native sync)
2. HubSpot webhook fires to Pipedream
3. Claude enriches the note with structured signals
4. The same note is updated in place (no duplicate notes)
5. Deal properties updated: Next Steps, Next Step Date, Sentiment, Call #, Unresolved Objections

## Granola-Inspired Features

| Feature | What it does |
|---|---|
| **Deal memory** | Fetches prior call notes to track continuity across the deal |
| **Call sequence** | Numbers each call (#1, #2, #3) for momentum context |
| **Sentiment tracking** | Shows sentiment change call-over-call (🟡 → 🟢 ↑) |
| **Objection tracking** | Tracks new / resolved / unresolved objections across calls |
| **Meeting type detection** | Sales, partner, CS, onboarding, internal — different signals per type |
| **Operational signals** | Flags blockers, escalations, churn risk, expansion opportunities |

## Architecture

```
Apollo call ends
        ↓
Apollo native sync → HubSpot note created on deal
        ↓
HubSpot webhook → Pipedream
        ↓
Step 1: Parse webhook + fetch prior call history
        ↓
Step 2: Claude enrichment (signals + objection tracking + sentiment change)
        ↓
Step 3: Update existing HubSpot note (enriched format, one note per call)
        ↓
Step 4: Update deal properties (Next Steps, Date, Sentiment, Call #)
```

## Note Format Output

```
📞 Sales Call #3 — June 12, 2026
Duration: 26m 55s | Sentiment: 🟢 positive
Sentiment change: neutral → positive ↑
Participants: Matt Shubert, Keith Kilpatrick

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Summary:
Prospect confirmed budget and wants to start POC in July.
CFO intro scheduled for next week. Competitor concern addressed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Key Signals:
• Competitors: Visa data solution (evaluating)
• Pricing: $50-75k annually, board sign-off needed
• Next Steps: Send proposal by Friday, CFO intro call June 17

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Objections:
• 🆕 New: Board approval required
• ✅ Resolved: Implementation timeline concern
• ⚠️ Still open: CFO sign-off

⚡ Operational Signals:
CFO intro required before commitment — flag for manager

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎙 Recording: https://app.apollo.io/...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Full Transcript:
[full transcript]
```

## Stack

| Layer | Tool |
|---|---|
| Call recording + summary | Apollo (native) |
| CRM sync trigger | Apollo → HubSpot native sync |
| Automation | Pipedream |
| AI enrichment | Claude API (claude-sonnet-4-6) |
| CRM | HubSpot (Private App Token) |

## Repo Structure

```
call-intelligence/
├── pipedream-steps/
│   ├── 01-parse-hubspot-webhook.js   # Webhook handler + prior call history fetch
│   ├── 02-claude-enrichment.js       # Claude AI extraction + objection tracking
│   ├── 03-update-hubspot-note.js     # Update existing note with enriched format
│   └── 04-update-deal-properties.js  # Update Next Steps, Date, Sentiment, Call #
├── zapier-steps/                     # Original Zapier steps (deprecated, kept for reference)
├── prompts/
│   └── extraction-prompt.md          # Claude prompt template + tuning guide
├── docs/
│   └── pipedream-setup.md            # Step-by-step Pipedream build guide
├── .env.example
└── README.md
```

## HubSpot Properties Required

5 deal properties, verified against the Markaaz portal on 2026-08-26. `last_call_number`
was dropped from the design — call sequencing still appears in the note text (see Note
Format Output above) but is no longer written back as a deal property.

| Property Label | Internal Name | Type | Status |
|---|---|---|---|
| Next Step | `hs_next_step` (HubSpot's built-in property) | Multi-line text | ✅ exists |
| Next Step Date | `next_step_date` | Date | ✅ exists |
| Last Call Sentiment | `last_call_sentiment` | Dropdown (positive/neutral/at-risk) | ⚠️ **not yet created** — confirmed missing portal-wide (active + archived deal properties, contacts) as of 2026-08-26; must be created before this pipeline can run |
| Last Call Date | `last_call_date` | Date | ✅ exists |
| Last Call Unresolved Objections | `last_call_unresolved_objections` | Single-line text | ✅ exists (previously documented here as "Multi-line text" — corrected to match the actual portal config) |

## Parking Lot — Phase 2

- At-risk deal alerts → Slack channel (connects to Slack↔HubSpot flow)
- Pre-call briefings — agent pulls all prior signals before scheduled calls
- Cross-deal pattern analysis — "what objections keep killing deals at pricing stage?"
- Partner channel updates — post call summaries to Slack Connect channels

## Credentials

| Credential | Where Used |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | All HubSpot API calls |
| `ANTHROPIC_API_KEY` | Claude enrichment step |
