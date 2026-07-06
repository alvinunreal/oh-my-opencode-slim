export class HookRegistry {
  #handlers = new Map<
    string,
    Array<(input: unknown, output: unknown) => Promise<void>>
  >();
  #firedHookPoints = new Set<string>();

  register(
    hookPoint: string,
    handler: (input: unknown, output: unknown) => Promise<void>,
  ): void {
    if (this.#firedHookPoints.has(hookPoint)) {
      console.warn(
        `[hook-registry] "${hookPoint}" already dispatched; late registration may miss events`,
      );
    }
    const group = this.#handlers.get(hookPoint);
    if (group) {
      group.push(handler);
    } else {
      this.#handlers.set(hookPoint, [handler]);
    }
  }

  async dispatch(
    hookPoint: string,
    input: unknown,
    output: unknown,
  ): Promise<void> {
    this.#firedHookPoints.add(hookPoint);
    const group = this.#handlers.get(hookPoint);
    if (!group) return;
    for (const handler of group) {
      await handler(input, output);
    }
  }

  handlers(
    hookPoint: string,
  ): ReadonlyArray<(input: unknown, output: unknown) => Promise<void>> {
    return this.#handlers.get(hookPoint) ?? [];
  }
}
