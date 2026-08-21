import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOauthGrantStore, hashOauthGrantSecret } from "../src/oauth-grant-store.js";
import { readOauthAuthorizationConfig } from "../src/oauth-config.js";

const STRONG_SESSION_SECRET = "session-secret-value-with-at-least-32-chars";
const OAUTH_SIGNING_SECRET = "oauth-signing-secret-value-with-at-least-32-chars";
const ISSUER = "https://recruiter-mcp.example.com";
const RESOURCE_URL = "https://recruiter-mcp.example.com/mcp";
const GRANTS_ORIGIN = "https://ibxvxmfhovmththllwoi.supabase.co";

function oauthEnv(): NodeJS.ProcessEnv {
  return {
    GREENHOUSE_RECRUITER_SESSION_SECRET: STRONG_SESSION_SECRET,
    GREENHOUSE_RECRUITER_ALLOWED_EMAIL_DOMAINS: "example.com",
    GREENHOUSE_RECRUITER_OAUTH_SIGNING_SECRET: OAUTH_SIGNING_SECRET,
    GREENHOUSE_RECRUITER_OAUTH_ISSUER: ISSUER,
    GREENHOUSE_RECRUITER_OAUTH_RESOURCE_URL: RESOURCE_URL,
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_ID: "google-client-id-value.apps.googleusercontent.com",
    GREENHOUSE_RECRUITER_OAUTH_GOOGLE_CLIENT_SECRET: "google-client-secret-value",
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_URL: GRANTS_ORIGIN,
    GREENHOUSE_RECRUITER_OAUTH_SUPABASE_KEY: "oauth-grants-key-value",
  } as NodeJS.ProcessEnv;
}

function requireConfig() {
  const result = readOauthAuthorizationConfig(oauthEnv());
  assert.equal(result.state, "configured");
  if (result.state !== "configured") throw new Error("unreachable");
  return result.config;
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function capturingFetch(
  responder: (request: CapturedRequest) => Response
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(captured);
    return responder(captured);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const SAMPLE_GRANT_INPUT = {
  kind: "code" as const,
  secret: "raw-authorization-code-secret-value-that-must-never-be-stored",
  familyId: "11111111-2222-4333-8444-555555555555",
  clientId: "https://claude.ai/oauth/claude-code-client-metadata",
  redirectUri: "http://localhost:53682/callback",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  email: "recruiter@example.com",
  surface: "claude_desktop" as const,
  client: "claude_code" as const,
  resource: RESOURCE_URL,
  scope: "offline_access",
  expiresAt: "2026-08-18T12:05:00.000Z",
};

describe("OAuth grant store (slice 4)", () => {
  it("stores only the sha256 of a grant secret — the raw secret never leaves the process", async () => {
    const { fetchImpl, requests } = capturingFetch(() => new Response("", { status: 201 }));
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });

    await store.insertGrant(SAMPLE_GRANT_INPUT);

    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.method, "POST");
    assert.match(request.url, /\/rest\/v1\/recruiter_mcp_oauth_grants/);
    const expectedHash = createHash("sha256").update(SAMPLE_GRANT_INPUT.secret, "utf8").digest("hex");
    assert.equal(hashOauthGrantSecret(SAMPLE_GRANT_INPUT.secret), expectedHash);
    const row = JSON.parse(request.body) as Record<string, unknown>;
    assert.equal(row["token_hash"], expectedHash);
    assert.equal(row["grant_kind"], "code");
    assert.equal(row["family_id"], SAMPLE_GRANT_INPUT.familyId);
    assert.equal(row["client_id"], SAMPLE_GRANT_INPUT.clientId);
    assert.equal(row["code_challenge"], SAMPLE_GRANT_INPUT.codeChallenge);
    assert.equal(row["email"], "recruiter@example.com");
    assert.equal(row["resource"], RESOURCE_URL);
    assert.equal(row["expires_at"], SAMPLE_GRANT_INPUT.expiresAt);
    const everything = `${request.url}\n${request.body}\n${JSON.stringify(request.headers)}`;
    assert.ok(!everything.includes(SAMPLE_GRANT_INPUT.secret), "raw grant secret must never be sent");
  });

  it("consumes a code through the redeem_oauth_code RPC and reports a spent code as not consumable", async () => {
    const config = requireConfig();
    const hash = hashOauthGrantSecret(SAMPLE_GRANT_INPUT.secret);
    let consumed = false;
    const { fetchImpl, requests } = capturingFetch((request) => {
      assert.equal(request.method, "POST");
      assert.match(request.url, /\/rest\/v1\/rpc\/redeem_oauth_code/);
      if (consumed) {
        return new Response(JSON.stringify({ status: "not_consumable" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      consumed = true;
      return new Response(JSON.stringify({
        status: "consumed",
        token_hash: hash,
        grant_kind: "code",
        family_id: SAMPLE_GRANT_INPUT.familyId,
        client_id: SAMPLE_GRANT_INPUT.clientId,
        redirect_uri: SAMPLE_GRANT_INPUT.redirectUri,
        code_challenge: SAMPLE_GRANT_INPUT.codeChallenge,
        email: SAMPLE_GRANT_INPUT.email,
        surface: SAMPLE_GRANT_INPUT.surface,
        client: SAMPLE_GRANT_INPUT.client,
        resource: SAMPLE_GRANT_INPUT.resource,
        scope: SAMPLE_GRANT_INPUT.scope,
        expires_at: SAMPLE_GRANT_INPUT.expiresAt,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const store = createOauthGrantStore(config, { fetchImpl });

    const first = await store.consumeGrant(SAMPLE_GRANT_INPUT.secret);
    assert.equal(first.status, "consumed");
    if (first.status !== "consumed") throw new Error("unreachable");
    assert.equal(first.grant.tokenHash, hash);
    assert.equal(first.grant.kind, "code");
    assert.equal(first.grant.familyId, SAMPLE_GRANT_INPUT.familyId);
    assert.equal(first.grant.codeChallenge, SAMPLE_GRANT_INPUT.codeChallenge);
    assert.equal(first.grant.email, "recruiter@example.com");

    const second = await store.consumeGrant(SAMPLE_GRANT_INPUT.secret);
    assert.equal(second.status, "not_consumable");

    // The hash rides in the RPC body, never the raw secret.
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    assert.equal(body["p_token_hash"], hash);
    assert.ok(typeof body["p_now"] === "string" && body["p_now"].length > 0);
    const everything = requests.map((r) => `${r.url}\n${r.body}`).join("\n");
    assert.ok(!everything.includes(SAMPLE_GRANT_INPUT.secret), "raw grant secret must never be sent");
  });

  it("rotates a refresh token through the redeem_oauth_refresh RPC — presented AND successor hashed, never raw", async () => {
    const presented = "the-outstanding-refresh-token-secret-value-abcdefghij";
    const successor = "the-freshly-minted-successor-refresh-secret-value-klmno";
    const presentedHash = hashOauthGrantSecret(presented);
    const successorHash = hashOauthGrantSecret(successor);
    const { fetchImpl, requests } = capturingFetch((request) => {
      assert.equal(request.method, "POST");
      assert.match(request.url, /\/rest\/v1\/rpc\/redeem_oauth_refresh/);
      return new Response(JSON.stringify({
        status: "rotated",
        family_id: SAMPLE_GRANT_INPUT.familyId,
        email: SAMPLE_GRANT_INPUT.email,
        surface: SAMPLE_GRANT_INPUT.surface,
        client: SAMPLE_GRANT_INPUT.client,
        resource: SAMPLE_GRANT_INPUT.resource,
        scope: SAMPLE_GRANT_INPUT.scope,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });

    const result = await store.redeemRefresh({
      presentedSecret: presented,
      clientId: SAMPLE_GRANT_INPUT.clientId,
      now: Date.parse("2026-08-18T12:00:00.000Z"),
      successorSecret: successor,
      successorExpiresAt: "2026-09-17T12:00:00.000Z",
      successorJti: "successor-access-token-jti-value",
    });
    assert.equal(result.status, "rotated");
    if (result.status !== "rotated") throw new Error("unreachable");
    assert.equal(result.grant.familyId, SAMPLE_GRANT_INPUT.familyId);
    assert.equal(result.grant.email, "recruiter@example.com");
    assert.equal(result.grant.client, SAMPLE_GRANT_INPUT.client);
    assert.equal(result.grant.scope, SAMPLE_GRANT_INPUT.scope);

    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    assert.equal(body["p_token_hash"], presentedHash);
    assert.equal(body["p_successor_hash"], successorHash);
    assert.equal(body["p_client_id"], SAMPLE_GRANT_INPUT.clientId);
    assert.equal(body["p_successor_expires_at"], "2026-09-17T12:00:00.000Z");
    assert.equal(body["p_successor_jti"], "successor-access-token-jti-value");
    const everything = `${requests[0]!.url}\n${requests[0]!.body}`;
    assert.ok(!everything.includes(presented) && !everything.includes(successor), "raw refresh secrets must never be sent");
  });

  it("maps the RPC reuse and failure statuses onto the redeem result contract", async () => {
    const responder = (status: string) => capturingFetch(() =>
      new Response(JSON.stringify({ status }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const redeem = async (status: string) => {
      const { fetchImpl } = responder(status);
      const store = createOauthGrantStore(requireConfig(), { fetchImpl });
      return store.redeemRefresh({
        presentedSecret: "presented-refresh-secret-value-of-sufficient-length",
        clientId: SAMPLE_GRANT_INPUT.clientId,
        now: Date.now(),
        successorSecret: "successor-refresh-secret-value-of-sufficient-length",
        successorExpiresAt: "2026-09-17T12:00:00.000Z",
        successorJti: "successor-access-token-jti-value",
      });
    };

    assert.deepEqual(await redeem("reuse_revoked"), { status: "reuse_revoked" });
    assert.deepEqual(await redeem("expired"), { status: "not_redeemable", detail: "expired" });
    assert.deepEqual(await redeem("wrong_kind"), { status: "not_redeemable", detail: "wrong_kind" });
    assert.deepEqual(await redeem("client_mismatch"), { status: "not_redeemable", detail: "client_mismatch" });
    assert.deepEqual(await redeem("not_found"), { status: "not_redeemable", detail: "not_found" });
    assert.deepEqual(await redeem("not_redeemable"), { status: "not_redeemable", detail: "not_redeemable" });
  });

  it("surfaces PostgREST failures as errors instead of silently treating them as replays", async () => {
    const { fetchImpl } = capturingFetch(() => new Response("boom", { status: 500 }));
    const store = createOauthGrantStore(requireConfig(), { fetchImpl });
    await assert.rejects(() => store.consumeGrant(SAMPLE_GRANT_INPUT.secret), /status 500/);
    await assert.rejects(
      () => store.redeemRefresh({
        presentedSecret: "presented-refresh-secret-value-of-sufficient-length",
        clientId: SAMPLE_GRANT_INPUT.clientId,
        now: Date.now(),
        successorSecret: "successor-refresh-secret-value-of-sufficient-length",
        successorExpiresAt: "2026-09-17T12:00:00.000Z",
        successorJti: "successor-access-token-jti-value",
      }),
      /status 500/
    );
  });
});
