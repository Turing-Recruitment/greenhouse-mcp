/**
 * Pure validation functions for Slack user IDs and allowlists.
 */

export function assertValidSlackUserId(userId: string): void {
  if (!userId || userId === "null" || userId === "undefined") {
    throw new Error(
      `Invalid Slack user ID: "${userId}". ` +
        `Check config/team.json for missing slack_id values.`
    );
  }
  if (!/^[UW][A-Z0-9]+$/.test(userId)) {
    throw new Error(
      `Invalid Slack user ID format: "${userId}". ` +
        `Slack user IDs start with U or W followed by alphanumeric characters.`
    );
  }
}

/**
 * Returns a check function that throws if a user ID is not on the allowlist.
 * If allowedUsers is null, the returned function is a no-op (all users allowed).
 */
export function createAllowlistChecker(
  allowedUsers: Set<string> | null
): (userId: string) => void {
  return (userId: string) => {
    if (allowedUsers && !allowedUsers.has(userId)) {
      throw new Error(
        `User ${userId} is not on the SLACK_ALLOWED_USERS allowlist. ` +
          `Allowed: ${[...allowedUsers].join(", ")}`
      );
    }
  };
}
