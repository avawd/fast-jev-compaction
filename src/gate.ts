import type { CompactResult, Message } from './types.js';

/** Characters of tool-result text in `messages`: the only thing compaction shrinks. */
export function resultChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) for (const r of message.toolResults ?? []) total += r.text.length;
  return total;
}

/**
 * The reduction the fallback gate judges: characters saved over the
 * characters of tool results before compaction, plus what the teammate-row
 * pass saved (user-rows.ts) on both sides: its saving raises the ratio, and a
 * teammate row it leaves alone never dilutes it. A transcript whose bulk is
 * user text and attachments no longer looks like a failed compaction just
 * because the plugin cannot touch that bulk. Capped at 1 (dropped call inputs
 * can push the saving past the result total).
 */
export function gateRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter, resultCharsBefore } = result.stats;
  const shrinkable = resultCharsBefore + (result.stats.userRows?.charsSaved ?? 0);
  if (!shrinkable) return 0;
  return Math.min(1, Math.max(0, (charsBefore - charsAfter) / shrinkable));
}

/**
 * What a compaction does with a result that scored `ratio` against the gate `min`: prune (return
 * the pruned transcript), skip (leave the transcript as it is), or summary (hand it to Claude
 * Code's built-in summary). Below the gate, the plugin's own early request (`plugin`, sent at
 * `compactAtPercent`) skips: nothing needs the room yet, and a summary loses every verbatim fact.
 * Claude Code's own compaction (`auto`, at its threshold or on a prompt too long), `/compact`
 * (`manual`) and a `precompute` still get the summary, as before.
 */
export function gateOutcome(ratio: number, min: number, trigger: string): 'prune' | 'skip' | 'summary' {
  if (ratio >= min) return 'prune';
  return trigger === 'plugin' ? 'skip' : 'summary';
}
