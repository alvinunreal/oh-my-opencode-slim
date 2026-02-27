import type { AgentName } from '../types';
import type { RoutingRuntimeMetrics } from './types';

export interface DetectedAnomaly {
  agent: AgentName;
  model: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  type: 'latency-spike' | 'error-spike' | 'cost-spike' | 'fallback-spike';
  message: string;
}

export interface CircuitBreakerState {
  blockedUntilEpochMs: number;
  reason: string;
}

export class RoutingAnomalyDetector {
  private readonly history = new Map<string, RoutingRuntimeMetrics[]>();
  private readonly breakers = new Map<string, CircuitBreakerState>();

  record(
    agent: AgentName,
    model: string,
    metrics: RoutingRuntimeMetrics,
  ): void {
    const key = `${agent}|${model}`;
    const existing = this.history.get(key) ?? [];
    existing.push(metrics);
    this.history.set(key, existing.slice(-40));
  }

  detect(agent: AgentName, model: string): DetectedAnomaly[] {
    const key = `${agent}|${model}`;
    const samples = this.history.get(key) ?? [];
    if (samples.length < 8) return [];

    const latest = samples[samples.length - 1] as RoutingRuntimeMetrics;
    const baseline = samples.slice(0, samples.length - 1);
    const avgLatency =
      baseline.reduce((sum, item) => sum + item.avgLatencyMs, 0) /
      baseline.length;
    const avgCost =
      baseline.reduce((sum, item) => sum + item.avgCostUsd, 0) /
      baseline.length;
    const avgFallback =
      baseline.reduce((sum, item) => sum + item.fallbackRate, 0) /
      baseline.length;
    const avgSuccess =
      baseline.reduce((sum, item) => sum + item.successRate, 0) /
      baseline.length;

    const anomalies: DetectedAnomaly[] = [];
    if (avgLatency > 0 && latest.avgLatencyMs > avgLatency * 1.8) {
      anomalies.push({
        agent,
        model,
        severity: 'high',
        type: 'latency-spike',
        message: `Latency spiked ${(latest.avgLatencyMs / avgLatency).toFixed(2)}x`,
      });
    }
    if (avgCost > 0 && latest.avgCostUsd > avgCost * 1.7) {
      anomalies.push({
        agent,
        model,
        severity: 'medium',
        type: 'cost-spike',
        message: `Cost spiked ${(latest.avgCostUsd / avgCost).toFixed(2)}x`,
      });
    }
    if (latest.fallbackRate > Math.max(0.25, avgFallback * 1.8)) {
      anomalies.push({
        agent,
        model,
        severity: 'critical',
        type: 'fallback-spike',
        message: `Fallback rate rose to ${(latest.fallbackRate * 100).toFixed(1)}%`,
      });
    }
    if (latest.successRate < Math.min(0.85, avgSuccess - 0.1)) {
      anomalies.push({
        agent,
        model,
        severity: 'high',
        type: 'error-spike',
        message: `Success rate dropped to ${(latest.successRate * 100).toFixed(1)}%`,
      });
    }
    return anomalies;
  }

  openCircuit(
    agent: AgentName,
    model: string,
    reason: string,
    ttlMs: number,
  ): void {
    const key = `${agent}|${model}`;
    this.breakers.set(key, {
      blockedUntilEpochMs: Date.now() + ttlMs,
      reason,
    });
  }

  isCircuitOpen(agent: AgentName, model: string): boolean {
    const key = `${agent}|${model}`;
    const state = this.breakers.get(key);
    if (!state) return false;
    if (Date.now() >= state.blockedUntilEpochMs) {
      this.breakers.delete(key);
      return false;
    }
    return true;
  }
}
