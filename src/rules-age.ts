import { bashCommand, isReadOnlyCommand } from './rules-bash.js';
import { isTruncated } from './truncate.js';
import type { ToolCall, Verdict } from './types.js';

/** Reads of the engine's own spill files (persisted outputs, background task logs). */
const SPILL_PATH = /\/(?:tool-results|tasks)\//;

function isFileRead(call: ToolCall): boolean {
  if (call.tool === 'Read') {
    const p = call.input['file_path'];
    return typeof p === 'string' && !SPILL_PATH.test(p);
  }
  const command = bashCommand(call);
  return command.length > 0 && isReadOnlyCommand(command);
}

/**
 * `stale_age`: a Read, or a Bash command that only reads, lists or searches files, whose result is older than
 * `staleAfterMessages` (annotated as `stale`) and that no other rule decided
 * is truncated. The file is still on disk; the call records that it was read.
 */
export function ageRule(calls: readonly ToolCall[], decided: ReadonlySet<string>): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  for (const call of calls) {
    if (call.pinned || call.isError || !call.stale || decided.has(call.id)) continue;
    if ((call.resultText ?? '').startsWith('<persisted-output>')) continue;
    if (isFileRead(call)) verdicts.set(call.id, { action: 'drop_result', source: 'rule', rule: 'stale_age' });
  }
  return verdicts;
}

/**
 * `stale_truncation` (tier 2 only, see compact.ts `escalate`): a result an earlier compaction
 * already truncated, older than the tier's `staleAfterMessages`, whatever its tool. Its head is cut
 * further; the note's count keeps accounting for the original result.
 */
export function staleTruncationRule(calls: readonly ToolCall[], decided: ReadonlySet<string>): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  for (const call of calls) {
    if (call.pinned || !call.stale || decided.has(call.id)) continue;
    if (isTruncated(call.resultText ?? '')) verdicts.set(call.id, { action: 'drop_result', source: 'rule', rule: 'stale_truncation' });
  }
  return verdicts;
}
