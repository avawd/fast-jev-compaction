import type { Message } from './types.js';

/**
 * A row Claude Code hands over for a thinking block: an assistant message with no text, no tool
 * calls and no results. (Every assistant row maps to a message; a thinking block has its own row.)
 */
export function isThinkingRow(message: Message): boolean {
  return message.role === 'assistant' && message.text.trim() === '' && message.toolUses.length === 0 && !(message.toolResults?.length);
}

/**
 * Where the last assistant turn starts: the last typed prompt (a user row with no tool results).
 * Its thinking must stay: the API needs the thinking of an active tool loop, signature and all.
 */
function lastPromptIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user' && !(m.toolResults?.length)) return i;
  }
  return 0;
}

/**
 * `kept` (compact()'s output over `input`) without the thinking-only rows of completed earlier
 * turns. Rows are matched to `input` by identity: only the engine's own thinking rows go, never
 * the first message, one in the newest `preserveRecentMessages`, or one in the last assistant turn.
 * The model's earlier thinking stays in its context and is a large share of a long session's
 * tokens; verbatim pruning of tool output never reaches it.
 */
export function dropOldThinking(
  input: readonly Message[],
  kept: readonly Message[],
  preserveRecentMessages: number,
): { messages: Message[]; dropped: number } {
  const floor = Math.min(input.length - preserveRecentMessages, lastPromptIndex(input));
  const old = new Set<Message>();
  for (let i = 1; i < floor; i += 1) if (isThinkingRow(input[i]!)) old.add(input[i]!);
  const messages = kept.filter((m) => !old.has(m));
  return { messages, dropped: kept.length - messages.length };
}
