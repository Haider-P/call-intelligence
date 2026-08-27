/**
 * Plain-Node test for 01-filter-partner-calls.js — no test framework/dependency added
 * (this repo has no package.json / test runner). Run with:
 *
 *   node zapier-v2-steps/tests/01-filter-partner-calls.test.js
 *
 * The step file is written as a Zapier "Code by Zapier" script (top-level await, a
 * bare `output = ...` assignment, no module.exports) — it isn't `require()`-able as a
 * normal CommonJS module. This harness instead runs the real source text unmodified
 * inside a vm context with a mocked `fetch` + `process.env.APOLLO_API_KEY`, then reads
 * back the `output` global the script sets. This exercises the actual matching logic
 * end-to-end (searchApolloConversations -> matchPartnerFromTopic -> output), not a
 * reimplementation of it.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "01-filter-partner-calls.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

async function runFilterStep(mockConversations) {
  const sandbox = {
    process: { env: { APOLLO_API_KEY: "test-key" } },
    console,
    Date,
    Math,
    JSON,
    fetch: async () => ({
      ok: true,
      json: async () => ({ conversations: mockConversations })
    })
  };
  vm.createContext(sandbox);
  // Wrap in an async IIFE so the script's top-level `await` is legal; assignment to
  // the undeclared `output` leaks onto the sandbox global in sloppy mode, same as it
  // would in Zapier's own runtime.
  const wrapped = `(async () => {\n${source}\n})()`;
  await vm.runInContext(wrapped, sandbox, { filename: SOURCE_PATH });
  return sandbox.output;
}

async function main() {
  // Real production topic with the confirmed "Patnership" typo (missing the "r").
  // Under the old exact-substring match this silently failed to match and the call
  // was never processed. It must now match ZoomInfo.
  {
    const output = await runFilterStep([
      { id: "conv_1", topic: "ZoomInfo/Markaaz Patnership", start_time: "2026-08-27T10:00:00Z" }
    ]);
    assert.strictEqual(output.candidateCalls.length, 1, "typo'd topic should produce exactly one candidate call");
    assert.strictEqual(output.candidateCalls[0].partner, "ZoomInfo", "typo'd topic should match the ZoomInfo partner");
    assert.strictEqual(output.unlistedPartnerFlags.length, 0, "typo'd topic should not also land in unlistedPartnerFlags");
    console.log("PASS: 'ZoomInfo/Markaaz Patnership' now matches ZoomInfo");
  }

  // Genuinely unrelated topic — must NOT match, confirming the fuzzy tolerance didn't
  // introduce false positives.
  {
    const output = await runFilterStep([
      { id: "conv_2", topic: "Weekly Team Standup", start_time: "2026-08-27T11:00:00Z" }
    ]);
    assert.strictEqual(output.candidateCalls.length, 0, "unrelated topic must not match any partner");
    assert.strictEqual(output.unlistedPartnerFlags.length, 0, "unrelated topic must not even be flagged as unlisted (no 'markaaz')");
    assert.strictEqual(output.skippedCount, 1, "unrelated topic should be counted as skipped");
    console.log("PASS: 'Weekly Team Standup' correctly does not match");
  }

  // Sanity check: the original exact-match case (no typo) must still work unchanged.
  {
    const output = await runFilterStep([
      { id: "conv_3", topic: "Socure/Markaaz Partnership ", start_time: "2026-08-27T12:00:00Z" }
    ]);
    assert.strictEqual(output.candidateCalls.length, 1, "clean exact-match topic should still match");
    assert.strictEqual(output.candidateCalls[0].partner, "Socure");
    console.log("PASS: exact-match 'Socure/Markaaz Partnership' still matches (no regression)");
  }

  // A topic with "markaaz" but no real sync-keyword relation (not even a 1-edit typo)
  // must still fall to unlistedPartnerFlags, not candidateCalls — confirms the fuzzy
  // check isn't so loose it manufactures a keyword match out of nothing.
  {
    const output = await runFilterStep([
      { id: "conv_4", topic: "Markaaz internal roadmap review", start_time: "2026-08-27T13:00:00Z" }
    ]);
    assert.strictEqual(output.candidateCalls.length, 0, "topic with 'markaaz' but no sync keyword must not match a partner");
    assert.strictEqual(output.unlistedPartnerFlags.length, 1, "should still be flagged as an unlisted-partner candidate for human review");
    console.log("PASS: 'Markaaz internal roadmap review' correctly falls to unlistedPartnerFlags, not candidateCalls");
  }

  console.log("\nAll tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
