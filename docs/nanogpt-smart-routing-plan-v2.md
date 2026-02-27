# NanoGPT Smart Routing Plan v2
## Comprehensive Technical Specification

**Status:** Draft v2.0  
**Scope:** Full N-way model routing with billing-aware selection  
**Estimated Implementation:** 6-8 weeks  
**Breaking Changes:** Yes (Chutes/OpenCode migration included)  

---

## Executive Summary

This specification defines a complete overhaul of the model selection system to support NanoGPT as a first-class provider with intelligent N-way routing. Unlike the current 2-slot (primary/secondary) architecture used by Chutes and OpenCode Free, NanoGPT requires per-agent model selection with billing mode awareness (subscription vs paygo).

This plan includes:
1. **NanoGPT Integration** - Full provider support with discovery, auth, and routing
2. **Unified N-way Architecture** - Migration of Chutes and OpenCode to per-agent maps
3. **Advanced Scoring Engine v3** - Multi-dimensional scoring with budget constraints
4. **Autonomous Model Lifecycle** - Self-correcting model selection with guardrails

---

## Part 1: Current Architecture Analysis

### 1.1 Existing Limitations

The current architecture in `src/cli/providers.ts` uses a rigid 2-slot system:

```typescript
// Current pattern (ANTI-PATTERN for NanoGPT)
interface InstallConfig {
  selectedChutesPrimaryModel?: string;      // orchestrator/oracle/designer
  selectedChutesSecondaryModel?: string;    // explorer/librarian/fixer
  selectedOpenCodePrimaryModel?: string;   // orchestrator/oracle/designer  
  selectedOpenCodeSecondaryModel?: string;  // explorer/librarian/fixer
}
```

**Problems with this approach:**
1. **Coarse-grained assignment** - Three agents share one model, ignoring individual needs
2. **No billing awareness** - Cannot prefer subscription models for high-volume agents
3. **Limited fallback chains** - Only 2 models per provider, no ranked alternatives
4. **Provider lock-in** - Hard to mix providers optimally per agent

### 1.2 NanoGPT Requirements

NanoGPT has unique characteristics requiring N-way routing:

```typescript
// NanoGPT model structure (from API)
interface NanoGptModel {
  id: string;                          // "nanogpt/gpt-4o"
  name: string;                        // "GPT-4o"
  subscriptionEligible: boolean;     // Included in $8/mo plan
  paygoPrice: {                        // Per-token pricing
    input: number;                     // $/1M tokens
    output: number;                    // $/1M tokens
  };
  capabilities: {
    contextWindow: number;             // 128k
    toolCalling: boolean;
    reasoning: boolean;
    multimodal: boolean;
  };
  performance: {
    latencyP50: number;               // seconds
    latencyP95: number;
    qualityScore: number;              // 0-100
  };
}
```

**Key insight:** NanoGPT has 15+ models with varying subscription eligibility. A single "primary" model cannot serve all agent roles optimally.

---

## Part 2: Target Architecture

### 2.1 Core Data Model

#### 2.1.1 Agent Model Assignment

```typescript
// src/cli/types.ts

export type AgentName = 
  | 'orchestrator' 
  | 'oracle' 
  | 'designer' 
  | 'explorer' 
  | 'librarian' 
  | 'fixer';

export type BillingMode = 'subscription' | 'paygo';

export interface NanoGptAgentAssignment {
  model: string;                       // Full model ID: "nanogpt/gpt-4o"
  billingMode: BillingMode;
  confidence: number;                  // 0-1, selection confidence
  reasoning: string;                   // Human-readable selection rationale
}

export type NanoGptAgentMap = Record<AgentName, NanoGptAgentAssignment>;

export interface NanoGptRoutingPolicy {
  mode: 'subscription-only' | 'hybrid' | 'paygo-only';
  subscriptionBudget: {
    dailyRequests?: number;           // Max subscription calls/day
    monthlyRequests?: number;         // Max subscription calls/month
    enforcement: 'hard' | 'soft';   // Hard=fail if exceeded, soft=warn
  };
  paygoBudget?: {
    dailyUsdLimit?: number;
    monthlyUsdLimit?: number;
  };
}

export interface NanoGptProviderState {
  enabled: boolean;
  policy: NanoGptRoutingPolicy;
  assignments: NanoGptAgentMap;
  fallbackChains: Record<AgentName, NanoGptFallbackChain>;
  availableModels: NanoGptDiscoveredModel[];
  subscriptionQuota: {
    remainingDaily: number;
    remainingMonthly: number;
    lastUpdated: Date;
  };
}

export interface NanoGptFallbackChain {
  primary: NanoGptAgentAssignment;
  alternatives: NanoGptAgentAssignment[];  // Ranked alternatives
  crossProviderFallbacks: string[];          // Non-NanoGPT fallbacks
}

export interface NanoGptDiscoveredModel extends DiscoveredModel {
  nanoGptSpecific: {
    subscriptionEligible: boolean;
    paygoPriceInput: number;
    paygoPriceOutput: number;
    estimatedLatency: number;
    qualityBenchmark: 'high' | 'medium' | 'low';
  };
}
```

#### 2.1.2 Unified Provider Model (All Providers N-way)

```typescript
// Unified per-agent model selection for ALL providers
export interface UnifiedAgentAssignment {
  provider: string;                    // "nanogpt", "chutes", "opencode", etc.
  model: string;
  variant?: string;
  billingMode?: BillingMode;           // Provider-specific
  selectionReason: string;
  confidence: number;
}

export type UnifiedAgentMap = Record<AgentName, UnifiedAgentAssignment>;

export interface UnifiedFallbackChain {
  ranked: UnifiedAgentAssignment[];    // All candidates, ranked by score
  providerDistribution: Record<string, number>; // How many agents per provider
  diversityScore: number;              // 0-1, provider spread metric
}

// Replaces InstallConfig
export interface EnhancedInstallConfig {
  // Provider flags
  hasNanoGpt: boolean;
  hasChutes: boolean;
  hasOpenCodeFree: boolean;
  // ... other providers

  // N-way model assignments (replaces primary/secondary)
  nanoGptAssignments?: NanoGptAgentMap;
  chutesAssignments?: UnifiedAgentMap;
  openCodeAssignments?: UnifiedAgentMap;

  // Fallback chains per provider
  nanoGptFallbackChains?: Record<AgentName, NanoGptFallbackChain>;
  chutesFallbackChains?: Record<AgentName, UnifiedFallbackChain>;
  openCodeFallbackChains?: Record<AgentName, UnifiedFallbackChain>;

  // Global dynamic plan (cross-provider composition)
  dynamicModelPlan?: DynamicModelPlan;

  // Policy configuration
  nanoGptPolicy?: NanoGptRoutingPolicy;
  balanceProviderUsage: boolean;
}
```

### 2.2 Scoring Engine v3 Architecture

#### 2.2.1 Multi-Dimensional Scoring

```typescript
// src/cli/scoring-v3/types.ts

export interface ScoreComponent {
  name: string;
  weight: number;
  value: number;
  normalizedScore: number;           // -100 to +100
  description: string;
}

export interface AgentModelScore {
  agent: AgentName;
  model: DiscoveredModel;
  totalScore: number;
  components: ScoreComponent[];
  rank: number;
  tier: 'optimal' | 'acceptable' | 'suboptimal' | 'unsuitable';
}

export interface ScoringContext {
  agent: AgentName;
  provider: string;
  policy: NanoGptRoutingPolicy;
  subscriptionQuota: { remainingDaily: number; remainingMonthly: number };
  externalSignals: ExternalSignalMap;
  providerUsage: Map<string, number>;  // Current assignments per provider
}

// Score component definitions
export const SCORE_COMPONENTS = {
  // Role fit (0-25 points)
  ROLE_FIT: {
    orchestrator: { reasoning: 8, toolcall: 7, context: 5, quality: 5 },
    oracle: { reasoning: 10, context: 7, quality: 5, toolcall: 3 },
    designer: { multimodal: 8, toolcall: 7, quality: 5, speed: 5 },
    explorer: { speed: 10, toolcall: 8, cost: 5, context: 2 },
    librarian: { context: 10, toolcall: 7, reliability: 5, cost: 3 },
    fixer: { code: 8, toolcall: 7, speed: 5, cost: 5 },
  },

  // Billing policy fit (-50 to +25 points)
  BILLING_FIT: {
    subscriptionOnly: {
      subscription: 25,
      paygo: -1000,                    // Disqualify
    },
    hybrid: {
      subscription: 15,                // Prefer for high-volume agents
      paygo: 0,                        // Neutral
    },
    paygoOnly: {
      subscription: 0,
      paygo: 10,                       // Slight preference for paygo
    },
  },

  // Subscription quota pressure (0 to -30 points)
  QUOTA_PRESSURE: {
    healthy: 0,                        // >50% remaining
    warning: -10,                      // 25-50% remaining
    critical: -25,                     // 10-25% remaining
    exhausted: -30,                    // <10% remaining
  },

  // Provider diversity (-20 to +10 points)
  DIVERSITY: {
    overrepresented: -20,              // Provider has >3 agents
    balanced: 0,                       // Provider has 2-3 agents
    underrepresented: 10,              // Provider has <2 agents
  },

  // Cost efficiency (0 to 15 points)
  COST_EFFICIENCY: {
    excellent: 15,                     // Lowest cost in tier
    good: 10,
    fair: 5,
    poor: 0,                           // Highest cost
  },

  // Latency fit (-20 to +10 points)
  LATENCY: {
    fast: 10,                          // <2s p50
    medium: 0,                         // 2-5s p50
    slow: -10,                         // 5-10s p50
    verySlow: -20,                     // >10s p50
  },

  // Quality benchmark (0 to 20 points)
  QUALITY: {
    excellent: 20,                     // Top 10% of models
    good: 15,                          // Top 25%
    average: 10,                       // Top 50%
    belowAverage: 5,                   // Bottom 50%
    poor: -10,                         // Bottom 10%
  },
} as const;
```

#### 2.2.2 Scoring Algorithm

```typescript
// src/cli/scoring-v3/engine.ts

export function calculateAgentModelScore(
  model: NanoGptDiscoveredModel,
  context: ScoringContext,
): AgentModelScore {
  const components: ScoreComponent[] = [];

  // 1. Role Fit Score (base capability match)
  const roleFit = calculateRoleFit(context.agent, model);
  components.push({
    name: 'roleFit',
    weight: 1.0,
    value: roleFit.raw,
    normalizedScore: roleFit.normalized,
    description: `Capability match for ${context.agent}: ${roleFit.details}`,
  });

  // 2. Billing Policy Fit
  const billingFit = calculateBillingFit(
    model.nanoGptSpecific.subscriptionEligible ? 'subscription' : 'paygo',
    context.policy.mode,
  );
  components.push({
    name: 'billingFit',
    weight: 1.2,
    value: billingFit.raw,
    normalizedScore: billingFit.normalized,
    description: `Billing mode ${model.nanoGptSpecific.subscriptionEligible ? 'subscription' : 'paygo'} vs policy ${context.policy.mode}`,
  });

  // 3. Subscription Quota Pressure
  const quotaPressure = calculateQuotaPressure(
    model.nanoGptSpecific.subscriptionEligible,
    context.subscriptionQuota,
    context.policy.subscriptionBudget,
  );
  components.push({
    name: 'quotaPressure',
    weight: 0.8,
    value: quotaPressure.raw,
    normalizedScore: quotaPressure.normalized,
    description: `Quota: ${context.subscriptionQuota.remainingDaily} daily remaining`,
  });

  // 4. Provider Diversity
  const diversity = calculateDiversityImpact(
    model.providerID,
    context.providerUsage,
  );
  components.push({
    name: 'diversity',
    weight: 0.6,
    value: diversity.raw,
    normalizedScore: diversity.normalized,
    description: `Provider ${model.providerID} has ${context.providerUsage.get(model.providerID) ?? 0} assignments`,
  });

  // 5. Cost Efficiency (for paygo models)
  const costEfficiency = calculateCostEfficiency(
    model,
    context.agent,
    context.policy.mode,
  );
  components.push({
    name: 'costEfficiency',
    weight: 0.7,
    value: costEfficiency.raw,
    normalizedScore: costEfficiency.normalized,
    description: `Cost: $${model.nanoGptSpecific.paygoPriceInput}/1M in, $${model.nanoGptSpecific.paygoPriceOutput}/1M out`,
  });

  // 6. Latency Fit
  const latency = calculateLatencyFit(
    model.nanoGptSpecific.estimatedLatency,
    context.agent,
  );
  components.push({
    name: 'latency',
    weight: 0.5,
    value: latency.raw,
    normalizedScore: latency.normalized,
    description: `Latency: ${model.nanoGptSpecific.estimatedLatency}s p50`,
  });

  // 7. Quality Benchmark
  const quality = calculateQualityFit(
    model.nanoGptSpecific.qualityBenchmark,
    context.externalSignals,
  );
  components.push({
    name: 'quality',
    weight: 0.9,
    value: quality.raw,
    normalizedScore: quality.normalized,
    description: `Quality: ${model.nanoGptSpecific.qualityBenchmark}`,
  });

  // Calculate weighted total
  const totalScore = components.reduce(
    (sum, comp) => sum + comp.normalizedScore * comp.weight,
    0,
  );

  // Determine tier
  let tier: AgentModelScore['tier'] = 'unsuitable';
  if (totalScore >= 80) tier = 'optimal';
  else if (totalScore >= 60) tier = 'acceptable';
  else if (totalScore >= 40) tier = 'suboptimal';

  return {
    agent: context.agent,
    model,
    totalScore,
    components,
    rank: 0, // Set later by sorter
    tier,
  };
}

// Helper: Calculate role fit based on agent needs
function calculateRoleFit(
  agent: AgentName,
  model: NanoGptDiscoveredModel,
): { raw: number; normalized: number; details: string } {
  const needs = SCORE_COMPONENTS.ROLE_FIT[agent];
  let score = 0;
  const details: string[] = [];

  if (needs.reasoning && model.reasoning) {
    score += needs.reasoning;
    details.push('reasoning');
  }
  if (needs.toolcall && model.toolcall) {
    score += needs.toolcall;
    details.push('toolcall');
  }
  if (needs.context) {
    const contextScore = Math.min(model.contextLimit / 100000, 1) * needs.context;
    score += contextScore;
    details.push(`context(${Math.round(contextScore)})`);
  }
  if (needs.multimodal && model.attachment) {
    score += needs.multimodal;
    details.push('multimodal');
  }

  return {
    raw: score,
    normalized: (score / 25) * 100, // Normalize to -100 to +100 scale
    details: details.join(', '),
  };
}

// Helper: Calculate billing mode compatibility
function calculateBillingFit(
  billingMode: BillingMode,
  policyMode: NanoGptRoutingPolicy['mode'],
): { raw: number; normalized: number } {
  const fit = SCORE_COMPONENTS.BILLING_FIT[policyMode][billingMode];
  return {
    raw: fit,
    normalized: fit, // Already on appropriate scale
  };
}

// Helper: Calculate quota pressure penalty
function calculateQuotaPressure(
  isSubscription: boolean,
  quota: { remainingDaily: number; remainingMonthly: number },
  budget: { dailyRequests?: number; monthlyRequests?: number },
): { raw: number; normalized: number } {
  if (!isSubscription) return { raw: 0, normalized: 0 };

  const dailyPct = budget.dailyRequests 
    ? quota.remainingDaily / budget.dailyRequests 
    : 1;
  const monthlyPct = budget.monthlyRequests
    ? quota.remainingMonthly / budget.monthlyRequests
    : 1;

  const minPct = Math.min(dailyPct, monthlyPct);

  let penalty = 0;
  if (minPct < 0.1) penalty = SCORE_COMPONENTS.QUOTA_PRESSURE.exhausted;
  else if (minPct < 0.25) penalty = SCORE_COMPONENTS.QUOTA_PRESSURE.critical;
  else if (minPct < 0.5) penalty = SCORE_COMPONENTS.QUOTA_PRESSURE.warning;

  return { raw: penalty, normalized: penalty };
}
```

### 2.3 Selection Algorithm with Beam Search

```typescript
// src/cli/scoring-v3/selection.ts

export interface SelectionConfig {
  beamWidth: number;                   // Number of partial plans to keep
  diversityTarget: number;             // Target providers per plan
  maxIterations: number;
  convergenceThreshold: number;          // Score improvement threshold
}

export interface PartialPlan {
  assignments: Partial<UnifiedAgentMap>;
  remainingAgents: AgentName[];
  providerUsage: Map<string, number>;
  totalScore: number;
  diversityScore: number;
}

export function selectModelsWithBeamSearch(
  models: NanoGptDiscoveredModel[],
  agents: AgentName[],
  config: SelectionConfig,
  context: Omit<ScoringContext, 'agent' | 'providerUsage'>,
): UnifiedAgentMap {
  // Initialize beam with empty plan
  let beam: PartialPlan[] = [{
    assignments: {},
    remainingAgents: [...agents],
    providerUsage: new Map(),
    totalScore: 0,
    diversityScore: 0,
  }];

  for (const agent of agents) {
    const newBeam: PartialPlan[] = [];

    for (const plan of beam) {
      // Score all models for this agent in this plan context
      const scores = models
        .map((model) => calculateAgentModelScore(model, {
          ...context,
          agent,
          providerUsage: plan.providerUsage,
        }))
        .sort((a, b) => b.totalScore - a.totalScore);

      // Take top-k candidates
      const topCandidates = scores.slice(0, config.beamWidth);

      for (const candidate of topCandidates) {
        const newAssignments = { ...plan.assignments };
        newAssignments[agent] = {
          provider: candidate.model.providerID,
          model: candidate.model.model,
          billingMode: candidate.model.nanoGptSpecific.subscriptionEligible 
            ? 'subscription' 
            : 'paygo',
          selectionReason: candidate.components
            .map((c) => `${c.name}: ${c.normalizedScore}`)
            .join(', '),
          confidence: candidate.totalScore / 100,
        };

        const newProviderUsage = new Map(plan.providerUsage);
        newProviderUsage.set(
          candidate.model.providerID,
          (newProviderUsage.get(candidate.model.providerID) ?? 0) + 1,
        );

        newBeam.push({
          assignments: newAssignments,
          remainingAgents: plan.remainingAgents.filter((a) => a !== agent),
          providerUsage: newProviderUsage,
          totalScore: plan.totalScore + candidate.totalScore,
          diversityScore: calculateDiversityScore(newProviderUsage),
        });
      }
    }

    // Keep top beamWidth plans
    beam = newBeam
      .sort((a, b) => {
        // Combined score: total + diversity bonus
        const scoreA = a.totalScore + a.diversityScore * 10;
        const scoreB = b.totalScore + b.diversityScore * 10;
        return scoreB - scoreA;
      })
      .slice(0, config.beamWidth);
  }

  // Return best complete plan
  const bestPlan = beam[0];
  if (!bestPlan) {
    throw new Error('Beam search failed to find valid plan');
  }

  return bestPlan.assignments as UnifiedAgentMap;
}

function calculateDiversityScore(providerUsage: Map<string, number>): number {
  const counts = Array.from(providerUsage.values());
  if (counts.length === 0) return 0;

  const total = counts.reduce((a, b) => a + b, 0);
  const ideal = total / counts.length;

  // Calculate variance from ideal distribution
  const variance = counts.reduce(
    (sum, count) => sum + Math.pow(count - ideal, 2),
    0,
  ) / counts.length;

  // Normalize: lower variance = higher diversity score
  return Math.max(0, 1 - variance / (ideal * ideal));
}
```

---

## Part 3: Implementation Phases

### Phase 1: Foundation (Week 1-2)

#### 3.1.1 Type System Expansion

```typescript
// src/cli/types.ts - Additions

// NanoGPT-specific types
export interface NanoGptProviderConfig {
  enabled: boolean;
  apiKey?: string;
  policy: NanoGptRoutingPolicy;
}

export interface NanoGptQuotaStatus {
  dailyRemaining: number;
  monthlyRemaining: number;
  resetsAt: Date;
  lastChecked: Date;
}

// Extend InstallConfig
export interface InstallConfig {
  // Existing fields...
  
  // NanoGPT
  hasNanoGpt?: boolean;
  nanoGptConfig?: NanoGptProviderConfig;
  nanoGptAssignments?: NanoGptAgentMap;
  nanoGptFallbackChains?: Record<AgentName, NanoGptFallbackChain>;
  nanoGptQuotaStatus?: NanoGptQuotaStatus;
  
  // Unified N-way (replacing primary/secondary)
  chutesAssignments?: UnifiedAgentMap;
  openCodeAssignments?: UnifiedAgentMap;
  
  // Legacy migration markers
  _migratedFromV1?: boolean;
  _migrationTimestamp?: Date;
}

// Extend InstallArgs
export interface InstallArgs {
  // Existing fields...
  nanogpt?: BooleanArg;
  nanogptPolicy?: 'subscription-only' | 'hybrid' | 'paygo-only';
  nanogptDailyBudget?: number;
  nanogptMonthlyBudget?: number;
}
```

#### 3.1.2 CLI Argument Parsing

```typescript
// src/cli/index.ts - Additions to parseArgs()

function parseArgs(args: string[]): InstallArgs {
  const result: InstallArgs = { tui: true };

  for (const arg of args) {
    // Existing handlers...
    
    // NanoGPT flags
    else if (arg.startsWith('--nanogpt=')) {
      result.nanogpt = arg.split('=')[1] as BooleanArg;
    }
    else if (arg.startsWith('--nanogpt-policy=')) {
      result.nanogptPolicy = arg.split('=')[1] as InstallArgs['nanogptPolicy'];
    }
    else if (arg.startsWith('--nanogpt-daily-budget=')) {
      result.nanogptDailyBudget = parseInt(arg.split('=')[1], 10);
    }
    else if (arg.startsWith('--nanogpt-monthly-budget=')) {
      result.nanogptMonthlyBudget = parseInt(arg.split('=')[1], 10);
    }
  }

  return result;
}

// Update help text
function printHelp(): void {
  console.log(`
    // Existing options...
    
    --nanogpt=yes|no                    Enable NanoGPT provider
    --nanogpt-policy=<mode>             Routing policy: subscription-only|hybrid|paygo-only
    --nanogpt-daily-budget=<n>          Max daily subscription calls
    --nanogpt-monthly-budget=<n>        Max monthly subscription calls
  `);
}
```

#### 3.1.3 Model Discovery

```typescript
// src/cli/nanogpt-discovery.ts

import { execSync } from 'node:child_process';

export interface NanoGptDiscoveryResult {
  models: NanoGptDiscoveredModel[];
  quotaStatus: NanoGptQuotaStatus;
  error?: string;
}

export async function discoverNanoGptModels(
  apiKey?: string,
): Promise<NanoGptDiscoveryResult> {
  try {
    // Method 1: Try OpenCode CLI if NanoGPT is integrated
    const openCodeModels = await discoverViaOpenCode();
    if (openCodeModels.length > 0) {
      return {
        models: openCodeModels,
        quotaStatus: await fetchQuotaStatus(apiKey),
      };
    }

    // Method 2: Direct NanoGPT API
    const apiModels = await discoverViaApi(apiKey);
    return {
      models: apiModels,
      quotaStatus: await fetchQuotaStatus(apiKey),
    };
  } catch (error) {
    return {
      models: [],
      quotaStatus: { dailyRemaining: 0, monthlyRemaining: 0, resetsAt: new Date(), lastChecked: new Date() },
      error: String(error),
    };
  }
}

async function discoverViaOpenCode(): Promise<NanoGptDiscoveredModel[]> {
  try {
    const output = execSync('opencode models --provider=nanogpt --json', {
      encoding: 'utf-8',
      timeout: 30000,
    });
    const models = JSON.parse(output);
    return models.map(normalizeNanoGptModel);
  } catch {
    return [];
  }
}

async function discoverViaApi(apiKey?: string): Promise<NanoGptDiscoveredModel[]> {
  if (!apiKey) return [];
  
  const response = await fetch('https://api.nanogpt.ai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  
  if (!response.ok) {
    throw new Error(`NanoGPT API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.models.map(normalizeNanoGptModel);
}

function normalizeNanoGptModel(raw: unknown): NanoGptDiscoveredModel {
  // Validation and normalization logic
  const model = raw as Record<string, unknown>;
  
  return {
    providerID: 'nanogpt',
    model: `nanogpt/${model.id}`,
    name: String(model.name || model.id),
    status: normalizeStatus(model.status),
    contextLimit: Number(model.context_window) || 128000,
    outputLimit: Number(model.output_limit) || 32000,
    reasoning: Boolean(model.reasoning),
    toolcall: Boolean(model.tool_calling),
    attachment: Boolean(model.multimodal),
    nanoGptSpecific: {
      subscriptionEligible: Boolean(model.subscription_eligible),
      paygoPriceInput: Number(model.paygo_price?.input) || 0,
      paygoPriceOutput: Number(model.paygo_price?.output) || 0,
      estimatedLatency: Number(model.latency_p50) || 5,
      qualityBenchmark: normalizeQuality(model.quality_score),
    },
  };
}
```

### Phase 2: Selection Engine (Week 2-3)

#### 3.2.1 NanoGPT Selection Module

```typescript
// src/cli/nanogpt-selection.ts

export interface NanoGptSelectionInput {
  models: NanoGptDiscoveredModel[];
  policy: NanoGptRoutingPolicy;
  quotaStatus: NanoGptQuotaStatus;
  externalSignals?: ExternalSignalMap;
}

export interface NanoGptSelectionOutput {
  assignments: NanoGptAgentMap;
  fallbackChains: Record<AgentName, NanoGptFallbackChain>;
  metadata: {
    totalScore: number;
    subscriptionUsage: Record<AgentName, number>;
    estimatedDailyCost: number;
    confidence: number;
  };
}

export function selectNanoGptModels(
  input: NanoGptSelectionInput,
): NanoGptSelectionOutput {
  const { models, policy, quotaStatus, externalSignals } = input;

  // Filter models by policy
  const eligibleModels = filterByPolicy(models, policy);
  
  if (eligibleModels.length === 0) {
    throw new Error(`No NanoGPT models match policy: ${policy.mode}`);
  }

  // Build scoring context
  const context: Omit<ScoringContext, 'agent' | 'providerUsage'> = {
    provider: 'nanogpt',
    policy,
    subscriptionQuota: quotaStatus,
    externalSignals: externalSignals ?? {},
  };

  // Use beam search for optimal assignment
  const assignments = selectModelsWithBeamSearch(
    eligibleModels,
    AGENTS,
    { beamWidth: 5, diversityTarget: 3, maxIterations: 100, convergenceThreshold: 0.01 },
    context,
  );

  // Build fallback chains
  const fallbackChains = buildFallbackChains(
    eligibleModels,
    assignments,
    context,
  );

  // Calculate metadata
  const metadata = calculateMetadata(assignments, fallbackChains, policy);

  return {
    assignments: convertToNanoGptMap(assignments),
    fallbackChains,
    metadata,
  };
}

function filterByPolicy(
  models: NanoGptDiscoveredModel[],
  policy: NanoGptRoutingPolicy,
): NanoGptDiscoveredModel[] {
  switch (policy.mode) {
    case 'subscription-only':
      return models.filter((m) => m.nanoGptSpecific.subscriptionEligible);
    
    case 'paygo-only':
      return models.filter((m) => !m.nanoGptSpecific.subscriptionEligible);
    
    case 'hybrid':
    default:
      return models; // All models eligible
  }
}

function buildFallbackChains(
  models: NanoGptDiscoveredModel[],
  assignments: UnifiedAgentMap,
  context: Omit<ScoringContext, 'agent' | 'providerUsage'>,
): Record<AgentName, NanoGptFallbackChain> {
  const chains: Record<AgentName, NanoGptFallbackChain> = {} as Record<AgentName, NanoGptFallbackChain>;

  for (const agent of AGENTS) {
    const primary = assignments[agent];
    if (!primary) continue;

    // Score all models for this agent
    const scores = models
      .map((model) => calculateAgentModelScore(model, {
        ...context,
        agent,
        providerUsage: new Map(),
      }))
      .sort((a, b) => b.totalScore - a.totalScore);

    // Build ranked alternatives (excluding primary)
    const alternatives = scores
      .filter((s) => s.model.model !== primary.model)
      .slice(0, 4)
      .map((s) => ({
        model: s.model.model,
        billingMode: s.model.nanoGptSpecific.subscriptionEligible ? 'subscription' : 'paygo',
        confidence: s.totalScore / 100,
        reasoning: s.components.map((c) => `${c.name}:${c.normalizedScore}`).join(','),
      }));

    chains[agent] = {
      primary: {
        model: primary.model,
        billingMode: primary.billingMode || 'paygo',
        confidence: primary.confidence,
        reasoning: primary.selectionReason,
      },
      alternatives,
      crossProviderFallbacks: [], // Populated later by cross-provider composition
    };
  }

  return chains;
}
```

### Phase 3: Cross-Provider Composition (Week 3-4)

#### 3.3.1 Unified Dynamic Planner

```typescript
// src/cli/dynamic-model-selection-v3.ts

export interface CrossProviderCompositionInput {
  nanoGpt?: NanoGptSelectionOutput;
  chutes?: UnifiedAgentMap;
  openCode?: UnifiedAgentMap;
  // Other providers...
  config: EnhancedInstallConfig;
}

export interface CrossProviderCompositionOutput {
  finalAssignments: UnifiedAgentMap;
  globalFallbackChains: Record<AgentName, string[]>;
  providerDistribution: Record<string, number>;
  compositionReport: CompositionReport;
}

export interface CompositionReport {
  agentDecisions: Record<AgentName, AgentDecision>;
  providerScores: Record<string, ProviderScore>;
  conflicts: Conflict[];
  recommendations: string[];
}

export interface AgentDecision {
  selectedProvider: string;
  selectedModel: string;
  candidates: CandidateInfo[];
  rationale: string;
}

export interface CandidateInfo {
  provider: string;
  model: string;
  score: number;
  billingMode?: BillingMode;
}

export function composeCrossProviderPlan(
  input: CrossProviderCompositionInput,
): CrossProviderCompositionOutput {
  const { nanoGpt, chutes, openCode, config } = input;
  
  // Collect all provider candidates per agent
  const candidatesByAgent = collectCandidates(input);
  
  // Score cross-provider candidates
  const scoredCandidates = scoreCrossProvider(candidatesByAgent, config);
  
  // Select best per agent with diversity constraints
  const selections = selectWithDiversity(scoredCandidates, config);
  
  // Build global fallback chains
  const fallbackChains = buildGlobalFallbackChains(scoredCandidates, selections);
  
  // Generate report
  const report = generateCompositionReport(selections, scoredCandidates);

  return {
    finalAssignments: selections,
    globalFallbackChains: fallbackChains,
    providerDistribution: calculateProviderDistribution(selections),
    compositionReport: report,
  };
}

function collectCandidates(
  input: CrossProviderCompositionInput,
): Record<AgentName, CandidateInfo[]> {
  const candidates: Record<AgentName, CandidateInfo[]> = {
    orchestrator: [],
    oracle: [],
    designer: [],
    explorer: [],
    librarian: [],
    fixer: [],
  };

  // Add NanoGPT candidates
  if (input.nanoGpt) {
    for (const [agent, assignment] of Object.entries(input.nanoGpt.assignments)) {
      candidates[agent as AgentName].push({
        provider: 'nanogpt',
        model: assignment.model,
        score: assignment.confidence * 100,
        billingMode: assignment.billingMode,
      });
    }
  }

  // Add Chutes candidates
  if (input.chutes) {
    for (const [agent, assignment] of Object.entries(input.chutes)) {
      candidates[agent as AgentName].push({
        provider: 'chutes',
        model: assignment.model,
        score: assignment.confidence * 100,
      });
    }
  }

  // Add OpenCode candidates
  if (input.openCode) {
    for (const [agent, assignment] of Object.entries(input.openCode)) {
      candidates[agent as AgentName].push({
        provider: 'opencode',
        model: assignment.model,
        score: assignment.confidence * 100,
      });
    }
  }

  // Add other providers...

  return candidates;
}
```

### Phase 4: Migration & Backward Compatibility (Week 4-5)

#### 3.4.1 Migration Strategy

```typescript
// src/cli/migration/v1-to-v2.ts

export interface MigrationInput {
  oldConfig: InstallConfig;
  availableNanoGptModels?: NanoGptDiscoveredModel[];
  availableChutesModels?: DiscoveredModel[];
  availableOpenCodeModels?: OpenCodeFreeModel[];
}

export interface MigrationOutput {
  newConfig: EnhancedInstallConfig;
  migrationLog: MigrationEntry[];
  warnings: string[];
}

export interface MigrationEntry {
  type: 'transform' | 'split' | 'create' | 'deprecate';
  field: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
}

export function migrateV1ToV2(input: MigrationInput): MigrationOutput {
  const { oldConfig } = input;
  const migrationLog: MigrationEntry[] = [];
  const warnings: string[] = [];

  const newConfig: EnhancedInstallConfig = {
    // Copy simple fields
    hasKimi: oldConfig.hasKimi,
    hasOpenAI: oldConfig.hasOpenAI,
    hasAnthropic: oldConfig.hasAnthropic,
    hasCopilot: oldConfig.hasCopilot,
    hasZaiPlan: oldConfig.hasZaiPlan,
    hasAntigravity: oldConfig.hasAntigravity,
    hasChutes: oldConfig.hasChutes,
    hasOpencodeZen: oldConfig.hasOpencodeZen,
    balanceProviderUsage: oldConfig.balanceProviderUsage ?? false,
    hasTmux: oldConfig.hasTmux,
    installSkills: oldConfig.installSkills,
    installCustomSkills: oldConfig.installCustomSkills,
    setupMode: oldConfig.setupMode,
    dryRun: oldConfig.dryRun,
    modelsOnly: oldConfig.modelsOnly,

    // Initialize new fields
    hasNanoGpt: false,
    _migratedFromV1: true,
    _migrationTimestamp: new Date(),
  };

  // Migrate Chutes: primary/secondary -> per-agent
  if (oldConfig.hasChutes && input.availableChutesModels) {
    const chutesAssignments = migrateChutesToNWay(
      oldConfig.selectedChutesPrimaryModel,
      oldConfig.selectedChutesSecondaryModel,
      input.availableChutesModels,
    );
    newConfig.chutesAssignments = chutesAssignments;
    
    migrationLog.push({
      type: 'transform',
      field: 'selectedChutesPrimaryModel/selectedChutesSecondaryModel',
      oldValue: {
        primary: oldConfig.selectedChutesPrimaryModel,
        secondary: oldConfig.selectedChutesSecondaryModel,
      },
      newValue: chutesAssignments,
      reason: 'Migrated from 2-slot to N-way per-agent assignment',
    });
  }

  // Migrate OpenCode: primary/secondary -> per-agent
  if (oldConfig.useOpenCodeFreeModels && input.availableOpenCodeModels) {
    const openCodeAssignments = migrateOpenCodeToNWay(
      oldConfig.selectedOpenCodePrimaryModel,
      oldConfig.selectedOpenCodeSecondaryModel,
      input.availableOpenCodeModels,
    );
    newConfig.openCodeAssignments = openCodeAssignments;
    
    migrationLog.push({
      type: 'transform',
      field: 'selectedOpenCodePrimaryModel/selectedOpenCodeSecondaryModel',
      oldValue: {
        primary: oldConfig.selectedOpenCodePrimaryModel,
        secondary: oldConfig.selectedOpenCodeSecondaryModel,
      },
      newValue: openCodeAssignments,
      reason: 'Migrated from 2-slot to N-way per-agent assignment',
    });
  }

  // Migrate dynamic plan if present
  if (oldConfig.dynamicModelPlan) {
    newConfig.dynamicModelPlan = oldConfig.dynamicModelPlan;
    warnings.push('Existing dynamic model plan preserved. Consider re-running selection for optimal NanoGPT integration.');
  }

  return { newConfig, migrationLog, warnings };
}

function migrateChutesToNWay(
  primaryModel?: string,
  secondaryModel?: string,
  availableModels?: DiscoveredModel[],
): UnifiedAgentMap {
  const assignments: Partial<UnifiedAgentMap> = {};

  // Primary agents get primary model
  const primaryAgents: AgentName[] = ['orchestrator', 'oracle', 'designer'];
  for (const agent of primaryAgents) {
    if (primaryModel) {
      assignments[agent] = {
        provider: 'chutes',
        model: primaryModel,
        variant: agent === 'oracle' ? 'high' : agent === 'designer' ? 'medium' : undefined,
        selectionReason: 'Migrated from Chutes primary model',
        confidence: 0.8,
      };
    }
  }

  // Secondary agents get secondary model
  const secondaryAgents: AgentName[] = ['explorer', 'librarian', 'fixer'];
  for (const agent of secondaryAgents) {
    const model = secondaryModel || primaryModel;
    if (model) {
      assignments[agent] = {
        provider: 'chutes',
        model,
        variant: 'low',
        selectionReason: 'Migrated from Chutes secondary model',
        confidence: 0.8,
      };
    }
  }

  return assignments as UnifiedAgentMap;
}
```

### Phase 5: Runtime Guardrails (Week 5-6)

#### 3.5.1 Shadow Evaluation System

```typescript
// src/cli/runtime/shadow-evaluation.ts

export interface ShadowEvaluationConfig {
  enabled: boolean;
  canaryPercentage: number;              // 0-100, percentage of traffic
  evaluationPeriod: number;              // milliseconds
  minSamples: number;
  regressionThreshold: number;           // Score drop threshold for rollback
}

export interface ModelPerformanceMetrics {
  model: string;
  agent: AgentName;
  billingMode?: BillingMode;
  samples: number;
  successRate: number;
  avgLatency: number;
  p95Latency: number;
  avgCost: number;
  qualityScore: number;
  fallbackRate: number;
}

export interface ShadowEvaluationResult {
  candidateModel: string;
  baselineModel: string;
  agent: AgentName;
  metrics: {
    candidate: ModelPerformanceMetrics;
    baseline: ModelPerformanceMetrics;
  };
  recommendation: 'promote' | 'hold' | 'rollback';
  confidence: number;
  reasons: string[];
}

export class ShadowEvaluationEngine {
  private metricsStore: Map<string, ModelPerformanceMetrics> = new Map();
  private config: ShadowEvaluationConfig;

  constructor(config: ShadowEvaluationConfig) {
    this.config = config;
  }

  async evaluateCandidate(
    candidate: string,
    baseline: string,
    agent: AgentName,
  ): Promise<ShadowEvaluationResult> {
    const candidateMetrics = this.metricsStore.get(`${candidate}:${agent}`);
    const baselineMetrics = this.metricsStore.get(`${baseline}:${agent}`);

    if (!candidateMetrics || !baselineMetrics) {
      throw new Error('Insufficient metrics for evaluation');
    }

    if (candidateMetrics.samples < this.config.minSamples) {
      return {
        candidateModel: candidate,
        baselineModel: baseline,
        agent,
        metrics: { candidate: candidateMetrics, baseline: baselineMetrics },
        recommendation: 'hold',
        confidence: 0,
        reasons: [`Insufficient samples: ${candidateMetrics.samples}/${this.config.minSamples}`],
      };
    }

    const comparison = this.compareMetrics(candidateMetrics, baselineMetrics);
    
    let recommendation: ShadowEvaluationResult['recommendation'] = 'hold';
    const reasons: string[] = [];

    if (comparison.overallScore > 0.1) {
      recommendation = 'promote';
      reasons.push(`Overall improvement: ${(comparison.overallScore * 100).toFixed(1)}%`);
    } else if (comparison.overallScore < -this.config.regressionThreshold) {
      recommendation = 'rollback';
      reasons.push(`Regression detected: ${(comparison.overallScore * 100).toFixed(1)}%`);
    } else {
      reasons.push(`Performance neutral: ${(comparison.overallScore * 100).toFixed(1)}%`);
    }

    if (comparison.latencyRegression) {
      reasons.push(`Latency regression: ${comparison.latencyDiff.toFixed(0)}ms`);
    }

    if (comparison.costIncrease) {
      reasons.push(`Cost increase: ${(comparison.costDiff * 100).toFixed(1)}%`);
    }

    return {
      candidateModel: candidate,
      baselineModel: baseline,
      agent,
      metrics: { candidate: candidateMetrics, baseline: baselineMetrics },
      recommendation,
      confidence: comparison.confidence,
      reasons,
    };
  }

  private compareMetrics(
    candidate: ModelPerformanceMetrics,
    baseline: ModelPerformanceMetrics,
  ): {
    overallScore: number;
    confidence: number;
    latencyRegression: boolean;
    latencyDiff: number;
    costIncrease: boolean;
    costDiff: number;
  } {
    // Calculate weighted score comparison
    const successScore = (candidate.successRate - baseline.successRate) * 100;
    const latencyScore = (baseline.avgLatency - candidate.avgLatency) / baseline.avgLatency;
    const costScore = (baseline.avgCost - candidate.avgCost) / baseline.avgCost;
    const qualityScore = (candidate.qualityScore - baseline.qualityScore) / 100;

    const overallScore = successScore * 0.4 + latencyScore * 0.3 + costScore * 0.2 + qualityScore * 0.1;

    return {
      overallScore,
      confidence: Math.min(candidate.samples, baseline.samples) / (this.config.minSamples * 2),
      latencyRegression: candidate.avgLatency > baseline.avgLatency * 1.2,
      latencyDiff: candidate.avgLatency - baseline.avgLatency,
      costIncrease: candidate.avgCost > baseline.avgCost * 1.15,
      costDiff: (candidate.avgCost - baseline.avgCost) / baseline.avgCost,
    };
  }
}
```

---

## Part 4: Testing Strategy

### 4.1 Unit Tests

```typescript
// src/cli/nanogpt-selection.test.ts

describe('NanoGPT Selection Engine', () => {
  describe('Policy Filtering', () => {
    it('should filter to subscription-only models', () => {
      const models = [
        createModel({ subscriptionEligible: true }),
        createModel({ subscriptionEligible: false }),
      ];
      
      const result = filterByPolicy(models, { mode: 'subscription-only', subscriptionBudget: { enforcement: 'hard' } });
      
      expect(result).toHaveLength(1);
      expect(result[0].nanoGptSpecific.subscriptionEligible).toBe(true);
    });

    it('should allow all models in hybrid mode', () => {
      const models = [
        createModel({ subscriptionEligible: true }),
        createModel({ subscriptionEligible: false }),
      ];
      
      const result = filterByPolicy(models, { mode: 'hybrid', subscriptionBudget: { enforcement: 'soft' } });
      
      expect(result).toHaveLength(2);
    });
  });

  describe('Scoring', () => {
    it('should score orchestrator higher for reasoning models', () => {
      const reasoningModel = createModel({ reasoning: true, toolcall: true });
      const nonReasoningModel = createModel({ reasoning: false, toolcall: true });
      
      const reasoningScore = calculateAgentModelScore(reasoningModel, createContext('orchestrator'));
      const nonReasoningScore = calculateAgentModelScore(nonReasoningModel, createContext('orchestrator'));
      
      expect(reasoningScore.totalScore).toBeGreaterThan(nonReasoningScore.totalScore);
    });

    it('should apply quota pressure penalty', () => {
      const model = createModel({ subscriptionEligible: true });
      const lowQuotaContext = createContext('orchestrator', { remainingDaily: 5, dailyBudget: 100 });
      const highQuotaContext = createContext('orchestrator', { remainingDaily: 90, dailyBudget: 100 });
      
      const lowQuotaScore = calculateAgentModelScore(model, lowQuotaContext);
      const highQuotaScore = calculateAgentModelScore(model, highQuotaContext);
      
      expect(highQuotaScore.totalScore).toBeGreaterThan(lowQuotaScore.totalScore);
    });
  });

  describe('Beam Search', () => {
    it('should find valid assignment for all agents', () => {
      const models = Array.from({ length: 10 }, (_, i) => 
        createModel({ id: `model-${i}`, subscriptionEligible: i < 5 }),
      );
      
      const result = selectNanoGptModels({
        models,
        policy: { mode: 'hybrid', subscriptionBudget: { enforcement: 'soft' } },
        quotaStatus: { dailyRemaining: 100, monthlyRemaining: 1000, resetsAt: new Date(), lastChecked: new Date() },
      });
      
      expect(Object.keys(result.assignments)).toHaveLength(6); // All agents
      for (const agent of AGENTS) {
        expect(result.assignments[agent]).toBeDefined();
        expect(result.assignments[agent].model).toMatch(/^nanogpt\//);
      }
    });

    it('should respect diversity constraints', () => {
      // Create models from multiple providers
      const models = [
        ...Array.from({ length: 5 }, () => createModel({ providerID: 'nanogpt' })),
        ...Array.from({ length: 5 }, () => createModel({ providerID: 'openai' })),
      ];
      
      const result = selectModelsWithBeamSearch(
        models,
        AGENTS,
        { beamWidth: 3, diversityTarget: 2, maxIterations: 50, convergenceThreshold: 0.01 },
        createContext('orchestrator'),
      );
      
      const providers = new Set(Object.values(result).map((a) => a.provider));
      expect(providers.size).toBeGreaterThanOrEqual(2);
    });
  });
});
```

### 4.2 Integration Tests

```typescript
// src/cli/integration/nanogpt-integration.test.ts

describe('NanoGPT Integration', () => {
  describe('Discovery', () => {
    it('should discover models from OpenCode CLI', async () => {
      const result = await discoverNanoGptModels();
      
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models[0]).toHaveProperty('nanoGptSpecific');
      expect(result.quotaStatus).toBeDefined();
    });

    it('should handle discovery failure gracefully', async () => {
      // Mock failure
      jest.spyOn(child_process, 'execSync').mockImplementation(() => {
        throw new Error('Command failed');
      });
      
      const result = await discoverNanoGptModels();
      
      expect(result.models).toHaveLength(0);
      expect(result.error).toBeDefined();
    });
  });

  describe('End-to-End Selection', () => {
    it('should generate valid configuration', async () => {
      const config = await runInstall({
        nanogpt: 'yes',
        nanogptPolicy: 'hybrid',
        nanogptDailyBudget: 100,
        // ... other args
      });
      
      expect(config.hasNanoGpt).toBe(true);
      expect(config.nanoGptAssignments).toBeDefined();
      expect(Object.keys(config.nanoGptAssignments!)).toHaveLength(6);
    });
  });
});
```

### 4.3 Matrix Tests

```typescript
// src/cli/dynamic-model-selection-matrix.test.ts - Additions

describe('Provider Combination Matrix', () => {
  const providerCombinations = [
    ['nanogpt'],
    ['nanogpt', 'chutes'],
    ['nanogpt', 'openai'],
    ['nanogpt', 'chutes', 'openai'],
    ['nanogpt', 'chutes', 'openai', 'opencode'],
    // ... more combinations
  ];

  for (const combination of providerCombinations) {
    it(`should produce valid plan for ${combination.join('+')}`, () => {
      const config = createConfigWithProviders(combination);
      const plan = buildDynamicModelPlanV3(mockCatalog, config);
      
      expect(plan).toBeDefined();
      expect(Object.keys(plan.agents)).toHaveLength(6);
      
      // Verify provider distribution
      const providerCounts = countProviders(plan.agents);
      for (const provider of combination) {
        expect(providerCounts[provider]).toBeGreaterThanOrEqual(1);
      }
    });
  }

  describe('NanoGPT Policy Matrix', () => {
    const policies: NanoGptRoutingPolicy['mode'][] = ['subscription-only', 'hybrid', 'paygo-only'];
    const quotaScenarios = [
      { remainingDaily: 100, remainingMonthly: 1000 }, // Healthy
      { remainingDaily: 10, remainingMonthly: 100 },     // Warning
      { remainingDaily: 2, remainingMonthly: 20 },       // Critical
    ];

    for (const policy of policies) {
      for (const quota of quotaScenarios) {
        it(`should handle ${policy} with quota: ${quota.remainingDaily}/${quota.remainingMonthly}`, () => {
          const config = createConfig({
            hasNanoGpt: true,
            nanoGptPolicy: { mode: policy, subscriptionBudget: { enforcement: 'soft' } },
            nanoGptQuotaStatus: { ...quota, resetsAt: new Date(), lastChecked: new Date() },
          });
          
          const plan = buildDynamicModelPlanV3(mockCatalog, config);
          
          if (policy === 'subscription-only' && quota.remainingDaily < 6) {
            // Should fall back to other providers
            expect(hasNonNanoGptFallbacks(plan)).toBe(true);
          }
        });
      }
    }
  });
});
```

---

## Part 5: Risk Mitigation

### 5.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Score drift from v1 to v3 | High | Medium | Shadow mode comparison, gradual rollout |
| Migration data loss | Medium | High | Backup configs, rollback script, dry-run mode |
| Discovery API instability | Medium | Medium | Retry logic, caching, fallback to static list |
| Performance regression | Medium | High | Benchmark suite, canary deployment |
| Subscription quota sync issues | Medium | High | Conservative defaults, soft enforcement option |

### 5.2 Migration Rollback Plan

```typescript
// src/cli/migration/rollback.ts

export async function rollbackToV1(
  configPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Read current (v2) config
    const currentConfig = await readConfig(configPath);
    
    if (!currentConfig._migratedFromV1) {
      return { success: false, error: 'Config was not migrated from V1' };
    }

    // Restore from backup
    const backupPath = `${configPath}.v1-backup`;
    if (!existsSync(backupPath)) {
      return { success: false, error: 'V1 backup not found' };
    }

    const v1Config = await readConfig(backupPath);
    
    // Validate V1 config
    if (!validateV1Config(v1Config)) {
      return { success: false, error: 'V1 backup is invalid' };
    }

    // Atomic swap
    const rollbackPath = `${configPath}.rollback-${Date.now()}`;
    await writeConfig(rollbackPath, currentConfig);
    await writeConfig(configPath, v1Config);

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
```

### 5.3 Gradual Rollout Strategy

```
Week 1-2: Internal testing
  - Unit tests passing
  - Integration tests with mock NanoGPT API
  - Shadow mode in production (no user impact)

Week 3: Canary (5% of users)
  - Opt-in flag: --nanogpt=preview
  - Monitor error rates, selection quality
  - Daily review of shadow comparisons

Week 4: Expanded rollout (25% of users)
  - Auto-migration for new installs
  - Manual migration option for existing users
  - Rollback capability maintained

Week 5: Full rollout (100% of users)
  - Remove preview flag
  - Deprecate v1 primary/secondary fields
  - Migration assistance for remaining users

Week 6+: Cleanup
  - Remove v1 compatibility layer
  - Update documentation
  - Archive migration tools
```

---

## Part 6: Acceptance Criteria (Detailed)

### 6.1 Functional Requirements

- [ ] **FR-001**: NanoGPT can be enabled via `--nanogpt=yes` CLI flag
- [ ] **FR-002**: NanoGPT models are discoverable via `opencode models` or direct API
- [ ] **FR-003**: Per-agent model selection produces valid assignments for all 6 agents
- [ ] **FR-004**: Billing mode (subscription/paygo) is tracked per assignment
- [ ] **FR-005**: Policy modes (subscription-only/hybrid/paygo-only) are enforced
- [ ] **FR-006**: Subscription quota is checked before assignment
- [ ] **FR-007**: Fallback chains include 3+ NanoGPT alternatives per agent
- [ ] **FR-008**: Cross-provider composition includes NanoGPT candidates
- [ ] **FR-009**: Chutes migration from 2-slot to N-way preserves existing assignments
- [ ] **FR-010**: OpenCode migration from 2-slot to N-way preserves existing assignments
- [ ] **FR-011**: V1 configs can be migrated to V2 without data loss
- [ ] **FR-012**: V2 configs can be rolled back to V1

### 6.2 Performance Requirements

- [ ] **PR-001**: Model selection completes in <500ms for 50 models
- [ ] **PR-002**: Discovery completes in <10s with timeout handling
- [ ] **PR-003**: Config generation produces valid JSON in <100ms
- [ ] **PR-004**: Memory usage stays below 100MB during selection

### 6.3 Quality Requirements

- [ ] **QR-001**: Unit test coverage >90% for selection engine
- [ ] **QR-002**: Integration tests cover all provider combinations
- [ ] **QR-003**: Shadow mode shows <5% score drift vs v1
- [ ] **QR-004**: Migration succeeds in >99% of cases
- [ ] **QR-005**: Rollback succeeds in >99% of cases

---

## Appendix A: Data Flow Diagrams

### A.1 Discovery Flow

```
User runs install
    |
    v
+----------------------------+
| discoverNanoGptModels()    |
| 1. Try OpenCode CLI        |
| 2. Fallback to direct API  |
| 3. Normalize results       |
+----------------------------+
    |
    v
+----------------------------+
| fetchQuotaStatus()         |
| - GET /v1/quota             |
| - Cache result              |
+----------------------------+
    |
    v
+----------------------------+
| store in InstallConfig     |
| - availableNanoGptModels   |
| - nanoGptQuotaStatus       |
+----------------------------+
```

### A.2 Selection Flow

```
InstallConfig
    |
    v
+----------------------------+
| selectNanoGptModels()      |
| 1. Filter by policy        |
| 2. Score all candidates    |
| 3. Beam search selection   |
| 4. Build fallback chains   |
+----------------------------+
    |
    v
+----------------------------+
| composeCrossProviderPlan() |
| 1. Collect all candidates |
| 2. Cross-provider scoring  |
| 3. Diversity optimization  |
| 4. Final assignment        |
+----------------------------+
    |
    v
+----------------------------+
| generateLiteConfig()       |
| - Write to opencode.json   |
+----------------------------+
```

### A.3 Runtime Flow

```
OpenCode Agent Request
    |
    v
+----------------------------+
| resolveAgentModel()        |
| 1. Check primary           |
| 2. Check NanoGPT fallback  |
| 3. Check cross-provider    |
| 4. Return best available   |
+----------------------------+
    |
    v
+----------------------------+
| trackUsage()               |
| - Decrement quota          |
| - Log metrics              |
+----------------------------+
    |
    v
+----------------------------+
| shadowEvaluation()         |
| (if canary enabled)        |
+----------------------------+
```

---

## Appendix B: Configuration Examples

### B.1 Minimal NanoGPT Config

```json
{
  "preset": "nanogpt-hybrid",
  "presets": {
    "nanogpt-hybrid": {
      "orchestrator": {
        "model": "nanogpt/gpt-4o",
        "variant": "high",
        "skills": ["*"],
        "mcps": []
      },
      "oracle": {
        "model": "nanogpt/gpt-4o",
        "variant": "high",
        "skills": ["frontend-ui-ux", "git-master"],
        "mcps": []
      },
      "designer": {
        "model": "nanogpt/gpt-4o",
        "variant": "medium",
        "skills": ["frontend-ui-ux", "agent-browser"],
        "mcps": []
      },
      "explorer": {
        "model": "nanogpt/gpt-4o-mini",
        "variant": "low",
        "skills": ["cartography"],
        "mcps": []
      },
      "librarian": {
        "model": "nanogpt/gpt-4o-mini",
        "variant": "low",
        "skills": ["agent-browser"],
        "mcps": []
      },
      "fixer": {
        "model": "nanogpt/gpt-4o-mini",
        "variant": "low",
        "skills": ["simplify"],
        "mcps": []
      }
    }
  },
  "fallback": {
    "enabled": true,
    "timeoutMs": 15000,
    "chains": {
      "orchestrator": [
        "nanogpt/gpt-4o",
        "nanogpt/gpt-4o-mini",
        "openai/gpt-5.3-codex",
        "opencode/big-pickle"
      ],
      "oracle": [
        "nanogpt/gpt-4o",
        "nanogpt/gpt-4-turbo",
        "openai/gpt-5.3-codex",
        "opencode/big-pickle"
      ],
      "...": "..."
    }
  },
  "nanogpt": {
    "policy": "hybrid",
    "subscriptionBudget": {
      "dailyRequests": 100,
      "monthlyRequests": 2000,
      "enforcement": "soft"
    }
  }
}
```

### B.2 Complex Multi-Provider Config

```json
{
  "preset": "dynamic",
  "dynamic": {
    "agents": {
      "orchestrator": {
        "provider": "nanogpt",
        "model": "nanogpt/gpt-4o",
        "billingMode": "subscription",
        "confidence": 0.92
      },
      "oracle": {
        "provider": "openai",
        "model": "openai/gpt-5.3-codex",
        "confidence": 0.88
      },
      "designer": {
        "provider": "chutes",
        "model": "chutes/kimi-k2.5",
        "confidence": 0.85
      },
      "explorer": {
        "provider": "nanogpt",
        "model": "nanogpt/gpt-4o-mini",
        "billingMode": "subscription",
        "confidence": 0.90
      },
      "librarian": {
        "provider": "nanogpt",
        "model": "nanogpt/gpt-4o",
        "billingMode": "subscription",
        "confidence": 0.87
      },
      "fixer": {
        "provider": "chutes",
        "model": "chutes/minimax-m2.1",
        "confidence": 0.82
      }
    },
    "chains": { "...": "..." },
    "provenance": { "...": "..." },
    "scoring": {
      "engineVersion": "v3",
      "shadowCompared": false
    }
  },
  "providerDistribution": {
    "nanogpt": 3,
    "openai": 1,
    "chutes": 2
  }
}
```

---

## Appendix C: API Reference

### C.1 NanoGPT Provider API

```typescript
// Provider interface implementation
export const nanogptProvider: ProviderImplementation = {
  id: 'nanogpt',
  
  async discover(apiKey?: string): Promise<DiscoveredModel[]> {
    return discoverNanoGptModels(apiKey);
  },
  
  async getQuotaStatus(apiKey?: string): Promise<QuotaStatus> {
    return fetchQuotaStatus(apiKey);
  },
  
  selectModels(
    models: NanoGptDiscoveredModel[],
    policy: NanoGptRoutingPolicy,
    quota: QuotaStatus,
  ): NanoGptSelectionOutput {
    return selectNanoGptModels({ models, policy, quotaStatus: quota });
  },
  
  validateConfig(config: NanoGptProviderConfig): ValidationResult {
    return validateNanoGptConfig(config);
  },
};
```

---

**End of Specification**

*Last Updated: 2024-01-15*  
*Version: 2.0*  
*Status: Draft for Review*
