import type { ResolveMarketplaceActivationOptions } from './activation';
import { resolveMarketplaceActivation } from './activation';
import {
  createMarketplaceAgentDefinitions,
  type MarketplaceAgentDefinitions,
  type MarketplaceAgentMetadata,
} from './agent-definitions';

export interface MarketplaceRegistryImplementation {
  resolveMarketplaceActivation: typeof resolveMarketplaceActivation;
  createMarketplaceAgentDefinitions: typeof createMarketplaceAgentDefinitions;
}

export type { MarketplaceAgentMetadata };
/** @public Consumed as namespace properties by src/index.ts (knip blind spot). */
export { createMarketplaceAgentDefinitions, resolveMarketplaceActivation };
