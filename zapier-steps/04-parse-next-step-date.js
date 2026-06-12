/**
 * ZAPIER STEP 4 — Parse Next Step Date for HubSpot Date Picker
 * -------------------------------------------------------------
 * Type: Zapier Code step (JavaScript)
 *
 * HubSpot date picker properties require a Unix timestamp in milliseconds.
 * This step converts Claude's extracted date string (YYYY-MM-DD) to the
 * correct format for HubSpot.
 *
 * Required Zapier fields:
 *   - inputData.nextStepDate   → "YYYY-MM-DD" string or empty
 */

const nextStepDate = inputData.nextStepDate || "";

if (!nextStepDate) {
  // No date extracted — return empty so Zapier filter can skip the update
  return {
    hasNextStepDate: "false",
    nextStepDateMs: ""
  };
}

try {
  // Parse YYYY-MM-DD and convert to milliseconds for HubSpot
  // Use noon UTC to avoid off-by-one day in US timezones (UTC midnight = previous day locally)
  const date = new Date(nextStepDate + "T12:00:00.000Z");

  if (isNaN(date.getTime())) {
    return {
      hasNextStepDate: "false",
      nextStepDateMs: ""
    };
  }

  return {
    hasNextStepDate: "true",
    nextStepDateMs: date.getTime().toString()
  };
} catch (e) {
  return {
    hasNextStepDate: "false",
    nextStepDateMs: ""
  };
}
