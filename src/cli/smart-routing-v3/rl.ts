import type { AgentName, BillingMode } from '../types';

export interface RoutingState {
  agent: AgentName;
  quotaBucket: 'critical' | 'low' | 'healthy';
  taskBucket: 'reasoning' | 'speed' | 'balanced';
}

export interface RoutingAction {
  model: string;
  billingMode: BillingMode;
}

export interface RoutingReward {
  success: number;
  latencyPenalty: number;
  costPenalty: number;
  qualityBonus: number;
}

function stateKey(state: RoutingState): string {
  return `${state.agent}|${state.quotaBucket}|${state.taskBucket}`;
}

function actionKey(action: RoutingAction): string {
  return `${action.model}|${action.billingMode}`;
}

export class RoutingQAgent {
  private table = new Map<string, Map<string, number>>();

  constructor(
    private readonly alpha = 0.12,
    private readonly gamma = 0.9,
    private readonly epsilon = 0.08,
  ) {}

  select(state: RoutingState, actions: RoutingAction[]): RoutingAction {
    if (actions.length === 0) {
      throw new Error('RoutingQAgent.select requires at least one action');
    }
    if (Math.random() < this.epsilon) {
      return actions[
        Math.floor(Math.random() * actions.length)
      ] as RoutingAction;
    }
    const key = stateKey(state);
    const row = this.table.get(key);
    if (!row) {
      return actions[0] as RoutingAction;
    }
    const ranked = [...actions].sort((left, right) => {
      const rightScore = row.get(actionKey(right)) ?? 0;
      const leftScore = row.get(actionKey(left)) ?? 0;
      return rightScore - leftScore;
    });
    return ranked[0] as RoutingAction;
  }

  update(input: {
    state: RoutingState;
    action: RoutingAction;
    reward: RoutingReward;
    nextState: RoutingState;
    availableNextActions: RoutingAction[];
  }): void {
    const sKey = stateKey(input.state);
    const aKey = actionKey(input.action);
    const reward =
      input.reward.success +
      input.reward.qualityBonus -
      input.reward.latencyPenalty -
      input.reward.costPenalty;

    const row = this.table.get(sKey) ?? new Map<string, number>();
    const current = row.get(aKey) ?? 0;

    const nextRow = this.table.get(stateKey(input.nextState));
    const maxNext = nextRow
      ? Math.max(
          0,
          ...input.availableNextActions.map(
            (action) => nextRow.get(actionKey(action)) ?? 0,
          ),
        )
      : 0;

    const updated =
      current + this.alpha * (reward + this.gamma * maxNext - current);
    row.set(aKey, updated);
    this.table.set(sKey, row);
  }

  snapshot(): Record<string, Record<string, number>> {
    const output: Record<string, Record<string, number>> = {};
    for (const [state, row] of this.table.entries()) {
      output[state] = {};
      for (const [action, value] of row.entries()) {
        output[state][action] = value;
      }
    }
    return output;
  }
}
