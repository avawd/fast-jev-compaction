import { analyzeReferences } from './pin.js';
import type { Message, ResolvedCompactOptions, ToolCall } from './types.js';

/**
 * Returns copies of `calls` carrying what the text-reading rules and the
 * scorer need: the result text, its age in messages, whether it is stale, and
 * the later-quoted tokens it carries (`refTokens`, `refLater`).
 */
export function annotateCalls(
  calls: readonly ToolCall[],
  messages: readonly Message[],
  options: Pick<ResolvedCompactOptions, 'staleAfterMessages'>,
): ToolCall[] {
  const texts = new Map<string, string>();
  for (const message of messages) for (const r of message.toolResults ?? []) texts.set(r.tool_use_id, r.text);
  const refs = analyzeReferences(calls, messages);
  return calls.map((call) => {
    const age = messages.length - 1 - call.resultIndex;
    const refTokens = refs.get(call.id) ?? [];
    return {
      ...call,
      resultText: texts.get(call.tool_use_id) ?? '',
      age,
      stale: age > options.staleAfterMessages,
      refTokens,
      refLater: refTokens.length,
    };
  });
}
