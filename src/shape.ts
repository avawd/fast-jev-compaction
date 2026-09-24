import { pinnedWindow } from './pin.js';
import { bashCommand, readonlyFamilyKey, sourceReadPaths, stripCommandPrefix } from './rules-bash.js';
import type { CallDecision, ResolvedCompactOptions, ToolCall } from './types.js';

/** A command word that marks a run whose verdict is printed last. */
const TAIL_WORD =
  /^(?:[\w.-]*deploy[\w.-]*|(?:test|build|lint|typecheck|check|e2e)(?::[\w:-]+)?|tests|install|ci|push|vitest|jest|pytest|playwright|tsc|eslint)$/;

/** A verdict line: counts, exit status, pass/fail markers. */
const VERDICT =
  /(\b\d+ (?:passed|failed|skipped|errors?)\b|Tests?:|Test Files|exit(?:ed)? (?:code|status)|✓|✗|×|\bPASS\b|\bFAIL\b|error TS\d+|Build (?:succeeded|failed)|Done in|Ran \d+ tests?)/;

/** Longest head a pinned token may stretch a truncation to; past it the result is kept whole. */
export const MAX_PINNED_HEAD = 4000;

/** Files whose end is a verdict: logs and background-task outputs. */
const LOG_FILE = /\.(?:log|out|output)$|\/tasks\//;

/** How far from the end a verdict line counts as "near the end". */
const VERDICT_WINDOW = 400;

/**
 * Whether truncating this call's result should keep a tail as well as the
 * head: a Bash run of a test/build/deploy/lint/install/push command, or any
 * Bash result that ends with a verdict line. Reads of source files never do;
 * reads of logs and task outputs do when they end with a verdict.
 */
export function wantsTail(call: ToolCall): boolean {
  const command = bashCommand(call);
  if (!command) return false;
  const reads = sourceReadPaths(command);
  if (reads.length > 0) {
    // A source file's last lines are nothing special; a log's are where the verdict is.
    return reads.some((p) => LOG_FILE.test(p)) && VERDICT.test((call.resultText ?? '').slice(-VERDICT_WINDOW));
  }
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
 * dropped: it is truncated to a window holding all of them (a wider tail, or a
 * head stretched up to MAX_PINNED_HEAD), or kept. A decision's own `headChars`
 * is honoured; 0 (a drop turned truncation) keeps no tail unless a pin needs one.
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
    // headChars 0 is a drop in all but name (see preferTruncation): it keeps no tail either.
    const preferred = decision.headChars !== 0 && wantsTail(call) ? options.truncateTailChars : 0;
    const tokens = options.pinReferenced ? (call.refTokens ?? []) : [];
    if (tokens.length === 0) {
      if (decision.action === 'drop_result' && preferred > 0) tails.set(call.tool_use_id, preferred);
      return decision;
    }
    const text = texts.get(call.tool_use_id) ?? call.resultText ?? '';
    const head = decision.headChars ?? options.truncateHeadChars;
    const window = pinnedWindow(text, tokens, {
      head,
      preferredTail: preferred,
      maxTail: options.truncateTailChars,
      maxHead: Math.max(head, MAX_PINNED_HEAD),
    });
    if (!window) return { id: decision.id, tool: decision.tool, action: 'keep', source: 'pinned' };
    if (window.tail > 0) tails.set(call.tool_use_id, window.tail);
    const truncated: CallDecision = { ...decision, action: 'drop_result' };
    return window.head === head ? truncated : { ...truncated, headChars: window.head };
  });
  return { decisions: planned, tails };
}
