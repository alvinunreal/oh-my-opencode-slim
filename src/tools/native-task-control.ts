/**
 * Thin host-read task controls for `backgroundJobs.mode: "native"`.
 *
 * No board, no ledger, no lease: both tools verify ownership with one
 * bounded `session.get` (exact child ID, `parentID` must be the caller) and
 * reuse the untracked-task primitives the managed `task_status` already
 * uses for sessions the board lost. `task_cancel` then sends the host's own
 * interruption — the same primitive the managed tool uses — and reports the
 * host's answer instead of fabricating a terminal state: the host owns
 * cleanup, terminal publication, and completion notification.
 *
 * These exist because the native delegation surface has no model-facing
 * status or cancel: completion is pushed, and a lost notice has no re-fetch
 * channel. They are registered ONLY in `native` mode, so managed-mode
 * prompt bytes and tool catalogs are unchanged.
 */
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';

import { diagnosticTail } from '../utils/child-transcript';
import { getClient } from '../utils/opencode-client';
import {
  SESSION_ABORT_TIMEOUT_MS,
  sessionAbortFailure,
  withTimeout,
} from '../utils/session';
import { delegationWording } from '../v2/delegation';
import { idParamFor, readTaskRef, taskRefArgs } from './task-ref';
import {
  readUntrackedEvidence,
  verifyUntrackedOwnership,
} from './untracked-task-observation';

/** Trailing assistant text exposed by `task_status`. */
const RESULT_MAX_BYTES = 4_096;

export interface NativeTaskControlOptions {
  input: PluginInput;
  isDisposed?: () => boolean;
  /** Abort round-trip budget (default: the shared 1 s session-abort cap). */
  abortTimeoutMs?: number;
}

/** Ownership-verified child for one control call, or why it was refused. */
type OwnedChild =
  | {
      ok: true;
      identity: string;
      agent?: string;
      hostInfo: Record<string, unknown>;
    }
  | { ok: false; error: string };

/**
 * One bounded `session.get` proves the requested ID is an exact child of
 * the calling session. No board, no aliases, no history scan.
 */
async function ownedChild(
  options: NativeTaskControlOptions,
  requested: string,
  parentSessionID: string,
): Promise<OwnedChild> {
  const ownership = await verifyUntrackedOwnership(
    options,
    requested,
    parentSessionID,
  );
  if (options.isDisposed?.()) {
    return { ok: false, error: 'Plugin instance disposed' };
  }
  if (ownership.kind === 'foreign-parent') {
    return {
      ok: false,
      error: `Task ${requested} does not belong to this session`,
    };
  }
  if (ownership.kind !== 'verified') {
    return {
      ok: false,
      error:
        ownership.kind === 'no-session-get'
          ? 'Host client has no session.get API; cannot read the child session'
          : `Unknown or unreadable task session: ${requested}`,
    };
  }
  return {
    ok: true,
    identity: requested,
    agent: ownership.agent,
    hostInfo: ownership.hostInfo ?? {},
  };
}

/**
 * Normalize one host interruption answer across both hosts. v2's shim
 * returns the bare `{interrupted}` payload (idle interrupt is a host-side
 * no-op); v1's SDK resolves `{data: boolean}`. An absent outcome means the
 * host accepted the request but did not report one — never fake `false`.
 */
function interruptionOutcome(result: unknown): string {
  const failure = sessionAbortFailure(result);
  if (failure) return `rejected (${failure})`;
  const payload =
    result && typeof result === 'object'
      ? (result as { data?: unknown; interrupted?: unknown })
      : undefined;
  const flag = payload?.interrupted ?? payload?.data;
  if (flag === true) return 'Interrupt accepted';
  if (flag === false) return 'No active execution interrupted';
  return 'Abort request accepted; the host did not report an interruption outcome';
}

export function createNativeTaskControlTools(
  options: NativeTaskControlOptions,
): Record<'task_cancel' | 'task_status', ToolDefinition> {
  const idParam = idParamFor(options.input);
  const hostFlavor = (options.input as { hostFlavor?: unknown }).hostFlavor;
  const delegation = delegationWording(
    typeof hostFlavor === 'string' ? hostFlavor : undefined,
  );

  const task_status = tool({
    description:
      "Read a child session's state and latest result from the host. Use after a missing completion notice; do not poll.",
    args: taskRefArgs(idParam, 'Exact child session ID'),
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_status requires ${idParam}`);
      const child = await ownedChild(options, requested, parentSessionID);
      if (!child.ok) throw new Error(child.error);
      const evidence = await readUntrackedEvidence(
        options,
        child.identity,
        child.hostInfo,
      );
      if (options.isDisposed?.()) {
        throw new Error('Plugin instance disposed');
      }
      const lines = [`Session ${child.identity}`];
      if (child.agent) lines.push(`agent: ${child.agent}`);
      // v1's live status map is real evidence of execution; v2 has no
      // equivalent (the shim omits `status`), so this probe is v1 only.
      if (evidence.live.status === 'busy' || evidence.live.status === 'retry') {
        lines.push(`state: ${evidence.live.status} (live)`);
        lines.push(
          '',
          'It is still working; the host notifies on completion. Do not poll.',
        );
      } else if (evidence.round) {
        const round = evidence.round;
        if (round.verdict === 'completed') {
          lines.push('state: completed');
          const text = round.text
            ? diagnosticTail(round.text, RESULT_MAX_BYTES)
            : '';
          if (text.trim() !== '') lines.push('', text);
        } else if (round.verdict === 'error') {
          lines.push('state: error');
          if (round.text)
            lines.push('', diagnosticTail(round.text, RESULT_MAX_BYTES));
        } else if (round.verdict === 'interrupted') {
          lines.push('state: stopped (interrupted)');
        } else {
          // incomplete / retry / absent / unreadable: history proves no
          // terminal round, not that the child is working. The host may
          // also have overwritten a textless success to `incomplete`.
          lines.push(
            `state: unknown (incomplete: no terminal evidence in the current round${'reason' in round && round.reason ? `: ${round.reason}` : ''})`,
          );
          lines.push(
            '',
            'The host notifies on completion; re-check later if no notice arrives.',
          );
        }
      } else {
        lines.push(
          `state: unknown (incomplete: transcript could not be read${
            evidence.roundError ? `: ${String(evidence.roundError)}` : ''
          })`,
        );
        lines.push(
          '',
          'The host notifies on completion; re-check later if no notice arrives.',
        );
      }
      return lines.join('\n');
    },
  });

  const task_cancel = tool({
    description: `Interrupt a child session without deleting it. The host owns cleanup and the completion notification.`,
    args: taskRefArgs(idParam, 'Exact child session ID'),
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_cancel requires sessionID');
      const requested = readTaskRef(args, idParam);
      if (!requested) throw new Error(`task_cancel requires ${idParam}`);
      const child = await ownedChild(options, requested, parentSessionID);
      if (!child.ok) throw new Error(child.error);
      // Invoke as a member: the SDK method reads `this._client`, so a
      // detached reference would throw or post nowhere.
      const abort = getClient(options.input).session?.abort;
      if (typeof abort !== 'function') {
        throw new Error(
          'Host client has no session.abort API; cannot cancel the child session',
        );
      }
      let result: unknown;
      try {
        result = await withTimeout(
          // Cast: both host generations resolve error envelopes instead of
          // rejecting, and `sessionAbortFailure` reads them as `unknown`.
          abort.call(getClient(options.input).session, {
            path: { id: requested },
          }) as Promise<unknown>,
          options.abortTimeoutMs ?? SESSION_ABORT_TIMEOUT_MS,
          'session abort timed out',
        );
      } catch (err) {
        throw new Error(
          `task_cancel could not confirm the interruption for ${requested}: ${
            err instanceof Error ? err.message : String(err)
          }. It may still land; check task_status.`,
        );
      }
      const failure = sessionAbortFailure(result);
      if (failure) {
        throw new Error(
          `task_cancel was rejected for ${requested}: ${failure}`,
        );
      }
      return `${interruptionOutcome(result)} for ${requested}; session retained. Send a follow-up with ${delegation.tool}(${delegation.resumeParam}, prompt) when needed.`;
    },
  });

  return { task_cancel, task_status };
}
