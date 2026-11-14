/**
 * Native v2 `subagent` policy: delegating to Observer is unnecessary when the
 * calling model accepts images. Reads only the exact tool-call assistant row
 * plus the injected host registry; any failure or unknown result proceeds
 * natively. No executor, ledger, or state.
 *
 * Resume calls must name the agent: the host schema requires it, so an
 * omitted-agent input is a dead call the host validator rejects — no
 * classification needed here.
 */

import { isRecord } from '../utils/guards';
import type { ModelImageCapabilityRef } from '../utils/model-image-capability';
import { withTimeout } from '../utils/session';
import type { TimerSeam } from '../utils/timer-seam';
import type { V2ToolBeforeEvent } from './types';

const SUBAGENT = 'subagent';
const OBSERVER = 'observer';
const READ_TIMEOUT_MS = 2_000;
const REFUSAL =
  'Observer delegation is unnecessary: the current model accepts images. Read and analyze the visual file directly.';

export interface ObserverDispatchGuardOptions {
  observerNames: () => readonly string[];
  context?: (input: {
    sessionID: string;
  }) => Promise<Array<Record<string, unknown>>>;
  acceptsImages: (ref: ModelImageCapabilityRef) => Promise<boolean | undefined>;
  /** Deterministic scheduling seam (tests); production uses real timers. */
  timers?: TimerSeam;
}

export function createObserverDispatchGuard({
  observerNames,
  context,
  acceptsImages,
  timers,
}: ObserverDispatchGuardOptions): (event: V2ToolBeforeEvent) => Promise<void> {
  return async (event) => {
    const input = event.input;
    if (event.tool !== SUBAGENT || !isRecord(input) || Array.isArray(input))
      return;

    // A pre-finalized registry may throw; unrelated calls still pass.
    let names: readonly string[];
    try {
      const runtime = observerNames();
      names = Array.isArray(runtime) ? runtime : [OBSERVER];
    } catch {
      names = [OBSERVER];
    }
    const matchesObserver = (name: string) =>
      name === OBSERVER || names.includes(name);

    // The host schema requires `agent`; anything but an observer-targeting
    // string is left to the host validator without a single read.
    const agent = input.agent;
    if (typeof agent !== 'string' || !matchesObserver(agent)) return;

    const { messageID, sessionID } = event;
    if (
      typeof messageID !== 'string' ||
      messageID.length === 0 ||
      typeof sessionID !== 'string' ||
      sessionID.length === 0 ||
      !context
    )
      return;

    let accepts: boolean | undefined;
    try {
      accepts = await withTimeout(
        (async () => {
          const rows = await context?.({ sessionID });
          const row = Array.isArray(rows)
            ? rows.find(
                (entry) =>
                  isRecord(entry) &&
                  entry.id === messageID &&
                  entry.type === 'assistant',
              )
            : undefined;
          const model = isRecord(row) ? row.model : undefined;
          if (!isRecord(model)) return;
          const { providerID, id } = model;
          if (
            typeof providerID !== 'string' ||
            providerID.length === 0 ||
            typeof id !== 'string' ||
            id.length === 0
          )
            return;
          return acceptsImages({ providerID, id });
        })(),
        READ_TIMEOUT_MS,
        '[v2] observer dispatch capability lookup timed out',
        timers,
      );
    } catch {
      return;
    }
    if (accepts === true) throw new Error(REFUSAL);
  };
}
