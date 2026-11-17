/**
 * Server-side `/preset` for non-TUI clients (issues #1474, #1700).
 *
 * Create/edit/delete stay in the TUI preset manager. `/preset
 * <name>` binds the invoking session's inference snapshot (see
 * `./session-preset-apply`), matching the TUI fast path; `/preset-default`
 * changes the user default through the same persistence path as the manager.
 *
 * A preset switch is a config mutation, not a turn. v2 has no display-only
 * message channel — a synthetic inbox item is delivered into the model context
 * on the next turn — so the result travels through the command error channel
 * the client already renders. Nothing runs and nothing enters the context.
 */
import { readPluginConfigSnapshot } from '../config/snapshot';
import {
  getPresetSelectionState,
  switchPresetOnDisk,
} from '../tools/preset-switch';
import { bindSessionPreset } from './session-preset-apply';
import type { SessionPresetState } from './session-presets';
import type { V2CommandDefinition } from './types';

export const PRESET_COMMAND_NAME = 'preset';
export const PRESET_COMMAND_DESCRIPTION =
  'List presets, or apply one to this session';
export const PRESET_STATUS_COMMAND_NAME = 'preset-status';
export const PRESET_DEFAULT_COMMAND_NAME = 'preset-default';

export interface PresetDefaultCommandOptions {
  directory: string;
  /** Await the server's existing profile refresh, not just a refresh request. */
  refreshDefault: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface PresetCommandOptions {
  directory: string;
  /** Binds a preset to the invoking session (server-side store, no RPC). */
  applyToSession: (
    sessionID: string,
    presetName: string,
  ) => Promise<SessionPresetState>;
  /** Reads the invoking session's binding, so the list reports what actually
   * applies to it instead of only the global default. */
  readSessionPreset: (sessionID: string) => Promise<SessionPresetState>;
}

function presetDefaultsFeedback(directory: string, hostFlavor = 'v2'): string {
  const snapshot = readPluginConfigSnapshot(directory, { hostFlavor });
  const selection = getPresetSelectionState(directory, hostFlavor, snapshot);
  const source = process.env.OH_MY_OPENCODE_SLIM_PRESET
    ? 'environment: OH_MY_OPENCODE_SLIM_PRESET'
    : selection.project !== undefined
      ? 'project config (.opencode)'
      : selection.global
        ? 'user config'
        : 'none';
  return [
    `Global default: ${selection.global ?? '(none)'}.`,
    `Effective project default: ${selection.effective?.trim() || '(none)'} (source: ${source}).`,
    selection.projectAvailable.length
      ? `Available presets: ${selection.projectAvailable.join(', ')}.`
      : 'No presets configured. Define presets in oh-my-opencode-slim.jsonc.',
  ].join(' ');
}

/** Read-only even when no configured presets remain. */
export async function presetStatusFeedback(
  options: Pick<PresetCommandOptions, 'directory' | 'readSessionPreset'> & {
    sessionID: string;
    hostFlavor?: string;
  },
): Promise<string> {
  const parts: string[] = [];
  try {
    const state = await options.readSessionPreset(options.sessionID);
    parts.push(
      state.status === 'unbound'
        ? 'Session status: unbound. Session team: not bound yet.'
        : `Session status: bound. Selection: ${state.selection === 'default' ? 'default-derived (root sessions refresh on next admission)' : state.selection === 'explicit' ? 'explicit (fixed until /preset <name>)' : 'legacy explicit (fixed until /preset <name>)'}. Saved session preset: ${state.presetName ?? '(no named preset)'}.`,
    );
  } catch (error) {
    parts.push(`Session status: unknown — ${String(error)}.`);
  }
  try {
    parts.push(presetDefaultsFeedback(options.directory, options.hostFlavor));
  } catch (error) {
    parts.push(`Preset defaults/catalog: unknown — ${String(error)}.`);
  }
  return parts.join(' ');
}

/** No argument: list, binding provenance, defaults, and command hints. */
export async function presetListFeedback(
  options: Pick<PresetCommandOptions, 'directory' | 'readSessionPreset'> & {
    sessionID: string;
    hostFlavor?: string;
  },
): Promise<string> {
  return `${await presetStatusFeedback(options)} Run /preset <name> to apply or reapply to this session; /preset-status to inspect; /preset-default <name> to change the user default (not this session binding).`;
}

export async function presetDefaultFeedback(
  options: PresetDefaultCommandOptions & { presetName: string },
): Promise<string> {
  const { directory, presetName, refreshDefault } = options;
  if (!presetName) {
    return `${presetDefaultsFeedback(directory)} Run /preset-default <name> to change the user default.`;
  }
  const snapshot = readPluginConfigSnapshot(directory, { hostFlavor: 'v2' });
  const selection = getPresetSelectionState(directory, 'v2', snapshot);
  if (selection.project === '') {
    return 'Cannot change the user default: project config (.opencode) explicitly sets an empty preset, which overrides the user default. Remove or update the project preset first.';
  }
  // Runtime-parsed declarations retain extends and marketplace metadata.
  const result = switchPresetOnDisk(
    directory,
    presetName,
    { presets: selection.rawDefinitions },
    {
      hostFlavor: 'v2',
    },
  );
  if (!result.ok) return result.message;
  const saved = `Saved global default "${presetName}". Session bindings unchanged.`;
  try {
    const refresh = await refreshDefault();
    return refresh.ok
      ? `${saved} Runtime profiles refreshed. Default-bound root sessions adopt the default on their next admission; no running child was changed immediately. Existing explicit bindings and continuation behavior are unchanged.`
      : `${saved} Runtime refresh failed: ${refresh.reason}. Reload OpenCode to refresh runtime profiles.`;
  } catch (error) {
    return `${saved} Runtime refresh failed: ${String(error)}. Reload OpenCode to refresh runtime profiles.`;
  }
}

export function createPresetStatusCommand(
  options: Pick<PresetCommandOptions, 'directory' | 'readSessionPreset'>,
): V2CommandDefinition {
  return {
    name: PRESET_STATUS_COMMAND_NAME,
    description: 'Inspect session preset binding and configured defaults',
    execute: async (input) => {
      const feedback = input.prompt?.text?.trim()
        ? 'Usage: /preset-status (no arguments).'
        : await presetStatusFeedback({
            ...options,
            sessionID: input.sessionID,
          });
      throw new Error(feedback);
    },
  };
}

export function createPresetDefaultCommand(
  options: PresetDefaultCommandOptions,
): V2CommandDefinition {
  return {
    name: PRESET_DEFAULT_COMMAND_NAME,
    description:
      'Inspect or change the user default preset (not session binding)',
    execute: async (input) => {
      const feedback = await presetDefaultFeedback({
        ...options,
        presetName: (input.prompt?.text ?? '').trim(),
      });
      // Keep this display-only rejection outside the refresh catch above.
      throw new Error(feedback);
    },
  };
}

/** A named preset: bind it to the invoking session. Never throws. */
export async function presetApplyFeedback(
  options: Pick<PresetCommandOptions, 'directory' | 'applyToSession'> & {
    sessionID: string;
    presetName: string;
    hostFlavor?: string;
  },
): Promise<string> {
  const { directory, sessionID, presetName, applyToSession, hostFlavor } =
    options;
  const outcome = await bindSessionPreset({
    directory,
    presetName,
    hostFlavor: hostFlavor ?? 'v2',
    bind: (name) => applyToSession(sessionID, name),
  });
  return outcome.message;
}

/**
 * The v2 command definition. `execute` deliberately rejects with its feedback:
 * it is the only surface a non-TUI client renders without creating a message
 * or waking a turn.
 */
export function createPresetCommand(
  options: PresetCommandOptions,
): V2CommandDefinition {
  return {
    name: PRESET_COMMAND_NAME,
    description: PRESET_COMMAND_DESCRIPTION,
    execute: async (input) => {
      const presetName = (input?.prompt?.text ?? '').trim();
      throw new Error(
        presetName
          ? await presetApplyFeedback({
              directory: options.directory,
              applyToSession: options.applyToSession,
              sessionID: input.sessionID,
              presetName,
            })
          : await presetListFeedback({
              directory: options.directory,
              readSessionPreset: options.readSessionPreset,
              sessionID: input.sessionID,
            }),
      );
    },
  };
}
