import type { MarketplaceService } from '../marketplace/service';
import type { V2PermissionRule } from '../v2/types';
import type { RegistryHostSnapshot, ResolvedAgentRegistry } from './registry';

/** Private lifecycle seam shared by the v1 factory and its v2 adapter. */
export interface RegistryFactoryBridge {
  readonly hasSelectedMarketplaceAgents: boolean;
  setMarketplaceSkillReader(reader: () => Promise<readonly string[]>): void;
  verifyMarketplaceSkills(): Promise<void>;
  /** Marketplace status/reload surface; absent when the marketplace kill
   * switch (`marketplace.enabled: false`) skips service construction. */
  readonly marketplaceService?: Pick<
    MarketplaceService,
    'status' | 'requestReload'
  >;
  finalize(
    hostSnapshot: RegistryHostSnapshot,
    nativePermissionsByAgent: Readonly<
      Record<string, readonly V2PermissionRule[]>
    >,
  ): ResolvedAgentRegistry;
  requireRegistry(): ResolvedAgentRegistry;
  prepareCommands(config: Record<string, unknown>): void;
  retire(): void;
}
