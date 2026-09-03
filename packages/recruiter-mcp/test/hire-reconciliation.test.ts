import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyOfferCompensationPrivacy } from "../src/tools/hire-probes.js";
import { hireReconciliationSummary, reconciliationLine } from "../src/tools/hire-facts.js";
import { fakeScopedReader, scopedSuccess, testRuntime, type ScopedCall } from "./test-helpers.js";

const WINDOW = { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z", label: "Q2 2026" };
const SCOPE = { label: "all 45 reqs you can see in Greenhouse" };

// The fixture the brief names: the three counts DISAGREE, which is the whole reason the line exists.
// 10 accepted current offers; 8 of their applications carry status=hired; 11 closed openings, of
// which 8 close with a Hire reason, 2 close with no reason at all, and 1 closes on a reason id the
// close-reason dictionary does not resolve.
const ACCEPTED_OFFERS = Array.from({ length: 10 }, (_, index) => ({
  id: index + 1,
  job_id: 10,
  application_id: 100 + index,
  candidate_id: 1000 + index,
  opening_id: 500 + index,
  status: "Accepted",
  version: 1,
  sent_on: "2026-05-01",
  resolved_at: "2026-05-10T12:00:00.000Z",
}));

const HIRED_APPLICATION_IDS = new Set([100, 101, 102, 103, 104, 105, 106, 107]);

const CLOSED_OPENINGS = [
  ...Array.from({ length: 8 }, (_, index) => ({
    id: 500 + index,
    job_id: 10,
    application_id: 100 + index,
    open: false,
    closed_at: "2026-05-11T00:00:00.000Z",
    close_reason_id: 90,
  })),
  { id: 600, job_id: 10, application_id: 108, open: false, closed_at: "2026-05-12T00:00:00.000Z" },
  { id: 601, job_id: 10, application_id: 109, open: false, closed_at: "2026-05-12T00:00:00.000Z" },
  { id: 602, job_id: 10, application_id: 110, open: false, closed_at: "2026-05-13T00:00:00.000Z", close_reason_id: 9999 },
];

interface WithheldByTool {
  list_offers?: number;
  list_applications?: number;
  list_openings?: number;
}

function reconciliationReader(withheld: WithheldByTool = {}) {
  return fakeScopedReader((toolName, params) => {
    if (toolName === "list_offers") {
      return withPrivacy(toolName, ACCEPTED_OFFERS, withheld.list_offers ?? 0);
    }
    if (toolName === "list_applications") {
      const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
      const rows = ids.map((id) => ({ id, job_id: 10, status: HIRED_APPLICATION_IDS.has(id) ? "hired" : "in_process" }));
      return withPrivacy(toolName, rows, withheld.list_applications ?? 0);
    }
    if (toolName === "list_openings") {
      return withPrivacy(toolName, CLOSED_OPENINGS, withheld.list_openings ?? 0);
    }
    if (toolName === "list_close_reasons") {
      return scopedSuccess(toolName, [
        { id: 90, name: "Hire - Offer accepted" },
        { id: 91, name: "Not Filling - Budget" },
      ]);
    }
    throw new Error(`unexpected scoped tool ${toolName}`);
  });
}

function withPrivacy(toolName: string, rows: Array<Record<string, unknown>>, privacyWithheld: number) {
  return scopedSuccess(toolName, rows, null, {
    rowCounts: {
      raw: rows.length + privacyWithheld,
      returned: rows.length,
      permissionExcluded: privacyWithheld,
      unresolved: 0,
      status: "complete",
      ...(privacyWithheld > 0 ? { privacyWithheld } : {}),
    },
  });
}

function toolNames(calls: ScopedCall[]): string[] {
  return calls.map((call) => call.toolName);
}

// ---------------------------------------------------------------------------
// H2: three counts that disagree, each with its OWN clock and its OWN privacy
// regime. Summing the withheld figures across reads would invent a number no
// read produced, so the line never does it.
// ---------------------------------------------------------------------------
describe("H2 reconciliationLine — three counts, three clocks, three privacy regimes", () => {
  it("counts accepted offers, hired applications and hire-closed openings separately (attested actor)", async () => {
    const reader = reconciliationReader();
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, { includeOpenings: true });

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    const line = result.line;

    assert.equal(line.accepted_current_offers.value, 10);
    assert.equal(line.accepted_offer_applications_marked_hired.value, 8, "two accepted offers never had the hire endpoint fired");
    assert.equal(line.openings_closed_by_hire.value, 8);
    assert.equal(line.openings_closed_by_hire.closed_with_no_reason, 2);
    assert.equal(line.openings_closed_by_hire.closed_reason_unresolved, 1);

    // Each count states the clock it is dated on. They are different clocks, which is exactly why
    // the three numbers can be right and still disagree.
    assert.equal(line.accepted_current_offers.clock, "offers.resolved_at");
    assert.equal(line.accepted_offer_applications_marked_hired.clock, "applications.status (point-in-time, not dated)");
    assert.equal(line.openings_closed_by_hire.clock, "openings.closed_at");

    // Not asked for, so not read — and the line says so rather than reporting a zero.
    assert.equal(line.offer_rows_per_hire.not_read, true);
    assert.equal(line.offer_rows_per_hire.value, null);
    assert.equal(line.applications_status_hired_scope_all_time, undefined);

    for (const count of [line.accepted_current_offers, line.accepted_offer_applications_marked_hired, line.openings_closed_by_hire]) {
      assert.equal(count.privacy_withheld, 0, "an attested actor sees every row");
      assert.equal(count.window_label, WINDOW.label);
      assert.equal(count.scope_label, SCOPE.label);
    }
  });

  it("reports a per-count withheld figure for an unattested actor and never sums them", async () => {
    const reader = reconciliationReader({ list_offers: 4, list_applications: 2, list_openings: 3 });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, { includeOpenings: true });

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    const line = result.line;

    assert.equal(line.accepted_current_offers.privacy_withheld, 4);
    assert.equal(line.accepted_offer_applications_marked_hired.privacy_withheld, 2);
    assert.equal(line.openings_closed_by_hire.privacy_withheld, 3);

    const rendered = hireReconciliationSummary(line);
    // One sentence per count, each attributing ITS OWN withheld figure. A single "9 withheld"
    // anywhere in the rendered line would be a number no read produced.
    assert.match(rendered, /4 withheld as private candidates you cannot see/);
    assert.match(rendered, /2 withheld as private candidates you cannot see/);
    assert.match(rendered, /3 withheld as private candidates you cannot see/);
    assert.ok(!/9 withheld/.test(rendered), "withheld counts are never summed across reads");
    assert.match(rendered, /Q2 2026/);
    assert.match(rendered, /all 45 reqs you can see in Greenhouse/);
  });

  it("renders each count with its own clock and names what was not read", async () => {
    const reader = reconciliationReader();
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, {});

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    const rendered = hireReconciliationSummary(result.line);

    assert.match(rendered, /10 accepted current offers/);
    assert.match(rendered, /8 .*marked hired/);
    assert.match(rendered, /offers\.resolved_at/);
    assert.match(rendered, /applications\.status/);
    assert.match(rendered, /openings closed by a hire were not read/i);
    assert.match(rendered, /superseded versions were not read/i);
    assert.equal(toolNames(reader.calls).includes("list_openings"), false, "the openings read is opt-in — it costs a read");
  });

  it("counts offer rows per hire from the chain read when asked", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers" && params?.current_only === false) {
        // 14 rows across the 10 accepted applications: four hires took a second extension.
        return scopedSuccess(toolName, [
          ...ACCEPTED_OFFERS,
          ...ACCEPTED_OFFERS.slice(0, 4).map((offer) => ({ ...offer, id: offer.id + 900, version: 0, status: "Deprecated" })),
        ]);
      }
      if (toolName === "list_offers") return scopedSuccess(toolName, ACCEPTED_OFFERS);
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id: number) => ({ id, job_id: 10, status: HIRED_APPLICATION_IDS.has(id) ? "hired" : "in_process" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, { includeChain: true });

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    assert.equal(result.line.offer_rows_per_hire.not_read, false);
    assert.equal(result.line.offer_rows_per_hire.value, 1.4, "14 offer rows across 10 hires");
    assert.match(hireReconciliationSummary(result.line), /1\.4 offer rows per hire/);
  });

  it("reads the all-time hired-application count only when it is explicitly asked for, and labels it all-time", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers") return scopedSuccess(toolName, ACCEPTED_OFFERS);
      if (toolName === "list_applications" && params?.status === "hired") {
        return scopedSuccess(toolName, Array.from({ length: 26 }, (_, index) => ({ id: 7000 + index, job_id: 10, status: "hired" })));
      }
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id: number) => ({ id, job_id: 10, status: HIRED_APPLICATION_IDS.has(id) ? "hired" : "in_process" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, {
      includeAllTimeHiredApplications: true,
    });

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    assert.equal(result.line.applications_status_hired_scope_all_time?.value, 26);
    assert.equal(result.line.applications_status_hired_scope_all_time?.window_label, "all time");
    assert.match(hireReconciliationSummary(result.line), /all time/);
  });
});

// ---------------------------------------------------------------------------
// H6: the offer-compensation privacy probe classifies THREE ways. "Inconclusive"
// is a real answer here — no match, conflicting matches, or a definition row that
// never carried `private` all mean the same thing operationally: we do not know
// yet, and PO10 must not be planned on a guess either way.
// ---------------------------------------------------------------------------
describe("H6 classifyOfferCompensationPrivacy — tri-state", () => {
  it("says withheld when every matching offer comp field is flagged private", () => {
    const probe = classifyOfferCompensationPrivacy([
      { id: 1, name: "Base Salary", field_type: "offer", value_type: "currency", private: true },
      { id: 2, name: "Start Date", field_type: "offer", value_type: "date", private: false },
    ]);
    assert.equal(probe.verdict, "withheld");
    assert.deepStrictEqual(probe.matched.map((row) => row.name), ["Base Salary"]);
  });

  it("says available when every matching offer comp field is readable", () => {
    const probe = classifyOfferCompensationPrivacy([
      { id: 1, name: "Base Salary", field_type: "offer", value_type: "currency", private: false },
      { id: 3, name: "Bonus Target", field_type: "offer", value_type: "currency", private: false },
    ]);
    assert.equal(probe.verdict, "available");
    assert.equal(probe.matched.length, 2);
  });

  it("says inconclusive when no offer field looks like compensation", () => {
    const probe = classifyOfferCompensationPrivacy([
      { id: 2, name: "Start Date", field_type: "offer", value_type: "date", private: false },
    ]);
    assert.equal(probe.verdict, "inconclusive");
    assert.match(probe.reason, /no offer custom field/i);
  });

  it("says inconclusive when the matching fields disagree", () => {
    const probe = classifyOfferCompensationPrivacy([
      { id: 1, name: "Base Salary", field_type: "offer", value_type: "currency", private: true },
      { id: 3, name: "Bonus Target", field_type: "offer", value_type: "currency", private: false },
    ]);
    assert.equal(probe.verdict, "inconclusive");
    assert.match(probe.reason, /disagree/i);
  });

  it("says inconclusive when a matching field carries no private flag at all", () => {
    const probe = classifyOfferCompensationPrivacy([
      { id: 1, name: "Base Salary", field_type: "offer", value_type: "currency" },
    ]);
    assert.equal(probe.verdict, "inconclusive");
    assert.match(probe.reason, /no private flag/i);
  });

  it("ignores a compensation field that is not an OFFER field", () => {
    const probe = classifyOfferCompensationPrivacy([
      { id: 4, name: "Base Salary", field_type: "job", value_type: "currency", private: true },
    ]);
    assert.equal(probe.verdict, "inconclusive");
  });
});
