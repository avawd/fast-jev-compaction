import { pinnedTail } from './pin.js';
import { bashCommand, readonlyFamilyKey, sourceReadPaths, stripCommandPrefix } from './rules-bash.js';
import type { CallDecision, ResolvedCompactOptions, ToolCall } from './types.js';

/** A command word that marks a run whose verdict is printed last. */
const TAIL_WORD =
  /^(?:[\w.-]*deploy[\w.-]*|(?:test|build|lint|typecheck|check|e2e)(?::[\w:-]+)?|tests|install|ci|push|vitest|jest|pytest|playwright|tsc|eslint)$/;

/** A verdict line: counts, exit status, pass/fail markers. */
const VERDICT =
  /(\b\d+ (?:passed|failed|skipped|errors?)\b|Tests?:|Test Files|exit(?:ed)? (?:code|status)|✓|✗|×|\bPASS\b|\bFAIL\b|error TS\d+|Build (?:succeeded|failed)|Done in|Ran \d+ tests?)/;

/** How far from the end a verdict line counts as "near the end". */
const VERDICT_WINDOW = 400;

/**
 * Whether truncating this call's result should keep a tail as well as the
 * head: a Bash run of a test/build/deploy/lint/install/push command, or any
 * Bash result that ends with a verdict line. File reads never do.
 */
export function wantsTail(call: ToolCall): boolean {
  const command = bashCommand(call);
  if (!command || sourceReadPaths(command).length > 0) return false;
  const rest = stripCommandPrefix(command);
  if (!readonlyFamilyKey(rest) && rest.split(/[\s;&|()]+/).some((w) => TAIL_WORD.test(w))) return true;
  return VERDICT.test((call.resultText ?? '').slice(-VERDICT_WINDOW));
}

export interface ShapePlan {
  /** The decisions, with pin vetoes (keep) and drop_call → truncate downgrades applied. */
  decisions: CallDecision[];
  /** Tail characters to keep, by `tool_use_id`, for truncations that keep one. */
  tails: Map<string, number>;
}

/**
 * Decides the shape of every truncation: head only, or head + tail for
 * log-like results. A call whose result carries later-quoted tokens is never
 * dropped: it is truncated to a window holding all of them, or kept.
 */
export function planShapes(
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  options: ResolvedCompactOptions,
  /** The text that will actually be truncated, by `tool_use_id`, when it differs from `resultText`. */
  texts: ReadonlyMap<string, string> = new Map(),
): ShapePlan {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const tails = new Map<string, number>();
  const planned = decisions.map((decision): CallDecision => {
    const call = byId.get(decision.id);
    if (!call || decision.action === 'keep') return decision;
    const preferred = wantsTail(call) ? options.truncateTailChars : 0;
    const tokens = options.pinReferenced ? (call.refTokens ?? []) : [];
    if (tokens.length === 0) {
      if (decision.action === 'drop_result' && preferred > 0) tails.set(call.tool_use_id, preferred);
      return decision;
    }
    const text = texts.get(call.tool_use_id) ?? call.resultText ?? '';
    const tail = pinnedTail(text, tokens, options.truncateHeadChars, preferred, options.truncateTailChars);
    if (tail === undefined) return { id: decision.id, tool: decision.tool, action: 'keep', source: 'pinned' };
    if (tail > 0) tails.set(call.tool_use_id, tail);
    return decision.action === 'drop_result' ? decision : { ...decision, action: 'drop_result' };
  });
  return { decisions: planned, tails };
}
