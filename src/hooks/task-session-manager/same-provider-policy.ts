/**
 * Opt-in same-provider background-to-foreground conversion.
 *
 * Some local inference backends expose multiple logical agent sessions but
 * execute them on one shared model runtime (one accelerator, one KV-context
 * pool). A foreground parent and a same-provider background child running
 * concurrently on such a backend degrade throughput from repeated
 * model/KV context switching between the two large sessions. When the user
 * configures a provider with policy "foreground" in
 * `backgroundJobs.sameProviderPolicy`, an explicit `background: true` task
 * request whose parent and child both resolve to that provider is rewritten
 * to the existing foreground execution path (no concurrency admission, no
 * supervision, synchronous host execution).
 *
 * The decision is fail-open at every step: any unknown or undeterminable
 * model or provider leaves `background: true` untouched.
 */
import { providerFromModel } from '../../utils/background-task-concurrency';

export type SameProviderPolicy = 'foreground';

export interface SameProviderConversionResult {
  converted: boolean;
  parentProvider?: string;
  childProvider?: string;
}

export interface SameProviderConversionInput {
  agentType: string;
  parentSessionID: string;
  args: { background?: unknown };
  policy?: Record<string, SameProviderPolicy>;
  getParentModel: (parentSessionID: string) => string | undefined;
  getChildModel: (
    agentType: string,
    parentSessionID: string,
  ) => string | undefined;
}

/**
 * Converts a same-provider background task to foreground in place when the
 * provider is opted in. Returns the decision so the caller can log it.
 */
export function convertSameProviderBackgroundTask(
  input: SameProviderConversionInput,
): SameProviderConversionResult {
  if (input.args.background !== true) {
    return { converted: false };
  }

  const parentModel = input.getParentModel(input.parentSessionID);
  const childModel = input.getChildModel(
    input.agentType,
    input.parentSessionID,
  );
  const parentProvider = providerFromModel(parentModel);
  const childProvider = providerFromModel(childModel);

  if (
    parentProvider === undefined ||
    childProvider === undefined ||
    parentProvider !== childProvider ||
    input.policy?.[parentProvider] !== 'foreground'
  ) {
    return { converted: false };
  }

  input.args.background = false;
  return { converted: true, parentProvider, childProvider };
}
