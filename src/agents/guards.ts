// Security hooks and checks shared by every Agent class in this app.
import { timingSafeEqual } from "node:crypto";
import { sha256Hex } from "../shared";

/**
 * Agents change state only in server code (callables, RPC, alarms). The SDK
 * also accepts state frames sent by clients over the WebSocket; reject them so
 * no one can overwrite project data or Settings without going through the
 * validated, access-checked methods.
 */
export function rejectClientStateChange(source: unknown) {
  if (source !== "server")
    throw new Error("Agent state can only be changed by the server");
}

/** This app has no sub-agents; refuse the SDK's /sub/<class>/<name> forwarding route. */
export async function denySubAgents(): Promise<Response> {
  return new Response("Not found", { status: 404 });
}

/** Constant-time comparison (hashing first gives equal-length inputs). */
async function secretsMatch(given: string, expected: string) {
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  return timingSafeEqual(
    new TextEncoder().encode(a),
    new TextEncoder().encode(b)
  );
}

/** True if `key` is this deployment's admin key; false when no key is configured. */
export async function isAdminKey(env: Env, key: unknown): Promise<boolean> {
  const expected = env.SETTINGS_ADMIN_KEY;
  return (
    !!expected && typeof key === "string" && (await secretsMatch(key, expected))
  );
}

/**
 * Consume one unit of a rate limit for `key` (see "ratelimits" in
 * wrangler.jsonc). Returns false when the caller should back off.
 */
export async function withinRateLimit(
  limiter: RateLimit,
  key: string
): Promise<boolean> {
  const { success } = await limiter.limit({ key });
  return success;
}
