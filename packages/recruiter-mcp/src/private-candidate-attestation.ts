import type { PermissionScope } from "../../scoped-core/src/index.js";
import { DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS, fetchWithTimeout, readLookupTimeoutMs } from "./fetch-timeout.js";
import {
  assertCanonicalSupabaseProjectRef,
  normalizeOptionalSupabaseIdentifier,
  normalizeSupabaseApiKey,
} from "./supabase-config.js";

/**
 * The private-candidate attestation (CLO-273).
 *
 * Greenhouse gates a private candidate on a USER-SPECIFIC permission ("Can create and view private
 * candidates") that Harvest v3 does not expose. The read plane can see that an actor is a site
 * admin, or holds an all-jobs role — neither of which is that permission — so an all-access actor
 * used to receive every private candidate in the tenant on the strength of an inference Greenhouse
 * itself does not make. This module supplies the missing input: a per-directory-row attestation an
 * operator records with `greenhouse-recruiter-attest-private-candidates`.
 *
 * Two pieces live here:
 *   - the LOOKUP, one PostgREST read that answers "has an operator attested this user";
 *   - the provider STAMP, which puts the answer on the permission scope so the scoped core can gate
 *     on it without ever learning how the directory is stored.
 *
 * Deliberately independent of `identity.ts`'s resolver. That resolver's PostgREST select is a fixed
 * list, and its undefined-column fallback only understands the row-id column — a new column in that
 * select would be misclassified on a project where the migration has not landed and end in a thrown
 * identity outage (identity.ts:447). A separate read costs one request and cannot take identity
 * resolution down with it.
 */

export const PRIVATE_CANDIDATES_ATTESTED_COLUMN = "private_candidates_attested";
export const PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN = "private_candidates_attested_at";
export const PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN = "private_candidates_attested_by";

/** The three columns migration 0008 adds. Exported so the writer-lock tests name one source. */
export const PRIVATE_CANDIDATE_ATTESTATION_COLUMNS: readonly string[] = [
  PRIVATE_CANDIDATES_ATTESTED_COLUMN,
  PRIVATE_CANDIDATES_ATTESTED_AT_COLUMN,
  PRIVATE_CANDIDATES_ATTESTED_BY_COLUMN,
];

export type PrivateCandidateAttestationLookup = (
  greenhouseUserId: number,
  signal?: AbortSignal
) => Promise<boolean>;

/**
 * Where the attestation is read from. The identity directory's own Supabase pair, its table name
 * and its column overrides — the same configuration the resolver takes, read here so a custom table
 * stays supported without the resolver having to carry the column.
 */
export interface PrivateCandidateAttestationAccess {
  baseUrl: string;
  apiKey: string;
  table: string;
  greenhouseUserIdColumn: string;
  statusColumn: string;
  resolvedStatus: string;
  timeoutMs: number;
}

export function readPrivateCandidateAttestationAccess(
  env: NodeJS.ProcessEnv
): PrivateCandidateAttestationAccess | null {
  const supabaseUrl = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_URL;
  const apiKey = env.GREENHOUSE_RECRUITER_IDENTITY_SUPABASE_KEY;
  // A directory that is not Supabase-backed (the JSON/static configurations) carries no attestation
  // to read. That is not an error and must not throw here: it resolves to "unattested", which is
  // the fail-closed direction — private candidates stay withheld from an org-wide actor whose
  // permission we cannot establish.
  if (!supabaseUrl || !apiKey) return null;
  return {
    baseUrl: assertCanonicalSupabaseProjectRef(supabaseUrl, "Supabase identity directory"),
    apiKey: normalizeSupabaseApiKey(apiKey, "Supabase identity directory"),
    table: normalizeOptionalSupabaseIdentifier(
      env.GREENHOUSE_RECRUITER_IDENTITY_TABLE,
      "recruiter_identity_directory",
      "Supabase identity directory table"
    ),
    greenhouseUserIdColumn: normalizeOptionalSupabaseIdentifier(
      env.GREENHOUSE_RECRUITER_IDENTITY_GREENHOUSE_USER_ID_COLUMN,
      "greenhouse_user_id",
      "Supabase identity Greenhouse user id column"
    ),
    statusColumn: normalizeOptionalSupabaseIdentifier(
      env.GREENHOUSE_RECRUITER_IDENTITY_STATUS_COLUMN,
      "status",
      "Supabase identity status column"
    ),
    resolvedStatus: env.GREENHOUSE_RECRUITER_IDENTITY_RESOLVED_STATUS?.trim() || "resolved",
    timeoutMs: readLookupTimeoutMs(
      env.GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS,
      "GREENHOUSE_RECRUITER_IDENTITY_LOOKUP_TIMEOUT_MS",
      DEFAULT_EXTERNAL_LOOKUP_TIMEOUT_MS
    ),
  };
}

/**
 * Build the attestation lookup.
 *
 * Answers `true` ONLY when exactly one resolved directory row comes back and its flag is strictly
 * `true`. Every other outcome — no row, two rows (a duplicate the unique index should prevent but
 * which must never be resolved by picking one), a 400 because the migration has not been applied
 * yet, a 5xx, a timeout, a malformed body, a network error — answers `false` and never throws.
 * That is what lets the migration and the deploy land in either order: before the columns exist the
 * read fails, the answer is "unattested", and the only consequence is that private candidates stay
 * withheld from org-wide actors until the operator attests them.
 *
 * Failures are warned about ONCE per distinct class per lookup instance. The lookup is built once
 * per env fingerprint in `scoped-reader.ts`, so that is once per process — a per-request warning on
 * a dead column would be a log flood, and no warning at all would make a silent withhold
 * undiagnosable. Never logs the URL or the key.
 */
export function createPrivateCandidateAttestationLookup(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  warn: (message: string) => void = (message) => console.warn(message)
): PrivateCandidateAttestationLookup {
  let access: PrivateCandidateAttestationAccess | null;
  try {
    access = readPrivateCandidateAttestationAccess(env);
  } catch (error) {
    // A misconfigured directory pair is the identity layer's problem to report; here it can only
    // mean "cannot establish the attestation", which is unattested.
    access = null;
  }
  const warnedClasses = new Set<string>();
  const warnOnce = (failureClass: string, detail: string): void => {
    if (warnedClasses.has(failureClass)) return;
    warnedClasses.add(failureClass);
    warn(`[private-candidate-attestation] ${failureClass}: ${detail} — treating org-wide actors as unattested.`);
  };

  if (access === null) {
    return async () => false;
  }
  const resolved = access;

  return async function isPrivateCandidateAttested(greenhouseUserId, signal): Promise<boolean> {
    if (!Number.isSafeInteger(greenhouseUserId) || greenhouseUserId <= 0) return false;
    const url = new URL(`${resolved.baseUrl}/rest/v1/${encodeURIComponent(resolved.table)}`);
    url.searchParams.set("select", PRIVATE_CANDIDATES_ATTESTED_COLUMN);
    url.searchParams.set(resolved.greenhouseUserIdColumn, `eq.${greenhouseUserId}`);
    url.searchParams.set(resolved.statusColumn, `eq.${resolved.resolvedStatus}`);
    // Two, not one: a second row means the directory holds a duplicate for this user, and picking
    // the first would let a stale row grant access. Read enough to detect it, then refuse.
    url.searchParams.set("limit", "2");

    let response: Response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: "GET",
          headers: {
            apikey: resolved.apiKey,
            authorization: `Bearer ${resolved.apiKey}`,
            accept: "application/json",
          },
          ...(signal ? { signal } : {}),
        },
        resolved.timeoutMs,
        "Private-candidate attestation lookup"
      );
    } catch (error) {
      warnOnce("lookup_failed", errorLabel(error));
      return false;
    }
    if (!response.ok) {
      warnOnce(`http_${response.status}`, `the identity directory answered ${response.status}`);
      return false;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      warnOnce("malformed_body", "the identity directory returned a body that is not JSON");
      return false;
    }
    if (!Array.isArray(body)) {
      warnOnce("non_array_body", "the identity directory returned a non-array response");
      return false;
    }
    if (body.length !== 1) {
      // Zero rows is the ordinary answer for an actor with no directory row and needs no warning
      // beyond its class; two rows is a directory defect worth surfacing.
      if (body.length > 1) warnOnce("duplicate_rows", "more than one resolved row matched this Greenhouse user id");
      return false;
    }
    const row = body[0] as Record<string, unknown> | null;
    return isRecord(row) && row[PRIVATE_CANDIDATES_ATTESTED_COLUMN] === true;
  };
}

function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "unknown error";
}

// ---------------------------------------------------------------------------
// The permission-provider stamp
// ---------------------------------------------------------------------------

/** The minimal shape both the base provider and the site-admin chain satisfy. */
export interface PermissionProviderLike {
  getPermittedJobIds(greenhouseUserId: number, signal?: AbortSignal): Promise<unknown>;
}

export interface PrivateCandidateAttestationStampOptions {
  /** The full provider chain whose answer is being stamped (site-admin wrapper over the base). */
  chained: PermissionProviderLike;
  /**
   * The BASE per-job-grant provider. Consulted only for an UNATTESTED all-access actor, to recover
   * the `privateCapableJobIds` the site-admin path discards: Greenhouse grants private visibility
   * per job through the built-in "Private" Job Admin role as well as org-wide, and an actor who
   * holds that role on a req is entitled to its private candidates whether or not anyone has
   * attested them org-wide. Withholding those would deny access the organization already granted.
   */
  base: PermissionProviderLike;
  isAttested: PrivateCandidateAttestationLookup;
}

/**
 * Wrap a permission-provider chain so every `{ kind: "all" }` answer carries the actor's
 * private-candidate attestation.
 *
 * This is the ONE place the flag is stamped. The three all-access constructors in
 * `site-admin-permission.ts` and the base provider's all-jobs marker all funnel through here, so a
 * new all-access path cannot be added without inheriting the gate.
 *
 * Never mutates the answer it was given: the chain's object may be memoized (and in production it
 * is, for `readPermissionTtlMs`), and writing onto it would stamp one actor's attestation onto a
 * shared object. A fresh object is returned every call.
 *
 * `{ kind: "jobs" }` and bare-Set answers are returned untouched and cost no lookup — a job-scoped
 * actor has no org-wide grant to attest, and their private access is already decided per job.
 */
export function createPrivateCandidateAttestationStamp(
  options: PrivateCandidateAttestationStampOptions
): PermissionProviderLike {
  return {
    async getPermittedJobIds(greenhouseUserId: number, signal?: AbortSignal): Promise<unknown> {
      const scope = await options.chained.getPermittedJobIds(greenhouseUserId, signal);
      if (!isAllAccessScope(scope)) return scope;
      if (await options.isAttested(greenhouseUserId, signal)) {
        return { ...scope, privateCandidatesAttested: true };
      }
      const privateCapableJobIds = await explicitPrivateCapableJobIds(options.base, greenhouseUserId, signal);
      return {
        ...scope,
        privateCandidatesAttested: false,
        ...(privateCapableJobIds && privateCapableJobIds.size > 0 ? { privateCapableJobIds } : {}),
      };
    },
  };
}

function isAllAccessScope(value: unknown): value is PermissionScope & { kind: "all" } {
  return isRecord(value) && value.kind === "all";
}

/**
 * The jobs this actor holds through a private-capable Greenhouse role, read from their EXPLICIT
 * per-job grants.
 *
 * Fails soft to `undefined`: if the base provider cannot answer, no job is treated as
 * private-capable and the unattested actor sees no private candidates at all, which is the same
 * direction every other failure in this layer takes. It can only under-grant, never over-grant.
 */
async function explicitPrivateCapableJobIds(
  base: PermissionProviderLike,
  greenhouseUserId: number,
  signal?: AbortSignal
): Promise<ReadonlySet<number> | undefined> {
  let granted: unknown;
  try {
    granted = await base.getPermittedJobIds(greenhouseUserId, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return undefined;
  }
  if (!isRecord(granted) || granted.kind !== "jobs") return undefined;
  const privateCapable = (granted as Extract<PermissionScope, { kind: "jobs" }>).privateCapableJobIds;
  return privateCapable === undefined ? undefined : new Set(privateCapable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
