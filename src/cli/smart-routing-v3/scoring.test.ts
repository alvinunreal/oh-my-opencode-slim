import { describe, expect, test } from 'bun:test';
import type { DiscoveredModel } from '../types';
import { rankRoutingCandidates } from './scoring';

function model(
  input: Partial<DiscoveredModel> & { model: string },
): DiscoveredModel {
  const [providerID] = input.model.split('/');
  return {
    providerID: providerID ?? 'openai',
    model: input.model,
    name: input.name ?? input.model,
    status: input.status ?? 'active',
    contextLimit: input.contextLimit ?? 200_000,
    outputLimit: input.outputLimit ?? 32_000,
    reasoning: input.reasoning ?? true,
    toolcall: input.toolcall ?? true,
    attachment: input.attachment ?? false,
    costInput: input.costInput,
    costOutput: input.costOutput,
    nanoGptAccess: input.nanoGptAccess,
  };
}

describe('smart-routing-v3 scoring', () => {
  test('treats nanogpt models as subscription billing', () => {
    const ranked = rankRoutingCandidates(
      [
        model({
          model: 'nanogpt/qwen/qwen3-coder',
          costInput: 1,
          costOutput: 2,
          nanoGptAccess: 'subscription',
        }),
        model({
          model: 'chutes/zai-org/GLM-4.7-Flash',
          costInput: 0.06,
          costOutput: 0.35,
        }),
      ],
      'oracle',
      {
        policy: {
          mode: 'subscription-only',
          subscriptionBudget: {
            dailyRequests: 100,
            monthlyRequests: 3000,
            enforcement: 'soft',
          },
        },
        quotaStatus: {
          dailyRemaining: 90,
          monthlyRemaining: 2500,
          lastCheckedAt: new Date(),
        },
        providerUsage: new Map<string, number>(),
      },
    );

    const nanogptCandidate = ranked.find((entry) =>
      entry.model.model.startsWith('nanogpt/'),
    );
    expect(nanogptCandidate?.billingMode).toBe('subscription');
  });

  test('prefers Gemini 3 over Gemini 2.5 flash when both available', () => {
    const ranked = rankRoutingCandidates(
      [
        model({
          model: 'google/gemini-2.5-flash',
          costInput: 0,
          costOutput: 0,
        }),
        model({
          model: 'google/gemini-3-flash-preview',
          costInput: 0,
          costOutput: 0,
        }),
      ],
      'orchestrator',
      {
        policy: {
          mode: 'hybrid',
          subscriptionBudget: {
            dailyRequests: 100,
            monthlyRequests: 3000,
            enforcement: 'soft',
          },
        },
        quotaStatus: {
          dailyRemaining: 90,
          monthlyRemaining: 2500,
          lastCheckedAt: new Date(),
        },
        providerUsage: new Map<string, number>(),
      },
    );

    expect(ranked[0]?.model.model).toBe('google/gemini-3-flash-preview');
  });
});
