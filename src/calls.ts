import { sliceWhole } from './text.js';
import type { Message, ToolCall, ToolResult } from './types.js';

/** Enough of a result for the scorer's preview (it shows 80 chars after collapsing whitespace). */
const RESULT_HEAD_CHARS = 200;

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
  /** Calls kept whole whatever their position (riders.ts). */
  protectedIds: ReadonlySet<string> = new Set(),
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        resultHead: sliceWhole(found.result.text, RESULT_HEAD_CHARS),
        isError: found.result.isError ?? false,
        pinned:
          protectedIds.has(tool.tool_use_id) ||
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}
