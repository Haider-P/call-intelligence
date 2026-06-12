# 📞 Call Intelligence — Apollo → HubSpot

Automated pipeline that captures Apollo call transcripts, enriches them with Claude AI, and logs structured intelligence directly into HubSpot deals.

## What It Does

After every Apollo call:
1. Apollo webhook fires to Zapier
2. Transcript is fetched from Apollo API
3. Claude extracts structured signals (summary, objections, competitors, pricing, sentiment, next steps)
4. HubSpot deal is updated:
   - Enriched note created with full brief + transcript
   - `Next Steps` property updated
   - `Next Step Date` property updated
   - Recording link appended

## Stack

| Layer | Tool |
|---|---|
| Trigger | Apollo webhook (call completed) |
| Orchestration | Zapier |
| AI Extraction | Claude API (claude-sonnet-4-6) |
| CRM | HubSpot (Private App Token) |

## Repo Structure

```
call-intelligence/
├── zapier-steps/
│   ├── 01-fetch-transcript.js       # HTTP step: fetch transcript from Apollo API
│   ├── 02-claude-extraction.js      # Code step: Claude API call + signal extraction
│   ├── 03-format-note.js            # Code step: format final HubSpot note
│   └── 04-parse-next-step-date.js   # Code step: parse date from next steps text
├── prompts/
│   └── extraction-prompt.md         # Claude prompt template
├── docs/
│   └── zapier-setup.md              # Step-by-step Zapier build guide
├── .env.example                     # Required credentials
└── README.md
```

## HubSpot Prerequisites

Before running this flow, ensure the following exist on your HubSpot Deal object:
- `Next Steps` — Single-line or multi-line text property
- `Next Step Date` — Date picker property

These should already exist. No new properties required.

## Credentials Needed

| Credential | Used In |
|---|---|
| `APOLLO_API_KEY` | Fetch transcript (Zapier HTTP step) |
| `ANTHROPIC_API_KEY` | Claude extraction (Zapier Code step) |
| `HUBSPOT_ACCESS_TOKEN` | Update deal + create note (Zapier HubSpot steps) |

Store all as **Zapier secrets** — never hardcode in steps.

## HubSpot Note Output Format

```
📞 Call Summary — {date}
Duration: {duration} | Sentiment: {emoji} {sentiment}
Participants: {participants}

Summary:
{2-3 sentence summary}

Key Signals:
• Objections: {objections}
• Competitors: {competitors}
• Pricing: {pricing discussed}
• Next Steps: {next steps}

🎙 Recording: {apollo_recording_url}

---
Full Transcript:
{transcript}
```
