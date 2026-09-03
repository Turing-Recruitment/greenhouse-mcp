import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createScopedGreenhouseReader,
  type ActorResolver,
  type ApiResponse,
  type PermissionLookupResult,
  type PermissionProvider,
  type RawReadClient,
} from "../src/index.js";

/**
 * The private-candidate attestation gate (CLO-273, lane B).
 *
 * Greenhouse gates a private candidate on a user-specific permission Harvest v3 does not expose,
 * so all-access here is an INFERENCE (site_admin, or an all-jobs role marker) that says nothing
 * about it. These tests pin both halves: an ATTESTED all-access actor and an attested operator read
 * exactly what they read before, byte for byte; an UNATTESTED one keeps everything except the
 * private candidates their own Greenhouse roles do not reach.
 */

interface RawCall {
  path: string;
  params?: Record<string, unknown>;
  cursor?: string;
}

const CANDIDATES = [
  { id: 501, first_name: "Ada", private: false },
  { id: 502, first_name: "Bo", private: false },
  { id: 503, first_name: "Cy", private: false },
  { id: 504, first_name: "Di", private: true },
  { id: 505, first_name: "Eve", private: true },
];

// A candidate with NO application at all and nothing private about them. The job-scope filter path
// drops this shape as `missingParent`; the unattested branch must not.
const UNAPPLIED_CANDIDATE = { id: 506, first_name: "Fay", private: false };

const APPLICATIONS = [
  { id: 1001, job_id: 7, candidate_id: 501 },
  { id: 1002, job_id: 7, candidate_id: 502 },
  { id: 1003, job_id: 9, candidate_id: 503 },
  { id: 1004, job_id: 7, candidate_id: 504 },
  { id: 1005, job_id: 9, candidate_id: 505 },
];

function idsOf(params: Record<string, unknown> | undefined, key: string): number[] {
  return String(params?.[key] ?? "")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/** The tenant, answered the way `/v3/candidates` and `/v3/applications` answer. */
function tenantHandler(path: string, params?: Record<string, unknown>): unknown {
  const everyCandidate = [...CANDIDATES, UNAPPLIED_CANDIDATE];
  if (path === "/candidates") {
    if (params?.ids !== undefined) {
      const wanted = new Set(idsOf(params, "ids"));
      const rows = everyCandidate.filter((row) => wanted.has(row.id));
      return params.fields === "id,private" ? rows.map((row) => ({ id: row.id, private: row.private })) : rows;
    }
    return CANDIDATES;
  }
  if (path === "/applications") {
    if (params?.candidate_ids !== undefined) {
      const wanted = new Set(idsOf(params, "candidate_ids"));
      return APPLICATIONS.filter((row) => wanted.has(row.candidate_id));
    }
    if (params?.ids !== undefined) {
      const wanted = new Set(idsOf(params, "ids"));
      return APPLICATIONS.filter((row) => wanted.has(row.id));
    }
    return APPLICATIONS;
  }
  return [];
}

function rawReader(
  handler: (path: string, params?: Record<string, unknown>, cursor?: string) => unknown = tenantHandler
): RawReadClient & { calls: RawCall[] } {
  const calls: RawCall[] = [];
  return {
    calls,
    async read<T = unknown>(path: string, params?: Record<string, unknown>, cursor?: string): Promise<ApiResponse<T>> {
      calls.push({ path, params, cursor });
      return { data: handler(path, params, cursor) as T, nextCursor: null };
    },
  };
}

function actorResolver(): ActorResolver<number> {
  return { resolveActor: (actorId) => actorId };
}

function providerReturning(scope: unknown): PermissionProvider {
  return { async getPermittedJobIds(): Promise<PermissionLookupResult> { return scope as PermissionLookupResult; } };
}

function readerFor(options: {
  scope?: unknown;
  raw?: RawReadClient & { calls: RawCall[] };
  operatorActorIds?: Set<number>;
  attestation?: (userId: number, signal?: AbortSignal) => Promise<boolean>;
  providerByActor?: Map<number, unknown>;
}) {
  const raw = options.raw ?? rawReader();
  const permissionProvider: PermissionProvider = options.providerByActor
    ? {
        async getPermittedJobIds(actorId: number): Promise<PermissionLookupResult> {
          return options.providerByActor!.get(actorId) as PermissionLookupResult;
        },
      }
    : providerReturning(options.scope);
  return {
    raw,
    scoped: createScopedGreenhouseReader<number>({
      actorResolver: actorResolver(),
      permissionProvider,
      rawReader: raw,
      ...(options.operatorActorIds ? { operatorActorIds: options.operatorActorIds } : {}),
      ...(options.attestation ? { privateCandidateAttestation: options.attestation } : {}),
    } as Parameters<typeof createScopedGreenhouseReader>[0]),
  };
}

function rowIds(data: unknown): number[] {
  return (data as Array<{ id: number }>).map((row) => row.id);
}

// ---------------------------------------------------------------------------
// B1 / B1b — the unattested all-access branch withholds private rows, batched
// ---------------------------------------------------------------------------

describe("B1: unattested all-access, list_candidates", () => {
  it("returns the public rows, counts the withheld ones, and says so in the envelope", async () => {
    const { raw, scoped } = readerFor({ scope: { kind: "all" } });
    const result = await scoped.scopedRead(100, "list_candidates", {});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503]);
    assert.equal(result.rowCounts.privacyWithheld, 2);
    assert.equal(result.rowCounts.returned, 3);
    assert.equal(result.rowCounts.raw, 5);
    assert.equal(result.scoped, true, "rows were withheld, so this read was not unscoped");
    assert.deepStrictEqual(result.permissionScope, {
      kind: "all",
      permittedJobCount: null,
      privateCandidatesWithheld: true,
    });
    // 1 page read + at most one batched privacy read per 50 ids. A candidate row carries `private`
    // in its own field set, so in practice this costs nothing beyond the page itself.
    assert.ok(raw.calls.length <= 1 + Math.ceil(CANDIDATES.length / 50), `saw ${raw.calls.length} upstream calls`);
  });
});

describe("B1b: unattested all-access, an application-backed read", () => {
  it("withholds the applications of private candidates through one batched candidate lookup", async () => {
    const { raw, scoped } = readerFor({ scope: { kind: "all" } });
    const result = await scoped.scopedRead(100, "list_applications", {});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [1001, 1002, 1003]);
    assert.equal(result.rowCounts.privacyWithheld, 2);
    assert.equal(raw.calls.length, 2, "one page read plus one batched /candidates privacy read");
    const privacyRead = raw.calls[1]!;
    assert.equal(privacyRead.path, "/candidates");
    assert.equal(privacyRead.params?.fields, "id,private");
    assert.deepStrictEqual(idsOf(privacyRead.params, "ids"), [501, 502, 503, 504, 505]);
  });

  it("costs one page read plus ceil(n/50) batched candidate reads on a 100-row page", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: 2000 + index,
      job_id: 7,
      candidate_id: 3000 + index,
    }));
    const raw = rawReader((path, params) => {
      if (path === "/applications") return rows;
      if (path === "/candidates") {
        // Twenty of the hundred are private.
        return idsOf(params, "ids").map((id) => ({ id, private: (id - 3000) % 5 === 0 }));
      }
      return [];
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });

    const result = await scoped.scopedRead(100, "list_applications", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rowCounts.returned, 80);
    assert.equal(result.rowCounts.privacyWithheld, 20);
    assert.equal(raw.calls.length, 3, "1 page + ceil(100/50) batched privacy reads — never one read per row");
  });
});

// ---------------------------------------------------------------------------
// B2 / B2b — an attested actor reads exactly what they read before
// ---------------------------------------------------------------------------

describe("B2: attested all-access is byte-identical to the unfiltered read", () => {
  // Captured against the code BEFORE the gate existed: an org-wide scope with nothing excluded
  // takes the raw fast path, reports scoped:false, and counts nothing as excluded.
  const EXPECTED_ENVELOPE = {
    ok: true,
    toolName: "list_candidates",
    actorId: 100,
    effectiveActorId: 100,
    scoped: false,
    permissionScope: { kind: "all", permittedJobCount: null },
    rowCounts: { raw: 5, returned: 5, permissionExcluded: 0, unresolved: 0, status: "complete" },
    data: CANDIDATES,
    nextCursor: null,
    meta: undefined,
  };

  it("returns every row and the pre-change envelope, routed through the provider answer", async () => {
    const { raw, scoped } = readerFor({ scope: { kind: "all", privateCandidatesAttested: true } });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.deepStrictEqual(result, EXPECTED_ENVELOPE);
    assert.equal(raw.calls.length, 1, "the attested fast path stays a single unfiltered read");
  });
});

describe("B2b: the flag survives normalization, and a malformed one is refused", () => {
  it("keeps the attestation across the provider-answer clone, exclusions included", async () => {
    const { scoped } = readerFor({
      scope: {
        kind: "all",
        excludedJobIds: new Set([9]),
        privateCandidatesAttested: true,
      },
    });
    const result = await scoped.scopedRead(100, "list_applications", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Job 9 is excluded by Greenhouse's own confidential-job rule; job 7's private candidate is
    // still visible, because the actor is attested.
    assert.deepStrictEqual(rowIds(result.data), [1001, 1002, 1004]);
    assert.deepStrictEqual(result.permissionScope, { kind: "all", permittedJobCount: null });
  });

  it("keeps an unattested actor's explicit private-capable jobs across the clone", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all", privateCandidatesAttested: false, privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_applications", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [1001, 1002, 1003, 1004],
      "the private candidate on job 7 is reachable through the actor's own Greenhouse role");
  });

  it("refuses a provider answer whose attestation is not a boolean, or whose private set is not a set", async () => {
    for (const scope of [
      { kind: "all", privateCandidatesAttested: "true" },
      { kind: "all", privateCandidatesAttested: 1 },
      { kind: "all", privateCapableJobIds: 7 },
    ]) {
      const { scoped } = readerFor({ scope });
      const result = await scoped.scopedRead(100, "list_candidates", {});
      assert.equal(result.ok, false, JSON.stringify(scope));
      assert.equal(result.ok === false && result.denial.code, "PERMISSION_LOOKUP_FAILED");
    }
  });

  it("treats an absent flag as unattested", async () => {
    const { scoped } = readerFor({ scope: { kind: "all" } });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.equal(result.ok && result.rowCounts.privacyWithheld, 2);
  });
});

// ---------------------------------------------------------------------------
// B3 / B3b — point gets
// ---------------------------------------------------------------------------

describe("B3: a withheld point get is indistinguishable from a nonexistent id", () => {
  it("reports the same envelope for a private candidate and for an id that does not exist", async () => {
    const hidden = await readerFor({ scope: { kind: "all" } }).scoped.scopedRead(100, "get_candidate", { id: 504 });
    const missing = await readerFor({ scope: { kind: "all" } }).scoped.scopedRead(100, "get_candidate", { id: 999 });
    assert.equal(hidden.ok && hidden.data, null);
    assert.equal(missing.ok && missing.data, null);
    assert.deepStrictEqual(hidden, missing,
      "counts that separate 'withheld' from 'never existed' are a per-person existence oracle for the private flag");
  });

  it("returns the row to an attested actor", async () => {
    const { scoped } = readerFor({ scope: { kind: "all", privateCandidatesAttested: true } });
    const result = await scoped.scopedRead(100, "get_candidate", { id: 504 });
    assert.deepStrictEqual(result.ok && result.data, CANDIDATES[3]);
  });
});

describe("B3b: the unattested branch never inherits the job-scope filter's drops", () => {
  it("returns a public candidate who has no applications at all", async () => {
    const { scoped } = readerFor({ scope: { kind: "all" } });
    const result = await scoped.scopedRead(100, "get_candidate", { id: 506 });
    assert.deepStrictEqual(result.ok && result.data, UNAPPLIED_CANDIDATE,
      "a candidate with no application is `missingParent` to the job-scope filter; withholding them " +
        "would be the gate taking rows the actor is entitled to");
    assert.equal(result.ok && result.rowCounts.unresolved, 0);
    assert.equal(result.ok && result.rowCounts.status, "complete");
  });
});

// ---------------------------------------------------------------------------
// B5 — the direct-operator path
// ---------------------------------------------------------------------------

describe("B5: the operator path is gated by the same attestation", () => {
  const OPERATORS = new Set([900]);

  it("keeps an attested operator's raw envelope byte-identical", async () => {
    const { raw, scoped } = readerFor({
      scope: { kind: "all" },
      operatorActorIds: OPERATORS,
      attestation: async () => true,
    });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.deepStrictEqual(result, {
      ok: true,
      toolName: "list_candidates",
      actorId: 900,
      effectiveActorId: 900,
      scoped: false,
      permissionScope: { kind: "operator", permittedJobCount: null },
      rowCounts: { raw: 5, returned: 5, permissionExcluded: 0, unresolved: 0, status: "complete" },
      data: CANDIDATES,
      nextCursor: null,
      meta: undefined,
    });
    assert.equal(raw.calls.length, 1);
  });

  it("withholds private rows from an unattested operator", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all" },
      operatorActorIds: OPERATORS,
      attestation: async () => false,
    });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503]);
    assert.equal(result.scoped, true);
    assert.deepStrictEqual(result.permissionScope, {
      kind: "operator",
      permittedJobCount: null,
      privateCandidatesWithheld: true,
    });
  });

  it("treats a missing attestation lookup as unattested", async () => {
    const { scoped } = readerFor({ scope: { kind: "all" }, operatorActorIds: OPERATORS });
    const result = await scoped.scopedRead(900, "list_candidates", {});
    assert.deepStrictEqual(rowIds(result.ok ? result.data : []), [501, 502, 503],
      "no lookup configured means the permission cannot be established, which is not a grant");
  });

  it("uses the EFFECTIVE actor's attestation under actAsUser, not the operator's", async () => {
    const { scoped } = readerFor({
      providerByActor: new Map<number, unknown>([[100, { kind: "all", privateCandidatesAttested: true }]]),
      operatorActorIds: OPERATORS,
      // The operator's own lookup says no. It must not decide a read performed AS someone else.
      attestation: async () => false,
    });
    const result = await scoped.scopedRead(900, "list_candidates", {}, { actAsUser: 100 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503, 504, 505]);
    assert.equal(result.effectiveActorId, 100);
  });
});

// ---------------------------------------------------------------------------
// B6 — job scopes are untouched
// ---------------------------------------------------------------------------

describe("B6: a job-scoped recruiter is unaffected by the attestation", () => {
  it("still sees the private candidates their Private Job Admin role reaches, and no others", async () => {
    const { scoped } = readerFor({
      scope: { kind: "jobs", jobIds: new Set([7]), privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 504]);
    assert.deepStrictEqual(result.permissionScope, { kind: "jobs", permittedJobCount: 1 });
    assert.equal(
      (result.permissionScope as { privateCandidatesWithheld?: boolean }).privateCandidatesWithheld,
      undefined,
      "the disclosure belongs to the org-wide branch; a job scope was never org-wide"
    );
  });
});

// ---------------------------------------------------------------------------
// B14 — an unattested all-access actor keeps their per-job private grants
// ---------------------------------------------------------------------------

describe("B14: unattested all-access keeps the private access Greenhouse's per-job roles grant", () => {
  it("sees private candidates on a private-capable job and nowhere else", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all", privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), [501, 502, 503, 504],
      "504 sits on job 7, where this actor holds Greenhouse's Private Job Admin role");
    assert.equal(result.rowCounts.privacyWithheld, 1, "only 505, on job 9, is withheld");
  });

  it("gives an attested actor both, with no envelope disclosure at all", async () => {
    const { scoped } = readerFor({
      scope: { kind: "all", privateCandidatesAttested: true, privateCapableJobIds: new Set([7]) },
    });
    const result = await scoped.scopedRead(100, "list_candidates", {});
    assert.deepStrictEqual(rowIds(result.ok ? result.data : []), [501, 502, 503, 504, 505]);
    assert.deepStrictEqual(result.ok && result.permissionScope, { kind: "all", permittedJobCount: null });
  });
});
