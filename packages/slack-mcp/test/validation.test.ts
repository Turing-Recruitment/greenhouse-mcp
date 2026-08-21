import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertValidSlackUserId, createAllowlistChecker } from "../src/validation.js";

// ---------------------------------------------------------------------------
// assertValidSlackUserId
// ---------------------------------------------------------------------------

describe("assertValidSlackUserId", () => {
  it("accepts valid U-prefixed user IDs", () => {
    assert.doesNotThrow(() => assertValidSlackUserId("U0MAG0001"));
    assert.doesNotThrow(() => assertValidSlackUserId("U0123456789"));
  });

  it("accepts valid W-prefixed user IDs", () => {
    assert.doesNotThrow(() => assertValidSlackUserId("W012ABC3DEF"));
  });

  it("rejects empty string", () => {
    assert.throws(
      () => assertValidSlackUserId(""),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid Slack user ID"));
        return true;
      }
    );
  });

  it('rejects the string "null"', () => {
    assert.throws(
      () => assertValidSlackUserId("null"),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid Slack user ID"));
        return true;
      }
    );
  });

  it('rejects the string "undefined"', () => {
    assert.throws(
      () => assertValidSlackUserId("undefined"),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid Slack user ID"));
        return true;
      }
    );
  });

  it("rejects channel-prefixed IDs (C...)", () => {
    assert.throws(
      () => assertValidSlackUserId("C01234"),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid Slack user ID format"));
        return true;
      }
    );
  });

  it("rejects email addresses", () => {
    assert.throws(
      () => assertValidSlackUserId("user@email.com"),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid Slack user ID format"));
        return true;
      }
    );
  });

  it("rejects bare numeric strings", () => {
    assert.throws(
      () => assertValidSlackUserId("12345"),
      (err: Error) => {
        assert.ok(err.message.includes("Invalid Slack user ID format"));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// createAllowlistChecker
// ---------------------------------------------------------------------------

describe("createAllowlistChecker", () => {
  it("allows any user when allowlist is null", () => {
    const check = createAllowlistChecker(null);
    assert.doesNotThrow(() => check("U0MAG0001"));
    assert.doesNotThrow(() => check("UANYTHING"));
  });

  it("allows users on the allowlist", () => {
    const check = createAllowlistChecker(new Set(["U111", "U222"]));
    assert.doesNotThrow(() => check("U111"));
    assert.doesNotThrow(() => check("U222"));
  });

  it("throws for users not on the allowlist", () => {
    const check = createAllowlistChecker(new Set(["U111", "U222"]));
    assert.throws(
      () => check("U999"),
      (err: Error) => {
        assert.ok(err.message.includes("not on the SLACK_ALLOWED_USERS allowlist"));
        assert.ok(err.message.includes("U111"));
        assert.ok(err.message.includes("U222"));
        return true;
      }
    );
  });

  it("throws for users not on an empty allowlist", () => {
    const check = createAllowlistChecker(new Set());
    assert.throws(
      () => check("U111"),
      (err: Error) => {
        assert.ok(err.message.includes("not on the SLACK_ALLOWED_USERS allowlist"));
        return true;
      }
    );
  });
});
