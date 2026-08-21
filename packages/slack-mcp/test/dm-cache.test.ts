import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getDmChannel, setDmChannel, resetDmCache } from "../src/dm-cache.js";
import { createDmResolver } from "../src/dm-resolve.js";

describe("DM channel cache", () => {
  beforeEach(() => {
    resetDmCache();
  });

  it("returns undefined for unknown user", () => {
    assert.equal(getDmChannel("U_UNKNOWN"), undefined);
  });

  it("returns cached channel after set", () => {
    setDmChannel("U111", "D_CHANNEL_111");
    assert.equal(getDmChannel("U111"), "D_CHANNEL_111");
  });

  it("caches multiple users independently", () => {
    setDmChannel("U111", "D_CH_1");
    setDmChannel("U222", "D_CH_2");
    assert.equal(getDmChannel("U111"), "D_CH_1");
    assert.equal(getDmChannel("U222"), "D_CH_2");
  });

  it("resetDmCache clears all entries", () => {
    setDmChannel("U111", "D_CH_1");
    setDmChannel("U222", "D_CH_2");
    resetDmCache();
    assert.equal(getDmChannel("U111"), undefined);
    assert.equal(getDmChannel("U222"), undefined);
  });

  it("overwrites existing cache entry for same user", () => {
    setDmChannel("U111", "D_OLD");
    setDmChannel("U111", "D_NEW");
    assert.equal(getDmChannel("U111"), "D_NEW");
  });
});

describe("DM cache integration — avoids redundant conversations.open", () => {
  beforeEach(() => {
    resetDmCache();
  });

  it("second resolve for same user skips API call", () => {
    // Simulate: first call populates cache, second reads from it
    const userId = "U0MAG0001";
    const channelId = "D_CACHED";

    // First call: cache miss, would call conversations.open
    assert.equal(getDmChannel(userId), undefined);
    setDmChannel(userId, channelId);

    // Second call: cache hit, no API call needed
    const cached = getDmChannel(userId);
    assert.equal(cached, channelId, "Should return cached channel without API call");

    // Third resolve for same user: still cached
    assert.equal(getDmChannel(userId), channelId);
  });
});

// ---------------------------------------------------------------------------
// createDmResolver — tests the full resolve path (cache + API coordination)
// ---------------------------------------------------------------------------

describe("createDmResolver", () => {
  beforeEach(() => {
    resetDmCache();
  });

  it("calls conversations.open on cache miss and caches the result", async () => {
    let posterCalls = 0;
    const mockPoster = async (_method: string, _body: Record<string, unknown>) => {
      posterCalls++;
      return { ok: true, channel: { id: "D_FROM_API" } };
    };

    const resolve = createDmResolver(mockPoster);
    const channelId = await resolve("U0MAG0001");

    assert.equal(channelId, "D_FROM_API");
    assert.equal(posterCalls, 1, "Should have called conversations.open once");
    assert.equal(getDmChannel("U0MAG0001"), "D_FROM_API", "Should be cached after resolve");
  });

  it("skips API call on cache hit", async () => {
    let posterCalls = 0;
    const mockPoster = async (_method: string, _body: Record<string, unknown>) => {
      posterCalls++;
      return { ok: true, channel: { id: "D_FROM_API" } };
    };

    const resolve = createDmResolver(mockPoster);

    // First resolve: cache miss → API call
    await resolve("U0MAG0001");
    assert.equal(posterCalls, 1, "First resolve should call API");

    // Second resolve: cache hit → no API call
    const channelId = await resolve("U0MAG0001");
    assert.equal(channelId, "D_FROM_API");
    assert.equal(posterCalls, 1, "Second resolve should NOT call API again");
  });

  it("throws when conversations.open returns no channel ID", async () => {
    const mockPoster = async (_method: string, _body: Record<string, unknown>) => {
      return { ok: true };
    };

    const resolve = createDmResolver(mockPoster);

    await assert.rejects(
      () => resolve("U0MAG0001"),
      (err: Error) => {
        assert.ok(err.message.includes("Failed to open DM conversation"));
        return true;
      }
    );
  });
});
