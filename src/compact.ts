import { annotateCalls } from './annotate.js';
import { collectToolCalls } from './calls.js';
import { tier2Options, tier2Verdicts, wasCompacted } from './escalate.js';
import { gateRatio, resultChars } from './gate.js';
import { stripFurnitureInMessages } from './rules-mcp.js';
import { planShapes } from './shape.js';
import { truncatedResultText } from './truncate.js';
import { compactUserRows } from './user-rows.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  Message,
  ResolvedCompactOptions,
  Scorer,
  ScoreOutcome,
  ToolCall,
  Verdict,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
  truncateTailChars: 1000,
  // Rows as the engine hands them over (one per content block). Calibrated as 60 merged
  // messages; merged-to-row ratios on the review corpus are 1.49-1.76 (median 1.64): ~100 rows.
  staleAfterMessages: 100,
  pinReferenced: true,
  stripMcpFurniture: true,
  dedupeTeammates: true,
  trimStaleTeammates: true,
  dedupePeerNotice: true,
  trimStaleTasks: true,
  teammateHeadChars: 1000,
  keepRecentUserTurns: 3,
};

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
    dedupeTeammates: flag(options.dedupeTeammates, DEFAULT_OPTIONS.dedupeTeammates),
    trimStaleTeammates: flag(options.trimStaleTeammates, DEFAULT_OPTIONS.trimStaleTeammates),
    dedupePeerNotice: flag(options.dedupePeerNotice, DEFAULT_OPTIONS.dedupePeerNotice),
    trimStaleTasks: flag(options.trimStaleTasks, DEFAULT_OPTIONS.trimStaleTasks),
    teammateHeadChars: Math.max(0, Math.floor(finite(options.teammateHeadChars, DEFAULT_OPTIONS.teammateHeadChars))),
    keepRecentUserTurns: Math.max(0, Math.floor(finite(options.keepRecentUserTurns, DEFAULT_OPTIONS.keepRecentUserTurns))),
    ...(typeof options.cwd === 'string' && options.cwd.startsWith('/') ? { cwd: options.cwd } : {}),
  };
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
  const windows = new Map<string, Array<[number, number]>>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (!call || decision.action === 'keep') continue;
    actions.set(call.tool_use_id, decision.action);
    if (decision.headChars !== undefined) heads.set(call.tool_use_id, decision.headChars);
    if (decision.windows && decision.windows.length > 0) windows.set(call.tool_use_id, decision.windows);
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
        const text = truncatedResultText(
          result.text,
          result.isError ?? false,
          head,
          tails.get(result.tool_use_id),
          windows.get(result.tool_use_id),
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

/**
 * A drop_call on a call whose assistant row has no text becomes a drop_result. Claude Code
 * hands over one row per content block, so that row's thinking block is a sibling row with no
 * text of its own: removing the tool_use row would leave an assistant message holding only
 * thinking. Keeping the call costs its input alone.
 *
 * A rule's drop keeps nothing but the note: a later call superseded the result (the repeated
 * search, the retry that worked), so its head is a copy. Claude's `drop` keeps the default head
 * and no tail. It used to keep no head either, and the recall eval measured that as the largest
 * single loss: 9 of the 15 live misses Claude caused sat within the first 300 characters.
 */
function preferTruncation(decision: CallDecision, call: ToolCall, messages: readonly Message[]): CallDecision {
  if (decision.action !== 'drop_call') return decision;
  if ((messages[call.callIndex]?.text ?? '').trim().length > 0) return decision;
  if (decision.source === 'rule') return { ...decision, action: 'drop_result', headChars: 0 };
  return { ...decision, action: 'drop_result', headOnly: true };
}

/** A drop_result that would leave the result unchanged is a keep, so the stats count what happened. */
function unlessNoop(decision: CallDecision, text: string, headChars: number, tailChars = 0): CallDecision {
  if (decision.action !== 'drop_result') return decision;
  const unchanged = truncatedResultText(text, false, decision.headChars ?? headChars, tailChars, decision.windows) === text;
  return unchanged ? { ...decision, action: 'keep' } : decision;
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
  const source = resolved.stripMcpFurniture ? stripFurnitureInMessages(messages, calls) : messages;
  const outcome: ScoreOutcome = calls.some((c) => !c.pinned)
    ? await scorer(calls)
    : { verdicts: new Map(), claude: 'skipped' };
  const first = build(messages, source, calls, outcome.verdicts, resolved, outcome, started);
  const gate = options.escalateBelow;
  if (typeof gate !== 'number' || !(gateRatio(first) < gate) || !wasCompacted(messages)) return first;
  const strict = tier2Options(resolved);
  const strictCalls = annotateCalls(collectToolCalls(messages, strict.preserveRecentMessages), messages, strict);
  const second = build(messages, source, strictCalls, tier2Verdicts(strictCalls, outcome.verdicts), strict, outcome, started);
  if (!(gateRatio(second) > gateRatio(first))) return first;
  return { ...second, stats: { ...second.stats, tier: 2 } };
}

/** Decisions from verdicts, shaped (pins, tails), applied; the stats of what happened. */
function build(
  messages: readonly Message[],
  source: readonly Message[],
  calls: readonly ToolCall[],
  verdicts: ReadonlyMap<string, Verdict>,
  resolved: ResolvedCompactOptions,
  outcome: ScoreOutcome,
  started: number,
): CompactResult {
  const scored: CallDecision[] = calls.map((call) => {
    if (call.pinned) return { id: call.id, tool: call.tool, action: 'keep', source: 'pinned' };
    const verdict = verdicts.get(call.id);
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
  const users = compactUserRows(applyDecisions(source, decisions, calls, resolved.truncateHeadChars, shaped.tails), resolved);
  const kept = users.messages;
  const by = (pred: (d: CallDecision) => boolean) => decisions.filter(pred).length;
  const stats: CompactResult['stats'] = {
    messagesBefore: messages.length,
    messagesAfter: kept.length,
    charsBefore: messages.reduce((sum, m) => sum + messageChars(m), 0),
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
  if (users.stats.rows > 0) stats.userRows = users.stats;
  if (outcome.claudeMs !== undefined) stats.claudeMs = outcome.claudeMs;
  if (outcome.forks && outcome.forks.length > 0) stats.forks = outcome.forks;
  if (outcome.wait) stats.wait = outcome.wait;
  return { messages: kept, decisions, stats };
}
