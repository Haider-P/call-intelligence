/**
 * ZAPIER STEP 3 — Format HubSpot Note
 * ------------------------------------
 * Type: Zapier Code step (JavaScript)
 *
 * Required Zapier fields mapped from Steps 1 + 2:
 *   - inputData.callDate         → ISO date string
 *   - inputData.duration         → e.g. "14m 22s"
 *   - inputData.participants     → e.g. "Matt Shubert, Keith Kilpatrick"
 *   - inputData.sentimentEmoji   → 🟢 / 🟡 / 🔴
 *   - inputData.sentiment        → positive / neutral / at-risk
 *   - inputData.summary          → 2-3 sentence summary
 *   - inputData.objections       → extracted objections
 *   - inputData.competitors      → extracted competitors
 *   - inputData.pricing          → extracted pricing info
 *   - inputData.nextSteps        → extracted next steps
 *   - inputData.recordingUrl     → Apollo recording link
 *   - inputData.transcript       → full transcript text
 */

// Format date nicely
const rawDate = inputData.callDate || new Date().toISOString();
const callDate = new Date(rawDate).toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric"
});

const note = `📞 Call Summary — ${callDate}
Duration: ${inputData.duration || "Unknown"} | Sentiment: ${inputData.sentimentEmoji} ${inputData.sentiment}
Participants: ${inputData.participants || "Unknown"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Summary:
${inputData.summary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Key Signals:
• Objections: ${inputData.objections}
• Competitors: ${inputData.competitors}
• Pricing: ${inputData.pricing}
• Next Steps: ${inputData.nextSteps}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎙 Recording: ${inputData.recordingUrl || "Not available"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Full Transcript:
${inputData.transcript}`;

return {
  formattedNote: note
};
