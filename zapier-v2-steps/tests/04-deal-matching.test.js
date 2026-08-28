/**
 * Plain-Node test for 04-deal-matching.js — same harness pattern as
 * 01-filter-partner-calls.test.js (no test framework/dependency added; this repo has
 * no package.json / test runner). Run with:
 *
 *   node zapier-v2-steps/tests/04-deal-matching.test.js
 *
 * Runs the real source text unmodified inside a vm context with a mocked `fetch` and
 * `inputData`, then reads back the `output` global the script sets. Exercises the
 * actual COMPANY_NAME_ALIASES + normalize() matching logic end-to-end, not a
 * reimplementation of it.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "04-deal-matching.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

// Simulated HubSpot deal roster — real dealnames, exactly as they'd appear in HubSpot
// (i.e. the ALIAS target, not the mangled Claude-transcribed name).
const HUBSPOT_DEALS = [
  { id: "d1", properties: { dealname: "Socure - Paymitto" } },
  { id: "d2", properties: { dealname: "Socure - Velera" } },
  { id: "d3", properties: { dealname: "Socure - Greensky" } },
  { id: "d4", properties: { dealname: "Socure - Anthropic" } }
];

function mockFetch(url, opts) {
  const body = JSON.parse(opts.body);
  const q = body.query.toLowerCase();
  // Rough stand-in for HubSpot's free-text search: substring match on dealname.
  const results = HUBSPOT_DEALS.filter((d) => d.properties.dealname.toLowerCase().includes(q));
  return Promise.resolve({
    ok: true,
    json: async () => ({ results })
  });
}

async function runDealMatchingStep(inputDataFields) {
  const sandbox = {
    process: { env: { HUBSPOT_ACCESS_TOKEN: "test-token" } },
    inputData: inputDataFields,
    console,
    fetch: mockFetch
  };
  vm.createContext(sandbox);
  const wrapped = `(async () => {\n${source}\n})()`;
  await vm.runInContext(wrapped, sandbox, { filename: SOURCE_PATH });
  return sandbox.output;
}

async function main() {
  // Alias case 1: "PayMeadow" (transcribed) -> "Paymitto" (real deal/company name).
  {
    const output = await runDealMatchingStep({ companyName: "PayMeadow", partner: "Socure" });
    assert.strictEqual(output.matched, true, "'PayMeadow' should match via COMPANY_NAME_ALIASES");
    assert.strictEqual(output.dealId, "d1");
    assert.strictEqual(output.companyName, "Paymitto", "resolved companyName should be the aliased real name");
    assert.strictEqual(output.reason, null);
    console.log("PASS: 'PayMeadow' matches 'Paymitto' via alias map");
  }

  // Alias case 2: "Valera" -> "Velera".
  {
    const output = await runDealMatchingStep({ companyName: "Valera", partner: "Socure" });
    assert.strictEqual(output.matched, true, "'Valera' should match via COMPANY_NAME_ALIASES");
    assert.strictEqual(output.dealId, "d2");
    assert.strictEqual(output.companyName, "Velera");
    console.log("PASS: 'Valera' matches 'Velera' via alias map");
  }

  // Alias case 3: "Green Sky" (two words) -> "Greensky" (one word) — also confirms
  // the alias lookup is case/spacing-insensitive per normalizeCompanyKey().
  {
    const output = await runDealMatchingStep({ companyName: "Green Sky", partner: "Socure" });
    assert.strictEqual(output.matched, true, "'Green Sky' should match via COMPANY_NAME_ALIASES");
    assert.strictEqual(output.dealId, "d3");
    assert.strictEqual(output.companyName, "Greensky");
    console.log("PASS: 'Green Sky' matches 'Greensky' via alias map");
  }

  // Case-insensitive / whitespace-insensitive alias lookup: same "Green Sky" pair,
  // but written with different case and extra spacing.
  {
    const output = await runDealMatchingStep({ companyName: "  green   sky ", partner: "Socure" });
    assert.strictEqual(output.matched, true, "alias lookup should be case/whitespace-insensitive");
    assert.strictEqual(output.companyName, "Greensky");
    console.log("PASS: alias lookup tolerates case and extra whitespace");
  }

  // No regression: existing normalize()-based fuzzy tolerance (punctuation/case) must
  // still work for a company with no alias entry.
  {
    const output = await runDealMatchingStep({ companyName: "Anthropic", partner: "Socure" });
    assert.strictEqual(output.matched, true, "non-aliased exact-ish company should still match via normalize()");
    assert.strictEqual(output.dealId, "d4");
    console.log("PASS: non-aliased company still matches via existing normalize() tolerance (no regression)");
  }

  // Genuinely unknown company — no alias, no fuzzy match — must fall through to
  // "no matching deal found" with the new transcription-mismatch flag, and must NOT
  // false-positive match an unrelated deal.
  {
    const output = await runDealMatchingStep({ companyName: "Totally Unknown Company Inc", partner: "Socure" });
    assert.strictEqual(output.matched, false, "unknown company must not match any deal");
    assert.strictEqual(output.dealId, null);
    assert.ok(
      output.reason && output.reason.includes("possible transcription mismatch") && output.reason.includes("COMPANY_NAME_ALIASES"),
      "unmatched reason should flag a possible transcription mismatch pointing at COMPANY_NAME_ALIASES"
    );
    console.log("PASS: unknown company correctly falls through to no-match with transcription-mismatch flag");
  }

  console.log("\nAll tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
