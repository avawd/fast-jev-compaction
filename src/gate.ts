import type { CompactResult, Message } from './types.js';

/** Characters of tool-result text in `messages`: the only thing compaction shrinks. */
export function resultChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) for (const r of message.toolResults ?? []) total += r.text.length;
  return total;
}

/**
 * The reduction the fallback gate judges: characters saved over the
 * characters of tool results before compaction. A transcript whose bulk is
 * user text and attachments no longer looks like a failed compaction just
 * because the plugin cannot touch that bulk. Capped at 1 (dropped call inputs
 * can push the saving past the result total).
 */
export function gateRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter, resultCharsBefore } = result.stats;
  if (!resultCharsBefore) return 0;
  return Math.min(1, Math.max(0, (charsBefore - charsAfter) / resultCharsBefore));
}
