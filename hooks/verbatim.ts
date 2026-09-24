import type {
  EngineInterface, On, PluginOptions, Register, SessionCompactInput, SessionMessage, ToolResultSummary, ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio } from '../src/compact.js';
import { makeScorer } from '../src/score.js';
import type { ForkFn, SleepFn } from '../src/claude-scorer.js';
import type { CompactResult, Message, ToolResult, ToolUse } from '../src/types.js';

export type HookConfig = {
  compactAtPercent: number;
  minReductionRatio: number;
  preserveRecentMessages: number;
  truncateHeadChars: number;
  maxCandidates: number;
  useClaudeScorer: boolean;
  /**
   * Past this the fork is abandoned and rules alone decide. Clamped to
   * [MIN_CLAUDE_TIMEOUT_MS, MAX_CLAUDE_TIMEOUT_MS].
   */
  claudeTimeoutMs: number;
};

/**
 * The hook's 10 s budget (HookBudget.ms) counts only its own time: it stops while any `$` call
 * is in flight. The declaration excepts a `$.clock` wait, so a live probe settled whether
 * racing `$.clock.sleep` against the fork restarts it. On 2.1.281 a turn.complete hook that
 * raced a fork against `$.clock.sleep(30000)` ran 30,007 ms of wall time, was not cut, and read
 * `next.budget.remainingMs` 9999 both before and after: the in-flight fork holds the clock.
 * So the timeout may exceed ten seconds. The ceiling stays under the 60 s a headless session
 * waits on turn events before ending the turn without them.
 */
const MIN_CLAUDE_TIMEOUT_MS = 500;
const MAX_CLAUDE_TIMEOUT_MS = 45_000;

const DEFAULTS: HookConfig = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
  maxCandidates: 400,
  useClaudeScorer: true,
  claudeTimeoutMs: 20_000,
};

function num(options: PluginOptions, key: keyof HookConfig, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveHookConfig(options: PluginOptions): HookConfig {
  const flag = options['useClaudeScorer'];
  return {
    compactAtPercent: num(options, 'compactAtPercent', DEFAULTS.compactAtPercent),
    minReductionRatio: num(options, 'minReductionRatio', DEFAULTS.minReductionRatio),
    preserveRecentMessages: num(options, 'preserveRecentMessages', DEFAULTS.preserveRecentMessages),
    truncateHeadChars: num(options, 'truncateHeadChars', DEFAULTS.truncateHeadChars),
    maxCandidates: num(options, 'maxCandidates', DEFAULTS.maxCandidates),
    useClaudeScorer: typeof flag === 'boolean' ? flag : DEFAULTS.useClaudeScorer,
    claudeTimeoutMs: clamp(
      num(options, 'claudeTimeoutMs', DEFAULTS.claudeTimeoutMs),
      MIN_CLAUDE_TIMEOUT_MS,
      MAX_CLAUDE_TIMEOUT_MS,
    ),
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return { tool_use_id: result.tool_use_id, text: result.text, isError: result.isError ?? false };
}

/** Unchanged objects stay the engine's own (handles included); rebuilt ones are fresh. */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map((r) => results.get(r) ?? toolResultSummary(r));
    }
    return rebuilt;
  });
}

export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fork?: ForkFn,
  sleep?: SleepFn,
): Promise<{ result: CompactResult; messages: SessionMessage[] }> {
  const scorer = makeScorer({
    fork,
    sleep,
    useClaudeScorer: config.useClaudeScorer,
    maxCandidates: config.maxCandidates,
    claudeTimeoutMs: config.claudeTimeoutMs,
  });
  const result = await compact(messages, scorer, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

export function summarize(result: CompactResult): string {
  const s = result.stats;
  return `${Math.round(reductionRatio(result) * 100)}% reduction; rules ${s.byRule}, claude ${s.byClaude} (${s.claude}), ` +
    `kept ${s.kept}, pinned ${s.pinned}; ${s.resultsDropped} truncated, ${s.callsDropped} dropped`;
}

type Ui = { ui: { log: (t: string) => void; toast: (t: string, o?: { timeoutMs?: number }) => void } };

/** Reports without ever throwing: a broken UI must not turn a good compaction into a failed hook. */
function notify($: Ui, text: string, toast = true): void {
  // The engine already prefixes a log line with the plugin's name (seen live on 2.1.281);
  // the toast bar carries no attribution, so only the toast gets the prefix.
  const line = `verbatim-compaction: ${text}`;
  try {
    $.ui.log(text);
  } catch {
    // Nothing else to report to.
  }
  if (!toast) return;
  try {
    $.ui.toast(line, { timeoutMs: 15_000 });
  } catch {
    // The log line above already carries it.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `/compact <instructions>` asks for a focused summary, which pruning cannot give. */
function wantsSummary(event: SessionCompactInput): boolean {
  return event.trigger === 'manual' && typeof event.instructions === 'string' && event.instructions.trim().length > 0;
}

/** `$.model.fork` forks the main session, so it has nothing to say about a subagent's transcript. */
function mayFork(event: SessionCompactInput): boolean {
  return event.agentId === undefined;
}

/** `precompute` computes and keeps nothing; the real compaction that follows runs the full pipeline. */
const PRECOMPUTE_SKIP_REASON = 'precompute skipped; the real compaction runs the full pipeline';

/** The engine's `next()` rejects empty `messages`, so an empty transcript is vetoed here. */
const EMPTY_SKIP_REASON = 'nothing to compact yet';

/**
 * `$.session.compact()` rejects in a headless (-p / SDK) session on 2.1.281, where compaction
 * only runs inside a turn (a `/compact` prompt). Resolves false on a rejection, which the caller
 * takes as final for the session: asking again every turn would only repeat the same failure.
 * Top-level because the engine follows `$` only into functions declared at the top of the file.
 */
async function requestCompaction($: EngineInterface): Promise<boolean> {
  try {
    await $.session.compact();
    return true;
  } catch (error) {
    notify($, `auto-compact off for this session: $.session.compact() was refused (${message(error)}). ` +
      'In a headless (-p / SDK) session send /compact yourself.');
    return false;
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;
  let autoCompactOff = false;

  on('session.compact', async ($, event, next) => {
    if (event.trigger === 'precompute') {
      notify($, PRECOMPUTE_SKIP_REASON, false);
      return { skip: PRECOMPUTE_SKIP_REASON };
    }
    // Bounds the fork-timeout sleep: aborts it as soon as the race is decided (win, lose, or
    // error), instead of leaving it pending until claudeTimeoutMs elapses or the dispatch ends.
    const cancelSleep = new AbortController();
    const signal = AbortSignal.any([next.signal, cancelSleep.signal]);
    try {
      if (event.messages.length === 0) {
        notify($, EMPTY_SKIP_REASON, false);
        return { skip: EMPTY_SKIP_REASON };
      }
      if (wantsSummary(event)) return next(event);
      const fork: ForkFn | undefined = mayFork(event) ? (request) => $.model.fork(request) : undefined;
      const sleep: SleepFn = (ms) => $.clock.sleep(ms, { signal });
      const { result, messages } = await compactSession(event.messages, config, fork, sleep);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify($, `fallback to built-in summary (below ${Math.round(config.minReductionRatio * 100)}%: ${summarize(result)})`);
        return next(event);
      }
      notify($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`);
      return { messages };
    } catch (error) {
      notify($, `fallback to built-in summary (${message(error)})`);
      return next(event);
    } finally {
      cancelSleep.abort();
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting || autoCompactOff || event.agentId !== undefined || event.reason !== 'answer') return next(event);
    compacting = true;
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) >= config.compactAtPercent) autoCompactOff = !(await requestCompaction($));
    } catch (error) {
      notify($, `auto-compact skipped (${message(error)})`, false);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
