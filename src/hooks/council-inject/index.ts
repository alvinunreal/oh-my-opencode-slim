/**
 * Keyword-triggered Council Mode injection (omo keyword-detector pattern,
 * ported onto the omo-s cache-safe injection discipline).
 *
 * The full Council Mode dispatch procedure is NOT part of the orchestrator's
 * static prompt: it is appended as a tagged synthetic part only to
 * orchestrator user messages whose text matches a council trigger (e.g.
 * "@council", "consensus", "共识"). Messages without a trigger never carry
 * the block, so a session that never asks for a council pays zero tokens
 * for it.
 *
 * First-hit injection: at most ONE block per transcript. The block lands on
 * the FIRST triggering message and reads as a standing procedure; later
 * triggering messages reuse the block already in history instead of
 * re-injecting it (a session with N triggering messages costs one block,
 * not N). Because the earliest triggering message never moves in an
 * append-only transcript, the derivation stays a pure function of the
 * message list, so the cache-safety contract below is preserved.
 *
 * Cache safety (see ../cache-safe-injection): the block is a
 * construction-time constant (delegation vocabulary) and the trigger
 * decision is a pure function of the message text — re-running this
 * transform on later turns reproduces the same bytes at the same positions.
 * Do not make this tail-only (PR #790) and never gate it on in-memory
 * session state: a plugin restart would drop the block and rewrite already-
 * cached prefix bytes every turn.
 *
 * Compaction: the compaction bridge strips this part
 * (COMPACTION_STRIP_METADATA_KEYS). If a triggering message survives
 * compaction, the block is regenerated on the next turn by the same
 * pure-function re-derivation — no restoration state is needed.
 */
import { formatSystemReminder } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils/internal-initiator';
import {
  appendTaggedSyntheticPart,
  hasTaggedPart,
} from '../cache-safe-injection';
import { findLatestUserMessage, isUserMessageWithParts } from '../types';

export const COUNCIL_INJECT_METADATA_KEY = 'oh-my-opencode-slim.councilInject';

/**
 * Council trigger keywords across every supported language (English,
 * 简/繁体中文, 日本語, 한국어, فارسی). Recall-biased by design: a false
 * positive only injects a ~140-token block once per transcript, and the
 * block's gate sentence ("When the conversation calls for multi-model
 * consensus") lets the model decline incidental mentions — while a false
 * negative leaves the orchestrator unaware of the Council Mode procedure.
 * ASCII words use \b word boundaries (covers "@council" and
 * "@councillor-<seat>"); non-ASCII scripts use plain substring matching
 * (JS \b is ASCII-only). Deliberately excluded: bare seat names in prose,
 * vote/投票, and single-token hot words (model/モデル/모델/مدل).
 */
const COUNCIL_TRIGGER_PATTERN =
  /\b(?:councillors?|councils?|consensus|second opinions?|roundtable|multiple opinions|multiple models|several models|multi-model|multi-?agents?|multiagent|panels?|deliberat\w*|diverse perspectives|sounding board)\b|议会|議會|評議会|協議会|顾问团|顧問團|圆桌|圓桌|円卓|共识|共識|合意|第二意见|第二意見|セカンドオピニオン|多方意见|多模型|多个模型|多個模型|几个模型|幾個模型|别的模型|別的模型|其他模型|多代理|多智能体|マルチエージェント|複数のモデル|평의회|위원회|원탁|합의|세컨드 오피니언|여러 모델|멀티에이전트|شورا|انجمن|میزگرد|اجماع|نظر دوم|چند مدل|چندعامله/i;

const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const SLASH_COMMAND_LEAD_PATTERN = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/;

/** Strip fenced code blocks and inline code so pasted configs/logs that
 * merely mention "council" do not trigger the injection. */
export function stripCodeForTriggerMatch(text: string): string {
  return text
    .replace(CODE_FENCE_PATTERN, ' ')
    .replace(INLINE_CODE_PATTERN, ' ');
}

/** Pure function of the message text: deterministic across turns and
 * across plugin restarts (the cache-safety contract above). */
export function matchesCouncilTrigger(text: string): boolean {
  const clean = stripCodeForTriggerMatch(text);
  if (SLASH_COMMAND_LEAD_PATTERN.test(clean)) return false;
  return COUNCIL_TRIGGER_PATTERN.test(clean);
}

/** Delegation wording subset needed to render the dispatch examples.
 * Structurally typed so the hooks layer does not import from src/v2. */
export interface CouncilWording {
  tool: string;
  agentParam: string;
}

/**
 * Build the Council Mode dispatch block. Pure function of the delegation
 * vocabulary — a construction-time constant, so the rendered bytes are
 * stable for the lifetime of the plugin generation.
 *
 * Deliberately terse: the orchestrator is a strong model, seat names live
 * in the orchestrator's static seat pointer, and the tool schemas document
 * themselves, so the block only carries what the model cannot infer —
 * the gate condition, the dispatch shape, and the councillors' capability
 * boundary. The gate sentence is descriptive, not restrictive ("when the
 * conversation calls for it"), so weaker models still run the procedure
 * on a genuine ask while stronger models can decline incidental mentions.
 */
export function buildCouncilModeBlock(wording: CouncilWording): string {
  return [
    '## Council Mode',
    '',
    'When the conversation calls for multi-model consensus, run this procedure:',
    '1. Embed a summary of any external sources into each councillor prompt (councillors cannot fetch).',
    `2. Dispatch the question to every council seat in parallel via ${wording.tool}() — one call per seat.`,
    '3. Collect all responses; retry an empty seat once; mark failed seats; do not wait on stragglers.',
    `4. Call ${wording.tool}(${wording.agentParam}='council', description='Synthesize council report', prompt=<question + every seat response labeled by seat and model>) to synthesize, then present its report.`,
  ].join('\n');
}

interface CouncilInjectOptions {
  /** Native delegation wording for the host flavor (construction-time). */
  wording: CouncilWording;
}

/**
 * Creates the experimental.chat.messages.transform hook for keyword-triggered
 * Council Mode injection. Runs right before sending to API (no UI display).
 * Only injects for the orchestrator agent, and only onto the FIRST message
 * whose text matches a council trigger — later triggering messages reuse
 * the block already planted in history (first-hit, one block per
 * transcript).
 */
export function createCouncilInjectHook(options: CouncilInjectOptions) {
  const block = formatSystemReminder(buildCouncilModeBlock(options.wording));

  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      const lastUserMessage = findLatestUserMessage(messages);
      if (!lastUserMessage) {
        return;
      }

      const { agent, sessionID } = lastUserMessage.info;
      if (agent !== 'orchestrator' || !sessionID) {
        return;
      }

      // First-hit dedupe: if this payload already carries a block (e.g. the
      // same output object transformed twice), add nothing anywhere.
      const alreadyInjected = messages.some(
        (message) =>
          isUserMessageWithParts(message) &&
          message.info.agent === 'orchestrator' &&
          message.info.sessionID === sessionID &&
          hasTaggedPart(message, COUNCIL_INJECT_METADATA_KEY),
      );
      if (alreadyInjected) {
        return;
      }

      let injected = false;
      for (const message of messages) {
        if (injected) {
          break;
        }
        if (
          !isUserMessageWithParts(message) ||
          message.info.agent !== 'orchestrator' ||
          message.info.sessionID !== sessionID
        ) {
          continue;
        }

        // Collect eligible text parts once: the message-level slash gate
        // and the trigger scan share the same eligibility.
        const eligibleTexts: string[] = [];
        for (const part of message.parts) {
          if (
            part.type === 'text' &&
            typeof part.text === 'string' &&
            part.synthetic !== true &&
            !isInternalInitiatorPart(part)
          ) {
            eligibleTexts.push(part.text);
          }
        }
        if (eligibleTexts.length === 0) {
          continue;
        }

        // Slash commands never trigger (documented behavior): a message
        // whose FIRST eligible text part leads with a slash is a host
        // command, and the whole message is skipped — a later part
        // containing a trigger word must not inject around the command.
        if (
          SLASH_COMMAND_LEAD_PATTERN.test(
            stripCodeForTriggerMatch(eligibleTexts[0]),
          )
        ) {
          continue;
        }

        // Scan every eligible text part (not just the first): a trigger in
        // any part of a multi-part message still injects.
        if (eligibleTexts.some((text) => matchesCouncilTrigger(text))) {
          appendTaggedSyntheticPart(message, {
            text: block,
            metadataKey: COUNCIL_INJECT_METADATA_KEY,
          });
          injected = true;
        }
      }
    },
  };
}
