import type {
  On, PluginOptions, Register, SessionMessage, ToolResultSummary, ToolUseSummary, TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio } from '../src/compact.js';
import { makeScorer } from '../src/score.js';
import type { ForkFn } from '../src/claude-scorer.js';
import type { CompactResult, Message, ToolResult, ToolUse } from '../src/types.js';

export type HookConfig = {
  compactAtPercent: number;
  minReductionRatio: number;
  preserveRecentMessages: number;
  truncateHeadChars: number;
  maxCandidates: number;
  useClaudeScorer: boolean;
};

const DEFAULTS: HookConfig = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
  maxCandidates: 400,
  useClaudeScorer: true,
};

function num(options: PluginOptions, key: keyof HookConfig, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
): Promise<{ result: CompactResult; messages: SessionMessage[] }> {
  const scorer = makeScorer({ fork, useClaudeScorer: config.useClaudeScorer, maxCandidates: config.maxCandidates });
  const result = await compact(messages, scorer, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

export function summarize(result: CompactResult): string {
  const s = result.stats;
  return `${Math.round(reductionRatio(result) * 100)}% reduction; rules ${s.byRule}, claude ${s.byClaude} (${s.claude}), ` +
    `kept ${s.kept}, pinned ${s.pinned}; ${s.resultsDropped} truncated, ${s.callsDropped} dropped`;
}

function notify($: { ui: { log: (t: string) => void; toast: (t: string, o?: { timeoutMs?: number }) => void } }, text: string): void {
  $.ui.log(`verbatim-compaction: ${text}`);
  $.ui.toast(`verbatim-compaction: ${text}`, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const fork: ForkFn = (request) => $.model.fork(request);
      const { result, messages } = await compactSession(event.messages, config, fork);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify($, `fallback to built-in summary (below ${Math.round(config.minReductionRatio * 100)}%: ${summarize(result)})`);
        return next(event);
      }
      notify($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`);
      return { messages };
    } catch (error) {
      notify($, `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(`verbatim-compaction: auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
