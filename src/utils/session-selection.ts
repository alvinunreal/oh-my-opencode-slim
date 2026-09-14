import { parseContinuationModelSelection } from '../hooks/task-session-manager/continuation-model-selection';
import { isRecord } from './guards';

/** Which source produced a resolved selection. */
export type SessionSelectionProvenance =
  /** Selection persisted in the host (`session.get()`). */
  | 'host-persisted'
  /** Last selection observed from an external (user-initiated) chat
   * message, kept by slim's session metadata. */
  | 'observed-external'
  /** No selection could be resolved. */
  | 'unknown';

export interface SessionSelection {
  agent?: string;
  /** Prompt-shaped model ref (`{providerID, modelID}`), the same form
   * promptAsync bodies expect. */
  model?: { providerID: string; modelID: string };
  variant?: string;
  provenance: SessionSelectionProvenance;
}

export interface SessionSelectionReader {
  /** Read the host-persisted selection for a session, or undefined when
   * the host does not expose one. Implementations must not throw. */
  readHostSelection(sessionID: string): Promise<
    | {
        agent?: string;
        model?: unknown;
      }
    | undefined
  >;
}

/** Bound only the host `session.get` read. Metadata fallback must still
 * run if that read is slow or hangs (#1079 Oracle r2). */
export const HOST_SELECTION_TIMEOUT_MS = 2_000;

/**
 * Resolve the session's CURRENT selection for lifecycle continuations
 * (#1079): a background-task lifecycle event must continue the parent in
 * the agent/model the session actually uses now, never a hardcoded
 * `orchestrator`.
 *
 * Hierarchy:
 * 1. Host-persisted selection (`session.get()`). This is whatever the
 *    host last stored; user-message admission updates it, and synthetic
 *    prompts may also rewrite the host copy.
 * 2. Last externally observed selection from slim metadata (internal
 *    admissions are filtered out of this store).
 * 3. Unknown — callers apply a conservative fallback (`orchestrator`,
 *    matching historical wake behavior).
 */
export async function resolveCurrentSelection(
  sessionID: string,
  host: SessionSelectionReader,
  metadata: {
    getAgent(sessionID: string): string | undefined;
    getModel(sessionID: string): string | undefined;
  },
  timeoutMs: number = HOST_SELECTION_TIMEOUT_MS,
): Promise<SessionSelection> {
  const hostSelection = await readHostSelectionBounded(
    host,
    sessionID,
    timeoutMs,
  );
  const hostParsed = parseContinuationModelSelection(hostSelection?.model);
  const hostAgent =
    typeof hostSelection?.agent === 'string' ? hostSelection.agent : undefined;
  const metaAgent = metadata.getAgent(sessionID);
  const metaModel = modelFromMetadataString(metadata.getModel(sessionID));
  if (hostAgent !== undefined) {
    return {
      agent: hostAgent,
      model: hostParsed?.model ?? metaModel,
      variant: hostParsed?.variant,
      provenance: 'host-persisted',
    };
  }
  if (metaAgent !== undefined) {
    return {
      agent: metaAgent,
      model: hostParsed?.model ?? metaModel,
      variant: hostParsed?.variant,
      provenance: hostParsed ? 'host-persisted' : 'observed-external',
    };
  }
  if (hostParsed) {
    return {
      model: hostParsed.model,
      variant: hostParsed.variant,
      provenance: 'host-persisted',
    };
  }
  return { provenance: 'unknown' };
}

/** Slim stores models as `"provider/modelID"`; promptAsync wants the
 * object form. A slash-less string cannot be a continuation pin. */
export function modelFromMetadataString(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const parsed = parseContinuationModelSelection(model);
  if (parsed) return parsed.model;
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

async function readHostSelectionBounded(
  host: SessionSelectionReader,
  sessionID: string,
  timeoutMs: number,
): Promise<
  | {
      agent?: string;
      model?: unknown;
    }
  | undefined
> {
  let settled = false;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
    host
      .readHostSelection(sessionID)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      });
  });
}

function sessionFromGetResponse(
  response: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(response)) return undefined;
  if (isRecord(response.data)) return response.data;
  if (isRecord(response.info)) return response.info;
  if (typeof response.agent === 'string' || response.model !== undefined) {
    return response;
  }
  return undefined;
}

/** Build a {@link SessionSelectionReader} from a plugin client. Works
 * for the v1 SDK client and the v2 client shim alike (the shim
 * delegates `session.get` without transforming it, wrapping the result
 * in `{data}`). The published v1 SDK type for `Session` omits
 * `agent`/`model`, but the runtime host sends both; read them
 * defensively. */
export function createSessionSelectionReader(
  client: unknown,
  directory?: string,
): SessionSelectionReader {
  const sessionSdk = isRecord(client)
    ? (client as { session?: unknown }).session
    : undefined;
  const get = isRecord(sessionSdk)
    ? (sessionSdk as { get?: unknown }).get
    : undefined;
  return {
    async readHostSelection(sessionID) {
      if (typeof get !== 'function') return undefined;
      // Call through the session object: the generated v1 SDK method
      // reads `this._client` (#595 / Oracle r1 #1079). Detaching `.get`
      // silently fails and degrades to stale metadata.
      const response = await (
        get as (
          this: unknown,
          args: Record<string, unknown>,
        ) => Promise<unknown>
      ).call(sessionSdk, {
        path: { id: sessionID },
        ...(directory ? { query: { directory } } : {}),
      });
      const session = sessionFromGetResponse(response);
      if (!session) return undefined;
      const agent =
        typeof session.agent === 'string' ? session.agent : undefined;
      if (agent === undefined && session.model === undefined) {
        return undefined;
      }
      return { agent, model: session.model };
    },
  };
}
