#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { configure, validateToken, slackPost } from "./client.js";
import { assertValidSlackUserId, createAllowlistChecker } from "./validation.js";
import { createDmResolver } from "./dm-resolve.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const botToken = process.env.SLACK_BOT_TOKEN;

if (!botToken) {
  console.error(
    "Error: SLACK_BOT_TOKEN environment variable is required."
  );
  process.exit(1);
}

const DRY_RUN = process.env.DRY_RUN === "true";
const ALLOWED_USERS: Set<string> | null = process.env.SLACK_ALLOWED_USERS
  ? new Set(process.env.SLACK_ALLOWED_USERS.split(",").map((id) => id.trim()))
  : null;

configure(botToken);

const checkAllowlist = createAllowlistChecker(ALLOWED_USERS);

if (DRY_RUN) {
  console.error("[slack-mcp] DRY_RUN mode enabled — messages will be logged, not sent");
}
if (ALLOWED_USERS) {
  console.error(
    `[slack-mcp] SLACK_ALLOWED_USERS allowlist active: ${[...ALLOWED_USERS].join(", ")}`
  );
}

console.error("[slack-mcp] Server starting");

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "ta-ops-slack",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Helper: format result as MCP tool response
// ---------------------------------------------------------------------------

function formatResult(data: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Helper: resolve DM channel ID (cached)
// ---------------------------------------------------------------------------

const resolveDmChannel = createDmResolver(slackPost);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// 1. send_dm
server.tool(
  "send_dm",
  "Send a Slack DM to a user by their Slack user ID. Uses Slack mrkdwn formatting (*bold*, _italic_, ~strike~, <url|text>). Optionally accepts Block Kit blocks for rich layouts. In DRY_RUN mode, logs the message instead of sending.",
  {
    user_id: z.string().describe("Slack user ID (e.g. U0MAG0001)"),
    text: z
      .string()
      .describe(
        "Message text in Slack mrkdwn format. Required even when using blocks (serves as notification fallback)."
      ),
    blocks: z
      .string()
      .optional()
      .describe(
        "Optional Block Kit blocks as a JSON string. See https://api.slack.com/block-kit"
      ),
  },
  async ({ user_id, text, blocks }) => {
    assertValidSlackUserId(user_id);
    await validateToken();
    checkAllowlist(user_id);

    // Parse blocks if provided
    let parsedBlocks: unknown[] | undefined;
    if (blocks) {
      try {
        parsedBlocks = JSON.parse(blocks);
      } catch {
        throw new Error("Invalid JSON in blocks parameter");
      }
    }

    if (DRY_RUN) {
      const dryResult = {
        ok: true,
        dry_run: true,
        would_send_to: user_id,
        text_length: text.length,
        has_blocks: !!parsedBlocks,
        text_preview: text.slice(0, 500),
      };
      console.error(
        `[slack-mcp] DRY_RUN send_dm to ${user_id}:\n${text}`
      );
      return formatResult(dryResult);
    }

    const channelId = await resolveDmChannel(user_id);

    // Send message
    const msgPayload: Record<string, unknown> = {
      channel: channelId,
      text,
    };
    if (parsedBlocks) {
      msgPayload.blocks = parsedBlocks;
    }

    const result = await slackPost("chat.postMessage", msgPayload);
    return formatResult({
      ok: true,
      channel: channelId,
      ts: result.ts,
      message_text_length: text.length,
    });
  }
);

// 2. lookup_user_by_email
server.tool(
  "lookup_user_by_email",
  "Look up a Slack user by their email address. Returns user ID, name, and profile. Critical for resolving Greenhouse user emails to Slack IDs for DM delivery.",
  {
    email: z.string().email().describe("Email address to look up"),
  },
  async ({ email }) => {
    await validateToken();

    const result = await slackPost("users.lookupByEmail", { email });
    const user = result.user as Record<string, unknown> | undefined;

    return formatResult({
      ok: true,
      user: user
        ? {
            id: user.id,
            name: user.name,
            real_name: user.real_name,
            email: (user.profile as Record<string, unknown>)?.email,
          }
        : null,
    });
  }
);

// 3. lookup_user_by_id
server.tool(
  "lookup_user_by_id",
  "Get a Slack user's profile by their user ID. Returns display name, real name, email, and status.",
  {
    user_id: z.string().describe("Slack user ID (e.g. U0MAG0001)"),
  },
  async ({ user_id }) => {
    assertValidSlackUserId(user_id);
    await validateToken();

    const result = await slackPost("users.info", { user: user_id });
    const user = result.user as Record<string, unknown> | undefined;
    const profile = user?.profile as Record<string, unknown> | undefined;

    return formatResult({
      ok: true,
      user: user
        ? {
            id: user.id,
            name: user.name,
            real_name: user.real_name,
            email: profile?.email,
            status_text: profile?.status_text,
            status_emoji: profile?.status_emoji,
          }
        : null,
    });
  }
);

// 4. list_users
server.tool(
  "list_users",
  "List all users in the Slack workspace with cursor pagination. Useful for building a bulk email-to-Slack-ID lookup table.",
  {
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from a previous response"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .optional()
      .describe("Number of users to return per page (1-200, default 100)"),
  },
  async ({ cursor, limit }) => {
    await validateToken();

    const params: Record<string, unknown> = {};
    if (cursor) params.cursor = cursor;
    if (limit) params.limit = limit;

    const result = await slackPost("users.list", params);
    const members = result.members as unknown[];
    const nextCursor = result.response_metadata?.next_cursor || null;

    const users = Array.isArray(members)
      ? members.map((m: unknown) => {
          const member = m as Record<string, unknown>;
          const profile = member.profile as Record<string, unknown> | undefined;
          return {
            id: member.id,
            name: member.name,
            real_name: member.real_name,
            email: profile?.email,
            is_bot: member.is_bot,
            deleted: member.deleted,
          };
        })
      : [];

    const response: Record<string, unknown> = {
      ok: true,
      users,
      total_returned: users.length,
    };
    if (nextCursor) {
      response.next_cursor = nextCursor;
      response._pagination_note =
        "Pass next_cursor value as the 'cursor' parameter to fetch the next page.";
    }

    return formatResult(response);
  }
);

// 5. open_conversation
server.tool(
  "open_conversation",
  "Open or resume a DM conversation with a Slack user. Returns the channel ID for the DM. Also called internally by send_dm, but exposed here for debugging or pre-opening conversations.",
  {
    user_id: z.string().describe("Slack user ID to open DM with"),
  },
  async ({ user_id }) => {
    assertValidSlackUserId(user_id);
    await validateToken();

    const channelId = await resolveDmChannel(user_id);

    return formatResult({
      ok: true,
      channel: { id: channelId },
    });
  }
);

// 6. get_message_permalink
server.tool(
  "get_message_permalink",
  "Get a permanent link to a specific Slack message. Useful for logging or referencing sent messages.",
  {
    channel_id: z.string().describe("Channel ID where the message was posted"),
    message_ts: z
      .string()
      .describe("Timestamp of the message (returned by send_dm as 'ts')"),
  },
  async ({ channel_id, message_ts }) => {
    await validateToken();

    const result = await slackPost("chat.getPermalink", {
      channel: channel_id,
      message_ts,
    });

    return formatResult({
      ok: true,
      permalink: result.permalink,
    });
  }
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[slack-mcp] Server connected and ready");
}

main().catch((err) => {
  console.error("[slack-mcp] Fatal error:", err);
  process.exit(1);
});
