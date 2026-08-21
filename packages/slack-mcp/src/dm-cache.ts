/**
 * In-memory cache for Slack DM channel IDs.
 * DM channel IDs are stable for the lifetime of a workspace,
 * so caching avoids redundant conversations.open calls within a process.
 */

const cache = new Map<string, string>();

export function getDmChannel(userId: string): string | undefined {
  return cache.get(userId);
}

export function setDmChannel(userId: string, channelId: string): void {
  cache.set(userId, channelId);
}

export function resetDmCache(): void {
  cache.clear();
}
