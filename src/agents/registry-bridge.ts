import type { V2PermissionRule } from '../v2/types';
import type { RegistryHostSnapshot, ResolvedAgentRegistry } from './registry';

/** Private lifecycle seam shared by the v1 factory and its v2 adapter. */
export interface RegistryFactoryBridge {
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
