/**
 * ZAPIER STEP 2 — Claude AI Signal Extraction
 * --------------------------------------------
 * Type: Zapier Code step (JavaScript)
 *
 * Required Zapier fields mapped from Step 1:
 *   - inputData.transcript       → full transcript text
 *   - inputData.claudeApiKey     → Anthropic API key (store as Zapier secret)
 *
 * Returns structured JSON with all call intelligence signals.
 */

const transcript = inputData.transcript;
const apiKey = inputData.claudeApiKey;

if (!transcript) {
  throw new Error("No transcript provided to Claude extraction step");
}

// Truncate transcript if too long (Claude handles ~200k tokens but Zapier
// has a 30s timeout — truncate to ~15k words to be safe)
const words = transcript.split(" ");
const truncated = words.length > 15000
  ? words.slice(0, 15000).join(" ") + "\n\n[Transcript truncated for processing]"
  : transcript;

const prompt = `You are a sales intelligence assistant. Analyze this sales call transcript and extract the following signals.

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
${truncated}`;

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
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
  // Strip any accidental markdown fences
  const clean = rawText.replace(/```json|```/g, "").trim();
  parsed = JSON.parse(clean);
} catch (e) {
  throw new Error(`Failed to parse Claude response as JSON: ${rawText}`);
}

// Map sentiment to emoji for note display
const sentimentEmoji = {
  positive: "🟢",
  neutral: "🟡",
  "at-risk": "🔴"
}[parsed.sentiment] || "🟡";

return {
  summary: parsed.summary || "",
  sentiment: parsed.sentiment || "neutral",
  sentimentEmoji,
  objections: parsed.objections || "None identified",
  competitors: parsed.competitors || "None mentioned",
  pricing: parsed.pricing || "Not discussed",
  nextSteps: parsed.next_steps || "None identified",
  nextStepDate: parsed.next_step_date || ""
};
