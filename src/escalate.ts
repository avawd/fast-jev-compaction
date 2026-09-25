import { applyRules } from './rules.js';
import { staleTruncationRule } from './rules-age.js';
import { isTruncated } from './truncate.js';
import type { Message, ResolvedCompactOptions, ToolCall, Verdict } from './types.js';

/**
 * Tier 2: what compact() tries once more when a pass misses the caller's gate on a transcript an
 * earlier compaction already truncated. A long session compacts many times, and on the replayed
 * corpus (eval/replay.ts) a later pass misses the gate far more often than a first one: the old
 * output is already cut, so only what arrived since can go. The alternative is the built-in
 * summary, which loses every verbatim fact, so the tier halves the age at which reads count as
 * stale and the head and tail a truncation keeps, and cuts old truncations further. Pins still
 * hold: shapes are planned by the same code, which never lets a quoted-later token go.
 */
export function tier2Options(options: ResolvedCompactOptions): ResolvedCompactOptions {
  return {
    ...options,
    staleAfterMessages: Math.floor(options.staleAfterMessages / 2),
    truncateHeadChars: Math.floor(options.truncateHeadChars / 2),
    truncateTailChars: Math.floor(options.truncateTailChars / 2),
  };
}

/** Whether an earlier compaction already truncated something in this transcript. */
export function wasCompacted(messages: readonly Message[]): boolean {
  return messages.some((m) => (m.toolResults ?? []).some((r) => isTruncated(r.text)));
}

/**
 * The first pass's verdicts (rules and the scorer's), plus what the rules decide at tier 2's age
 * for the calls nothing decided: no second scorer run. `calls` are annotated with tier-2 options.
 */
export function tier2Verdicts(calls: readonly ToolCall[], first: ReadonlyMap<string, Verdict>): Map<string, Verdict> {
  const verdicts = new Map(first);
  for (const [id, verdict] of applyRules(calls)) if (!verdicts.has(id)) verdicts.set(id, verdict);
  for (const [id, verdict] of staleTruncationRule(calls, new Set(verdicts.keys()))) verdicts.set(id, verdict);
  return verdicts;
}
