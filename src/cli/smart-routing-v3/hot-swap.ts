import type { AgentModelAssignment, AgentName } from '../types';

export interface RuntimeRoutingConfig {
  version: number;
  assignments: Record<AgentName, AgentModelAssignment>;
  fallbackChains: Record<AgentName, string[]>;
}

export interface HotSwapEvent {
  fromVersion: number;
  toVersion: number;
  changedAgents: AgentName[];
}

type Subscriber = (event: HotSwapEvent) => void;

export class HotSwapManager {
  private config: RuntimeRoutingConfig;
  private subscribers: Subscriber[] = [];

  constructor(initial: RuntimeRoutingConfig) {
    this.config = initial;
  }

  current(): RuntimeRoutingConfig {
    return JSON.parse(JSON.stringify(this.config)) as RuntimeRoutingConfig;
  }

  subscribe(callback: Subscriber): () => void {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter((item) => item !== callback);
    };
  }

  apply(next: Omit<RuntimeRoutingConfig, 'version'>): RuntimeRoutingConfig {
    const fromVersion = this.config.version;
    const toVersion = fromVersion + 1;

    const changedAgents = Object.keys(next.assignments).filter((agent) => {
      const previous = this.config.assignments[agent as AgentName];
      const current = next.assignments[agent as AgentName];
      return previous?.model !== current?.model;
    }) as AgentName[];

    this.config = {
      version: toVersion,
      assignments: next.assignments,
      fallbackChains: next.fallbackChains,
    };

    const event: HotSwapEvent = {
      fromVersion,
      toVersion,
      changedAgents,
    };
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }

    return this.current();
  }
}
