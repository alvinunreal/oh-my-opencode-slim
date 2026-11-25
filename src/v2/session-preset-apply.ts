/**
 * Session-scoped preset switching shared by the TUI `/preset <name>` fast
 * path and the server-side `/preset <name>` command (issue #1700).
 *
 * A preset switch is not a configuration write: it binds the target session's
 * inference snapshot (see `./session-presets`) for new delegations and explicit
 * same-agent continuations. The root model, prompts, skills/MCPs and global
 * default are untouched — unless `forceOrchestrator` is set, in which case the
 * same transaction also switches the root session's model to the preset's
 * orchestrator entry (ADR-005); the global default still stays untouched. The
 * transport differs (TUI:
 * session-preset RPC; server: the in-process store), so callers pass a `bind`
 * callback; name validation and the user-facing wording live here so both
 * surfaces report the same thing.
 */
import { loadPluginConfig } from '../config/loader';
import { getAllConfiguredPresets } from '../tools/preset-switch';
import type { SessionPresetState } from './session-presets';

export interface SessionPresetOutcome {
  ok: boolean;
  message: string;
}

/** Parsed `/preset` command input, shared by the TUI fast path and the
 * server command so both surfaces report identical usage errors.
 * Configured preset names may contain spaces (the schema accepts
 * arbitrary keys, and the pre-flag command matched the whole argument),
 * so callers pass the configured names: an exact match wins before
 * token parsing, and otherwise more than one non-flag token is a usage
 * error. */
export type ParsedPresetCommandInput =
  | { kind: 'empty' }
  | { kind: 'apply'; presetName: string; forceOrchestrator: boolean }
  | { kind: 'usage-error'; message: string };

export const FORCE_ORCHESTRATOR_FLAG = '--force-orchestrator';
export const FORCE_ORCHESTRATOR_SHORT_FLAG = '-f';

export function parsePresetCommandInput(
  text: string,
  availableNames?: readonly string[],
): ParsedPresetCommandInput {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };
  // An exact configured name wins over flag tokenizing, so names with
  // spaces keep working (`/preset code review`).
  if (availableNames?.includes(trimmed))
    return { kind: 'apply', presetName: trimmed, forceOrchestrator: false };
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const names: string[] = [];
  let forceOrchestrator = false;
  for (const token of tokens) {
    if (
      token === FORCE_ORCHESTRATOR_FLAG ||
      token === FORCE_ORCHESTRATOR_SHORT_FLAG
    ) {
      forceOrchestrator = true;
      continue;
    }
    if (token.startsWith('--'))
      return {
        kind: 'usage-error',
        message: `Unknown flag "${token}". The only valid flag is ${FORCE_ORCHESTRATOR_FLAG} (${FORCE_ORCHESTRATOR_SHORT_FLAG}).`,
      };
    names.push(token);
  }
  if (names.length > 1) {
    // The name tokens may still be one configured multi-word name
    // alongside the flag (`/preset code review -f`).
    const joined = names.join(' ');
    if (availableNames?.includes(joined))
      return { kind: 'apply', presetName: joined, forceOrchestrator };
    return {
      kind: 'usage-error',
      message: `Specify one preset name: /preset <name> [${FORCE_ORCHESTRATOR_FLAG} | ${FORCE_ORCHESTRATOR_SHORT_FLAG}].`,
    };
  }
  if (names.length === 0)
    return {
      kind: 'usage-error',
      message: `Specify a preset name: /preset <name> [${FORCE_ORCHESTRATOR_FLAG} | ${FORCE_ORCHESTRATOR_SHORT_FLAG}] to force the orchestrator model.`,
    };
  return { kind: 'apply', presetName: names[0], forceOrchestrator };
}

export interface AvailablePresets {
  names: string[];
  /** The configured default, not the session binding. */
  active: string | undefined;
}

/** Presets visible from `directory`, deduped and sorted, plus the default. */
export function readAvailablePresets(
  directory: string,
  hostFlavor = 'v2',
): AvailablePresets {
  const config = loadPluginConfig(directory, { silent: true, hostFlavor });
  const names = [
    ...new Set([
      ...Object.keys(getAllConfiguredPresets(directory, hostFlavor)),
      ...Object.keys(config.presets ?? {}),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return { names, active: config.preset };
}

function sessionPresetAppliedMessage(presetName: string): string {
  return `Applied preset "${presetName}" to this session's team.`;
}

/**
 * Validate the name, then bind it to the target session through `bind`.
 * Never throws: every failure becomes an `ok: false` outcome.
 */
export async function bindSessionPreset(options: {
  directory: string;
  presetName: string;
  hostFlavor?: string;
  forceOrchestrator?: boolean;
  bind: (
    presetName: string,
    forceOrchestrator: boolean,
  ) => Promise<SessionPresetState>;
}): Promise<SessionPresetOutcome> {
  const {
    directory,
    presetName,
    hostFlavor = 'v2',
    forceOrchestrator = false,
    bind,
  } = options;
  const { names } = readAvailablePresets(directory, hostFlavor);
  if (!names.includes(presetName)) {
    return {
      ok: false,
      message:
        names.length > 0
          ? `Preset "${presetName}" not found. Available presets: ${names.join(', ')}`
          : 'No presets configured. Define presets in oh-my-opencode-slim.jsonc.',
    };
  }
  try {
    const state = await bind(presetName, forceOrchestrator);
    if (state.status !== 'bound' || state.presetName !== presetName) {
      return {
        ok: false,
        message: `Preset "${presetName}" was not applied: the server did not confirm the session binding.`,
      };
    }
    let message = sessionPresetAppliedMessage(presetName);
    if (state.rootForce?.outcome === 'switched') {
      message += ` Root model switched to ${state.rootForce.model}. A native model pick overrides it later.`;
    } else if (state.rootForce?.outcome === 'no-orchestrator-model') {
      message += ` The preset defines no orchestrator model; the main model is unchanged.`;
    }
    return { ok: true, message };
  } catch (err) {
    return {
      ok: false,
      message: `Preset "${presetName}" was not applied: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
