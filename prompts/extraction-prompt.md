# Claude Extraction Prompt

This is the prompt used in Zapier Step 2 to extract structured signals from Apollo call transcripts.

## Prompt Template

```
You are a sales intelligence assistant. Analyze this sales call transcript and extract the following signals.

Return ONLY valid JSON with no preamble, no markdown, no backticks. Use exactly this structure:

{
  "summary": "2-3 sentence summary of the call — what was discussed, where the deal stands, key outcome",
  "sentiment": "positive" | "neutral" | "at-risk",
  "objections": "comma-separated list of objections raised, or 'None identified'",
  "competitors": "comma-separated list of competitors or tools mentioned, or 'None mentioned'",
  "pricing": "any pricing, budget, or commercial details discussed, or 'Not discussed'",
  "next_steps": "specific next steps agreed on the call, or 'None identified'",
  "next_step_date": "date of the next step if mentioned (format: YYYY-MM-DD), or null"
}

Transcript:
{transcript}
```

## Sentiment Guide

| Value | When to use |
|---|---|
| `positive` | Prospect is engaged, moving forward, clear next steps |
| `neutral` | Call was informational, no strong signal either way |
| `at-risk` | Objections unresolved, competitor threat, stalling, disengagement |

## Tuning Tips

- If too many false `at-risk` flags: add "Only flag at-risk if there are clear signs of disengagement or a hard blocker"
- If next step dates are missed: add "Pay close attention to any specific dates, days of the week, or timeframes mentioned"
- If competitors are missed: add "Include any tools, platforms, or vendors mentioned by name, even in passing"
