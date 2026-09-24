import { ageRule } from './rules-age.js';
import { bashRules } from './rules-bash.js';
import { mcpWriteEcho } from './rules-mcp.js';
import type { ToolCall, Verdict } from './types.js';

/**
 * The Stage 2a rules, run after the core ones: each only decides calls that
 * are still undecided, so a core verdict is never overridden. Returns a new map.
 */
export function applyExtraRules(calls: readonly ToolCall[], core: ReadonlyMap<string, Verdict>): Map<string, Verdict> {
  const verdicts = new Map(core);
  for (const call of calls) {
    if (verdicts.has(call.id)) continue;
    const echo = mcpWriteEcho(call);
    if (echo) verdicts.set(call.id, echo);
  }
  for (const [id, verdict] of bashRules(calls, new Set(verdicts.keys()))) verdicts.set(id, verdict);
  // Last: the age rule only catches what no supersession rule explained.
  for (const [id, verdict] of ageRule(calls, new Set(verdicts.keys()))) verdicts.set(id, verdict);
  return verdicts;
}
