/**
 * Jev / SystemOne routing probe.
 *
 * Usage (from repo root):
 *   $env:TYPESAFE_API_KEY = "<token>"
 *   bun scripts/jev-route-probe.ts
 *
 * Optional:
 *   $env:JEV_BASE_URL = "https://api.commandcode.ai/provider/v1"
 *   $env:JEV_MODEL = "typesafe/jev"
 */
import { JevRouter } from '../src/routing/jev';

const samples = [
  {
    label: 'fixer-simple',
    state: 'Task: rename the local variable `tmp` to `tempBuffer` in utils/copy.ts line 12. Trivial one-line mechanical change.',
  },
  {
    label: 'fixer-complex',
    state:
      'Task: implement end-to-end payment retry with idempotency keys across billing service, webhook handler, and DB migrations. Multi-system coupling, money involved, several unknown edge cases. Clear that this is implementation work (not architecture advice).',
  },
  {
    label: 'librarian-research',
    state: 'Task: figure out why Next.js 15 App Router cache invalidation is not refreshing our product page after a server action update. We need current official docs and known issues.',
  },
  {
    label: 'oracle-architecture',
    state: 'Task: decide whether to split the monolithic billing service into separate invoice/payment modules. High risk: money, data integrity, multi-team impact. Need trade-off analysis.',
  },
  {
    label: 'designer-ui',
    state: 'Task: polish the dashboard layout — spacing, visual hierarchy, responsive sidebar, hover states. User-facing polish is the main goal.',
  },
];

async function main() {
  const config = {
    enabled: true,
    baseUrl: process.env.JEV_BASE_URL ?? 'https://api.commandcode.ai/provider/v1',
    model: process.env.JEV_MODEL ?? 'typesafe/jev',
    apiKey: process.env.TYPESAFE_API_KEY ?? process.env.COMMANDCODE_API_KEY,
    apiKeyEnv: 'TYPESAFE_API_KEY',
    timeoutMs: 8000,
    acceptConfidence: 0.75,
    escalateConfidence: 0.5,
    maxStateChars: 4000,
  };

  if (!config.apiKey) {
    console.error('Set TYPESAFE_API_KEY (or COMMANDCODE_API_KEY) first.');
    process.exit(1);
  }

  const router = new JevRouter({
    config,
    agents: () => ({
      // Task-type agents. model arrays = strength ladder on the SAME agent.
      explorer: {
        model: [
          { id: 'command-code/deepseek/deepseek-v4.1-flash', variant: 'low' },
          { id: 'command-code/deepseek/deepseek-v4.1-flash', variant: 'high' },
          { id: 'zhipuai-coding-plan/glm-5.3-flash' },
        ],
      },
      librarian: {
        model: [
          { id: 'zhipuai-coding-plan/glm-5.3-flash' },
          { id: 'zhipuai-coding-plan/glm-5.3' },
        ],
      },
      fixer: {
        model: [
          { id: 'command-code/deepseek/deepseek-v4.1-flash', variant: 'low' },
          { id: 'command-code/deepseek/deepseek-v4.1-flash', variant: 'high' },
          { id: 'zhipuai-coding-plan/glm-5.3' },
        ],
      },
      designer: {
        model: [
          { id: 'zhipuai-coding-plan/glm-5.3-flash' },
          { id: 'zhipuai-coding-plan/glm-5.3' },
        ],
      },
      oracle: {
        model: [
          { id: 'zhipuai-coding-plan/glm-5.3-flash' },
          { id: 'zhipuai-coding-plan/glm-5.3' },
        ],
      },
      orchestrator: {
        model: [
          { id: 'zhipuai-coding-plan/glm-5.3-flash' },
          { id: 'zhipuai-coding-plan/glm-5.3' },
        ],
      },
    }),
    disabledAgents: () => new Set(['observer', 'council']),
  });

  console.log(`Jev probe → ${config.baseUrl}/systemone model=${config.model}\n`);
  for (const sample of samples) {
    const t0 = Date.now();
    const result = await router.route({ state: sample.state });
    const ms = Date.now() - t0;
    console.log(`## ${sample.label} (${ms}ms)`);
    console.log(`status: ${result.status}`);
    console.log(`specialist: ${result.specialist ?? '-'}`);
    console.log(`confidence: ${result.confidence?.toFixed(2) ?? '-'}`);
    console.log(
      `complexity/risk: ${result.complexity?.toFixed(2) ?? '-'} / ${result.risk?.toFixed(2) ?? '-'}`,
    );
    console.log(`model_tier: ${result.modelTier ?? '-'}`);
    console.log(
      `model: ${result.model ? `${result.model.id}${result.model.variant ? ` (${result.model.variant})` : ''}` : '-'}`,
    );
    console.log(`recommendation: ${result.recommendation}`);
    if (result.probabilities) {
      const top = Object.entries(result.probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(' ');
      console.log(`probs: ${top}`);
    }
    if (result.error) console.log(`error: ${result.error}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
