/**
 * TUI config gates, kept free of the OpenTUI/Solid render stack.
 *
 * The v2 TUI entry must decide whether it registers anything before it
 * loads the heavy TUI implementation (`src/tui.ts` and its JSX modules).
 * Everything needed for that decision lives here: one shared
 * `readPluginConfigSnapshot` read projected onto the gate surface. The
 * heavy modules re-export these names, so every existing importer keeps
 * its path.
 */
import { MultiplexerConfigSchema, type MultiplexerType } from './config/schema';
import {
  type PluginConfigSnapshot,
  readPluginConfigSnapshot,
} from './config/snapshot';
import type { LoadedPaneConfig } from './multiplexer/client/tui-wiring';
import { log } from './utils/logger';

export interface SidebarConfigState {
  configInvalid: boolean;
  compactSidebar: boolean;
  multiplexerType: MultiplexerType;
  /** Active preset name (`config.preset`), undefined when unset. */
  presetName?: string;
}

/**
 * Every config-derived gate the TUI entry points need, derived from ONE
 * shared `readPluginConfigSnapshot` read. Replaces the per-concern reads
 * (`isTuiEnabled`, `isSidebarEnabled`, `disabledCommandsFor`,
 * `readConfigState`) that each parsed the whole config layer stack
 * independently.
 */
export interface TuiGatesSnapshot extends SidebarConfigState {
  tuiEnabled: boolean;
  sidebarEnabled: boolean;
  disabledCommands: ReadonlySet<string>;
  disabledHooks: ReadonlySet<string>;
}

/**
 * Gates paired with the identity of the shared snapshot they were derived
 * from. The snapshot fingerprint is the poll-time identity: unchanged ⇒ the
 * same inputs produced the gates, so a tick re-reads cheaply
 * (discovery + stats only) and reuses the derived gates. `readFailed` marks
 * a thrown read (fail-open gates); such an outcome is never adopted as the
 * new baseline.
 */
export interface TuiGatesRead {
  gates: TuiGatesSnapshot;
  /** Snapshot identity; empty for a failed/unseeded read. */
  fingerprint: string;
  /** Pane-wiring admission config from the same snapshot. */
  paneConfig: LoadedPaneConfig | undefined;
  /** True only when the shared read threw (fail-open gates were returned). */
  readFailed: boolean;
}

export function resolveMultiplexerType(value: unknown): MultiplexerType {
  const parsed = MultiplexerConfigSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data.type : 'none';
}

/**
 * Fail-open defaults for a config read that throws: the TUI and sidebar
 * survive, and the remaining fields read as though the config layer stack
 * parsed without any effective value (matching the per-concern reads this
 * replaces).
 */
function failOpenTuiGates(): TuiGatesSnapshot {
  return {
    tuiEnabled: true,
    sidebarEnabled: true,
    configInvalid: false,
    compactSidebar: true,
    multiplexerType: 'none',
    presetName: undefined,
    disabledCommands: new Set(),
    disabledHooks: new Set(),
  };
}

/**
 * Only genuinely broken configs (parse/load/schema failures) mark the
 * sidebar invalid. Benign missing-preset notices do not, otherwise a config
 * that loads fine would be shown as "Config invalid".
 */
export function warningsMakeConfigInvalid(
  warnings: readonly { kind: string }[],
): boolean {
  return warnings.some(
    (warning) =>
      warning.kind === 'invalid-json' ||
      warning.kind === 'invalid-schema' ||
      warning.kind === 'read-error',
  );
}

/** Derive every gate from one snapshot. Pure; no file access. */
function deriveTuiGates(snapshot: PluginConfigSnapshot): TuiGatesSnapshot {
  const config = snapshot.config;
  return {
    tuiEnabled: config.tui !== false,
    sidebarEnabled: config.sidebar !== false,
    configInvalid: warningsMakeConfigInvalid(snapshot.warnings),
    compactSidebar: config.compactSidebar ?? true,
    multiplexerType: resolveMultiplexerType(config.multiplexer),
    ...(typeof config.preset === 'string' && config.preset.length > 0
      ? { presetName: config.preset }
      : {}),
    disabledCommands: new Set(config.disabled_commands ?? []),
    disabledHooks: new Set(config.disabled_hooks ?? []),
  };
}

/** A gate read paired with the snapshot it came from, for callers that also
 *  need snapshot-derived fields (pane wiring) from the SAME read. */
export interface TuiGatesProbe {
  read: TuiGatesRead;
  /** Absent when the shared read threw (fail-open gates were returned). */
  snapshot?: PluginConfigSnapshot;
}

/**
 * Gates from one shared snapshot read, WITHOUT pane-wiring admission.
 *
 * Pane config is only needed by the heavy TUI setup; resolving it here would
 * pull the multiplexer client/adapters into every caller, including the thin
 * v2 entry that runs behind `tui: false`. `src/tui.ts` wraps this into the
 * full `readTuiGates` (pane config included, from the same snapshot) for the
 * render path.
 *
 * Fail-open on a thrown read: the TUI and sidebar survive, command gating
 * fails open, and the result is not adopted as the poll baseline.
 */
export function probeTuiGates(
  directory: string,
  hostFlavor?: string,
  fresh = false,
): TuiGatesProbe {
  try {
    const snapshot = readPluginConfigSnapshot(directory, { hostFlavor, fresh });
    return {
      read: {
        gates: deriveTuiGates(snapshot),
        fingerprint: snapshot.fingerprint,
        paneConfig: undefined,
        readFailed: false,
      },
      snapshot,
    };
  } catch (err) {
    log('[tui] tui config read failed; keeping TUI and sidebar', String(err));
    return {
      read: {
        gates: failOpenTuiGates(),
        fingerprint: '',
        paneConfig: undefined,
        readFailed: true,
      },
    };
  }
}

/** Light gate read (no pane wiring); see `probeTuiGates`. */
export function readTuiGatesOnly(
  directory: string,
  hostFlavor?: string,
  fresh = false,
): TuiGatesRead {
  return probeTuiGates(directory, hostFlavor, fresh).read;
}

/**
 * Load the TUI gates through the shared cached read. The snapshot module
 * dedupes unchanged reads (discovery + stats only), so repeated calls cost
 * one cheap identity revalidation instead of a full layer-stack parse.
 * Fail-open on a thrown read.
 */
export function loadTuiGates(
  directory: string,
  hostFlavor?: string,
): TuiGatesSnapshot {
  return readTuiGatesOnly(directory, hostFlavor).gates;
}

/** Project the gates onto the sidebar runtime's config-state view. */
export function configStateOfGates(
  gates: TuiGatesSnapshot,
): SidebarConfigState {
  return {
    configInvalid: gates.configInvalid,
    compactSidebar: gates.compactSidebar,
    multiplexerType: gates.multiplexerType,
    presetName: gates.presetName,
  };
}

export function readConfigState(
  directory: string,
  hostFlavor?: string,
): SidebarConfigState {
  return configStateOfGates(loadTuiGates(directory, hostFlavor));
}

/**
 * Surface a broken config without replacing config-backed rows with the
 * loader's fallback defaults. Once the file is valid again, the fresh state
 * atomically replaces the retained values.
 */
export function retainLastGoodConfigState(
  current: SidebarConfigState,
  next: SidebarConfigState,
): SidebarConfigState {
  return next.configInvalid
    ? { ...current, configInvalid: true }
    : { ...next, configInvalid: false };
}
