import { resolveMarketplaceActivation } from './activation';
import {
  createMarketplaceAgentDefinitions,
  type MarketplaceAgentMetadata,
} from './agent-definitions';

export interface MarketplaceRegistryImplementation {
  resolveMarketplaceActivation: typeof resolveMarketplaceActivation;
  createMarketplaceAgentDefinitions: typeof createMarketplaceAgentDefinitions;
}

export type { MarketplaceAgentMetadata };
/** @public knip: consumed via namespace alias import in src/index.ts. */
export { createMarketplaceAgentDefinitions, resolveMarketplaceActivation };
