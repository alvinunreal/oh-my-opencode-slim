import { log } from "../shared/logger";

/**
 * Shared utility to delete a session using multiple strategies.
 * Tries SDK v1, SDK v2, and falls back to raw fetch.
 */
export async function deleteSession(
  client: any,
  serverUrl: URL,
  directory: string,
  sessionId: string
): Promise<void> {
  let deletedViaSDK = false;

  try {
    const sessionClient = client.session as any;
    if (typeof sessionClient?.delete === "function") {
      // Try SDK v1 style
      try {
        await sessionClient.delete({ path: { id: sessionId } });
        deletedViaSDK = true;
        log(`[session-utils] deleted session via SDK v1`, { sessionId });
      } catch (e1) {
        // Try SDK v2 style
        try {
          await sessionClient.delete({ sessionID: sessionId });
          deletedViaSDK = true;
          log(`[session-utils] deleted session via SDK v2`, { sessionId });
        } catch (e2) {
          log(`[session-utils] SDK deletion styles failed`, {
            sessionId,
            errorV1: String(e1),
            errorV2: String(e2),
          });
        }
      }
    }
  } catch (err) {
    log(`[session-utils] SDK access error`, { sessionId, error: String(err) });
  }

  if (deletedViaSDK) return;

  try {
    // Fallback to raw fetch
    const url = new URL(`/session/${sessionId}`, serverUrl);
    const response = await fetch(url.toString(), {
      method: "DELETE",
      headers: {
        "x-opencode-directory": directory,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      log(`[session-utils] deleted session via fetch`, { sessionId });
    } else {
      log(`[session-utils] fetch delete failed`, { sessionId, status: response.status });
    }
  } catch (err) {
    log(`[session-utils] failed to delete session via all methods`, { sessionId, error: String(err) });
  }
}
