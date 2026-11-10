/**
 * Thin host-read task controls for `backgroundJobs.mode: "native"`.
 *
 * No board, no ledger, no lease: both lifecycle controls verify ownership with
 * one bounded `session.get` and reuse the untracked-task evidence reader. The
 * optional v2 permission bridge is also host-owned: status reads pending
 * permissions on demand and task_reply verifies the child/request pair before
 * replying. No native control creates or persists lifecycle state.
 */
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';

import { diagnosticTail } from '../utils/child-transcript';
import { isRecord } from '../utils/guards';
import { getClient } from '../utils/opencode-client';
import {
  SESSION_ABORT_TIMEOUT_MS,
  sessionAbortFailure,
  withTimeout,
} from '../utils/session';
import { delegationWording } from '../v2/delegation';
import {
  readUntrackedEvidence,
  verifyUntrackedOwnership,
} from './untracked-task-observation';

const z = tool.schema;

/** Trailing assistant text exposed by `task_status`. */
const RESULT_MAX_BYTES = 4_096;
/** The complete status result, including pending-permission lines. */
const STATUS_OUTPUT_MAX_BYTES = 4_096;
const PENDING_PERMISSION_LIMIT = 5;
const PENDING_PERMISSION_RESOURCE_LIMIT = 3;
const PENDING_PERMISSION_TEXT_LIMIT = 120;
const PENDING_PERMISSION_LINE_MAX_BYTES = 180;
const PENDING_PERMISSION_OUTPUT_MAX_BYTES = 1_024;
const PERMISSION_TIMEOUT_MS = 10_000;

type PermissionDecision = 'once' | 'always' | 'reject';

/** Flat v2 host permission surface forwarded by the v2 client shim. */
export interface NativePermissionBridge {
  list(input: { sessionID: string }): Promise<unknown>;
  get(input: { sessionID: string; requestID: string }): Promise<unknown>;
  reply(input: {
    sessionID: string;
    requestID: string;
    decision: PermissionDecision;
  }): Promise<unknown>;
}

export interface NativeTaskControlOptions {
  input: PluginInput;
  isDisposed?: () => boolean;
  /** Abort round-trip budget (default: the shared 1 s session-abort cap). */
  abortTimeoutMs?: number;
  /** Optional override; otherwise the shim's flat `client.permission` is used. */
  permission?: NativePermissionBridge;
}

export interface NativeTaskControlTools {
  task_cancel: ToolDefinition;
  task_status: ToolDefinition;
  /** Present only for v2; v1 native exposes status/cancel only. */
  task_reply?: ToolDefinition;
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

type NativePermissionRequest = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  resourceCount: number;
};

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

function nativeTaskArgs(
  hostFlavor: unknown,
  description: string,
): Record<string, ReturnType<typeof z.string>> {
  return hostFlavor === 'v2'
    ? { sessionID: z.string().describe(description) }
    : { task_id: z.string().describe(description) };
}

function nativeTaskID(
  args: Record<string, unknown>,
  hostFlavor: unknown,
): string {
  const value =
    hostFlavor === 'v2' ? args.sessionID : (args.task_id ?? args.sessionID);
  return typeof value === 'string' ? value.trim() : '';
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Host SDK methods may resolve an error envelope instead of throwing. */
function responseFailure(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  if (response.error !== undefined && response.error !== null) {
    return response.error;
  }
  const transport = isRecord(response.response) ? response.response : undefined;
  if (transport?.ok === false) {
    return Object.assign(
      new Error(
        `HTTP ${typeof transport.status === 'number' ? transport.status : 'request failure'}`,
      ),
      { response: transport },
    );
  }
  return undefined;
}

function isPermissionNotFound(error: unknown): boolean {
  // The flat host throws the core tag; the HTTP client throws the server tag.
  // Preserve those values rather than inferring resolution from message text.
  return (
    isRecord(error) &&
    (error._tag === 'Permission.NotFoundError' ||
      error._tag === 'PermissionNotFoundError' ||
      (isRecord(error.response) &&
        error.response.ok === false &&
        error.response.status === 404))
  );
}

async function permissionCall<T>(
  operation: Promise<T>,
  timeoutMessage: string,
): Promise<T> {
  const result = await withTimeout(
    operation,
    PERMISSION_TIMEOUT_MS,
    timeoutMessage,
  );
  const failure = responseFailure(result);
  if (failure !== undefined) throw failure;
  return result;
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && value.data !== undefined ? value.data : value;
}

function permissionRequestOf(
  value: unknown,
): NativePermissionRequest | undefined {
  const candidate = unwrapData(value);
  if (!isRecord(candidate)) return undefined;
  const id = candidate.id;
  const sessionID = candidate.sessionID;
  const action = candidate.action;
  const rawResources = candidate.resources;
  if (
    typeof id !== 'string' ||
    typeof sessionID !== 'string' ||
    typeof action !== 'string' ||
    !Array.isArray(rawResources)
  ) {
    return undefined;
  }
  const resources = rawResources.slice(0, PENDING_PERMISSION_RESOURCE_LIMIT);
  if (
    !resources.every(
      (resource): resource is string => typeof resource === 'string',
    )
  ) {
    return undefined;
  }
  return {
    id,
    sessionID,
    action,
    resources,
    resourceCount: rawResources.length,
  };
}

function shorten(value: string, max = PENDING_PERMISSION_TEXT_LIMIT): string {
  // Slice before normalizing so an unbounded host string cannot cost an
  // unbounded allocation just to print a bounded tail.
  const text = value
    .slice(0, max + 1)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One permission line keeps the exact request ID; only resources shrink. */
function permissionLine(request: NativePermissionRequest): {
  line: string;
  shortened: boolean;
} {
  const prefix = `- ${request.id}: ${shorten(request.action)}`;
  const suffix =
    request.resourceCount > PENDING_PERMISSION_RESOURCE_LIMIT ? ', …' : '';
  const resources = request.resources
    .slice(0, PENDING_PERMISSION_RESOURCE_LIMIT)
    .map((resource) => shorten(resource))
    .join(', ');
  const overhead = utf8Bytes(prefix) + utf8Bytes(' []…') + utf8Bytes(suffix);
  const room = Math.max(0, PENDING_PERMISSION_LINE_MAX_BYTES - overhead);
  const fitted = utf8Prefix(resources, room);
  const shortened = fitted !== resources;
  // A pathological ID/action can exceed the line cap; never drop the ID to
  // satisfy it. Normal host IDs are far below the cap.
  const line = `${prefix} [${fitted}${shortened ? '…' : ''}${suffix}]`;
  return {
    line:
      utf8Bytes(prefix) >= PENDING_PERMISSION_LINE_MAX_BYTES ? prefix : line,
    shortened,
  };
}

function permissionClient(
  options: NativeTaskControlOptions,
): NativePermissionBridge | undefined {
  if (options.permission) return options.permission;
  return (
    getClient(options.input) as unknown as {
      permission?: NativePermissionBridge;
    }
  ).permission;
}

async function pendingPermissionLines(
  options: NativeTaskControlOptions,
  childID: string,
  hostFlavor: unknown,
): Promise<string[]> {
  if (hostFlavor !== 'v2') return [];
  const permission = permissionClient(options);
  if (typeof permission?.list !== 'function') {
    return ['pending permissions: unavailable on this host'];
  }
  try {
    const response = await permissionCall(
      permission.list({ sessionID: childID }),
      'permission list timed out',
    );
    const raw = unwrapData(response);
    if (!Array.isArray(raw)) throw new Error('permission list was malformed');
    const requests: NativePermissionRequest[] = [];
    for (const item of raw) {
      const request = permissionRequestOf(item);
      if (!request || request.sessionID !== childID) {
        // Never expose a response that cannot prove it belongs to the owned
        // child. A malformed/global list is unavailable, not an empty list.
        throw new Error('permission list was not session-scoped');
      }
      requests.push(request);
    }
    if (requests.length === 0) return ['pending permissions: none'];

    const lines = [`pending permissions: ${requests.length}`];
    let shortened = false;
    for (const request of requests.slice(0, PENDING_PERMISSION_LIMIT)) {
      const detail = permissionLine(request);
      shortened ||= detail.shortened;
      lines.push(detail.line);
    }
    if (requests.length > PENDING_PERMISSION_LIMIT) {
      lines.push(`- … ${requests.length - PENDING_PERMISSION_LIMIT} more`);
    }
    if (shortened) lines.push('- … resource details shortened');
    return lines;
  } catch {
    return ['pending permissions: unavailable on this host'];
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const next = utf8Bytes(character);
    if (bytes + next > maxBytes) break;
    output += character;
    bytes += next;
  }
  return output;
}

/** Keep permission details bounded while preserving their truncation marker. */
function boundedPermissionLines(lines: string[], maxBytes: number): string[] {
  if (utf8Bytes(lines.join('\n')) <= maxBytes) return lines;
  const marker = '- … permission details truncated';
  if (maxBytes < utf8Bytes(marker)) return [];
  const output: string[] = [];
  let used = 0;
  for (const line of lines) {
    const separatorBytes = output.length > 0 ? utf8Bytes('\n') : 0;
    const nextBytes = separatorBytes + utf8Bytes(line);
    const markerBytes = utf8Bytes('\n') + utf8Bytes(marker);
    if (used + nextBytes + markerBytes > maxBytes) break;
    output.push(line);
    used += nextBytes;
  }
  return [...output, marker];
}

/** Keep child state ahead of bounded permission details and result text. */
function boundedStatusOutput(
  stateLines: string[],
  permissionLines: string[],
  resultText?: string,
): string {
  const state = stateLines.join('\n');
  const permissionBudget = Math.min(
    PENDING_PERMISSION_OUTPUT_MAX_BYTES,
    Math.max(0, STATUS_OUTPUT_MAX_BYTES - utf8Bytes(state) - utf8Bytes('\n\n')),
  );
  const permissions = boundedPermissionLines(permissionLines, permissionBudget);
  const prefix = [state, ...permissions].filter(Boolean).join('\n');
  if (!resultText) return utf8Prefix(prefix, STATUS_OUTPUT_MAX_BYTES);
  const separator = '\n\n';
  const available =
    STATUS_OUTPUT_MAX_BYTES - utf8Bytes(prefix) - utf8Bytes(separator);
  if (available <= 0) return utf8Prefix(prefix, STATUS_OUTPUT_MAX_BYTES);
  return `${prefix}${separator}${diagnosticTail(
    resultText,
    Math.min(RESULT_MAX_BYTES, available),
  )}`;
}

export function createNativeTaskControlTools(
  options: NativeTaskControlOptions,
): NativeTaskControlTools {
  const hostFlavor = (options.input as { hostFlavor?: unknown }).hostFlavor;
  const idDescription =
    hostFlavor === 'v2' ? 'Exact child session ID' : 'Exact child task ID';
  const delegation = delegationWording(
    typeof hostFlavor === 'string' ? hostFlavor : undefined,
  );

  const task_status = tool({
    description:
      "Read a child session's state and latest result from the host. Use after a missing completion notice; do not poll.",
    args: nativeTaskArgs(hostFlavor, idDescription),
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_status requires sessionID');
      const requested = nativeTaskID(
        args as Record<string, unknown>,
        hostFlavor,
      );
      const idParam = hostFlavor === 'v2' ? 'sessionID' : 'task_id';
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
      const stateLines = [`Session ${child.identity}`];
      if (child.agent) stateLines.push(`agent: ${child.agent}`);
      const permissionLines = await pendingPermissionLines(
        options,
        child.identity,
        hostFlavor,
      );
      if (options.isDisposed?.()) {
        throw new Error('Plugin instance disposed');
      }
      let resultText: string | undefined;
      // v1's live status map is real evidence of execution; v2 has no
      // equivalent (the shim omits `status`), so this probe is v1 only.
      if (evidence.live.status === 'busy' || evidence.live.status === 'retry') {
        stateLines.push(`state: ${evidence.live.status} (live)`);
        stateLines.push(
          '',
          'It is still working; the host notifies on completion. Do not poll.',
        );
      } else if (evidence.round) {
        const round = evidence.round;
        if (round.verdict === 'completed') {
          stateLines.push('state: completed');
          if (round.text?.trim()) resultText = round.text;
        } else if (round.verdict === 'error') {
          stateLines.push('state: error');
          if (round.text) resultText = round.text;
        } else if (round.verdict === 'interrupted') {
          stateLines.push('state: stopped (interrupted)');
        } else {
          // incomplete / retry / absent / unreadable: history proves no
          // terminal round, not that the child is working. The host may also
          // have overwritten a textless success to `incomplete`.
          stateLines.push(
            `state: unknown (incomplete: no terminal evidence in the current round${'reason' in round && round.reason ? `: ${round.reason}` : ''})`,
          );
          stateLines.push(
            '',
            'The host notifies on completion; re-check later if no notice arrives.',
          );
        }
      } else {
        stateLines.push(
          `state: unknown (incomplete: transcript could not be read${
            evidence.roundError ? `: ${String(evidence.roundError)}` : ''
          })`,
        );
        stateLines.push(
          '',
          'The host notifies on completion; re-check later if no notice arrives.',
        );
      }
      return boundedStatusOutput(stateLines, permissionLines, resultText);
    },
  });

  const task_cancel = tool({
    description:
      'Interrupt a child session without deleting it. The host owns cleanup and the completion notification.',
    args: nativeTaskArgs(hostFlavor, idDescription),
    async execute(args, toolContext) {
      const parentSessionID = toolContext?.sessionID;
      if (!parentSessionID) throw new Error('task_cancel requires sessionID');
      const requested = nativeTaskID(
        args as Record<string, unknown>,
        hostFlavor,
      );
      const idParam = hostFlavor === 'v2' ? 'sessionID' : 'task_id';
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

  const task_reply =
    hostFlavor === 'v2'
      ? tool({
          description:
            'Reply to a pending permission request on an owned child session. The host confirms whether it is still pending.',
          args: {
            ...nativeTaskArgs(hostFlavor, idDescription),
            request_id: z
              .string()
              .trim()
              .min(1)
              .describe('Pending permission request ID'),
            reply: z
              .enum(['once', 'always', 'reject'])
              .optional()
              .describe('Permission decision; defaults to once'),
          },
          async execute(args, toolContext) {
            const parentSessionID = toolContext?.sessionID;
            if (!parentSessionID)
              throw new Error('task_reply requires sessionID');
            const inputArgs = args as Record<string, unknown>;
            const requested = nativeTaskID(inputArgs, hostFlavor);
            if (!requested) throw new Error('task_reply requires sessionID');
            const requestID =
              typeof inputArgs.request_id === 'string'
                ? inputArgs.request_id.trim()
                : '';
            if (!requestID) throw new Error('task_reply requires request_id');
            const permission = permissionClient(options);
            if (
              typeof permission?.get !== 'function' ||
              typeof permission.reply !== 'function'
            ) {
              throw new Error(
                'Host permission get/reply APIs are unavailable; answer the child permission in the host UI',
              );
            }
            const child = await ownedChild(options, requested, parentSessionID);
            if (!child.ok) throw new Error(child.error);

            let request: NativePermissionRequest | undefined;
            try {
              const response = await permissionCall(
                permission.get({
                  sessionID: child.identity,
                  requestID,
                }),
                'permission get timed out',
              );
              request = permissionRequestOf(response);
              if (!request) throw new Error('permission request was malformed');
            } catch (error) {
              if (isPermissionNotFound(error)) {
                return `Permission ${requestID} on ${child.identity} is no longer pending; it was resolved elsewhere or never existed. Nothing was replied.`;
              }
              throw new Error(
                `task_reply could not read permission ${requestID}: ${errorText(error)}`,
              );
            }
            if (
              request.id !== requestID ||
              request.sessionID !== child.identity
            ) {
              throw new Error(
                `Permission ${requestID} does not belong to child session ${child.identity}; nothing was replied.`,
              );
            }
            if (options.isDisposed?.()) {
              throw new Error('Plugin instance disposed');
            }
            const decision: PermissionDecision =
              inputArgs.reply === 'always' || inputArgs.reply === 'reject'
                ? inputArgs.reply
                : 'once';
            try {
              await permissionCall(
                permission.reply({
                  sessionID: child.identity,
                  requestID,
                  decision,
                }),
                'permission reply timed out',
              );
            } catch (error) {
              if (isPermissionNotFound(error)) {
                return `Permission ${requestID} on ${child.identity} was resolved elsewhere before the ${decision} reply landed. Nothing was replied.`;
              }
              throw new Error(
                `task_reply could not reply to permission ${requestID}: ${errorText(error)}`,
              );
            }
            return `Permission ${requestID} on ${child.identity} replied with ${decision}.`;
          },
        })
      : undefined;

  return {
    task_cancel,
    task_status,
    ...(task_reply ? { task_reply } : {}),
  };
}
