/**
 * Session-scoped preset switching shared by the TUI `/preset <name>` fast
 * path and the server-side `/preset <name>` command (issue #1700).
 *
 * A preset switch is not a configuration write: it binds the target session's
 * inference snapshot (see `./session-presets`), so future subagents of that
 * session use the preset. The root model, prompts, skills/MCPs, already-created
 * children and the global default are untouched. The transport differs (TUI:
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
  return `Applied preset "${presetName}" to this session's team. Future subagents use it on their next dispatch; the root model, already-created children and the global default stay unchanged.`;
}

/**
 * Validate the name, then bind it to the target session through `bind`.
 * Never throws: every failure becomes an `ok: false` outcome.
 */
export async function bindSessionPreset(options: {
  directory: string;
  presetName: string;
  hostFlavor?: string;
  bind: (presetName: string) => Promise<SessionPresetState>;
}): Promise<SessionPresetOutcome> {
  const { directory, presetName, hostFlavor = 'v2', bind } = options;
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
    const state = await bind(presetName);
    if (state.status !== 'bound' || state.presetName !== presetName) {
      return {
        ok: false,
        message: `Preset "${presetName}" was not applied: the server did not confirm the session binding.`,
      };
    }
    return { ok: true, message: sessionPresetAppliedMessage(presetName) };
  } catch (err) {
    return {
      ok: false,
      message: `Preset "${presetName}" was not applied: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
