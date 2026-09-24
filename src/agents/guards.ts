// Security hooks shared by every Agent class in this app.

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
