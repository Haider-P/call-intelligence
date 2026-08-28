/**
 * Plain-Node test for 04-match-and-write-companies.js — same harness pattern as the
 * other tests in this folder (no test framework/dependency added). Run with:
 *
 *   node zapier-v2-steps/tests/04-match-and-write-companies.test.js
 *
 * Runs the real source text unmodified inside a vm context with a mocked `fetch`,
 * `inputData`, a mocked `setTimeout` (see fakeSetTimeout below — no test in this file
 * ever waits any real wall-clock time, including the batch-throttling tests), and
 * (only for the timeout scenario) a controllable `Date.now()`, then reads back the
 * `output` global the script sets, plus `delayCalls` and `searchWaveLog` for asserting
 * on Phase 1's batch-throttling behavior.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SOURCE_PATH = path.join(__dirname, "..", "04-match-and-write-companies.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

// Simulated HubSpot deal roster. "Socure - Paymitto" exercises the alias path
// ("PayMeadow"/"Pay Meadow" -> "Paymitto"); "Socure - US Bank" (note: NO periods —
// this is the real HubSpot deal name; the enrichment step extracts the punctuated
// "U.S. Bank" from the transcript) exercises the fuzzy normalize()-based path.
const HUBSPOT_DEALS = [
  { id: "d1", properties: { dealname: "Socure - Paymitto" } },
  { id: "d2", properties: { dealname: "Socure - US Bank" } },
  { id: "d3", properties: { dealname: "Socure - SentimentTestCo" } },
  // The 4 aliases confirmed 2026-08-29 — see COMPANY_NAME_ALIASES in the source file.
  { id: "n1", properties: { dealname: "Socure - OpenFx" } },
  { id: "n2", properties: { dealname: "Socure - Polymarket" } },
  { id: "n3", properties: { dealname: "Socure - WeBull" } },
  { id: "n4", properties: { dealname: "Socure - Partos" } },
  // Confirmed 2026-08-29 via direct lookup — distinct from n4 above: "Paros"
  // (transcript drops the "t") -> "Partos", vs. "Partos" (transcript drops "AI")
  // -> "Partos AI". Two separate real companies, two separate alias keys.
  { id: "n5", properties: { dealname: "Socure - Partos AI" } }
];

// Case-insensitive substring match — deliberately does NOT strip punctuation, unlike
// an earlier version of this mock. Real HubSpot search relevance can be sensitive to
// literal punctuation (that's the root cause a live "U.S. Bank" -> "US Bank" match
// failure traced back to — see matchCompanyDeal()'s 2026-08-29 comment). Because this
// mock doesn't paper over punctuation differences itself, a test only passes if the
// SOURCE CODE already normalized the query before sending it — making this mock an
// actual regression guard for that fix, not an accidentally-lenient stand-in for it.
function mockSearchKey(s) {
  return s.toLowerCase();
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

// Fakes the batch-throttling delay: records the requested ms (so tests can assert on
// SEARCH_BATCH_DELAY_MS without knowing the constant's value ahead of time) and
// bumps `currentWave` so fetch calls made after this point are attributed to the next
// batch — but resolves on a microtask instead of a real timer, so no test ever
// actually waits.
function makeFakeSetTimeout(delayCalls, bumpWave) {
  return function fakeSetTimeout(fn, ms) {
    delayCalls.push(ms);
    bumpWave();
    Promise.resolve().then(fn);
    return 0;
  };
}

async function runStep(inputDataFields, { dateNowSequence } = {}) {
  const delayCalls = [];
  const searchWaveLog = []; // { query, wave } — one entry per HubSpot search call
  const patchLog = []; // { dealId, properties } — one entry per deal PATCH call
  let currentWave = 0;

  function fetchWithTracking(url, opts) {
    if (url.includes("/deals/search") && opts.method === "POST") {
      const body = JSON.parse(opts.body);
      searchWaveLog.push({ query: body.query, wave: currentWave });
    }
    if (url.includes("/deals/") && !url.includes("/deals/search") && opts.method === "PATCH") {
      const dealId = url.split("/deals/")[1];
      const body = JSON.parse(opts.body);
      patchLog.push({ dealId, properties: body.properties });
    }
    return mockFetch(url, opts);
  }

  const sandbox = {
    process: { env: { HUBSPOT_ACCESS_TOKEN: "test-token" } },
    inputData: inputDataFields,
    console,
    fetch: fetchWithTracking,
    setTimeout: makeFakeSetTimeout(delayCalls, () => {
      currentWave++;
    }),
    Date: dateNowSequence ? makeControllableDate(dateNowSequence) : Date
  };
  vm.createContext(sandbox);
  const wrapped = `(async () => {\n${source}\n})()`;
  await vm.runInContext(wrapped, sandbox, { filename: SOURCE_PATH });
  return { output: sandbox.output, delayCalls, searchWaveLog, patchLog };
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
  // Primary path: companiesJson (a JSON string), NOT the companies array directly —
  // this is how Step 3 actually feeds Step 4 in the live Zap, since Zapier's "Step
  // Output {...}" picker can't be mapped to just the nested array (see
  // resolveCompanies() in the source file).
  {
    const companies = [
      company("PayMeadow"), // alias -> Paymitto
      company("U.S. Bank"), // fuzzy (normalize()) -> real deal "US Bank" (no periods)
      company("Totally Unknown Company Inc") // no match
    ];
    const { output, delayCalls } = await runStep({
      companiesJson: JSON.stringify(companies),
      partner: "Socure",
      startTime: "2026-08-28T10:00:00Z"
    });

    assert.strictEqual(output.results.length, 3);
    assert.strictEqual(output.companiesProcessed, 3);
    assert.strictEqual(output.companiesMatched, 2, "PayMeadow and U.S. Bank should both match");
    assert.strictEqual(output.companiesNoMatch, 1);
    assert.strictEqual(output.companiesSkippedTimeout, 0);
    assert.strictEqual(output.companiesErrored, 0);
    assert.strictEqual(delayCalls.length, 0, "3 companies fit in a single batch (SEARCH_BATCH_SIZE=3) — no throttling delay needed");

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

    console.log("PASS: multiple companies (alias match + fuzzy match + no-match) processed correctly via companiesJson (primary path)");
  }

  // Time-budget-exceeded: force the soft-budget check to trip after the first
  // company, confirming remaining companies are cleanly labeled skipped-timeout
  // rather than crashing or being silently dropped. Also uses companiesJson, same as
  // the live wiring.
  {
    const companies = [company("PayMeadow"), company("US Bank"), company("Totally Unknown Company Inc")];
    // 1st Date.now() call = startedAt (0). 2nd call = the budget check before company
    // 0 (small elapsed, proceeds). 3rd call = the budget check before company 1
    // (elapsed now reads past the 25000ms budget, so the loop stops there).
    const { output } = await runStep(
      { companiesJson: JSON.stringify(companies), partner: "Socure", startTime: "2026-08-28T10:00:00Z" },
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

  // Fallback path: inputData.companies as a genuine array, no companiesJson at all.
  // Secondary/testability path only — not how the live Zap wiring works — but must
  // still function so this file stays directly testable without JSON round-tripping.
  {
    const companies = [company("PayMeadow")];
    const { output } = await runStep({ companies, partner: "Socure", startTime: "2026-08-28T10:00:00Z" });

    assert.strictEqual(output.results.length, 1);
    assert.strictEqual(output.results[0].status, "written");
    assert.strictEqual(output.companiesMatched, 1);

    console.log("PASS: fallback to inputData.companies (genuine array) works when companiesJson is absent");
  }

  // Whitespace-insensitive alias lookup (added 2026-08-29 after a live "Pay Meadow"
  // — WITH a space — failed to match the existing "paymeadow" (no space) alias,
  // despite that alias already covering this exact real company). Root cause:
  // normalizeCompanyKey() only collapsed whitespace down to a single space rather
  // than stripping it entirely, so "Pay Meadow" normalized to "pay meadow" (one
  // space) — a different string from the stored "paymeadow" key. Both spacing
  // variants, run in the SAME call, must resolve to the exact same deal.
  {
    const companies = [company("PayMeadow"), company("Pay Meadow"), company("pay   meadow")];
    const { output } = await runStep({
      companiesJson: JSON.stringify(companies),
      partner: "Socure",
      startTime: "2026-08-28T10:00:00Z"
    });

    assert.strictEqual(output.companiesMatched, 3, "all 3 spacing variants of the same alias should match");
    for (const result of output.results) {
      assert.strictEqual(result.status, "written");
      assert.strictEqual(result.companyName, "Paymitto", "every spacing variant should resolve to the same aliased real name");
      assert.strictEqual(result.dealId, "d1", "every spacing variant should resolve to the exact same deal");
    }

    console.log("PASS: 'PayMeadow', 'Pay Meadow', and 'pay   meadow' all resolve to the same alias/deal regardless of spacing");
  }

  // The 4 newly confirmed aliases (2026-08-29), each written with a fully
  // whitespace-stripped key per the fixed normalizeCompanyKey() convention. Fuse
  // Finance was confirmed as a genuinely non-existent deal (correctly stays
  // unmatched, no alias/fix needed) — not added to the mock roster, and not
  // separately tested here beyond what the existing no-match tests already cover
  // generically.
  {
    const companies = [
      company("Open FX"), // alias key "openfx" -> "OpenFx"
      company("Poly Market"), // alias key "polymarket" -> "Polymarket"
      company("Weeble"), // alias key "weeble" -> "WeBull"
      company("Paros") // alias key "paros" -> "Partos"
    ];
    const { output } = await runStep({
      companiesJson: JSON.stringify(companies),
      partner: "Socure",
      startTime: "2026-08-28T10:00:00Z"
    });

    assert.strictEqual(output.companiesMatched, 4, "all 4 newly confirmed aliases should match");
    const [openFx, polyMarket, weeble, paros] = output.results;
    assert.strictEqual(openFx.companyName, "OpenFx");
    assert.strictEqual(openFx.dealId, "n1");
    assert.strictEqual(polyMarket.companyName, "Polymarket");
    assert.strictEqual(polyMarket.dealId, "n2");
    assert.strictEqual(weeble.companyName, "WeBull");
    assert.strictEqual(weeble.dealId, "n3");
    assert.strictEqual(paros.companyName, "Partos");
    assert.strictEqual(paros.dealId, "n4");

    console.log("PASS: all 4 newly confirmed aliases (Open FX, Poly Market, Weeble, Paros) match correctly");
  }

  // "Partos" -> "Partos AI" (confirmed 2026-08-29 via direct lookup). Distinct from
  // the "paros" -> "Partos" alias above -- two different real companies that both
  // happen to collide near the word "Partos", so this also confirms the two keys
  // ("paros" and "partos") don't cross-match each other.
  {
    const companies = [company("Partos")];
    const { output } = await runStep({
      companiesJson: JSON.stringify(companies),
      partner: "Socure",
      startTime: "2026-08-28T10:00:00Z"
    });

    assert.strictEqual(output.companiesMatched, 1);
    assert.strictEqual(output.results[0].companyName, "Partos AI", "alias-resolved name should be 'Partos AI', not 'Partos'");
    assert.strictEqual(output.results[0].dealId, "n5");

    console.log("PASS: 'Partos' resolves to 'Partos AI', distinct from the 'paros' -> 'Partos' alias");
  }

  // Dedicated regression test: "U.S. Bank" (transcribed, WITH periods) -> "US Bank"
  // (the real HubSpot deal name, no periods). Root cause (2026-08-29): normalize()
  // itself was never broken (normalize("U.S. Bank") === normalize("US Bank")
  // already) -- the bug was that the RAW punctuated name was sent as the HubSpot
  // search query, so a punctuation-sensitive search could return zero candidates
  // before normalize()'s comparison ever got a chance to run. This mock's
  // mockSearchKey() deliberately does NOT strip punctuation itself (see its own
  // comment above), so this test only passes if matchCompanyDeal() actually
  // normalizes the query before searching -- a real regression guard, not
  // window-dressing.
  {
    const companies = [company("U.S. Bank")];
    const { output, searchWaveLog } = await runStep({
      companiesJson: JSON.stringify(companies),
      partner: "Socure",
      startTime: "2026-08-28T10:00:00Z"
    });

    assert.strictEqual(output.companiesMatched, 1, "'U.S. Bank' should match the real 'US Bank' deal despite the punctuation difference");
    assert.strictEqual(output.results[0].dealId, "d2");

    assert.strictEqual(searchWaveLog.length, 1);
    assert.strictEqual(
      searchWaveLog[0].query,
      "us bank",
      "the outbound HubSpot search query must already be normalized (lowercased, periods stripped) before it's sent, not the raw 'U.S. Bank'"
    );

    console.log("PASS: 'U.S. Bank' matches the real 'US Bank' deal via a normalized search query, not just a normalized post-search comparison");
  }

  // The exact real-world bug this change fixes: Zapier's "Step Output {...}" picker
  // mapped to a downstream field inserts the WHOLE upstream step's output object,
  // stringified — not just the nested companies array. Simulate that literally:
  // companiesJson holds the entire Step 3 output object as a JSON string, not just
  // the array. JSON.parse() succeeds, but the result isn't an array, so it must NOT
  // be silently accepted — it should fall through to the (here, also missing)
  // companies fallback and throw the clear, diagnosable error.
  {
    const wholeStepOutputMistakenlyMapped = JSON.stringify({
      companies: [company("PayMeadow")],
      companiesJson: JSON.stringify([company("PayMeadow")]),
      partner: "Socure",
      startTime: "2026-08-28T10:00:00Z",
      companyCount: 1
    });

    await assert.rejects(
      () => runStep({ companiesJson: wholeStepOutputMistakenlyMapped, partner: "Socure", startTime: "2026-08-28T10:00:00Z" }),
      (err) =>
        err.message.includes("No companies array found") &&
        err.message.includes("companiesJson") &&
        err.message.includes("companies"),
      "mapping the whole stringified Step 3 output into companiesJson should throw a clear, diagnosable error, not silently misbehave"
    );

    console.log("PASS: the whole-step-output-stringified-into-companiesJson mistake throws a clear error instead of silently misbehaving");
  }

  // Neither companiesJson nor companies present at all.
  {
    await assert.rejects(
      () => runStep({ partner: "Socure", startTime: "2026-08-28T10:00:00Z" }),
      (err) => err.message.includes("No companies array found") && err.message.includes("companiesJson") && err.message.includes("companies"),
      "missing both fields should throw a clear error naming both fields checked"
    );

    console.log("PASS: missing companiesJson and companies throws a clear error naming both fields checked");
  }

  // companiesJson present but malformed JSON — should throw a clear parse error, not
  // an opaque native SyntaxError with no context about which field caused it.
  {
    await assert.rejects(
      () => runStep({ companiesJson: "{not valid json", partner: "Socure", startTime: "2026-08-28T10:00:00Z" }),
      (err) => err.message.includes("companiesJson") && err.message.includes("could not be parsed"),
      "malformed companiesJson should throw a clear parse error naming the field"
    );

    console.log("PASS: malformed companiesJson throws a clear, field-specific parse error");
  }

  // Sentiment casing mapping (added 2026-08-28 after a live run got HubSpot 400
  // INVALID_OPTION errors: last_call_sentiment's dropdown options are capitalized
  // ("Positive"/"Neutral"/"At-Risk"), but the enrichment step's sentiment values are
  // lowercase). All 3 known values must map correctly, and an unrecognized value must
  // default to "Neutral" and be flagged in the result's `reason`, not fail the write.
  {
    const companies = [
      company("SentimentTestCo", { sentiment: "positive" }),
      company("SentimentTestCo", { sentiment: "neutral" }),
      company("SentimentTestCo", { sentiment: "at-risk" }),
      company("SentimentTestCo", { sentiment: "somethingUnexpected" })
    ];
    const { output, patchLog } = await runStep({
      companiesJson: JSON.stringify(companies),
      partner: "Socure",
      startTime: "2026-08-28T10:00:00Z"
    });

    assert.strictEqual(output.companiesMatched, 4, "all 4 should still match and write successfully");
    assert.strictEqual(patchLog.length, 4);

    assert.strictEqual(patchLog[0].properties.last_call_sentiment, "Positive");
    assert.strictEqual(patchLog[1].properties.last_call_sentiment, "Neutral");
    assert.strictEqual(patchLog[2].properties.last_call_sentiment, "At-Risk");
    assert.strictEqual(
      patchLog[3].properties.last_call_sentiment,
      "Neutral",
      "an unrecognized sentiment value should default to Neutral rather than being sent as-is"
    );

    const [r1, r2, r3, r4] = output.results;
    assert.strictEqual(r1.status, "written");
    assert.strictEqual(r1.reason, null, "a known sentiment value should not flag a reason");
    assert.strictEqual(r2.status, "written");
    assert.strictEqual(r2.reason, null);
    assert.strictEqual(r3.status, "written");
    assert.strictEqual(r3.reason, null);

    assert.strictEqual(r4.status, "written", "an unrecognized sentiment should still be a successful write, not an error");
    assert.ok(
      r4.reason &&
        r4.reason.includes("somethingUnexpected") &&
        r4.reason.includes("Neutral"),
      "the fallback should be visibly flagged in the result's reason, naming both the bad value and what it defaulted to"
    );

    console.log("PASS: sentiment values map to HubSpot's capitalized dropdown options, with a visible fallback for unrecognized values");
  }

  // Batch throttling (added 2026-08-28 after a live dry run got 429'd firing all
  // searches for a 14-company call at once via an unthrottled Promise.all — see
  // SEARCH_BATCH_SIZE/SEARCH_BATCH_DELAY_MS in the source file). 7 companies with
  // SEARCH_BATCH_SIZE=3 should split into batches of [3, 3, 1] with a delay between
  // each of the first two batches (none after the last, since there's nothing left
  // to throttle).
  {
    const companies = [
      company("Company A"),
      company("Company B"),
      company("Company C"),
      company("Company D"),
      company("Company E"),
      company("Company F"),
      company("Company G")
    ];
    const { output, delayCalls, searchWaveLog } = await runStep({
      companiesJson: JSON.stringify(companies),
      partner: "Socure",
      startTime: "2026-08-28T10:00:00Z"
    });

    // All 7 are unknown companies (not in HUBSPOT_DEALS) -- correctness of matching
    // isn't the point here, batching timing is; still confirm nothing was dropped.
    assert.strictEqual(output.results.length, 7);
    assert.strictEqual(output.companiesProcessed, 7);
    assert.strictEqual(output.companiesNoMatch, 7);

    assert.strictEqual(delayCalls.length, 2, "3 batches (of 3, 3, 1) means exactly 2 between-batch delays");
    assert.deepStrictEqual(
      Array.from(delayCalls),
      [1000, 1000],
      "each delay should be SEARCH_BATCH_DELAY_MS (1000ms), not shortened for the smaller final batch"
    );

    // Confirm the searches actually landed in 3 waves of sizes [3, 3, 1], not just
    // that 2 delays happened somewhere unrelated.
    const waveSizes = [0, 1, 2].map((wave) => searchWaveLog.filter((entry) => entry.wave === wave).length);
    assert.deepStrictEqual(Array.from(waveSizes), [3, 3, 1], "searches should batch into groups of [3, 3, 1], not fire all at once or one at a time");

    console.log("PASS: 7 companies throttle into 3 batches of [3, 3, 1] with a 1000ms delay between each");
  }

  console.log("\nAll tests passed.");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
