/**
 * Mirror conformance guard (P1.2).
 *
 * Compile-time assertions binding the hand-mirrored v2 plugin context in
 * `./types.ts` to the official `@opencode/plugin` types (pinned to the
 * audited version in devDependencies). Enforcement point is `bun run
 * typecheck`: this file must NOT carry a test suffix, because tsconfig
 * excludes test-suffixed files (`*.test.ts`) from tsc — a test-suffixed
 * guard silently checks nothing.
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

import type { PermissionDomain } from '@opencode/plugin/promise/permission';
import type { SessionHooks } from '@opencode/plugin/promise/session';
import type { V2Context } from './types';

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Official session hook surface as of the pinned @opencode/plugin. */
type OfficialSessionHookNames =
  | 'prompt'
  | 'context'
  | 'compaction'
  | 'generate'
  | 'title'
  | 'model.request'
  | 'http.request'
  | 'http.response'
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
type _permissionRulesExists = Expect<
  PermissionDomain['rules'] extends (...args: never[]) => unknown ? true : false
>;
type _permissionRulesInput = Expect<
  Parameters<PermissionDomain['rules']>[0] extends {
    sessionID: string;
    permissions: ReadonlyArray<unknown>;
  }
    ? true
    : false
>;
