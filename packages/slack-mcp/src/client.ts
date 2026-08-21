/**
 * HTTP client for the Slack Web API.
 *
 * All Slack Web API methods use POST to https://slack.com/api/{method}.
 * Slack returns HTTP 200 for application-level errors — the `ok` field
 * in the response body determines success.
 *
 * Methods that accept structured data (blocks, attachments) use JSON.
 * All other methods use application/x-www-form-urlencoded.
 */

const BASE_URL = "https://slack.com/api";

// Methods that require JSON content type (they accept complex nested objects)
const JSON_METHODS = new Set(["chat.postMessage", "chat.update"]);

let botToken: string | null = null;
let tokenValidated = false;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function configure(token: string): void {
  botToken = token;
  tokenValidated = false;
}

function getToken(): string {
  if (!botToken) {
    throw new Error(
      "Slack client not configured. Set SLACK_BOT_TOKEN environment variable."
    );
  }
  return botToken;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackResponse<T = Record<string, unknown>> {
  ok: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function encodeFormBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  return params.toString();
}

function buildFetchOptions(
  method: string,
  token: string,
  body: Record<string, unknown>
): RequestInit {
  if (JSON_METHODS.has(method)) {
    return {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    };
  }
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: encodeFormBody(body),
  };
}

// ---------------------------------------------------------------------------
// Core request method
// ---------------------------------------------------------------------------

export async function slackPost<T = Record<string, unknown>>(
  method: string,
  body: Record<string, unknown> = {}
): Promise<SlackResponse<T> & T> {
  const token = getToken();
  const url = `${BASE_URL}/${method}`;
  const opts = buildFetchOptions(method, token, body);

  console.error(`[slack-mcp] POST ${method}`);

  let res: Response;
  try {
    res = await fetch(url, opts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[slack-mcp] FETCH FAILED: ${msg}`);
    throw new Error(`Slack API fetch failed: ${msg}`);
  }

  // Handle HTTP-level rate limiting (429)
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 30;
    console.error(
      `[slack-mcp] Rate limited on ${method}. Retrying after ${waitSeconds}s.`
    );
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

    // Retry once
    try {
      res = await fetch(url, opts);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Slack API retry failed: ${msg}`);
    }

    if (res.status === 429) {
      throw new Error(
        `Slack API rate limited on ${method}. Try again later.`
      );
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack API HTTP error: ${res.status} ${res.statusText} - ${text}`);
  }

  const data = (await res.json()) as SlackResponse<T> & T;

  console.error(`[slack-mcp] ${method} → ${data.ok ? "ok" : `error: ${data.error}`}`);

  if (!data.ok) {
    throw new Error(`Slack API error on ${method}: ${data.error}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Token validation (called once on first use)
// ---------------------------------------------------------------------------

export async function validateToken(): Promise<void> {
  if (tokenValidated) return;

  const result = await slackPost("auth.test");
  console.error(
    `[slack-mcp] Authenticated as "${result.user}" in team "${result.team}" (${result.team_id})`
  );
  tokenValidated = true;
}
