import { Rpc } from '@opencode/plugin/rpc';

export interface GoMonthlyLimitRow {
  modelID: string;
  go: string;
  goPlus: string;
  goTeams: string;
}

export interface GoMonthlyLimits {
  status: 'fresh' | 'stale' | 'unavailable';
  sourceURL: string;
  /** Last successful fetch or conditional revalidation. */
  updatedAt?: string;
  rows: GoMonthlyLimitRow[];
}

export interface AgentEntry {
  name: string;
  model?: string;
  variant?: string;
  temperature?: number;
  /** Serialized JSON of the agent's `options` object; absent when empty or unset. */
  optionsJson?: string;
  skills?: string[];
  mcps?: string[];
  /** Full ordered fallback model ids (provider/model), when the override is an array. */
  modelChain?: string[];
  /** Explicit model inheritance source declared by this override. */
  inheritModelFrom?: string;
  /** True when the effective agent comes from the preset's `extends`, not from a local override. */
  inherited: boolean;
  /** True when the override marks a custom agent as primary. */
  primary: boolean;
}

export interface PresetInfo {
  name: string;
  description: string;
  /** True when the preset key exists in the user config file. */
  inUserConfig: boolean;
  /** True when the preset key exists in any project `.opencode` config layer. */
  inProjectConfig: boolean;
  agents: AgentEntry[];
  /** False when any project layer defines this preset (project presets are read-only). */
  editable: boolean;
  /** Declared base preset names (normally zero or one in OMOS 3.0.7). */
  extends: string[];
  /** Inheritance/definition problem that prevents applying this preset. */
  validationError?: string;
}

export interface RosterEntry {
  name: string;
  description: string;
  protected: boolean;
  primary: boolean;
}

export interface Snapshot {
  found: boolean;
  configPath: string;
  /** Effective preset (env > project > global) for compatibility. */
  preset: string;
  envOverride: boolean;
  /** Installed oh-my-opencode-slim version, when the host reports it. */
  omosVersion?: string;
  presets: PresetInfo[];
  disabledAgents: string[];
  /** Global (user config) default preset; empty when unset. */
  globalPreset: string;
  /** Project-layer default preset; empty when unset. */
  projectPreset: string;
  /** OH_MY_OPENCODE_SLIM_PRESET; empty when unset. */
  envPreset: string;
  /** Effective OMOS live-config-refresh setting (defaults true). */
  liveConfigRefresh: boolean;
  warnings: string[];
  /** Existing project config files in merge order (root to session). */
  projectConfigPaths: string[];
  roster: RosterEntry[];
}

export interface OverridePatch {
  model?: string;
  /** Empty string "" removes the variant (model default). */
  variant?: string;
  /** Temperature to set, 0..2. Ignored when clearTemperature is true. */
  temperature?: number;
  /** true removes the temperature. */
  clearTemperature?: boolean;
  /** Empty string "" or "{}" removes options; otherwise a JSON object string. */
  optionsJson?: string;
}

export interface ResultMessage {
  ok: boolean;
  message: string;
}

/** OpenCode Desktop's own model favorites/recents (read-only, app-internal DB). */
export interface NativeModelPrefs {
  status: 'ok' | 'unavailable';
  favorites: string[];
  recent: string[];
  updatedAt?: string;
}

export interface SessionPresetTeam {
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
  inheritance: Record<string, 'session' | 'orchestrator'>;
}

/** Response shape of OMOS's public session-preset RPC. */
export interface SessionPresetState {
  sessionID: string;
  status: 'bound' | 'unbound';
  presetName: string | null;
  /** Default bindings may remain bound with an unnamed (null) preset. */
  selection?: 'explicit' | 'default';
  affects: 'future-children-only';
  team?: SessionPresetTeam;
}

function resultSchema() {
  return {
    type: 'object',
    properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
    required: ['ok', 'message'],
    additionalProperties: false,
  };
}

function directorySchema() {
  return { type: 'string' };
}

function agentEntrySchema() {
  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      model: { type: 'string' },
      variant: { type: 'string' },
      temperature: { type: 'number' },
      optionsJson: { type: 'string' },
      skills: { type: 'array', items: { type: 'string' } },
      mcps: { type: 'array', items: { type: 'string' } },
      modelChain: { type: 'array', items: { type: 'string' } },
      inheritModelFrom: { type: 'string' },
      inherited: { type: 'boolean' },
      primary: { type: 'boolean' },
    },
    required: ['name', 'inherited', 'primary'],
    additionalProperties: false,
  };
}

function presetInfoSchema() {
  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      inUserConfig: { type: 'boolean' },
      inProjectConfig: { type: 'boolean' },
      agents: { type: 'array', items: agentEntrySchema() },
      editable: { type: 'boolean' },
      extends: { type: 'array', items: { type: 'string' } },
      validationError: { type: 'string' },
    },
    required: [
      'name',
      'description',
      'inUserConfig',
      'inProjectConfig',
      'agents',
      'editable',
      'extends',
    ],
    additionalProperties: false,
  };
}

function rosterSchema() {
  return {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      protected: { type: 'boolean' },
      primary: { type: 'boolean' },
    },
    required: ['name', 'description', 'protected', 'primary'],
    additionalProperties: false,
  };
}

function snapshotSchema() {
  return {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      configPath: { type: 'string' },
      preset: { type: 'string' },
      envOverride: { type: 'boolean' },
      omosVersion: { type: 'string' },
      presets: { type: 'array', items: presetInfoSchema() },
      disabledAgents: { type: 'array', items: { type: 'string' } },
      globalPreset: { type: 'string' },
      projectPreset: { type: 'string' },
      envPreset: { type: 'string' },
      liveConfigRefresh: { type: 'boolean' },
      warnings: { type: 'array', items: { type: 'string' } },
      projectConfigPaths: { type: 'array', items: { type: 'string' } },
      roster: { type: 'array', items: rosterSchema() },
    },
    required: [
      'found',
      'configPath',
      'preset',
      'envOverride',
      'presets',
      'disabledAgents',
      'globalPreset',
      'projectPreset',
      'envPreset',
      'liveConfigRefresh',
      'warnings',
      'projectConfigPaths',
      'roster',
    ],
    additionalProperties: false,
  };
}

function sessionPresetStateSchema() {
  return {
    type: 'object',
    properties: {
      sessionID: { type: 'string' },
      status: { type: 'string', enum: ['bound', 'unbound'] },
      presetName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      selection: { type: 'string', enum: ['explicit', 'default'] },
      affects: { type: 'string', enum: ['future-children-only'] },
      team: {
        type: 'object',
        properties: {
          agentModels: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          agentVariants: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          inheritance: {
            type: 'object',
            additionalProperties: {
              type: 'string',
              enum: ['session', 'orchestrator'],
            },
          },
        },
        required: ['agentModels', 'agentVariants', 'inheritance'],
        additionalProperties: false,
      },
    },
    required: ['sessionID', 'status', 'presetName', 'affects'],
    additionalProperties: false,
  };
}

/**
 * Contract implemented by the server part (src/index.ts). There is no
 * OMOS-side RPC: the TUI preset manager writes the global config file
 * directly, and OpenCode picks the change up on hot reload. This contract
 * mirrors that mechanism (same file, same write semantics), with presets
 * merged from user + project config.
 */
export const OmosConfig = Rpc.define({
  id: 'oh-my-opencode-slim.gui-config.v1',
  methods: {
    getGoMonthlyLimits: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['fresh', 'stale', 'unavailable'] },
          sourceURL: { type: 'string' },
          updatedAt: { type: 'string' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                modelID: { type: 'string' },
                go: { type: 'string' },
                goPlus: { type: 'string' },
                goTeams: { type: 'string' },
              },
              required: ['modelID', 'go', 'goPlus', 'goTeams'],
              additionalProperties: false,
            },
          },
        },
        required: ['status', 'sourceURL', 'rows'],
        additionalProperties: false,
      },
    },
    getSnapshot: {
      input: {
        type: 'object',
        properties: { directory: directorySchema() },
        additionalProperties: false,
      },
      output: snapshotSchema(),
    },
    clearPresetDefault: {
      input: {
        type: 'object',
        properties: { directory: { type: 'string' } },
        additionalProperties: false,
      },
      output: resultSchema(),
    },
    switchPreset: {
      input: {
        type: 'object',
        properties: { name: { type: 'string' }, directory: directorySchema() },
        required: ['name'],
        additionalProperties: false,
      },
      output: resultSchema(),
    },
    createPreset: {
      input: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          copyFrom: { type: 'string' },
          directory: directorySchema(),
        },
        required: ['name'],
        additionalProperties: false,
      },
      output: resultSchema(),
    },
    deletePreset: {
      input: {
        type: 'object',
        properties: { name: { type: 'string' }, directory: directorySchema() },
        required: ['name'],
        additionalProperties: false,
      },
      output: resultSchema(),
    },
    setAgentOverride: {
      input: {
        type: 'object',
        properties: {
          preset: { type: 'string' },
          agent: { type: 'string' },
          patch: {
            type: 'object',
            properties: {
              model: { type: 'string' },
              variant: { type: 'string' },
              temperature: { type: 'number' },
              clearTemperature: { type: 'boolean' },
              optionsJson: { type: 'string' },
            },
            additionalProperties: false,
          },
          directory: directorySchema(),
        },
        required: ['preset', 'agent', 'patch'],
        additionalProperties: false,
      },
      output: resultSchema(),
    },
    removeAgent: {
      input: {
        type: 'object',
        properties: {
          preset: { type: 'string' },
          agent: { type: 'string' },
          directory: directorySchema(),
        },
        required: ['preset', 'agent'],
        additionalProperties: false,
      },
      output: resultSchema(),
    },
    setAgentDisabled: {
      input: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          disabled: { type: 'boolean' },
          directory: directorySchema(),
        },
        required: ['agent', 'disabled'],
        additionalProperties: false,
      },
      output: resultSchema(),
    },
  },
  events: {},
});

/**
 * OMOS 3.0.7's public session-preset contract, re-declared for GUI clients.
 * Our backend does not register it: the installed OMOS plugin owns the server
 * implementation and its session bindings.
 */
export const SessionPreset = Rpc.define({
  id: 'oh-my-opencode-slim.session-preset.v1',
  methods: {
    read: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string', minLength: 1 } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: sessionPresetStateSchema(),
    },
    apply: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string', minLength: 1 },
          presetName: { type: 'string', minLength: 1 },
        },
        required: ['sessionID', 'presetName'],
        additionalProperties: false,
      },
      output: sessionPresetStateSchema(),
    },
    unbind: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string', minLength: 1 } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: sessionPresetStateSchema(),
    },
  },
  events: {},
});
