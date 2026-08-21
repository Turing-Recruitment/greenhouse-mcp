import { createHash } from "node:crypto";
import { fetchWithTimeout } from "./fetch-timeout.js";
import type { OauthAuthorizationConfig } from "./oauth-config.js";
import type { RecruiterClient } from "./types.js";

// Durable OAuth grant store over the existing Supabase/PostgREST conventions (the identity
// directory's read shape, the session-revocation write shape). One table holds both one-time
// authorization codes and rotating refresh tokens; see supabase/migrations/0006.
//
// The store deals in RAW secrets at its boundary and hashes internally, so hash-only-at-rest
// holds by construction: no caller can accidentally persist a code or refresh-token string,
// and the sha256 CHECK constraint in the migration backstops the same invariant in Postgres.

export type OauthGrantKind = "code" | "refresh";

export interface OauthGrantRecordInput {
  kind: OauthGrantKind;
  /** The raw one-time secret handed to the client; only its sha256 is stored. */
  secret: string;
  familyId: string;
  clientId: string;
  redirectUri?: string;
  codeChallenge?: string;
  email: string;
  surface: "claude_desktop" | "chatgpt_desktop";
  client: RecruiterClient;
  resource: string;
  scope?: string;
  /** ISO timestamp. */
  expiresAt: string;
  /** The access-token jti minted with this refresh row, so the kill switch can reach it. */
  accessJti?: string;
}

export interface OauthGrantRow {
  kind: OauthGrantKind;
  tokenHash: string;
  familyId: string;
  clientId: string;
  redirectUri?: string;
  codeChallenge?: string;
  email: string;
  surface: string;
  client: string;
  resource: string;
  scope?: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export type OauthGrantConsumeResult =
  | { status: "consumed"; grant: OauthGrantRow }
  | { status: "not_consumable" };

/** The fields a rotated refresh grant hands back so the caller can mint the access-token pair. */
export interface OauthRotatedGrant {
  familyId: string;
  email: string;
  surface: string;
  client: string;
  resource: string;
  scope?: string;
}

export interface OauthRefreshRedeemInput {
  /** The raw refresh token the client presented; only its sha256 crosses the wire. */
  presentedSecret: string;
  clientId: string;
  /** Epoch millis; the store renders the transaction's `now` as an ISO instant. */
  now: number;
  /** The raw successor refresh secret to seat on a successful rotation; hashed at rest. */
  successorSecret: string;
  /** ISO timestamp for the successor's expiry. */
  successorExpiresAt: string;
  /** The access-token jti minted with the successor, persisted so reuse can revoke it. */
  successorJti: string;
}

export type OauthRefreshRedeemResult =
  | { status: "rotated"; grant: OauthRotatedGrant }
  /** A reused (already-rotated) refresh token: the family was revoked as a durable property. */
  | { status: "reuse_revoked" }
  /** Never issued, wrong kind, expired, wrong client, or a family already dead — invalid_grant. */
  | { status: "not_redeemable"; detail: OauthRefreshNotRedeemableDetail };

export type OauthRefreshNotRedeemableDetail =
  | "not_found"
  | "wrong_kind"
  | "expired"
  | "client_mismatch"
  | "not_redeemable";

export interface OauthGrantStore {
  insertGrant(input: OauthGrantRecordInput): Promise<void>;
  /**
   * Atomically mark a one-time authorization code consumed and return it (RPC redeem_oauth_code,
   * single-winner under the family lock). Not consumable — already consumed, revoked, a revoked
   * family, or never issued — is the caller's replay signal (invalid_grant). The verifier checks
   * (PKCE, redirect, client, expiry) stay in the caller, AFTER this burn, so no retry oracle.
   */
  consumeGrant(secret: string): Promise<OauthGrantConsumeResult>;
  /**
   * Atomically rotate a refresh token (RPC redeem_oauth_refresh). Consume, reuse-detection,
   * family revocation, and the successor seat all happen in ONE transaction under a per-family
   * advisory lock, so a concurrent reuse can never leave a live successor behind a killed family,
   * and a transient failure rolls back rather than burning the presented token without a heir.
   */
  redeemRefresh(input: OauthRefreshRedeemInput): Promise<OauthRefreshRedeemResult>;
}

export interface OauthGrantStoreOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function hashOauthGrantSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function createOauthGrantStore(
  config: OauthAuthorizationConfig,
  options: OauthGrantStoreOptions = {}
): OauthGrantStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const baseUrl = `${config.grantsSupabaseUrl}/rest/v1/${encodeURIComponent(config.grantsTable)}`;
  const rpcUrl = (fn: string) => new URL(`${config.grantsSupabaseUrl}/rest/v1/rpc/${fn}`);
  const headers = {
    apikey: config.grantsSupabaseKey,
    authorization: `Bearer ${config.grantsSupabaseKey}`,
    accept: "application/json",
    "content-type": "application/json",
  };

  return {
    async insertGrant(input) {
      const row: Record<string, unknown> = {
        token_hash: hashOauthGrantSecret(input.secret),
        grant_kind: input.kind,
        family_id: input.familyId,
        client_id: input.clientId,
        redirect_uri: input.redirectUri ?? null,
        code_challenge: input.codeChallenge ?? null,
        email: input.email,
        surface: input.surface,
        client: input.client,
        resource: input.resource,
        scope: input.scope ?? null,
        access_jti: input.accessJti ?? null,
        expires_at: input.expiresAt,
      };
      const response = await fetchWithTimeout(fetchImpl, new URL(baseUrl), {
        method: "POST",
        headers: { ...headers, prefer: "return=minimal" },
        body: JSON.stringify(row),
      }, config.lookupTimeoutMs, "OAuth grant insert");
      if (!response.ok) {
        throw new Error(`OAuth grant insert failed with status ${response.status}.`);
      }
    },

    async consumeGrant(secret) {
      const response = await fetchWithTimeout(fetchImpl, rpcUrl("redeem_oauth_code"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_token_hash: hashOauthGrantSecret(secret),
          p_now: new Date(now()).toISOString(),
        }),
      }, config.lookupTimeoutMs, "OAuth grant consume");
      if (!response.ok) {
        throw new Error(`OAuth grant consume failed with status ${response.status}.`);
      }
      const result = await readRpcObject(response, "OAuth grant consume");
      if (result["status"] !== "consumed") {
        return { status: "not_consumable" };
      }
      return { status: "consumed", grant: toGrantRow(result) };
    },

    async redeemRefresh(input) {
      const response = await fetchWithTimeout(fetchImpl, rpcUrl("redeem_oauth_refresh"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_token_hash: hashOauthGrantSecret(input.presentedSecret),
          p_client_id: input.clientId,
          p_now: new Date(input.now).toISOString(),
          p_successor_hash: hashOauthGrantSecret(input.successorSecret),
          p_successor_expires_at: input.successorExpiresAt,
          p_successor_jti: input.successorJti,
        }),
      }, config.lookupTimeoutMs, "OAuth refresh rotation");
      if (!response.ok) {
        throw new Error(`OAuth refresh rotation failed with status ${response.status}.`);
      }
      const result = await readRpcObject(response, "OAuth refresh rotation");
      const status = result["status"];
      if (status === "rotated") {
        return {
          status: "rotated",
          grant: {
            familyId: asRequiredString(result, "family_id"),
            email: asRequiredString(result, "email"),
            surface: asRequiredString(result, "surface"),
            client: asRequiredString(result, "client"),
            resource: asRequiredString(result, "resource"),
            ...(typeof result["scope"] === "string" ? { scope: result["scope"] } : {}),
          },
        };
      }
      if (status === "reuse_revoked") {
        return { status: "reuse_revoked" };
      }
      return { status: "not_redeemable", detail: toNotRedeemableDetail(status) };
    },
  };
}

function toNotRedeemableDetail(status: unknown): OauthRefreshNotRedeemableDetail {
  switch (status) {
    case "not_found":
    case "wrong_kind":
    case "expired":
    case "client_mismatch":
      return status;
    default:
      return "not_redeemable";
  }
}

// A scalar `returns jsonb` function comes back from PostgREST as the object itself; tolerate a
// single-element array wrapper too, so a config quirk cannot turn a valid result into a throw.
async function readRpcObject(response: Response, label: string): Promise<Record<string, unknown>> {
  const data = await response.json() as unknown;
  const value = Array.isArray(data) ? data[0] : data;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an unexpected response shape.`);
  }
  return value as Record<string, unknown>;
}

function toGrantRow(row: Record<string, unknown>): OauthGrantRow {
  return {
    kind: row["grant_kind"] === "refresh" ? "refresh" : "code",
    tokenHash: asRequiredString(row, "token_hash"),
    familyId: asRequiredString(row, "family_id"),
    clientId: asRequiredString(row, "client_id"),
    ...(typeof row["redirect_uri"] === "string" ? { redirectUri: row["redirect_uri"] } : {}),
    ...(typeof row["code_challenge"] === "string" ? { codeChallenge: row["code_challenge"] } : {}),
    email: asRequiredString(row, "email"),
    surface: asRequiredString(row, "surface"),
    client: asRequiredString(row, "client"),
    resource: asRequiredString(row, "resource"),
    ...(typeof row["scope"] === "string" ? { scope: row["scope"] } : {}),
    expiresAt: asRequiredString(row, "expires_at"),
    ...(typeof row["consumed_at"] === "string" ? { consumedAt: row["consumed_at"] } : {}),
    ...(typeof row["revoked_at"] === "string" ? { revokedAt: row["revoked_at"] } : {}),
  };
}

function asRequiredString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OAuth grant row is missing required column ${column}.`);
  }
  return value;
}
