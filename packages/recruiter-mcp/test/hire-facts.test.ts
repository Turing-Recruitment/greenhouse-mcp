import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createScopedGreenhouseReader,
  type ApiResponse,
  type RawReadClient,
  type ReadParams,
} from "../../scoped-core/src/index.js";
import { buildHireFacts } from "../src/facts.js";
import { HIRE_FACTS_OFFER_READ_PARAM_NAMES } from "../src/limits.js";
import { readHireSet } from "../src/tools/hire-facts.js";
import { computeMetric } from "../src/metrics.js";
import { SCOPED_TOOL_SCOPE_POLICIES } from "../src/tools/scoped-endpoint-adapters.js";
import type { AuthenticatedSession } from "../src/types.js";
import { fakeScopedReader, scopedSuccess, testRuntime, testSession } from "./test-helpers.js";

const WINDOW = { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T23:59:59.999Z", label: "Q2 2026" };

function offerRow(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    job_id: 10,
    application_id: 100 + id,
    candidate_id: 1000 + id,
    opening_id: 5,
    status: "Accepted",
    version: 1,
    sent_on: "2026-05-01",
    resolved_at: "2026-05-10T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// H1: the two legs of the shared 422 fallback, asserted on the params ACTUALLY
// sent to the reader. The LIVE /v3/offers endpoint 422s every date filter the
// vendored contract advertises, so the native attempt has to come first (cheap
// where it is supported) and the bracket-free re-read has to window locally and
// SAY it did.
// ---------------------------------------------------------------------------
describe("H1 readHireSet — the shared 422 date fallback", () => {
  it("tries the bracket filter, re-reads without it on 422, windows locally, and discloses", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      const hasBrackets = Object.keys(params ?? {}).some((key) => /\[(gte|lte|gt|lt)\]$/.test(key));
      if (hasBrackets) {
        throw new Error("Greenhouse API error: 422 Unprocessable Entity (/offers) [correlation_id=test]");
      }
      return scopedSuccess(toolName, [
        offerRow(1, { resolved_at: "2026-05-10T12:00:00.000Z" }),
        offerRow(2, { resolved_at: "2026-07-10T12:00:00.000Z" }), // after the window
        offerRow(3, { resolved_at: "2026-03-10T12:00:00.000Z" }), // before the window
      ]);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.deepStrictEqual(result.hires.map((row) => row.id), [1], "only the hire resolved inside the window survives");

    // Leg one: the native bracket attempt, with the hire filters beside it.
    const first = reader.calls[0]!.params as Record<string, unknown>;
    assert.equal(first["resolved_at[gte]"], WINDOW.start);
    assert.equal(first["resolved_at[lte]"], WINDOW.end);
    assert.equal(first.status, "Accepted");
    assert.equal(first.current_only, true);
    // Leg two: the SAME filters minus the date brackets.
    const second = reader.calls[1]!.params as Record<string, unknown>;
    assert.equal(second["resolved_at[gte]"], undefined, "the rejected date params are dropped on the re-read");
    assert.equal(second["resolved_at[lte]"], undefined);
    assert.equal(second.status, "Accepted", "the filters the endpoint DOES accept are kept");
    assert.equal(second.current_only, true);
    assert.equal(reader.calls.length, 2, "exactly one fallback re-read");

    assert.equal(result.read.windowAppliedLocally, true, "the local window is disclosed, never silent");
    assert.deepStrictEqual(result.read.dateParamsRejected.sort(), ["resolved_at[gte]", "resolved_at[lte]"]);
  });

  it("sends no second read when the native date filter is accepted", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [offerRow(1)]));
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(reader.calls.length, 1, "the native filter is the first and only attempt when it works");
    assert.equal(result.read.windowAppliedLocally, false);
    assert.deepStrictEqual(result.read.dateParamsRejected, []);
  });

  it("carries current_only / status / resolved_at through the read-param allowlist", () => {
    // sanitizeReadParams drops unknown params SILENTLY, so the hire read's own filters have to be
    // named in an allowlist or the read quietly becomes an unfiltered one.
    for (const name of ["current_only", "status", "resolved_at", "job_ids", "per_page", "cursor"]) {
      assert.ok(HIRE_FACTS_OFFER_READ_PARAM_NAMES.has(name), `${name} must survive sanitizeReadParams`);
    }
  });
});

// ---------------------------------------------------------------------------
// H1b: the org-wide default scope carries NO job_ids, so an org-wide hire read is
// ONE permission-bounded read — not 23 chunks. Chunking is for a FROZEN explicit
// job set only.
// ---------------------------------------------------------------------------
describe("H1b readHireSet — chunking only on an explicit job set", () => {
  it("issues ONE offer read for a permission-wide scope", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, [offerRow(1)]));
    const { runtime } = testRuntime(reader);

    await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    const offerCalls = reader.calls.filter((call) => call.toolName === "list_offers");
    assert.equal(offerCalls.length, 1, "a permission-wide read is one read, not one per permitted job");
    assert.equal(offerCalls[0]!.params?.job_ids, undefined, "no job_ids are invented for a permission-wide scope");
  });

  it("issues 3 offer reads for an explicit 120-job scope, 50 ids at a time", async () => {
    const reader = fakeScopedReader((toolName) => scopedSuccess(toolName, []));
    const { runtime } = testRuntime(reader);
    const jobIds = Array.from({ length: 120 }, (_, index) => 9_000_000 + index);

    await readHireSet(runtime, "test_tool", { jobIds, label: "120 named reqs" }, WINDOW, undefined, {});

    const offerCalls = reader.calls.filter((call) => call.toolName === "list_offers");
    assert.equal(offerCalls.length, 3, "120 explicit ids chunk into 50 + 50 + 20");
    const sent = offerCalls.map((call) => String(call.params?.job_ids ?? "").split(",").filter(Boolean).length);
    assert.deepStrictEqual(sent, [50, 50, 20]);
    const allIds = offerCalls.flatMap((call) => String(call.params?.job_ids ?? "").split(",").filter(Boolean));
    assert.deepStrictEqual([...new Set(allIds)].length, 120, "every named req is actually read");
  });
});

// ---------------------------------------------------------------------------
// H1c: names for the hires, bridged in 50-id chunks, with the private-candidate
// cost stated beside them.
// ---------------------------------------------------------------------------
describe("H1c readHireSet — the candidate bridge", () => {
  it("bridges candidate_ids in 50-id chunks and reports the withheld count", async () => {
    const hires = Array.from({ length: 120 }, (_, index) => offerRow(index + 1));
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers") return scopedSuccess(toolName, hires);
      if (toolName === "list_candidates") {
        const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
        // Greenhouse's private-candidate permission withholds one row per batch upstream.
        const returned = ids.slice(1).map((id) => ({ id, first_name: `First${id}`, last_name: "Hire", preferred_name: null }));
        return scopedSuccess(toolName, returned, null, {
          rowCounts: { raw: ids.length, returned: returned.length, permissionExcluded: 1, unresolved: 0, status: "complete", privacyWithheld: 1 },
        });
      }
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
      includeCandidates: true,
    });

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    const candidateCalls = reader.calls.filter((call) => call.toolName === "list_candidates");
    assert.equal(candidateCalls.length, 3, "120 candidate ids bridge as 50 + 50 + 20");
    assert.deepStrictEqual(
      candidateCalls.map((call) => String(call.params?.ids ?? "").split(",").filter(Boolean).length),
      [50, 50, 20]
    );
    assert.equal(result.candidates?.length, 117, "three withheld rows never arrive");
    assert.equal(result.candidatesRead?.privacyWithheld, 3, "and the cost of the withholding is stated");
    const named = result.hires.find((row) => row.id === 2) as Record<string, unknown>;
    assert.deepStrictEqual(named.candidate, { id: 1002, first_name: "First1002", last_name: "Hire" });
    const withheldHire = result.hires.find((row) => row.id === 1) as Record<string, unknown>;
    assert.equal(withheldHire.candidate, undefined, "a withheld candidate is absent, never invented");
  });

  it("reads the version chain keyed by the accepted set's application_ids when asked", async () => {
    const reader = fakeScopedReader((toolName, params) => {
      if (toolName === "list_offers" && params?.current_only === false) {
        return scopedSuccess(toolName, [
          { id: 1, job_id: 10, application_id: 101, status: "Accepted", version: 2, resolved_at: "2026-05-10T12:00:00.000Z" },
          { id: 9, job_id: 10, application_id: 101, status: "Deprecated", version: 1, resolved_at: "2026-05-01T12:00:00.000Z" },
        ]);
      }
      if (toolName === "list_offers") return scopedSuccess(toolName, [offerRow(1)]);
      throw new Error(`unexpected scoped tool ${toolName}`);
    });
    const { runtime } = testRuntime(reader);

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {
      includeChain: true,
    });

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    const chainCall = reader.calls.find((call) => call.params?.current_only === false);
    assert.ok(chainCall, "the chain read asks for every version, not just the current one");
    assert.equal(chainCall!.params?.application_ids, "101", "keyed by the accepted set's applications");
    assert.equal(chainCall!.params?.status, undefined, "a superseded version is not Accepted, so status must not filter it out");
    assert.equal(result.chain?.length, 2);
  });
});

// ---------------------------------------------------------------------------
// H4: an undated hire is disclosed, never silently dropped. requiredFields
// readiness is not enforced on the analysis path, so the honesty has to live in
// the fact builder itself.
// ---------------------------------------------------------------------------
describe("H4 buildHireFacts — dating a hire honestly", () => {
  it("dates a hire lacking resolved_at from sent_on, labels it, and counts it in omissions", () => {
    const built = buildHireFacts([
      offerRow(1, { resolved_at: "2026-05-10T12:00:00.000Z", sent_on: "2026-05-01" }),
      offerRow(2, { resolved_at: undefined, sent_on: "2026-05-02" }),
    ]);

    assert.equal(built.facts.length, 2, "the undated-by-resolved_at hire is NOT dropped");
    assert.equal(built.completeness, "complete");
    assert.deepStrictEqual(built.facts.map((fact) => fact.dated_from), ["resolved_at", "sent_on"]);
    assert.equal(built.facts[1]!.hired_at, "2026-05-02");
    assert.ok(
      built.omissions.some((line) => /sent_on/.test(line) && /1/.test(line)),
      `the sent_on fallback is disclosed, got ${JSON.stringify(built.omissions)}`
    );
  });

  it("excludes a hire with neither timestamp and says so", () => {
    const built = buildHireFacts([offerRow(1), offerRow(2, { resolved_at: undefined, sent_on: undefined })]);

    assert.equal(built.facts.length, 1);
    assert.ok(built.omissions.some((line) => /no resolved_at and no sent_on/.test(line)));
  });

  it("keeps only an exact Accepted status and discloses what it left out", () => {
    const built = buildHireFacts([
      offerRow(1),
      offerRow(2, { status: "Created" }),
      offerRow(3, { status: "Deprecated" }),
    ]);

    assert.deepStrictEqual(built.facts.map((fact) => fact.offer_id), [1]);
    assert.equal(built.completeness, "complete", "a non-accepted offer is out of scope, not a data defect");
    assert.ok(built.omissions.some((line) => /not Accepted/.test(line)));
  });

  it("carries the offer's custom_fields, starts_on, version and opening_id", () => {
    const built = buildHireFacts([
      offerRow(1, { starts_on: "2026-07-01", version: 3, custom_fields: { base_salary: { amount: "1", currency_code: "USD" } } }),
    ]);

    assert.equal(built.facts[0]!.starts_on, "2026-07-01");
    assert.equal(built.facts[0]!.version, 3);
    assert.equal(built.facts[0]!.opening_id, 5);
    assert.deepStrictEqual(built.facts[0]!.custom_fields, { base_salary: { amount: "1", currency_code: "USD" } });
  });

  it("feeds hire_count, whose omissions carry the dating disclosure through to the answer", () => {
    const built = buildHireFacts([offerRow(1), offerRow(2, { resolved_at: undefined, sent_on: "2026-05-02" })]);
    const metric = computeMetric("hire_count", { facts: { hire_fact: built } });

    assert.equal(metric.completeness, "complete");
    assert.equal(metric.value, 2);
    assert.equal(metric.unit, "count");
    assert.ok(metric.omissions.some((line) => /sent_on/.test(line)));
  });
});

// ---------------------------------------------------------------------------
// H-cost: on the privacy-only branches every offer batch also walks
// application_id AND candidate_id upstream. The guard has to count UPSTREAM
// reads (pagination and the privacy walk included), not scoped-tool calls.
// ---------------------------------------------------------------------------
// MEASURED for one org-wide 500-hire read by an UNATTESTED actor: 21 upstream
// reads — 1 offers page, 10 /applications batches and 10 /candidates batches,
// the privacy walk paying 50 ids at a time for each of the offer row's two
// carriers. Stated as a ceiling rather than an equality so a batching
// IMPROVEMENT does not fail the suite, and tight enough that a regression does:
// dropping to 25-id batches costs 41, and losing the batching altogether (a read
// per row) costs a thousand.
const ORG_WIDE_500_HIRE_UPSTREAM_READ_CEILING = 30;

describe("H-cost readHireSet — upstream read cost for an org-wide hire read", () => {
  it("keeps a 500-offer org-wide read under the stated upstream-read ceiling", async () => {
    const offers = Array.from({ length: 500 }, (_, index) => offerRow(index + 1));
    const calls: Array<{ path: string; params?: ReadParams }> = [];
    const rawReader: RawReadClient = {
      async read<T>(path: string, params?: ReadParams): Promise<ApiResponse<T>> {
        calls.push({ path, params });
        if (path === "/offers") return { data: offers as T, nextCursor: null };
        if (path === "/applications") {
          const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
          return { data: ids.map((id) => ({ id, job_id: 10, candidate_id: id + 900 })) as T, nextCursor: null };
        }
        if (path === "/candidates") {
          const ids = String(params?.ids ?? "").split(",").filter(Boolean).map(Number);
          return { data: ids.map((id) => ({ id, private: false })) as T, nextCursor: null };
        }
        return { data: [] as unknown as T, nextCursor: null };
      },
    };
    // The unattested direct-operator branch: no attestation lookup at all, which is the
    // fail-closed direction, and the branch that pays for the whole privacy walk.
    const scopedReader = createScopedGreenhouseReader<AuthenticatedSession>({
      rawReader,
      actorResolver: { resolveActor: () => 100 },
      permissionProvider: { getPermittedJobIds: async () => new Set<number>([10]) },
      operatorActorIds: new Set([100]),
      scopePolicyRegistry: SCOPED_TOOL_SCOPE_POLICIES,
    });
    const { runtime } = testRuntime(scopedReader, { session: testSession() });

    const result = await readHireSet(runtime, "test_tool", { label: "everything you can see" }, WINDOW, undefined, {});

    assert.equal(result.kind, "rows");
    if (result.kind !== "rows") return;
    assert.equal(result.hires.length, 500, "every hire survives a walk that finds no private candidate");
    assert.ok(
      calls.length <= ORG_WIDE_500_HIRE_UPSTREAM_READ_CEILING,
      `500 org-wide hires cost ${calls.length} upstream reads, over the ${ORG_WIDE_500_HIRE_UPSTREAM_READ_CEILING} ceiling: ` +
        JSON.stringify(calls.reduce<Record<string, number>>((acc, call) => ({ ...acc, [call.path]: (acc[call.path] ?? 0) + 1 }), {}))
    );
    assert.ok(calls.filter((call) => call.path === "/offers").length >= 1);
  });
});
