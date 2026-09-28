import type {
  JevQuestion,
  JevSystemOneResponse,
} from './types';

export type JevClientConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export type SystemOneRequest = {
  state: string;
  questions: Record<string, JevQuestion>;
  model?: string;
};

/**
 * Minimal SystemOne HTTP client (POST {baseUrl}/systemone).
 * Intentionally dependency-free so the plugin does not need the TypeSafe SDK.
 */
export class JevClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: JevClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async systemOne(
    request: SystemOneRequest,
  ): Promise<JevSystemOneResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model ?? this.model,
          state: request.state,
          questions: request.questions,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `systemone HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        );
      }
      return (await res.json()) as JevSystemOneResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Resolve bearer token from config / env. Returns undefined when missing. */
export function resolveJevApiKey(options: {
  apiKey?: string;
  apiKeyEnv?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const env = options.env ?? process.env;
  if (options.apiKey) return options.apiKey;
  const primary = options.apiKeyEnv || 'TYPESAFE_API_KEY';
  return env[primary] || env.COMMANDCODE_API_KEY || undefined;
}
