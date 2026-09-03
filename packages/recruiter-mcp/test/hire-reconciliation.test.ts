import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyOfferCompensationPrivacy } from "../src/tools/hire-probes.js";
import { hireReconciliationSummary, reconciliationLine } from "../src/tools/hire-facts.js";
import { fakeScopedReader, scopedDenial, scopedSuccess, testRuntime, type ScopedCall } from "./test-helpers.js";

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

// Every way a closed opening can fail to be a hire, so neither half of the discriminator can be
// deleted and stay green: a resolvable NON-hire reason with an application on it (603), and a hire
// reason with nobody attached to it (604). Plus the rows the read's own filters must exclude: one
// still open (605) and one closed outside the window (606).
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
  { id: 603, job_id: 10, application_id: 111, open: false, closed_at: "2026-05-14T00:00:00.000Z", close_reason_id: 91 },
  { id: 604, job_id: 10, open: false, closed_at: "2026-05-14T00:00:00.000Z", close_reason_id: 90 },
  { id: 605, job_id: 10, application_id: 113, open: true, close_reason_id: 90 },
  { id: 606, job_id: 10, application_id: 114, open: false, closed_at: "2026-08-14T00:00:00.000Z", close_reason_id: 90 },
  // No closed_at at all. On the fallback leg the local window cannot place it, and it is COUNTED
  // as unplaceable rather than quietly widening or narrowing the hire count.
  { id: 607, job_id: 10, application_id: 115, open: false, close_reason_id: 90 },
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
      // Answer the way Greenhouse would: honour open=false and, when the caller sent them, the
      // closed_at brackets. A fake that hands back every row whatever was asked cannot tell a
      // server-side filter that works from one that was silently dropped.
      const brackets = params?.["closed_at[gte]"] !== undefined;
      const rows = CLOSED_OPENINGS.filter((row) => {
        if (params?.open === false && row.open !== false) return false;
        if (!brackets) return true;
        const closedAt = typeof row.closed_at === "string" ? row.closed_at : null;
        if (closedAt === null) return false;
        return closedAt >= String(params?.["closed_at[gte]"]) && closedAt <= String(params?.["closed_at[lte]"]);
      });
      return withPrivacy(toolName, rows, withheld.list_openings ?? 0);
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
// H2b: the line counts HIRES, not returned rows.
//
// Before this the count was `hireSet.hires.length` — whatever the read handed
// back. buildHireFacts is where "what is a hire" is defined, so a stray
// non-accepted row was counted as a hire and a hire dated off `sent_on` was
// reported as dated on `resolved_at`. One definition, used everywhere.
// ---------------------------------------------------------------------------
describe("H2b reconciliationLine — one definition of a hire", () => {
  function offersReader(offers: Array<Record<string, unknown>>) {
    return fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers") {
        // Answer each leg the way Greenhouse would: a `resolved_at` range filter cannot return a
        // row that has no resolved_at, and the `sent_on` leg filters on sent_on.
        const field = params?.["resolved_at[gte]"] !== undefined
          ? "resolved_at"
          : params?.["sent_on[gte]"] !== undefined
            ? "sent_on"
            : null;
        if (field === null) return scopedSuccess(toolName, offers);
        const gte = String(params?.[`${field}[gte]`]);
        const lte = String(params?.[`${field}[lte]`]);
        return scopedSuccess(
          toolName,
          offers.filter((row) => {
            const value = row[field];
            return typeof value === "string" && value >= gte && value <= lte;
          })
        );
      }
      if (toolName === "list_applications") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        return scopedSuccess(toolName, ids.map((id) => ({ id, job_id: 10, status: "hired" })));
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
  }

  it("does not count a stray non-Accepted row the read handed back", async () => {
    const reader = offersReader([
      ...ACCEPTED_OFFERS,
      { id: 99, job_id: 10, application_id: 199, candidate_id: 1099, status: "Created", sent_on: "2026-05-01", resolved_at: "2026-05-10T12:00:00.000Z" },
    ]);
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, {});

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    assert.equal(result.line.accepted_current_offers.value, 10, "the Created row is not a hire, whatever the read returned");
    assert.ok(
      result.line.accepted_current_offers.notes.some((note) => /not Accepted/.test(note)),
      `the exclusion is disclosed, got ${JSON.stringify(result.line.accepted_current_offers.notes)}`
    );
    // And it never reaches the bridge either: an id that is not a hire has no business in the
    // count of "how many of THESE hires does Greenhouse call hired".
    const bridged = reader.calls.find((call) => call.toolName === "list_applications");
    assert.ok(!String(bridged?.params?.ids ?? "").split(",").includes("199"));
  });

  it("labels the hires it could only date from the send date, in the count and in the sentence", async () => {
    const reader = offersReader([
      ...ACCEPTED_OFFERS.slice(0, 9),
      { id: 10, job_id: 10, application_id: 109, candidate_id: 1009, status: "Accepted", sent_on: "2026-05-05" },
    ]);
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, {});

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    assert.equal(result.line.accepted_current_offers.value, 10, "a hire with no resolved_at is still a hire");
    assert.equal(result.line.accepted_current_offers.dated_from_fallback, 1);
    assert.match(
      hireReconciliationSummary(result.line),
      /1 of which dated from the send date because the accepted date was missing/
    );
  });

  it("says offer rows per hire is undefined, not null, when the window holds no hires", async () => {
    const reader = fakeScopedReader((toolName) => {
      if (toolName === "list_offers") return scopedSuccess(toolName, []);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, { includeChain: true });

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    assert.equal(result.line.offer_rows_per_hire.value, null);
    const rendered = hireReconciliationSummary(result.line);
    assert.match(rendered, /no hires in this window, so offer rows per hire is undefined/i);
    assert.ok(!/null offer rows per hire/.test(rendered), "a rendered 'null' is a bug leaking into a sentence");
  });
});

// ---------------------------------------------------------------------------
// H2c: the openings count's own disclosures reach the answer.
//
// readOpeningsClosedByHire computed windowAppliedLocally / dateParamsRejected /
// rowsMissingField and threw all three away, so the count always arrived with
// `notes: []` — a locally-windowed number over an unfiltered read presented as a
// clean server-side one.
// ---------------------------------------------------------------------------
describe("H2c reconciliationLine — the openings read discloses what it did", () => {
  it("says the closed_at filter was rejected and how many closed openings carried no closed_at", async () => {
    const base = reconciliationReader();
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_openings" && params?.["closed_at[gte]"] !== undefined) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/openings) [correlation_id=test]");
      }
      return base.scopedRead(undefined as never, toolName, params, undefined);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, { includeOpenings: true });

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    const count = result.line.openings_closed_by_hire;
    assert.equal(count.value, 8, "the local window keeps the same eight hire-closed seats");
    assert.ok(
      count.notes.some((note) => /rejected the closed_at filter/.test(note) && /closed_at\[gte\]/.test(note)),
      `the fallback must be named, got ${JSON.stringify(count.notes)}`
    );
    assert.ok(
      count.notes.some((note) => /1 closed opening\(s\) carried no closed_at/.test(note)),
      `the unplaceable seat is counted, got ${JSON.stringify(count.notes)}`
    );
  });

  it("keeps the line when the openings read is denied outright, rather than losing the other two counts", async () => {
    const base = reconciliationReader();
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_openings") return scopedDenial(toolName, "TOOL_NOT_AVAILABLE");
      return base.scopedRead(undefined as never, toolName, params, undefined);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, { includeOpenings: true });

    assert.equal(result.kind, "line", "one denied population must not destroy two computed counts");
    if (result.kind !== "line") return;
    assert.equal(result.line.accepted_current_offers.value, 10);
    assert.equal(result.line.accepted_offer_applications_marked_hired.value, 8);
    assert.equal(result.line.openings_closed_by_hire.not_read, true);
    assert.ok(result.line.openings_closed_by_hire.notes.some((note) => /TOOL_NOT_AVAILABLE/.test(note)));
  });

  it("keeps the accepted count when the applications bridge is denied", async () => {
    const base = reconciliationReader();
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications") return scopedDenial(toolName, "TOOL_NOT_AVAILABLE");
      return base.scopedRead(undefined as never, toolName, params, undefined);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, {});

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    assert.equal(result.line.accepted_current_offers.value, 10, "the read that succeeded still answers");
    assert.equal(result.line.accepted_offer_applications_marked_hired.not_read, true);
    assert.match(hireReconciliationSummary(result.line), /10 accepted current offers/);
  });

  it("chunks an explicit 120-req scope on the openings and all-time reads, and verifies status in memory", async () => {
    const jobIds = Array.from({ length: 120 }, (_, index) => 9_000_000 + index);
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers") return scopedSuccess(toolName, []);
      if (toolName === "list_openings") return scopedSuccess(toolName, []);
      if (toolName === "list_close_reasons") return scopedSuccess(toolName, []);
      if (toolName === "list_applications" && params?.status === "hired") {
        // A server-side filter this count used to TRUST: two of these rows are not hired.
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, status: "hired" },
          { id: 2, job_id: 10, status: "in_process" },
          { id: 3, job_id: 10, status: "rejected" },
        ]);
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(
      runtime,
      "test_tool",
      { jobIds, label: "120 named reqs" },
      WINDOW,
      undefined,
      { includeOpenings: true, includeAllTimeHiredApplications: true }
    );

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    const chunkSizes = (toolName: string, predicate: (params?: Record<string, unknown>) => boolean) =>
      reader.calls
        .filter((call) => call.toolName === toolName && predicate(call.params))
        .map((call) => String(call.params?.job_ids ?? "").split(",").filter(Boolean).length);
    assert.deepStrictEqual(
      chunkSizes("list_openings", (params) => params?.["closed_at[gte]"] !== undefined),
      [50, 50, 20],
      "120 explicit reqs are not sent to /openings as one job_ids string"
    );
    assert.deepStrictEqual(
      chunkSizes("list_applications", (params) => params?.status === "hired"),
      [50, 50, 20],
      "nor to the all-time /applications read"
    );
    // 3 chunks x 3 rows = 9 returned, of which 3 actually carry status=hired.
    assert.equal(result.line.applications_status_hired_scope_all_time?.value, 3, "the returned status is re-checked, not trusted");
    assert.ok(
      result.line.applications_status_hired_scope_all_time?.notes.some((note) => /do not carry status=hired/.test(note))
    );
  });

  it("reads NOTHING for an explicitly empty req set on any of the three counts", async () => {
    const reader = fakeScopedReader((toolName) => {
      throw new Error(`an empty scope must not read ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(
      runtime,
      "test_tool",
      { jobIds: [], label: "no reqs" },
      WINDOW,
      undefined,
      { includeOpenings: true, includeAllTimeHiredApplications: true }
    );

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    assert.equal(result.line.accepted_current_offers.value, 0);
    assert.equal(result.line.openings_closed_by_hire.value, 0);
    assert.equal(result.line.applications_status_hired_scope_all_time?.value, 0);
    assert.deepStrictEqual(
      toolNames(reader.calls),
      [],
      "an empty explicit scope reads NOTHING — not offers, not applications, not openings, and not the close-reason dictionary it has no ids to resolve"
    );
  });
});

// ---------------------------------------------------------------------------
// H2d: every read behind the line is contained, and a cancellation is the one
// thing that stops it.
//
// readAllScopedRows rethrows a 5xx, so the openings read, the close-reason
// dictionary and the all-time count could each escape as an exception and
// destroy two counts that had already been computed off completed reads.
// ---------------------------------------------------------------------------
describe("H2d reconciliationLine — contained reads, propagated cancellation", () => {
  function failingReader(failing: string, thrown: Error) {
    const base = reconciliationReader();
    return fakeScopedReader((toolName, params) => {
      if (toolName === failing) throw thrown;
      return base.scopedRead(undefined as never, toolName, params, undefined);
    });
  }

  for (const [label, failing, options] of [
    ["the closed-openings read", "list_openings", { includeOpenings: true }],
    ["the close-reason dictionary", "list_close_reasons", { includeOpenings: true }],
  ] as const) {
    it(`keeps the other counts when ${label} fails upstream`, async () => {
      const reader = failingReader(failing, new Error(`Greenhouse API error: 500 Internal Server Error (/${failing}) [correlation_id=test]`));
      const { runtime } = testRuntime(reader);

      const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, options);

      assert.equal(result.kind, "line", "one broken population must not destroy two computed counts");
      if (result.kind !== "line") return;
      assert.equal(result.line.accepted_current_offers.value, 10);
      assert.equal(result.line.accepted_offer_applications_marked_hired.value, 8);
      assert.equal(result.line.openings_closed_by_hire.not_read, true);
      assert.ok(
        result.line.openings_closed_by_hire.notes.some((note) => /500|could not be read/i.test(note)),
        `the failure is named on the count, got ${JSON.stringify(result.line.openings_closed_by_hire.notes)}`
      );
    });
  }

  it("keeps the other counts when the all-time hired-application read fails upstream", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_applications" && params?.status === "hired") {
        throw new Error("Greenhouse API error: 500 Internal Server Error (/applications) [correlation_id=test]");
      }
      return reconciliationReader().scopedRead(undefined as never, toolName, params, undefined);
    });
    const { runtime } = testRuntime(reader);

    const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, {
      includeAllTimeHiredApplications: true,
    });

    assert.equal(result.kind, "line");
    if (result.kind !== "line") return;
    assert.equal(result.line.accepted_current_offers.value, 10);
    assert.equal(result.line.applications_status_hired_scope_all_time?.not_read, true);
  });

  for (const failing of ["list_applications", "list_openings"] as const) {
    it(`propagates a cancellation on ${failing} rather than answering a client that has gone`, async () => {
      const reader = failingReader(failing, new Error("SCOPED_GREENHOUSE_TOOL_CANCELLED"));
      const { runtime } = testRuntime(reader);

      const result = await reconciliationLine(runtime, "test_tool", SCOPE, WINDOW, undefined, { includeOpenings: true });

      assert.equal(result.kind, "denial");
      if (result.kind !== "denial") return;
      assert.equal(result.result.ok === false && result.result.denial.code, "CANCELLED");
    });
  }
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

  it("says available when every matching offer comp field is readable, matching on name OR value_type", () => {
    // Both halves of the match are load-bearing and each one alone deleted green before this: a
    // tenant that renamed the field keeps the currency type, and a tenant that types comp as text
    // keeps the compensation vocabulary. Rows 5 and 6 exercise exactly one half each.
    const probe = classifyOfferCompensationPrivacy([
      { id: 1, name: "Base Salary", field_type: "offer", value_type: "currency", private: false },
      { id: 3, name: "Bonus Target", field_type: "offer", value_type: "currency", private: false },
      { id: 5, name: "Base Salary", field_type: "offer", value_type: "short_text", private: false },
      { id: 6, name: "Package", field_type: "offer", value_type: "currency", private: false },
    ]);
    assert.equal(probe.verdict, "available");
    assert.equal(probe.matched.length, 4);
    assert.deepStrictEqual(probe.matched.map((row) => row.id), [1, 3, 5, 6]);
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
