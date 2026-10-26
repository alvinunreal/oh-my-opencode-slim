/**
 * Mirror conformance guard (P1.2).
 *
 * Compile-time assertions binding the hand-mirrored v2 plugin context in
 * `./types.ts` to the official `@opencode/plugin` types (pinned to the
 * audited version in devDependencies; baseline `2.1.4`). Enforcement
 * point is `bun run typecheck`: this file must NOT carry a test suffix,
 * because tsconfig excludes test-suffixed files (`*.test.ts`) from tsc —
 * a test-suffixed guard silently checks nothing.
 *
 * This file is deliberately NOT imported by any entry point, so it never
 * reaches the runtime bundles, and it uses `import type` only, so it
 * never loads `@opencode/plugin` at runtime.
 *
 * Layers:
 *  1. Pin the official session hook surface exactly. Bumping the
 *     devDependency past an OpenCode-core hook change fails typecheck
 *     here first.
 *  2. The hook names the mirror registers exist officially, and the
 *     official-name subset the mirror's hook signature accepts equals
 *     the declared list — stale guard lists and mirror overloads that
 *     appear/disappear both fail.
 *  3. Official payload fields the bridges rely on exist with the shapes
 *     the bridges assume.
 *
 * Known residual: a NEW mirror hook overload using a non-official name
 * is invisible to layer 2's derivation (which filters official names
 * only). Add such names to `MirrorSessionHookNames` explicitly; layer
 * 2a then fails until the name is official — which is the intended
 * alarm. Deleting this file goes unnoticed by `bun test`; it is
 * referenced from docs/opencode-v2-compatibility.md instead.
 */

import type { RpcCallOptions } from '@opencode/client';
import type { EventDomain } from '@opencode/plugin/promise/event';
import type { PermissionDomain } from '@opencode/plugin/promise/permission';
import type { Context as OfficialContext } from '@opencode/plugin/promise/plugin';
import type { RpcDomain, RpcHandlers } from '@opencode/plugin/promise/rpc';
import type {
  SessionDomain,
  SessionHooks,
} from '@opencode/plugin/promise/session';
import type { Rpc } from '@opencode/plugin/rpc';
import type { V2PresetRpcCallOptions } from './preset-manager';
import type { sessionPresetRpc } from './preset-rpc';
import type {
  V2Context,
  V2PermissionRule,
  V2SessionModelRequestEvent,
  V2SessionPresetRpcHandlers,
} from './types';

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** The deliberately narrow RPC mirror supports only our portable Zod
 * contract. Keep handler inference, cancellation and client location options
 * pinned to the official 2.1.4 API without exporting its dev-only types. */
type PresetRpc = typeof sessionPresetRpc;
type _presetRpcPortable = Expect<
  PresetRpc extends Rpc.PortableDefinition ? true : false
>;
type _presetRpcNoEvents = Expect<Equal<keyof PresetRpc['events'], never>>;
type _presetRpcNoErrors = Expect<
  Equal<
    {
      [K in keyof PresetRpc['methods']]: 'errors' extends keyof PresetRpc['methods'][K]
        ? true
        : false;
    }[keyof PresetRpc['methods']],
    false
  >
>;
type _rpcRegistrationCompatible = Expect<
  RpcDomain extends NonNullable<V2Context['rpc']> ? true : false
>;
type _rpcHandlerInputs = Expect<
  Equal<
    {
      [K in keyof PresetRpc['methods']]: Parameters<
        V2SessionPresetRpcHandlers[K]
      >[0];
    },
    {
      [K in keyof PresetRpc['methods']]: Parameters<
        RpcHandlers<PresetRpc>[K]
      >[0];
    }
  >
>;
type _rpcHandlerOutputs = Expect<
  Equal<
    {
      [K in keyof PresetRpc['methods']]: ReturnType<
        V2SessionPresetRpcHandlers[K]
      >;
    },
    { [K in keyof PresetRpc['methods']]: ReturnType<RpcHandlers<PresetRpc>[K]> }
  >
>;
type _rpcHandlerSignal = Expect<
  Equal<
    Parameters<V2SessionPresetRpcHandlers['apply']>[1],
    Pick<Parameters<RpcHandlers<PresetRpc>['apply']>[1], 'signal'>
  >
>;
type _rpcCallOptions = Expect<
  V2PresetRpcCallOptions extends Pick<RpcCallOptions, 'location' | 'signal'>
    ? true
    : false
>;

/** Official session hook surface as of the pinned @opencode/plugin.
 * `experimental.ws.send`/`receive` were added upstream in 2.0.6 (#49136);
 * the plugin does not register them (experimental, no current consumer),
 * so they appear in the official set only. */
type OfficialSessionHookNames =
  | 'prompt'
  | 'context'
  | 'compaction'
  | 'generate'
  | 'title'
  | 'model.request'
  | 'http.request'
  | 'http.response'
  | 'experimental.ws.handshake'
  | 'experimental.ws.send'
  | 'experimental.ws.receive'
  | 'retry';

/** Layer 1: the official surface is exactly this set — nothing added,
 * removed, or renamed in OpenCode core without this guard failing. */
type _officialSurfacePinned = Expect<
  Equal<keyof SessionHooks, OfficialSessionHookNames>
>;

/** Session hook names the mirror currently registers. Keep in sync with
 * the `hook()` overloads on `V2Context['session']`. */
type MirrorSessionHookNames =
  | 'context'
  | 'prompt'
  | 'model.request'
  | 'compaction';

/** The official names the mirror's `session.hook` signature accepts.
 * `cb: never` neutralizes callback contravariance so only the name
 * matters; an overloaded source matches when any overload matches. */
type MirrorCallableHookNames<N extends OfficialSessionHookNames> =
  N extends unknown
    ? V2Context['session']['hook'] extends (name: N, cb: never) => unknown
      ? N
      : never
    : never;

/** Layer 2a: every mirrored hook name is an official name. */
type _mirrorSubsetOfOfficial = Expect<
  MirrorSessionHookNames extends OfficialSessionHookNames ? true : false
>;

/** Layer 2b: the declared list matches what the mirror actually
 * accepts — fails when either side drifts. */
type _mirrorListExact = Expect<
  Equal<
    MirrorCallableHookNames<OfficialSessionHookNames>,
    MirrorSessionHookNames
  >
>;

/** Layer 3: official payload fields the bridges rely on. */
type _promptMessageId = Expect<
  SessionHooks['prompt'] extends { readonly messageID: string } ? true : false
>;
type _compactionResultOverride = Expect<
  SessionHooks['compaction'] extends { result?: { summary: string } }
    ? true
    : false
>;
type _titleResultOverride = Expect<
  SessionHooks['title'] extends { result?: string } ? true : false
>;
type _modelRequestKind = Expect<
  SessionHooks['model.request'] extends {
    kind: 'primary' | 'compaction' | 'title' | 'generate';
  }
    ? true
    : false
>;
type _modelRequestSelection = Expect<
  SessionHooks['model.request']['model'] extends V2SessionModelRequestEvent['model']
    ? true
    : false
>;
type _modelRequestSelectionKeys = Expect<
  Equal<
    keyof V2SessionModelRequestEvent['model'],
    keyof SessionHooks['model.request']['model']
  >
>;
type _createMirrorInput = Expect<
  Parameters<
    NonNullable<V2Context['session']['create']>
  >[0] extends NonNullable<Parameters<SessionDomain['create']>[0]>
    ? true
    : false
>;
type _contextCreationScope = Expect<
  OfficialContext['location'] extends NonNullable<V2Context['location']>
    ? true
    : false
>;
type _contextWorkspaceAvailable = Expect<
  Equal<
    'workspaceID' extends keyof OfficialContext['location'] ? true : false,
    true
  >
>;
type _createDefaultLocation = Expect<
  Omit<
    Parameters<NonNullable<V2Context['session']['create']>>[0],
    'location'
  > extends NonNullable<Parameters<SessionDomain['create']>[0]>
    ? true
    : false
>;
/** The official PermissionDomain exposes no `rules` method — this fails
 * if upstream adds one or the mirror starts calling it. */
type _permissionRulesGone = Expect<
  Equal<'rules' extends keyof PermissionDomain ? true : false, false>
>;

type SessionUpdateInput = Parameters<SessionDomain['update']>[0];
type _sessionUpdateInput = Expect<
  SessionUpdateInput extends { sessionID: string; title?: string }
    ? true
    : false
>;
/** The permission-rules bridge (createPermissionRulesBridge in setup.ts)
 * relies on the `permissions` field and its rule element shape — pin both
 * so an upstream change fails typecheck here instead of at runtime. */
type _sessionUpdatePermissions = Expect<
  SessionUpdateInput extends {
    permissions?: ReadonlyArray<{
      action: string;
      resource: string;
      effect: 'allow' | 'deny' | 'ask';
    }>;
  }
    ? true
    : false
>;
/** The hand-mirrored rule element must equal the official element exactly —
 * mirror-side drift fails typecheck here too. */
type _permissionRuleMirrorPinned = Expect<
  Equal<
    V2PermissionRule,
    NonNullable<SessionUpdateInput['permissions']>[number]
  >
>;

type SessionInterruptInput = Parameters<SessionDomain['interrupt']>[0];
type _sessionInterruptResume = Expect<
  SessionInterruptInput extends { sessionID: string; resume?: boolean }
    ? true
    : false
>;
type _sessionInterruptContinueGone = Expect<
  Equal<'continue' extends keyof SessionInterruptInput ? true : false, false>
>;

/** Admission without resuming and idle verification are distinct contracts. */
type SessionPromptInput = Parameters<SessionDomain['prompt']>[0];
type MirrorPromptInput = Parameters<
  NonNullable<V2Context['session']['prompt']>
>[0];
type _sessionPromptResume = Expect<
  Equal<SessionPromptInput['resume'], boolean | null | undefined>
>;
type _sessionPromptDelivery = Expect<
  Equal<SessionPromptInput['delivery'], 'steer' | 'queue' | null | undefined>
>;
/** The mirror emits only the non-null subset of the official optional fields. */
type _promptMirrorIntent = Expect<
  Equal<
    [MirrorPromptInput['resume'], MirrorPromptInput['delivery']],
    [
      Exclude<SessionPromptInput['resume'], null>,
      Exclude<SessionPromptInput['delivery'], null>,
    ]
  >
>;
type _waitMirrorInput = Expect<
  Equal<
    Readonly<Parameters<NonNullable<V2Context['session']['wait']>>[0]>,
    Parameters<SessionDomain['wait']>[0]
  >
>;
type _sessionWaitCompletion = Expect<
  Equal<ReturnType<SessionDomain['wait']>, Promise<void>>
>;

/** Only the filters actually consumed by OMO are mirrored, not the complete
 * host listing API. Continuation cursors retain the initial filter set. */
type ListInput = NonNullable<Parameters<SessionDomain['list']>[0]>;
type MirrorListInput = Parameters<NonNullable<V2Context['session']['list']>>[0];
type _listInputFields = Expect<
  Equal<Readonly<MirrorListInput>, Pick<ListInput, keyof MirrorListInput>>
>;
type ListOutput = Awaited<ReturnType<SessionDomain['list']>>;
type _listOutputPage = Expect<
  ListOutput extends { data: Array<{ id: string }>; cursor: object }
    ? true
    : false
>;
type _listNullableContinuation = Expect<
  Equal<ListOutput['cursor']['next'], string | null | undefined>
>;

type HostEvent =
  ReturnType<EventDomain['subscribe']> extends AsyncIterable<infer E>
    ? E
    : never;
type ExecutionEvent = Extract<
  HostEvent,
  { type: `session.execution.${string}` }
>;
type _executionEnvelope = Expect<
  ExecutionEvent extends {
    id: string;
    created: number;
    data: { sessionID: string };
  }
    ? true
    : false
>;
type _shutdownIsSuspended = Expect<
  Equal<
    Extract<
      HostEvent,
      { type: 'session.execution.interrupted' }
    >['data']['reason'],
    'user' | 'shutdown' | 'superseded' | 'inactivity'
  >
>;
type CompactionResult = NonNullable<SessionHooks['compaction']['result']>;
type _nativeCompactionResult = Expect<
  'native' | 'metadata' | 'tokens' extends keyof CompactionResult ? true : false
>;
type _removedCompactionReplayNames = Expect<
  Equal<
    Extract<
      keyof CompactionResult,
      'providerState' | 'providerContext' | 'recent'
    >,
    never
  >
>;
type _waitMirrorCompletion = Expect<
  Equal<
    ReturnType<NonNullable<V2Context['session']['wait']>>,
    ReturnType<SessionDomain['wait']>
  >
>;

/** The runtime-profile bridge relies on the context hook's mutable
 * `options` record (temperature/provider options) and on session.switchModel
 * for model/variant. Pin both to the official surface so an upstream change
 * fails typecheck here instead of silently dropping profile application. */
type _contextOptions = Expect<
  SessionHooks['context'] extends { options: Record<string, unknown> }
    ? true
    : false
>;
type SessionSwitchModelInput = Parameters<SessionDomain['switchModel']>[0];
type _sessionSwitchModelFields = Expect<
  SessionSwitchModelInput extends {
    sessionID: string;
    model: { id: string; providerID: string; variant?: string };
  }
    ? true
    : false
>;
