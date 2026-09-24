import { annotateCalls } from './annotate.js';
import { collectToolCalls } from './calls.js';
import { resultChars } from './gate.js';
import { stripFurnitureInMessages } from './rules-mcp.js';
import { planShapes } from './shape.js';
import { sliceWhole, sliceWholeEnd } from './text.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  Message,
  ResolvedCompactOptions,
  Scorer,
  ScoreOutcome,
  ToolCall,
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

/** A result this short is left whole: the note would cost about as much as it saves. */
function shrinks(resultChars: number, headChars: number, tailChars = 0): boolean {
  return resultChars > headChars + tailChars + 120;
}

function truncatedResultText(text: string, isError: boolean, headChars: number, tailChars = 0): string {
  if (!shrinks(text.length, headChars, tailChars)) return text;
  const kept = sliceWhole(text, headChars);
  const end = sliceWholeEnd(text, tailChars);
  const head = kept.length > 0 ? `${kept}\n` : '';
  const tail = end.length > 0 ? `\n${end}` : '';
  return `${head}${TRUNCATION_NOTE_PREFIX} ${text.length - kept.length - end.length} chars of this tool result${
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
  /** Tail characters to keep as well, by `tool_use_id` (see `planShapes`). */
  tails: ReadonlyMap<string, number> = new Map(),
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  const heads = new Map<string, number>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (!call || decision.action === 'keep') continue;
    actions.set(call.tool_use_id, decision.action);
    if (decision.headChars !== undefined) heads.set(call.tool_use_id, decision.headChars);
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
    // drop_result shrinks only the user row's tool_result. The assistant row's tool_use is
    // returned as the engine's own object: rebuilding it would lose its handle (and with it
    // every block the summary shape does not carry) for no saving the engine would count.
    const toolUses = message.toolUses.filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call');
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const head = heads.get(result.tool_use_id) ?? headChars;
        const text = truncatedResultText(result.text, result.isError ?? false, head, tails.get(result.tool_use_id));
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

/**
 * A drop_call on a call whose assistant row has no text becomes a drop_result that keeps
 * nothing but the note. Claude Code hands over one row per content block, so that row's
 * thinking block is a sibling row with no text of its own: removing the tool_use row would
 * leave an assistant message holding only thinking. Keeping the call costs its input alone.
 */
function preferTruncation(decision: CallDecision, call: ToolCall, messages: readonly Message[]): CallDecision {
  if (decision.action !== 'drop_call') return decision;
  if ((messages[call.callIndex]?.text ?? '').trim().length > 0) return decision;
  return { ...decision, action: 'drop_result', headChars: 0 };
}

/** A drop_result that would leave the result unchanged is a keep, so the stats count what happened. */
function unlessNoop(decision: CallDecision, text: string, headChars: number, tailChars = 0): CallDecision {
  if (decision.action !== 'drop_result') return decision;
  return shrinks(text.length, decision.headChars ?? headChars, tailChars) ? decision : { ...decision, action: 'keep' };
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
    return preferTruncation(decision, call, messages);
  });
  const texts = new Map(source.flatMap((m) => (m.toolResults ?? []).map((r) => [r.tool_use_id, r.text] as const)));
  const shaped = planShapes(scored, calls, resolved, texts);
  const byId = new Map(calls.map((call) => [call.id, call]));
  const decisions = shaped.decisions.map((decision) => {
    const call = byId.get(decision.id)!;
    return unlessNoop(decision, texts.get(call.tool_use_id) ?? '', resolved.truncateHeadChars, shaped.tails.get(call.tool_use_id));
  });
  const kept = applyDecisions(source, decisions, calls, resolved.truncateHeadChars, shaped.tails);
  const by = (pred: (d: CallDecision) => boolean) => decisions.filter(pred).length;
  const stats: CompactResult['stats'] = {
    messagesBefore: messages.length,
    messagesAfter: kept.length,
    charsBefore,
    resultCharsBefore: resultChars(messages),
    charsAfter: kept.reduce((sum, m) => sum + messageChars(m), 0),
    calls: calls.length,
    kept: by((d) => d.action === 'keep' && d.source !== 'pinned'),
    resultsDropped: by((d) => d.action === 'drop_result'),
    callsDropped: by((d) => d.action === 'drop_call'),
    pinned: by((d) => d.source === 'pinned'),
    byRule: by((d) => d.source === 'rule' && d.action !== 'keep'),
    byClaude: by((d) => d.source === 'claude' && d.action !== 'keep'),
    claude: outcome.claude,
    ms: Date.now() - started,
  };
  if (outcome.claudeMs !== undefined) stats.claudeMs = outcome.claudeMs;
  if (outcome.forks && outcome.forks.length > 0) stats.forks = outcome.forks;
  if (outcome.wait) stats.wait = outcome.wait;
  return { messages: kept, decisions, stats };
}
