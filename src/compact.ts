import { annotateCalls } from './annotate.js';
import { collectToolCalls } from './calls.js';
import { stripFurnitureInMessages } from './rules-mcp.js';
import { planShapes } from './shape.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  Message,
  ResolvedCompactOptions,
  Scorer,
  ScoreOutcome,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
  truncateTailChars: 1000,
  staleAfterMessages: 60,
  pinReferenced: true,
  stripMcpFurniture: true,
};

export const TRUNCATION_NOTE_PREFIX = '[verbatim-compaction truncated';

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function flag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    truncateTailChars: Math.max(
      0,
      Math.floor(finite(options.truncateTailChars, DEFAULT_OPTIONS.truncateTailChars)),
    ),
    staleAfterMessages: Math.max(
      0,
      Math.floor(finite(options.staleAfterMessages, DEFAULT_OPTIONS.staleAfterMessages)),
    ),
    pinReferenced: flag(options.pinReferenced, DEFAULT_OPTIONS.pinReferenced),
    stripMcpFurniture: flag(options.stripMcpFurniture, DEFAULT_OPTIONS.stripMcpFurniture),
  };
}

function truncatedResultText(text: string, isError: boolean, headChars: number, tailChars = 0): string {
  if (text.length <= headChars + tailChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  const tail = tailChars > 0 ? `\n${text.slice(text.length - tailChars)}` : '';
  return `${head}${TRUNCATION_NOTE_PREFIX} ${text.length - headChars - tailChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]${tail}`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  tails: ReadonlyMap<string, number> = new Map(),
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
          tails.get(tool.tool_use_id),
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(
          result.text,
          result.isError ?? false,
          headChars,
          tails.get(result.tool_use_id),
        );
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

/**
 * Compacts a transcript: every paired call goes to `scorer`, and its verdicts
 * drop or truncate unpinned calls. Verdicts naming pinned or unknown calls are
 * ignored. Throws only if the scorer throws; the caller decides the fallback.
 */
export async function compact(
  messages: readonly Message[],
  scorer: Scorer,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = annotateCalls(collectToolCalls(messages, resolved.preserveRecentMessages), messages, resolved);
  const charsBefore = messages.reduce((sum, m) => sum + messageChars(m), 0);
  const source = resolved.stripMcpFurniture ? stripFurnitureInMessages(messages, calls) : messages;
  const outcome: ScoreOutcome = calls.some((c) => !c.pinned)
    ? await scorer(calls)
    : { verdicts: new Map(), claude: 'skipped' };

  const scored: CallDecision[] = calls.map((call) => {
    if (call.pinned) return { id: call.id, tool: call.tool, action: 'keep', source: 'pinned' };
    const verdict = outcome.verdicts.get(call.id);
    if (!verdict) return { id: call.id, tool: call.tool, action: 'keep', source: 'default' };
    const decision: CallDecision = {
      id: call.id,
      tool: call.tool,
      action: verdict.action,
      source: verdict.source,
    };
    if (verdict.rule) decision.rule = verdict.rule;
    return decision;
  });
  const texts = new Map(source.flatMap((m) => (m.toolResults ?? []).map((r) => [r.tool_use_id, r.text] as const)));
  const { decisions, tails } = planShapes(scored, calls, resolved, texts);
  const kept = applyDecisions(source, decisions, calls, resolved.truncateHeadChars, tails);
  const by = (pred: (d: CallDecision) => boolean) => decisions.filter(pred).length;
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, m) => sum + messageChars(m), 0),
      calls: calls.length,
      kept: by((d) => d.action === 'keep' && d.source !== 'pinned'),
      resultsDropped: by((d) => d.action === 'drop_result'),
      callsDropped: by((d) => d.action === 'drop_call'),
      pinned: by((d) => d.source === 'pinned'),
      byRule: by((d) => d.source === 'rule'),
      byClaude: by((d) => d.source === 'claude'),
      claude: outcome.claude,
      ms: Date.now() - started,
    },
  };
}
