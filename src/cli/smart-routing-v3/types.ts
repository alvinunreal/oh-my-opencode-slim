import type {
  AgentModelAssignment,
  AgentName,
  BillingMode,
  ChutesMonthlyPacingMode,
  DiscoveredModel,
  ExternalSignalMap,
  ModelPreferencesByAgent,
} from '../types';

export type ScoreTier = 'optimal' | 'acceptable' | 'suboptimal' | 'unsuitable';

export interface ScoreComponent {
  name: string;
  weight: number;
  value: number;
  normalizedScore: number;
  description: string;
}

export interface ScoredRoutingCandidate {
  agent: AgentName;
  model: DiscoveredModel;
  billingMode: BillingMode;
  totalScore: number;
  components: ScoreComponent[];
  tier: ScoreTier;
}

export interface RoutingBudget {
  dailyRequests?: number;
  monthlyRequests?: number;
  enforcement?: 'hard' | 'soft';
}

export interface NanoGptRoutingPolicy {
  mode: 'subscription-only' | 'hybrid' | 'paygo-only';
  subscriptionBudget?: RoutingBudget;
  paygoBudget?: {
    dailyUsdLimit?: number;
    monthlyUsdLimit?: number;
  };
}

export interface RoutingQuotaStatus {
  dailyRemaining: number;
  monthlyRemaining: number;
  lastCheckedAt: Date;
}

export interface ChutesMonthlyPacing {
  mode: ChutesMonthlyPacingMode;
  monthlyBudget?: number;
  monthlyUsed?: number;
}

export interface RoutingScoringContext {
  policy: NanoGptRoutingPolicy;
  quotaStatus: RoutingQuotaStatus;
  providerUsage: Map<string, number>;
  chutesPacing?: ChutesMonthlyPacing;
  externalSignals?: ExternalSignalMap;
  modelPreferences?: ModelPreferencesByAgent;
}

export interface SelectionConfig {
  beamWidth: number;
  diversityWeight: number;
  maxAlternativesPerAgent: number;
  maxPerProviderPerAgent: number;
  maxProvidersPerAgent: number;
}

export interface PartialPlan {
  assignments: Partial<Record<AgentName, AgentModelAssignment>>;
  providerUsage: Map<string, number>;
  totalScore: number;
}

export interface QuotaForecastPoint {
  dateIso: string;
  predictedUsage: number;
  predictedRemaining: number;
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

export interface QuotaForecast {
  predictedExhaustionDateIso?: string;
  confidence: number;
  points: QuotaForecastPoint[];
  recommendations: string[];
}

export interface RoutingDecisionExplanation {
  selectedModel: string;
  selectedBillingMode: BillingMode;
  score: number;
  summary: string;
  topFactors: string[];
  alternatives: Array<{
    model: string;
    billingMode: BillingMode;
    score: number;
    tradeoff: string;
  }>;
}

export interface RoutingRuntimeMetrics {
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgCostUsd: number;
  fallbackRate: number;
  sampleCount: number;
}

export interface RoutingExperimentVariant {
  id: string;
  description: string;
  assignmentOverrides?: Partial<Record<AgentName, AgentModelAssignment>>;
}

export interface RoutingExperiment {
  id: string;
  name: string;
  variants: RoutingExperimentVariant[];
  allocation: Record<string, number>;
  startedAtIso: string;
}

export interface LocalFederatedUpdate {
  modelRewards: Record<string, number>;
  featureAdjustments: Record<string, number>;
  sampleCount: number;
}

export interface AggregatedFederatedUpdate {
  modelRewards: Record<string, number>;
  featureAdjustments: Record<string, number>;
  participants: number;
}
