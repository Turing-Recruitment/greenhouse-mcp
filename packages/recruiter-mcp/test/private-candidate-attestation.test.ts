import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrivateCandidateAttestationLookup,
  createPrivateCandidateAttestationStamp,
  PRIVATE_CANDIDATE_ATTESTATION_COLUMNS,
} from "../src/private-candidate-attestation.js";
import { createHarvestPermissionProvider, type PermissionLookupResult, type RawReadClient } from "../../scoped-core/src/index.js";
import { createSiteAdminAwarePermissionProvider } from "../src/site-admin-permission.js";
import { buildIdentityBootstrapPlan } from "../src/identity-bootstrap.js";
import { applyIdentityReconciliationPlan, buildIdentityReconciliationPlan } from "../src/identity-reconciliation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(HERE, "../supabase/migrations/0008_private_candidate_attestation.sql");

const SUPABASE_URL = "https://ibxvxmfhovmththllwoi.supabase.co";
const ENV = {
  GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL: SUPABASE_URL,
  GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY: "test-service-role-key",
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// B8 — migration 0008 is re-runnable and additive only
// ---------------------------------------------------------------------------

describe("B8: migration 0008_private_candidate_attestation", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  // Statements only. The header comment explains the `add column if not exists` rule and the RLS
  // inheritance in prose, and a scan that read the prose would pass on the explanation rather than
  // on the SQL.
  const normalized = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  it("adds exactly the three attestation columns, each with `if not exists`", () => {
    const additions = [...normalized.matchAll(/add column(?: if not exists)? ([a-z_]+)/g)];
    assert.deepEqual(
      additions.map((match) => match[1]),
      ["private_candidates_attested", "private_candidates_attested_at", "private_candidates_attested_by"]
    );
    assert.equal(
      normalized.split("add column if not exists").length - 1,
      3,
      "every `add column` must carry `if not exists` — the migration is applied by hand and re-applied on rebuilds"
    );
  });

  it("contains no bare `add column` and no destructive statement", () => {
    assert.ok(!/add column(?! if not exists)/.test(normalized), "a bare `add column` breaks re-runnability");
    assert.ok(!/\bdrop\b/.test(normalized), "0008 is additive; nothing is dropped");
    assert.ok(!/\bgrant\b/.test(normalized) && !/row level security/.test(normalized),
      "RLS and grants are set in 0001 and inherited by new columns");
  });

  it("declares the three column names the code reads and writes", () => {
    for (const column of PRIVATE_CANDIDATE_ATTESTATION_COLUMNS) {
      assert.ok(normalized.includes(column), `migration must add ${column}`);
      assert.ok(normalized.includes(`comment on column recruiter_identity_directory.${column}`),
        `${column} must be documented in the database, not only here`);
    }
  });

  it("defaults the boolean to false so every pre-existing row is unattested", () => {
    assert.match(normalized, /private_candidates_attested boolean not null default false/);
  });
});

// ---------------------------------------------------------------------------
// B9 — the attestation lookup: true only for exactly-one-row-true, never throws
// ---------------------------------------------------------------------------

describe("B9: private-candidate attestation lookup", () => {
  it("is true only when exactly one resolved row carries the flag as literal true", async () => {
    let requestedUrl = "";
    const lookup = createPrivateCandidateAttestationLookup(ENV, async (input) => {
      requestedUrl = String(input);
      return jsonResponse([{ private_candidates_attested: true }]);
    });
    assert.equal(await lookup(5085047004), true);
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, "/rest/v1/recruiter_identity_directory");
    assert.equal(url.searchParams.get("select"), "private_candidates_attested");
    assert.equal(url.searchParams.get("greenhouse_user_id"), "eq.5085047004");
    assert.equal(url.searchParams.get("status"), "eq.resolved");
    assert.equal(url.searchParams.get("limit"), "2", "two rows are read so a duplicate is detectable, never assumed away");
  });

  it("returns false — and never rejects — for every other outcome", async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ["zero rows", async () => jsonResponse([])],
      ["two rows", async () => jsonResponse([{ private_candidates_attested: true }, { private_candidates_attested: true }])],
      ["flag false", async () => jsonResponse([{ private_candidates_attested: false }])],
      ["flag null", async () => jsonResponse([{ private_candidates_attested: null }])],
      ["flag missing", async () => jsonResponse([{}])],
      ["flag is the string true", async () => jsonResponse([{ private_candidates_attested: "true" }])],
      ["400 with 42703 undefined column", async () => new Response(
        JSON.stringify({ code: "42703", message: `column "private_candidates_attested" does not exist` }),
        { status: 400 }
      )],
      ["500", async () => new Response("upstream failure", { status: 500 })],
      ["non-array body", async () => jsonResponse({ private_candidates_attested: true })],
      ["malformed JSON", async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })],
      ["network error", async () => { throw new Error("ECONNRESET"); }],
      ["timeout", async () => { const error = new Error("lookup timed out"); error.name = "ExternalLookupTimeoutError"; throw error; }],
    ];
    for (const [label, impl] of cases) {
      const warnings: string[] = [];
      const lookup = createPrivateCandidateAttestationLookup(
        { ...ENV, GREENHOUSE_RECRUITER_PRIVATE_CANDIDATE_ATTESTATION_WARN: "capture" },
        impl as unknown as typeof fetch,
        (message) => warnings.push(message)
      );
      assert.equal(await lookup(5085047004), false, label);
      assert.ok(!warnings.some((warning) => warning.includes("test-service-role-key")), `${label}: warnings must never carry the key`);
    }
  });

  it("warns once per failure class per lookup rather than once per read", async () => {
    const warnings: string[] = [];
    const lookup = createPrivateCandidateAttestationLookup(ENV, async () => new Response("boom", { status: 500 }), (message) => warnings.push(message));
    await lookup(1);
    await lookup(2);
    await lookup(3);
    assert.equal(warnings.length, 1, "one warning per distinct failure class, not one per read");
  });

  it("returns false without a request when the directory is not Supabase-backed, or the id is not a positive integer", async () => {
    let calls = 0;
    const unconfigured = createPrivateCandidateAttestationLookup({} as NodeJS.ProcessEnv, async () => { calls += 1; return jsonResponse([]); });
    assert.equal(await unconfigured(5085047004), false);
    const configured = createPrivateCandidateAttestationLookup(ENV, async () => { calls += 1; return jsonResponse([{ private_candidates_attested: true }]); });
    assert.equal(await configured(0), false);
    assert.equal(await configured(-1), false);
    assert.equal(await configured(1.5), false);
    assert.equal(calls, 0, "neither an unconfigured directory nor an invalid id may reach the network");
  });
});

// ---------------------------------------------------------------------------
// B13 — the provider stamp
// ---------------------------------------------------------------------------

function rawReader(handler: (path: string, params?: Record<string, unknown>) => unknown): RawReadClient {
  return {
    async read<T>(path: string, params?: Record<string, unknown>) {
      return { data: handler(path, params) as T, nextCursor: null };
    },
  };
}

describe("B13: the permission-provider attestation stamp", () => {
  // A site admin: absent from /user_job_permissions except for one explicit Private Job Admin grant
  // on job 7, `site_admin: true` on /users, and no confidential jobs in the tenant.
  function siteAdminChain() {
    const raw = rawReader((path, params) => {
      if (path === "/users") return [{ id: 100, site_admin: true, deactivated: false }];
      if (path === "/jobs") return [];
      if (path === "/user_job_permissions") {
        return String(params?.user_ids) === "100" ? [{ user_id: 100, job_id: 7, role_id: 900 }] : [];
      }
      if (path === "/user_roles") return [{ id: 900, name: "Private", role_type: "job_admin" }];
      return [];
    });
    const base = createHarvestPermissionProvider({ rawReader: raw });
    return { base, chained: createSiteAdminAwarePermissionProvider({ base, rawReader: raw }) };
  }

  it("stamps an attested all-access answer from the site-admin path", async () => {
    const { base, chained } = siteAdminChain();
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => true });
    const scope = await stamp.getPermittedJobIds(100) as { kind: string; privateCandidatesAttested?: boolean };
    assert.equal(scope.kind, "all");
    assert.equal(scope.privateCandidatesAttested, true);
  });

  it("stamps an unattested all-access answer with the actor's explicit private-capable jobs", async () => {
    const { base, chained } = siteAdminChain();
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => false });
    const scope = await stamp.getPermittedJobIds(100) as {
      kind: string;
      privateCandidatesAttested?: boolean;
      privateCapableJobIds?: ReadonlySet<number>;
    };
    assert.equal(scope.kind, "all");
    assert.equal(scope.privateCandidatesAttested, false);
    assert.deepEqual([...(scope.privateCapableJobIds ?? [])], [7],
      "an unattested all-access actor keeps the private access their per-job Greenhouse roles grant");
  });

  it("stamps an all-access answer that came from the base provider's all-jobs role marker", async () => {
    const raw = rawReader((path) => {
      if (path === "/users") return [{ id: 100, site_admin: false }];
      if (path === "/user_job_permissions") return [{ user_id: 100, role: { name: "All Jobs" } }];
      return [];
    });
    const base = createHarvestPermissionProvider({ rawReader: raw });
    const chained = createSiteAdminAwarePermissionProvider({ base, rawReader: raw });
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => true });
    const scope = await stamp.getPermittedJobIds(100) as { kind: string; privateCandidatesAttested?: boolean };
    assert.equal(scope.kind, "all");
    assert.equal(scope.privateCandidatesAttested, true);
  });

  it("leaves a job-scoped answer untouched and never asks for an attestation", async () => {
    let asked = 0;
    const raw = rawReader((path, params) => {
      if (path === "/users") return [{ id: 100, site_admin: false }];
      if (path === "/user_job_permissions") return String(params?.user_ids) === "100" ? [{ user_id: 100, job_id: 3 }] : [];
      return [];
    });
    const base = createHarvestPermissionProvider({ rawReader: raw });
    const chained = createSiteAdminAwarePermissionProvider({ base, rawReader: raw });
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => { asked += 1; return true; } });
    const scope = await stamp.getPermittedJobIds(100);
    assert.ok(scope instanceof Set || (scope as { kind?: string }).kind === "jobs");
    assert.equal(asked, 0, "a job-scoped actor has no org-wide grant to attest");
  });

  it("never mutates the object the chain returned, and hands back a fresh object each call", async () => {
    const chainedScope: Record<string, unknown> = { kind: "all" };
    const chained = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return chainedScope as never; } };
    const base = { async getPermittedJobIds(): Promise<PermissionLookupResult> { return new Set<number>(); } };
    const stamp = createPrivateCandidateAttestationStamp({ chained, base, isAttested: async () => true });
    const first = await stamp.getPermittedJobIds(100);
    const second = await stamp.getPermittedJobIds(100);
    assert.notEqual(first, chainedScope, "stamping must never write onto the memoized chain answer");
    assert.notEqual(first, second);
    assert.deepEqual(Object.keys(chainedScope), ["kind"], "the chain's own object is unchanged");
  });
});

// ---------------------------------------------------------------------------
// B10 — the identity writers
// ---------------------------------------------------------------------------

describe("B10: identity writers and the attestation columns", () => {
  it("bootstrap's upsert payload carries none of the three columns — an upsert must never clear a live attestation", () => {
    const plan = buildIdentityBootstrapPlan({
      rosterEmails: ["someone@turing.com"],
      greenhouseUsers: [{ id: 5085047004, primary_email: "someone@turing.com" }],
      allowedDomains: ["turing.com"],
      source: "operator_bootstrap",
      generatedAt: "2026-09-03T00:00:00.000Z",
    });
    assert.equal(plan.resolved.length, 1, plan.denied.map((entry) => entry.reason).join("; "));
    const keys = Object.keys(plan.resolved[0]!.row);
    for (const column of PRIVATE_CANDIDATE_ATTESTATION_COLUMNS) {
      assert.ok(!keys.includes(column), `re-bootstrapping a recruiter must not resurrect or clear ${column}`);
    }
  });

  it("the oauth enrollment insert carries none of the three columns — a new enrollment takes the database default", () => {
    // Enrollment inserts exactly the bootstrap row shape (oauth-enroll.ts builds it through
    // buildIdentityBootstrapPlan and POSTs `entry.row`), so the assertion above is the same lock;
    // this one holds the source-level fact that nothing else is added on the enrollment path.
    const source = readFileSync(join(HERE, "../src/oauth-enroll.ts"), "utf8");
    for (const column of PRIVATE_CANDIDATE_ATTESTATION_COLUMNS) {
      assert.ok(!source.includes(column), `oauth-enroll.ts must not write ${column}`);
    }
  });

  it("reconciliation's deprovision PATCH clears all three columns", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const plan = buildIdentityReconciliationPlan({
      directoryRows: [{ greenhouseUserId: 5085047004, primaryEmail: "gone@turing.com", status: "resolved" }],
      greenhouseUsers: [{ id: 5085047004, primary_email: "gone@turing.com", deactivated: true }],
      rosterComplete: true,
      rosterAsOf: "2026-09-03T00:00:00.000Z",
    });
    assert.equal(plan.revoked.length + plan.tombstoned.length, 1);
    await applyIdentityReconciliationPlan(plan, {
      supabaseUrl: SUPABASE_URL,
      apiKey: "test-service-role-key",
      appliedAt: "2026-09-03T00:00:00.000Z",
      fetchImpl: (async (_input: unknown, init: RequestInit) => {
        if (init?.method === "PATCH") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse([]);
      }) as unknown as typeof fetch,
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.private_candidates_attested, false);
    assert.equal(bodies[0]!.private_candidates_attested_at, null);
    assert.equal(
      bodies[0]!.private_candidates_attested_by,
      "identity_directory_reconciliation:revoke",
      "a deprovisioned recruiter's attestation is cleared, and the clearing names its cause"
    );
  });
});
