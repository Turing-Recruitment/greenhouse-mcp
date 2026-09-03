import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANDIDATE_ROW_TOOLS,
  CANDIDATE_SUBSTANCE_TOOLS,
  DEFAULT_FILTER_REGISTRY,
  createScopedGreenhouseReader,
  type ActorResolver,
  type ApiResponse,
  type ExecutableScopePolicy,
  type PermissionLookupResult,
  type PermissionProvider,
  type RawReadClient,
} from "../src/index.js";

/**
 * The unattested branch runs no row filter, so every hop a row filter would have taken has to be
 * taken by the privacy resolver instead. These tests walk EVERY tool whose rows are candidate
 * substance, on both unattested branches (org-wide and direct operator), and assert that the row
 * linked to a private candidate is withheld — including the two- and three-hop tools whose rows
 * carry no candidate id and no application id at all.
 */

interface RawCall {
  path: string;
  params?: Record<string, unknown>;
  cursor?: string;
}

const CANDIDATES = [
  { id: 501, first_name: "Ada", private: false },
  { id: 504, first_name: "Di", private: true },
];

const APPLICATIONS = [
  { id: 1001, job_id: 7, candidate_id: 501 },
  { id: 1004, job_id: 7, candidate_id: 504 },
];

const INTERVIEWS = [
  { id: 2001, application_id: 1001 },
  { id: 2002, application_id: 1004 },
  // A job-level interview belongs to no candidate at all. It is not candidate substance and must
  // survive the gate, or the branch would withhold rows nobody's privacy is at stake in.
  { id: 2003, job_id: 7 },
];

const SCORECARDS = [
  { id: 4001, application_id: 1001 },
  { id: 4002, application_id: 1004 },
];

const SCORECARD_QUESTION_ANSWERS = [
  { id: 5001, scorecard_id: 4001 },
  { id: 5002, scorecard_id: 4002 },
];

const SCORECARD_QUESTION_ANSWER_OPTIONS = [
  { id: 6001, scorecard_question_answer_id: 5001 },
  { id: 6002, scorecard_question_answer_id: 5002 },
];

const TABLES: Record<string, Array<Record<string, unknown>>> = {
  "/candidates": CANDIDATES,
  "/applications": APPLICATIONS,
  "/application_stages": [
    { id: 7001, application_id: 1001 },
    { id: 7002, application_id: 1004 },
  ],
  "/scorecards": SCORECARDS,
  "/rejection_details": [
    { id: 7101, application_id: 1001 },
    { id: 7102, application_id: 1004 },
  ],
  "/prospect_details": [
    { id: 7201, application_id: 1001 },
    { id: 7202, application_id: 1004 },
  ],
  "/offers": [
    { id: 7301, job_id: 7, candidate_id: 501 },
    { id: 7302, job_id: 7, candidate_id: 504 },
  ],
  "/notes": [
    { id: 7401, visibility: "public", candidate_id: 501 },
    { id: 7402, visibility: "public", candidate_id: 504 },
  ],
  "/attachments": [
    { id: 7501, candidate_id: 501 },
    { id: 7502, candidate_id: 504 },
  ],
  "/candidate_educations": [
    { id: 7601, candidate_id: 501 },
    { id: 7602, candidate_id: 504 },
  ],
  "/candidate_employments": [
    { id: 7701, candidate_id: 501 },
    { id: 7702, candidate_id: 504 },
  ],
  "/interviews": INTERVIEWS,
  "/interviewers": [
    { id: 3001, interview_id: 2001 },
    { id: 3002, interview_id: 2002 },
    { id: 3003, interview_id: 2003 },
  ],
  "/scorecard_question_answers": SCORECARD_QUESTION_ANSWERS,
  "/scorecard_question_answer_options": SCORECARD_QUESTION_ANSWER_OPTIONS,
};

function idsOf(params: Record<string, unknown> | undefined, key: string): number[] {
  return String(params?.[key] ?? "")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function tenantHandler(path: string, params?: Record<string, unknown>): unknown {
  const table = TABLES[path];
  if (!table) return [];
  if (path === "/candidates" && params?.ids !== undefined) {
    const wanted = new Set(idsOf(params, "ids"));
    const rows = table.filter((row) => wanted.has(row.id as number));
    return params.fields === "id,private" ? rows.map((row) => ({ id: row.id, private: row.private })) : rows;
  }
  if (params?.ids !== undefined) {
    const wanted = new Set(idsOf(params, "ids"));
    return table.filter((row) => wanted.has(row.id as number));
  }
  if (path === "/applications" && params?.candidate_ids !== undefined) {
    const wanted = new Set(idsOf(params, "candidate_ids"));
    return table.filter((row) => wanted.has(row.candidate_id as number));
  }
  return table;
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

const actorResolver: ActorResolver<number> = { resolveActor: (actorId) => actorId };

// The three policy-driven tools refuse to run without a scope policy; the unattested branch never
// consults one, but the availability check runs before the fork, so the registry has to be here.
const SCOPE_POLICIES = new Map<string, ExecutableScopePolicy>([
  [
    "list_scorecard_question_answer_options",
    {
      kind: "join_backed",
      dependencies: [
        {
          field: "scorecard_question_answer_id",
          sourceFilter: "scorecard_question_answer_ids",
          targetEndpoint: "/v3/scorecard_question_answers",
          targetField: "id",
          targetFilter: "ids",
          purpose: "scope",
        },
      ],
      terminal: { field: "job_id", filter: "job_ids" },
    },
  ],
]);

function readerFor(options: {
  scope?: unknown;
  raw?: RawReadClient & { calls: RawCall[] };
  operatorActorIds?: Set<number>;
  attestation?: (userId: number, signal?: AbortSignal) => Promise<boolean>;
}) {
  const raw = options.raw ?? rawReader();
  const permissionProvider: PermissionProvider = {
    async getPermittedJobIds(): Promise<PermissionLookupResult> {
      return (options.scope ?? { kind: "all" }) as PermissionLookupResult;
    },
  };
  return {
    raw,
    scoped: createScopedGreenhouseReader<number>({
      actorResolver,
      permissionProvider,
      rawReader: raw,
      scopePolicyRegistry: SCOPE_POLICIES,
      ...(options.operatorActorIds ? { operatorActorIds: options.operatorActorIds } : {}),
      ...(options.attestation ? { privateCandidateAttestation: options.attestation } : {}),
    } as Parameters<typeof createScopedGreenhouseReader>[0]),
  };
}

function rowIds(data: unknown): number[] {
  return (data as Array<{ id: number }>).map((row) => row.id);
}

// ---------------------------------------------------------------------------
// The table: every tool whose rows are (or can be) candidate substance.
// ---------------------------------------------------------------------------

interface GateCase {
  toolName: string;
  kept: number[];
  withheld: number;
}

const GATE_CASES: readonly GateCase[] = [
  { toolName: "list_candidates", kept: [501], withheld: 1 },
  { toolName: "list_applications", kept: [1001], withheld: 1 },
  { toolName: "list_application_stages", kept: [7001], withheld: 1 },
  { toolName: "list_scorecards", kept: [4001], withheld: 1 },
  { toolName: "list_rejection_details", kept: [7101], withheld: 1 },
  { toolName: "list_prospect_details", kept: [7201], withheld: 1 },
  { toolName: "list_offers", kept: [7301], withheld: 1 },
  { toolName: "list_notes", kept: [7401], withheld: 1 },
  { toolName: "list_attachments", kept: [7501], withheld: 1 },
  { toolName: "list_candidate_educations", kept: [7601], withheld: 1 },
  { toolName: "list_candidate_employments", kept: [7701], withheld: 1 },
  // Multi-hop: no candidate_id and no application_id on the row at all.
  { toolName: "list_interviews", kept: [2001, 2003], withheld: 1 },
  { toolName: "list_interviewers", kept: [3001, 3003], withheld: 1 },
  { toolName: "list_scorecard_question_answers", kept: [5001], withheld: 1 },
  { toolName: "list_scorecard_question_answer_options", kept: [6001], withheld: 1 },
];

describe("the unattested branch gates every candidate-substance tool, however many hops away", () => {
  for (const testCase of GATE_CASES) {
    it(`withholds the private-candidate row from an unattested ALL-ACCESS actor: ${testCase.toolName}`, async () => {
      const { scoped } = readerFor({ scope: { kind: "all" } });
      const result = await scoped.scopedRead(100, testCase.toolName, {});
      assert.equal(result.ok, true, `${testCase.toolName} denied`);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), testCase.kept, testCase.toolName);
      assert.equal(result.rowCounts.privacyWithheld, testCase.withheld, testCase.toolName);
    });

    it(`withholds the private-candidate row from an unattested DIRECT OPERATOR: ${testCase.toolName}`, async () => {
      const { scoped } = readerFor({
        scope: { kind: "all" },
        operatorActorIds: new Set([900]),
        attestation: async () => false,
      });
      const result = await scoped.scopedRead(900, testCase.toolName, {});
      assert.equal(result.ok, true, `${testCase.toolName} denied`);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), testCase.kept, testCase.toolName);
      assert.equal(result.rowCounts.privacyWithheld, testCase.withheld, testCase.toolName);
    });
  }
});

describe("an ATTESTED actor still reads every row on all of them", () => {
  for (const testCase of GATE_CASES) {
    it(`returns the private-candidate row too: ${testCase.toolName}`, async () => {
      const { scoped } = readerFor({ scope: { kind: "all", privateCandidatesAttested: true } });
      const result = await scoped.scopedRead(100, testCase.toolName, {});
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(
        rowIds(result.data).length,
        testCase.kept.length + testCase.withheld,
        testCase.toolName
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed on a row that must resolve to a candidate but does not
// ---------------------------------------------------------------------------

const MALFORMED: ReadonlyArray<{ toolName: string; path: string; row: Record<string, unknown> }> = [
  { toolName: "list_notes", path: "/notes", row: { id: 9001, visibility: "public" } },
  { toolName: "list_attachments", path: "/attachments", row: { id: 9002 } },
  { toolName: "list_candidate_educations", path: "/candidate_educations", row: { id: 9003 } },
  { toolName: "list_candidate_employments", path: "/candidate_employments", row: { id: 9004 } },
  { toolName: "list_scorecard_question_answers", path: "/scorecard_question_answers", row: { id: 9005 } },
  {
    toolName: "list_scorecard_question_answer_options",
    path: "/scorecard_question_answer_options",
    row: { id: 9006 },
  },
  { toolName: "list_scorecards", path: "/scorecards", row: { id: 9007 } },
];

describe("a row that must name a candidate and does not is withheld, never waved through", () => {
  for (const entry of MALFORMED) {
    it(`fails closed: ${entry.toolName}`, async () => {
      const raw = rawReader((path, params) => (path === entry.path ? [entry.row] : tenantHandler(path, params)));
      const { scoped } = readerFor({ scope: { kind: "all" }, raw });
      const result = await scoped.scopedRead(100, entry.toolName, {});
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepStrictEqual(rowIds(result.data), [], entry.toolName);
      assert.equal(result.rowCounts.privacyWithheld, 1, entry.toolName);
    });
  }
});

describe("a parent hop that cannot be read withholds its row rather than waving it through", () => {
  it("withholds an interviewer whose interview read fails", async () => {
    const raw = rawReader((path, params) => {
      if (path === "/interviews") throw new Error("upstream 500");
      return tenantHandler(path, params);
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });
    const result = await scoped.scopedRead(100, "list_interviewers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(rowIds(result.data), []);
    assert.equal(result.rowCounts.privacyWithheld, 3);
  });
});

// ---------------------------------------------------------------------------
// Batching: the hops go through the shared caches, not one read per row
// ---------------------------------------------------------------------------

describe("the multi-hop resolution is batched", () => {
  it("reads each hop's parents in one batched call for a whole page", async () => {
    const answers = Array.from({ length: 40 }, (_, index) => ({ id: 8000 + index, scorecard_id: 4001 }));
    const raw = rawReader((path, params) => {
      if (path === "/scorecard_question_answers" && params?.ids === undefined) return answers;
      return tenantHandler(path, params);
    });
    const { scoped } = readerFor({ scope: { kind: "all" }, raw });
    const result = await scoped.scopedRead(100, "list_scorecard_question_answers", {});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rowCounts.returned, 40);
    // Exactly four, in chain order: the page, then one batched read per hop. Forty rows resolving
    // one at a time would be 121.
    assert.deepStrictEqual(raw.calls.map((call) => call.path), [
      "/scorecard_question_answers",
      "/scorecards",
      "/applications",
      "/candidates",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Registry drift guard (item 20)
// ---------------------------------------------------------------------------

describe("the hand-maintained privacy tool sets cannot drift from the registry", () => {
  it("classifies every registration whose row filter carries candidate substance", () => {
    // Row-filter name -> the set the tool has to appear in for the universal gate to reach it.
    const REQUIRED_MEMBERSHIP: Record<string, "candidate_row" | "candidate_substance"> = {
      filterCandidateRow: "candidate_row",
      filterApplicationRow: "candidate_substance",
      filterApplicationBackedRow: "candidate_substance",
      filterCandidateBackedRow: "candidate_substance",
      filterOfferRow: "candidate_substance",
      filterNoteOrActivityRow: "candidate_substance",
      filterAttachmentRow: "candidate_substance",
      filterScorecardBackedRow: "candidate_substance",
    };
    const unclassified: string[] = [];
    for (const [toolName, registration] of DEFAULT_FILTER_REGISTRY) {
      const filterName = registration.rowFilter?.name;
      if (!filterName) continue;
      const required = REQUIRED_MEMBERSHIP[filterName];
      if (required === undefined) continue;
      const set = required === "candidate_row" ? CANDIDATE_ROW_TOOLS : CANDIDATE_SUBSTANCE_TOOLS;
      if (!set.has(toolName)) unclassified.push(`${toolName} (${filterName})`);
    }
    assert.deepStrictEqual(
      unclassified,
      [],
      "a registration whose rows are candidate substance is missing from the privacy tool sets"
    );
  });

  it("names every row filter the registry actually uses, so a new one is a loud failure", () => {
    const KNOWN = new Set([
      "filterCandidateRow",
      "filterApplicationRow",
      "filterApplicationBackedRow",
      "filterApplicationBackedOrDirectJobRow",
      "filterCandidateBackedRow",
      "filterOfferRow",
      "filterNoteOrActivityRow",
      "filterAttachmentRow",
      "filterScorecardBackedRow",
      "filterInterviewerRow",
      "filterJobRow",
      "filterDirectJobScopedRow",
    ]);
    const unknown = new Set<string>();
    for (const [, registration] of DEFAULT_FILTER_REGISTRY) {
      const filterName = registration.rowFilter?.name;
      if (filterName && !KNOWN.has(filterName)) unknown.add(filterName);
    }
    assert.deepStrictEqual([...unknown], []);
  });
});
