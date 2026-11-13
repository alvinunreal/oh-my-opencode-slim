import type { V2Context } from '../v2/types';
import { createOmosConfigBackend, type OmosBackend } from './config-backend';
import { createGoMonthlyLimitsService } from './go-monthly-limits';
import { type GoMonthlyLimits, OmosConfig } from './rpc';

/**
 * Registers the Desktop GUI's config/allowance preferences RPC on the shared
 * server. The GUI reads and writes the same config files as the TUI through
 * this contract; no separate plugin process is involved.
 *
 * `V2Context.rpc` mirrors only the session-preset contract, so the generic
 * register signature is reconstructed here. The host validates definitions the
 * same way for every contract.
 *
 * Returns undefined when the host does not expose plugin RPC.
 */

/** Handlers this server registers for `OmosConfig`. */
interface GuiConfigHandlers
  extends Pick<
    OmosBackend,
    | 'getSnapshot'
    | 'switchPreset'
    | 'clearPresetDefault'
    | 'createPreset'
    | 'deletePreset'
    | 'setAgentOverride'
    | 'removeAgent'
    | 'setAgentDisabled'
  > {
  getGoMonthlyLimits(): Promise<GoMonthlyLimits>;
}

/** The narrow host surface this adapter calls (the v2 RPC domain). */
interface GuiConfigRpcDomain {
  register(
    definition: typeof OmosConfig,
    handlers: GuiConfigHandlers,
  ): Promise<{ dispose(): void }>;
}

export async function registerGuiConfigRpc(
  ctx: Pick<V2Context, 'rpc'>,
  directory: string,
  omosVersion: string,
): Promise<{ dispose(): void } | undefined> {
  if (!ctx.rpc?.register) return undefined;
  const backend = createOmosConfigBackend({ directory });
  const goMonthlyLimits = createGoMonthlyLimitsService();

  const register = ctx.rpc
    .register as unknown as GuiConfigRpcDomain['register'];

  // `getNativeModelPrefs` is deliberately not served here: the Desktop GUI
  // reads its own native favorites/recents locally.
  return register(OmosConfig, {
    async getSnapshot(input) {
      return backend.getSnapshot(input, { omosVersion });
    },

    async switchPreset(input) {
      return backend.switchPreset(input);
    },

    async clearPresetDefault(input) {
      return backend.clearPresetDefault(input);
    },

    async createPreset(input) {
      return backend.createPreset(input);
    },

    async deletePreset(input) {
      return backend.deletePreset(input);
    },

    async setAgentOverride(input) {
      return backend.setAgentOverride(input);
    },

    async removeAgent(input) {
      return backend.removeAgent(input);
    },

    async setAgentDisabled(input) {
      return backend.setAgentDisabled(input);
    },

    async getGoMonthlyLimits() {
      return goMonthlyLimits.getGoMonthlyLimits();
    },
  });
}
