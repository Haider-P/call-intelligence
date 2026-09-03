/**
 * Plain-Node test for 02-fetch-transcript.js — same harness pattern as
 * 01-filter-partner-calls.test.js (no test framework/dependency added). Run with:
 *
 *   node zapier-v2-steps/tests/02-fetch-transcript.test.js
 *
 * The step file is written as a Zapier "Code by Zapier" script (top-level await, a
 * bare `output = ...` assignment, no module.exports) — it isn't `require()`-able as a
 * normal CommonJS module. This harness instead runs the real source text unmodified
 * inside a vm context with a mocked `fetch`, `process.env.APOLLO_API_KEY`, and
 * `inputData`, then reads back the `output` global the script sets (or lets a thrown
 * error propagate, for the still-should-throw cases).
 *
 * Covers the 2026-09-03 race-condition fix: Apollo takes 30-40 min after a call ends
 * to finish processing it, so a conversation fetched before then must come back as an
 * explicit "not ready" result, not an error — see 02-fetch-transcript.js's header
 * comment (READINESS CHECK section) for how the "insights_generated" ready state was
 * confirmed against real production data.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "02-fetch-transcript.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

async function runFetchTranscriptStep(inputData, mockResponse) {
  const sandbox = {
    process: { env: { APOLLO_API_KEY: "test-key" } },
    console,
    JSON,
    inputData,
    fetch: async () => mockResponse
  };
  vm.createContext(sandbox);
  // Wrap in an async IIFE so the script's top-level `await` is legal; assignment to
  // the undeclared `output` leaks onto the sandbox global in sloppy mode, same as it
  // would in Zapier's own runtime. A thrown error propagates out of this await, same
  // as it would abort a real Zap step.
  const wrapped = `(async () => {\n${source}\n})()`;
  await vm.runInContext(wrapped, sandbox, { filename: SOURCE_PATH });
  return sandbox.output;
}

async function main() {
  // Conversation state indicates the call is still processing (one of the four known
  // pre-ready enum values). Must return transcriptReady: false and NOT throw — this is
  // the core race-condition fix: Step 1 can surface a call as a candidate well before
  // Apollo has finished generating its transcript/insights.
  {
    const mockResponse = {
      ok: true,
      json: async () => ({ state: "processed", transcript: null })
    };
    const output = await runFetchTranscriptStep(
      {
        conversationId: "conv_processing",
        partner: "Socure",
        topic: "Socure/Markaaz Partnership",
        startTime: "2026-09-03T14:00:00Z"
      },
      mockResponse
    );
    assert.strictEqual(output.transcriptReady, false, "state 'processed' must report transcriptReady: false");
    assert.strictEqual(output.conversationId, "conv_processing");
    assert.strictEqual(output.partner, "Socure");
    assert.strictEqual(output.topic, "Socure/Markaaz Partnership");
    assert.strictEqual(output.startTime, "2026-09-03T14:00:00Z");
    assert.strictEqual(output.reason, "transcript not yet generated");
    assert.strictEqual(output.transcriptText, undefined, "not-ready output must not carry a transcriptText field");
    console.log("PASS: state 'processed' (still processing) returns transcriptReady: false, does not throw");
  }

  // Conversation state is the confirmed-ready value — transcript must be returned as
  // before, plus the new transcriptReady: true flag.
  {
    const mockResponse = {
      ok: true,
      json: async () => ({
        state: "insights_generated",
        transcript: "GREG BANY: I know."
      })
    };
    const output = await runFetchTranscriptStep(
      {
        conversationId: "conv_ready",
        partner: "ZoomInfo",
        topic: "ZoomInfo/Markaaz Patnership",
        startTime: "2026-09-02T20:29:52Z"
      },
      mockResponse
    );
    assert.strictEqual(output.transcriptReady, true, "state 'insights_generated' must report transcriptReady: true");
    assert.strictEqual(output.transcriptText, "GREG BANY: I know.");
    assert.strictEqual(output.conversationId, "conv_ready");
    assert.strictEqual(output.partner, "ZoomInfo");
    assert.strictEqual(output.reason, undefined, "ready output must not carry a 'reason' field");
    console.log("PASS: state 'insights_generated' (ready) returns transcriptText as before, plus transcriptReady: true");
  }

  // A genuine Apollo API failure (non-OK HTTP response) must still throw — only the
  // "not ready yet" case became a non-error outcome, not every failure mode.
  {
    const mockResponse = {
      ok: false,
      status: 500,
      text: async () => "Internal Server Error"
    };
    let threw = false;
    try {
      await runFetchTranscriptStep(
        { conversationId: "conv_apifail", partner: "Socure", topic: "x", startTime: "y" },
        mockResponse
      );
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("conv_apifail"), "thrown error should name the conversation ID");
      assert.ok(err.message.includes("500"), "thrown error should carry the HTTP status");
    }
    assert.ok(threw, "a genuine Apollo API failure (500) must still throw, not be treated as not-ready");
    console.log("PASS: genuine Apollo API failure (500) still throws, unaffected by the readiness fix");
  }

  // Sanity check: a ready conversation with an unrecognized transcript shape must
  // still throw too — the readiness check only short-circuits the not-ready case, it
  // doesn't loosen the existing transcript-shape error handling.
  {
    const mockResponse = {
      ok: true,
      json: async () => ({ state: "insights_generated", transcript: 12345 })
    };
    let threw = false;
    try {
      await runFetchTranscriptStep(
        { conversationId: "conv_badshape", partner: "Socure", topic: "x", startTime: "y" },
        mockResponse
      );
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("conv_badshape"), "thrown error should name the conversation ID");
    }
    assert.ok(threw, "an unrecognized transcript shape on a READY conversation must still throw");
    console.log("PASS: unrecognized transcript shape on a ready conversation still throws (unchanged)");
  }

  console.log("\nAll tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
