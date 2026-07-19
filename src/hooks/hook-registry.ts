export interface HookHandler {
  priority: number;
  handler: (input: unknown, output: unknown) => Promise<void>;
}

export class HookRegistry {
  private handlers = new Map<string, HookHandler[]>();

  register(
    hookPoint: string,
    handler: (input: unknown, output: unknown) => Promise<void>,
    priority = 50,
  ): void {
    const existing = this.handlers.get(hookPoint) ?? [];
    existing.push({ priority, handler });
    this.handlers.set(hookPoint, existing);
  }

  async dispatch(
    hookPoint: string,
    input: unknown,
    output: unknown,
  ): Promise<void> {
    const handlers = this.handlers.get(hookPoint);
    if (!handlers || handlers.length === 0) return;

    const sorted = [...handlers].sort((a, b) => a.priority - b.priority);
    for (const { handler } of sorted) {
      try {
        await handler(input, output);
      } catch (error) {
        console.error(
          `[hook-registry] handler failed for ${hookPoint}:`,
          error,
        );
      }
    }
  }

  getHandlers(hookPoint: string): HookHandler[] {
    const handlers = this.handlers.get(hookPoint);
    if (!handlers) return [];
    return [...handlers].sort((a, b) => a.priority - b.priority);
  }
}

export function createHookRegistry(): HookRegistry {
  return new HookRegistry();
}
