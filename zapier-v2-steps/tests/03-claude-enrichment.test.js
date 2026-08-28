/**
 * Plain-Node test for 03-claude-enrichment.js — same harness pattern as the other
 * tests in this folder (no test framework/dependency added). Run with:
 *
 *   node zapier-v2-steps/tests/03-claude-enrichment.test.js
 *
 * Runs the real source text unmodified inside a vm context with a mocked `fetch`
 * (standing in for the Anthropic API) and `inputData`, then reads back the `output`
 * global the script sets.
 *
 * Focus of this test: the companiesJson output field (added 2026-08-28) that exists
 * specifically so Step 4 can map one unambiguous string field instead of Zapier's
 * "Step Output {...}" picker, which stringifies the whole output object rather than
 * just the nested companies array — see 04-match-and-write-companies.js's
 * resolveCompanies() and docs/zapier-v2-setup.md for the full explanation.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "03-claude-enrichment.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

const CLAUDE_COMPANIES = [
  {
    company_name: "Paymitto",
    sentiment: "positive",
    next_step: "CFO sign-off needed by end of month",
    unresolved_objections: "None",
    summary: "Discussed rollout timeline, on track."
  },
  {
    company_name: "Swipe Jobs",
    sentiment: "at-risk",
    next_step: "Reconcile contract figure before next call",
    unresolved_objections: "Quoted $11M but customer expects $300K",
    summary: "Contract-figure discrepancy needs resolving."
  }
];

function mockFetch(url, opts) {
  if (url.includes("api.anthropic.com/v1/messages") && opts.method === "POST") {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        content: [{ text: JSON.stringify(CLAUDE_COMPANIES) }]
      })
    });
  }
  return Promise.reject(new Error(`Unexpected fetch call in test mock: ${opts.method} ${url}`));
}

async function runStep(inputDataFields) {
  const sandbox = {
    process: { env: { ANTHROPIC_API_KEY: "test-key" } },
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
  const output = await runStep({
    transcriptText: "a full call transcript",
    partner: "Socure",
    topic: "Socure/Markaaz Partnership",
    startTime: "2026-08-28T10:00:00Z"
  });

  assert.strictEqual(output.companies.length, 2, "companies array should still be present, unchanged");
  assert.strictEqual(output.companyCount, 2);

  assert.strictEqual(typeof output.companiesJson, "string", "companiesJson should be a plain string, not an array/object");

  // Round-trip: parsing companiesJson must reproduce the same data as the companies
  // array field, so Step 4 gets identical data regardless of which field it reads.
  const parsedFromJson = JSON.parse(output.companiesJson);
  assert.strictEqual(parsedFromJson.length, 2);
  assert.strictEqual(parsedFromJson[0].companyName, "Paymitto");
  assert.strictEqual(parsedFromJson[1].companyName, "Swipe Jobs");
  assert.strictEqual(
    parsedFromJson[1].unresolvedObjections,
    "Quoted $11M but customer expects $300K",
    "specific extraction details (the Swipe Jobs contract-figure discrepancy) must survive the JSON round-trip"
  );

  // Array.from(...) copies output.companies out of the vm context's realm before
  // comparing — cross-realm objects otherwise fail deepStrictEqual on prototype
  // identity despite having equal contents.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(Array.from(output.companies))),
    parsedFromJson,
    "companiesJson must be an exact JSON representation of the companies array — same data via either field"
  );

  console.log("PASS: companiesJson is a JSON string matching the companies array exactly (primary Zapier-safe transport field)");
  console.log("\nAll tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
