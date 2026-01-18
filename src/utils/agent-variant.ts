import type { PluginConfig } from "../config";
import { log } from "../shared/logger";

export function normalizeAgentName(agentName: string): string {
  const trimmed = agentName.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function resolveAgentVariant(
  config: PluginConfig | undefined,
  agentName: string
): string | undefined {
  const normalized = normalizeAgentName(agentName);
  const rawVariant = config?.agents?.[normalized]?.variant;

  if (typeof rawVariant !== "string") {
    log(`[variant] no variant configured for agent "${normalized}"`);
    return undefined;
  }

  const trimmed = rawVariant.trim();
  if (trimmed.length === 0) {
    log(`[variant] empty variant for agent "${normalized}" (ignored)`);
    return undefined;
  }

  log(`[variant] resolved variant="${trimmed}" for agent "${normalized}"`);
  return trimmed;
}

export function applyAgentVariant<T extends { variant?: string }>(
  variant: string | undefined,
  body: T
): T {
  if (!variant) {
    log("[variant] no variant to apply (skipped)");
    return body;
  }
  if (body.variant) {
    log(`[variant] body already has variant="${body.variant}" (not overriding)`);
    return body;
  }
  log(`[variant] applied variant="${variant}" to prompt body`);
  return { ...body, variant };
}
