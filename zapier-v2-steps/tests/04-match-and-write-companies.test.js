/**
 * Plain-Node test for 04-match-and-write-companies.js — same harness pattern as the
 * other tests in this folder (no test framework/dependency added). Run with:
 *
 *   node zapier-v2-steps/tests/04-match-and-write-companies.test.js
 *
 * Runs the real source text unmodified inside a vm context with a mocked `fetch`,
 * `inputData`, and (only for the timeout scenario) a controllable `Date.now()`, then
 * reads back the `output` global the script sets.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "04-match-and-write-companies.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

// Simulated HubSpot deal roster. "Socure - Paymitto" exercises the alias path
// ("PayMeadow" -> "Paymitto"); "Socure - U.S. Bank" exercises the pre-existing
// normalize()-based fuzzy path (extracted as "US Bank", no alias needed).
const HUBSPOT_DEALS = [
  { id: "d1", properties: { dealname: "Socure - Paymitto" } },
  { id: "d2", properties: { dealname: "Socure - U.S. Bank" } }
];

// Loose substring match on alphanumeric-only text, standing in for HubSpot's real
// free-text search relevance (which isn't literal substring matching on the raw
// strings — e.g. it does find "U.S. Bank" for a "US Bank" query).
function mockSearchKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

let noteCounter = 0;

function mockFetch(url, opts) {
  if (url.includes("/deals/search") && opts.method === "POST") {
    const body = JSON.parse(opts.body);
    const q = mockSearchKey(body.query);
    const results = HUBSPOT_DEALS.filter((d) => mockSearchKey(d.properties.dealname).includes(q));
    return Promise.resolve({ ok: true, json: async () => ({ results }) });
  }
  if (url.includes("/deals/") && opts.method === "PATCH") {
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }
  if (url.includes("/notes") && opts.method === "POST") {
    noteCounter++;
    return Promise.resolve({ ok: true, json: async () => ({ id: `note-${noteCounter}` }) });
  }
  return Promise.reject(new Error(`Unexpected fetch call in test mock: ${opts.method} ${url}`));
}

// A Date subclass whose static now() returns a pre-scripted sequence instead of the
// real clock — lets the timeout test force the soft-budget check to trip without
// actually waiting 25 real seconds. `new Date(...)` (used for callDate/callDateStr)
// is untouched — only the static `now()` used for the elapsed-time check is faked.
function makeControllableDate(nowSequence) {
  let callIndex = 0;
  class ControllableDate extends Date {
    static now() {
      const value = nowSequence[Math.min(callIndex, nowSequence.length - 1)];
      callIndex++;
      return value;
    }
  }
  return ControllableDate;
}

async function runStep(inputDataFields, { dateNowSequence } = {}) {
  const sandbox = {
    process: { env: { HUBSPOT_ACCESS_TOKEN: "test-token" } },
    inputData: inputDataFields,
    console,
    fetch: mockFetch,
    Date: dateNowSequence ? makeControllableDate(dateNowSequence) : Date
  };
  vm.createContext(sandbox);
  const wrapped = `(async () => {\n${source}\n})()`;
  await vm.runInContext(wrapped, sandbox, { filename: SOURCE_PATH });
  return sandbox.output;
}

function company(companyName, overrides = {}) {
  return {
    companyName,
    sentiment: "neutral",
    nextStep: "None identified",
    unresolvedObjections: "None",
    rawSummary: `Summary for ${companyName}`,
    ...overrides
  };
}

async function main() {
  // Multiple companies in one call: alias match, fuzzy match, no-match, all together.
  {
    const companies = [
      company("PayMeadow"), // alias -> Paymitto
      company("US Bank"), // fuzzy (normalize()) -> "U.S. Bank"
      company("Totally Unknown Company Inc") // no match
    ];
    const output = await runStep({ companies, partner: "Socure", startTime: "2026-08-28T10:00:00Z" });

    assert.strictEqual(output.results.length, 3);
    assert.strictEqual(output.companiesProcessed, 3);
    assert.strictEqual(output.companiesMatched, 2, "PayMeadow and US Bank should both match");
    assert.strictEqual(output.companiesNoMatch, 1);
    assert.strictEqual(output.companiesSkippedTimeout, 0);
    assert.strictEqual(output.companiesErrored, 0);

    const [r1, r2, r3] = output.results;
    assert.strictEqual(r1.status, "written");
    assert.strictEqual(r1.companyName, "Paymitto", "alias-resolved name should be used");
    assert.strictEqual(r1.dealId, "d1");
    assert.ok(r1.noteId, "matched company should get a note written");
    // Array.from(...) copies out of the vm context's realm — deepStrictEqual on a
    // cross-realm array otherwise fails on prototype identity despite equal contents.
    assert.deepStrictEqual(Array.from(r1.updatedProperties).sort(), [
      "hs_next_step",
      "last_call_date",
      "last_call_sentiment",
      "last_call_unresolved_objections"
    ]);

    assert.strictEqual(r2.status, "written");
    assert.strictEqual(r2.dealId, "d2");

    assert.strictEqual(r3.status, "no-match");
    assert.strictEqual(r3.dealId, null);
    assert.ok(
      r3.reason.includes("possible transcription mismatch") && r3.reason.includes("COMPANY_NAME_ALIASES"),
      "no-match reason should flag possible transcription mismatch"
    );

    console.log("PASS: multiple companies (alias match + fuzzy match + no-match) processed correctly in one call");
  }

  // Time-budget-exceeded: force the soft-budget check to trip after the first
  // company, confirming remaining companies are cleanly labeled skipped-timeout
  // rather than crashing or being silently dropped.
  {
    const companies = [company("PayMeadow"), company("US Bank"), company("Totally Unknown Company Inc")];
    // 1st Date.now() call = startedAt (0). 2nd call = the budget check before company
    // 0 (small elapsed, proceeds). 3rd call = the budget check before company 1
    // (elapsed now reads past the 25000ms budget, so the loop stops there).
    const output = await runStep(
      { companies, partner: "Socure", startTime: "2026-08-28T10:00:00Z" },
      { dateNowSequence: [0, 1000, 30000] }
    );

    assert.strictEqual(output.results.length, 3);
    assert.strictEqual(output.companiesProcessed, 1, "only the first company should have been attempted");
    assert.strictEqual(output.companiesMatched, 1);
    assert.strictEqual(output.companiesSkippedTimeout, 2, "the remaining 2 companies should be skipped on timeout");

    assert.strictEqual(output.results[0].status, "written");
    assert.strictEqual(output.results[1].status, "skipped-timeout");
    assert.strictEqual(output.results[1].reason, "skipped — time budget exceeded, not attempted");
    assert.strictEqual(output.results[2].status, "skipped-timeout");
    assert.strictEqual(output.results[2].reason, "skipped — time budget exceeded, not attempted");
    assert.strictEqual(output.results[2].companyName, "Totally Unknown Company Inc", "skipped entries keep their real company name, not silently dropped");

    console.log("PASS: time-budget-exceeded scenario stops cleanly and labels skipped companies correctly");
  }

  console.log("\nAll tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
