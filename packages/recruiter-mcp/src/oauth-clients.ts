import { fetchWithTimeout } from "./fetch-timeout.js";
import type { OauthAuthorizationConfig } from "./oauth-config.js";
import type { RecruiterClient, RecruiterSurface } from "./types.js";

// Client resolution for the OAuth sign-in layer. No dynamic client registration exists on this
// server (DCR is deprecated in the 2026-07-28 authorization spec and skipping it eliminates a
// registered-clients table): a client is identified by its HTTPS client-metadata-document URL
// (Claude hosted and Claude Code both publish one), or by the single env-listed static client
// an org Owner can paste into a connector's Advanced settings.
//
// The client_id -> RecruiterClient mapping is what feeds signed client identity to the write
// plane's attribution bridge, so the values here are RECRUITER vocabulary: the static ChatGPT
// client maps to "chatgpt_codex_host", never the action plane's "codex" — auth.ts's
// isClientSurfaceCompatible would reject "codex" outright, and the edge translation to
// action-plane names happens exactly once, in actionClientForRecruiterSession.

export const CLAUDE_CODE_CIMD_URL = "https://claude.ai/oauth/claude-code-client-metadata";
const CLAUDE_CIMD_ORIGIN = "https://claude.ai";

export type OauthClientResolution =
  | {
      status: "resolved";
      client: RecruiterClient;
      surface: Exclude<RecruiterSurface, "test">;
      clientId: string;
    }
  | { status: "invalid_client"; reason: string }
  | { status: "invalid_redirect"; reason: string };

export interface ResolveOauthClientInput {
  clientId: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export async function resolveOauthClient(
  config: OauthAuthorizationConfig,
  input: ResolveOauthClientInput
): Promise<OauthClientResolution> {
  const { clientId, redirectUri } = input;
  if (typeof clientId !== "string" || clientId.length === 0) {
    return { status: "invalid_client", reason: "client_id is required." };
  }
  if (typeof redirectUri !== "string" || redirectUri.length === 0) {
    return { status: "invalid_redirect", reason: "redirect_uri is required." };
  }

  // 1. The known Claude Code client, by exact CIMD literal. Its redirects are loopback with
  //    the PORT IGNORED in matching (RFC 8252 native-app loopback; the OS assigns the port),
  //    so no document fetch is needed or performed.
  if (clientId === CLAUDE_CODE_CIMD_URL) {
    if (!isLoopbackCallbackRedirect(redirectUri)) {
      return {
        status: "invalid_redirect",
        reason: "Claude Code redirects must be http://localhost/callback or http://127.0.0.1/callback (any port).",
      };
    }
    return { status: "resolved", client: "claude_code", surface: "claude_desktop", clientId };
  }

  // 2. The env-listed static client (ChatGPT / org-connector fallback), by exact id, with an
  //    exact redirect match against the env-registered list.
  if (config.staticClient !== undefined && clientId === config.staticClient.clientId) {
    if (!config.staticClient.redirectUris.includes(redirectUri)) {
      return {
        status: "invalid_redirect",
        reason: "redirect_uri is not registered for the static OAuth client.",
      };
    }
    return { status: "resolved", client: "chatgpt_codex_host", surface: "chatgpt_desktop", clientId };
  }

  // 3. Any other claude.ai-origin HTTPS metadata URL is treated as hosted Claude chat (the
  //    exact hosted CIMD literal is unknowable until observed live; the claude.ai origin is
  //    the trust boundary). Everything else is refused WITHOUT a fetch — the resolver must
  //    never be a proxy that requests attacker-chosen URLs.
  const metadataUrl = parseClaudeCimdUrl(clientId);
  if (metadataUrl === undefined) {
    return {
      status: "invalid_client",
      reason: "client_id must be the static client id or a https://claude.ai client-metadata URL.",
    };
  }
  const document = await fetchCimdDocument(metadataUrl, config, input.fetchImpl ?? fetch);
  if (document === undefined) {
    return { status: "invalid_client", reason: "Client metadata document could not be read." };
  }
  if (!isHttpsUrl(redirectUri)) {
    return { status: "invalid_redirect", reason: "Hosted client redirects must be HTTPS." };
  }
  if (!document.redirectUris.includes(redirectUri)) {
    return {
      status: "invalid_redirect",
      reason: "redirect_uri is not listed in the client metadata document.",
    };
  }
  return { status: "resolved", client: "claude_desktop_chat", surface: "claude_desktop", clientId };
}

function parseClaudeCimdUrl(clientId: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.origin !== CLAUDE_CIMD_ORIGIN) return undefined;
  if (url.username || url.password || url.hash) return undefined;
  return url;
}

interface CimdDocument {
  redirectUris: string[];
}

async function fetchCimdDocument(
  url: URL,
  config: OauthAuthorizationConfig,
  fetchImpl: typeof fetch
): Promise<CimdDocument | undefined> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: "GET",
      headers: { accept: "application/json" },
      // A redirect could walk off the trusted origin; refuse rather than follow.
      redirect: "error",
    }, config.lookupTimeoutMs, "Client metadata document fetch");
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const redirectUris = (parsed as { redirect_uris?: unknown }).redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return { redirectUris };
}

// Loopback callback matching with the port deliberately ignored: the client binds an
// OS-assigned port at authorization time, so only scheme, loopback host, and the /callback
// path participate in the comparison.
function isLoopbackCallbackRedirect(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return false;
  return url.pathname === "/callback";
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
