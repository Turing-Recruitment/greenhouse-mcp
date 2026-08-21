/**
 * DM channel resolver with caching.
 * Extracted from index.ts for testability without entrypoint side effects.
 */

import { getDmChannel, setDmChannel } from "./dm-cache.js";

type Poster = (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function createDmResolver(poster: Poster): (userId: string) => Promise<string> {
  return async (userId: string): Promise<string> => {
    const cached = getDmChannel(userId);
    if (cached) {
      console.error(`[slack-mcp] DM channel cache hit for ${userId}`);
      return cached;
    }

    const conv = await poster("conversations.open", { users: userId });
    const channelId = (conv as Record<string, unknown> & { channel?: { id?: string } })
      .channel?.id;
    if (!channelId) {
      throw new Error(`Failed to open DM conversation with user ${userId}`);
    }

    setDmChannel(userId, channelId);
    return channelId;
  };
}
