import type {
  EngineInterface, On, PluginOptions, Register, SessionCompactInput, SessionMessage, ToolResultSummary, ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio } from '../src/compact.js';
import { gateRatio } from '../src/gate.js';
import { makeScorer, rulesGate } from '../src/score.js';
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
  /** Tail kept, beside the head, when truncating a test/build/deploy-like result. */
  truncateTailChars: number;
  /** Read and Bash file-read results older than this many messages are truncated. */
  staleAfterMessages: number;
  /** Never drop a result whose introduced tokens are quoted later. */
  pinReferenced: boolean;
  /** Strip JSON furniture from MCP results. */
  stripMcpFurniture: boolean;
  /** Maps the fork's `unsure` list: < 0.5 keep, up to 0.75 truncate, above drop. Clamped to [0, 1]. */
  keepThreshold: number;
  /** Most calls per fork; more candidates run as concurrent forks. Whole number in [1, 400]. */
  forkChunkSize: number;
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
/**
 * How long the forks may take when the rules alone cannot clear the gate (a timeout then means
 * the built-in summary) and on `precompute` (nobody waits): the ceiling, under the 60 s a
 * headless turn waits. The shorter `claudeTimeoutMs` applies only when rules alone clear it.
 */
const CLAUDE_AWAIT_MS = MAX_CLAUDE_TIMEOUT_MS;
const MAX_FORK_CHUNK_SIZE = 400;

const DEFAULTS: HookConfig = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
  maxCandidates: 400,
  useClaudeScorer: true,
  claudeTimeoutMs: 30_000,
  truncateTailChars: 1000,
  // Rows as the engine hands them over (one per content block). Calibrated as 60 merged
  // messages; merged-to-row ratios on the review corpus are 1.49-1.76 (median 1.64): ~100 rows.
  staleAfterMessages: 100,
  pinReferenced: true,
  stripMcpFurniture: true,
  keepThreshold: 0.5,
  forkChunkSize: 60,
};

function num(options: PluginOptions, key: keyof HookConfig, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bool(options: PluginOptions, key: keyof HookConfig, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function resolveHookConfig(options: PluginOptions): HookConfig {
  const flag = options['useClaudeScorer'];
  return {
    // Below 1% every turn would compact; a gate at or under 0 would bill a fork for a transcript it hands
    // back unchanged, and one at 1 or more could never be met.
    compactAtPercent: clamp(num(options, 'compactAtPercent', DEFAULTS.compactAtPercent), 1, 100),
    minReductionRatio: clamp(num(options, 'minReductionRatio', DEFAULTS.minReductionRatio), 0.01, 0.95),
    preserveRecentMessages: num(options, 'preserveRecentMessages', DEFAULTS.preserveRecentMessages),
    truncateHeadChars: num(options, 'truncateHeadChars', DEFAULTS.truncateHeadChars),
    maxCandidates: num(options, 'maxCandidates', DEFAULTS.maxCandidates),
    useClaudeScorer: typeof flag === 'boolean' ? flag : DEFAULTS.useClaudeScorer,
    claudeTimeoutMs: clamp(
      num(options, 'claudeTimeoutMs', DEFAULTS.claudeTimeoutMs),
      MIN_CLAUDE_TIMEOUT_MS,
      MAX_CLAUDE_TIMEOUT_MS,
    ),
    truncateTailChars: num(options, 'truncateTailChars', DEFAULTS.truncateTailChars),
    staleAfterMessages: num(options, 'staleAfterMessages', DEFAULTS.staleAfterMessages),
    pinReferenced: bool(options, 'pinReferenced', DEFAULTS.pinReferenced),
    stripMcpFurniture: bool(options, 'stripMcpFurniture', DEFAULTS.stripMcpFurniture),
    keepThreshold: clamp(num(options, 'keepThreshold', DEFAULTS.keepThreshold), 0, 1),
    forkChunkSize: clamp(Math.floor(num(options, 'forkChunkSize', DEFAULTS.forkChunkSize)), 1, MAX_FORK_CHUNK_SIZE),
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
  /** Nobody waits on the result (`precompute`): always give the forks the ceiling. */
  background = false,
  /** The session's working directory, so the rules resolve relative Bash paths. */
  cwd?: string,
): Promise<{ result: CompactResult; messages: SessionMessage[] }> {
  const scorer = makeScorer({
    fork,
    sleep,
    useClaudeScorer: config.useClaudeScorer,
    maxCandidates: config.maxCandidates,
    keepThreshold: config.keepThreshold,
    chunkSize: config.forkChunkSize,
    messageCount: messages.length,
    claudeTimeoutMs: config.claudeTimeoutMs,
    claudeAwaitMs: Math.max(config.claudeTimeoutMs, CLAUDE_AWAIT_MS),
    rulesClearGate: background
      ? () => false
      : rulesGate(messages, config.truncateHeadChars, config.minReductionRatio),
  });
  const result = await compact(messages, scorer, cwd ? { ...config, cwd } : config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

/** `ran 5.2s`, `timeout 20.0s`, or the bare status when the Claude stage never started. */
function claudeStage(stats: CompactResult['stats']): string {
  return stats.claudeMs === undefined ? stats.claude : `${stats.claude} ${(stats.claudeMs / 1000).toFixed(1)}s`;
}

export function summarize(result: CompactResult): string {
  const s = result.stats;
  return `${Math.round(gateRatio(result) * 100)}% of tool output (${Math.round(reductionRatio(result) * 100)}% of transcript); rules ${s.byRule}, claude ${s.byClaude} (${claudeStage(s)}), ` +
    `untouched ${s.kept}, pinned ${s.pinned}; ${s.resultsDropped} truncated${s.callsDropped > 0 ? `, ${s.callsDropped} dropped` : ''}`;
}

/** Per-fork timings, for the debug log: which wait applied, each fork's size, time and outcome. */
export function describeForks(result: CompactResult): string | undefined {
  const s = result.stats;
  if (!s.forks || s.forks.length === 0) return undefined;
  const runs = s.forks.map((f) => `${f.retry ? `retry-${f.retry} ` : ''}${f.candidates} calls ${f.ms}ms ${f.status}`).join(', ');
  const plural = s.forks.length === 1 ? 'fork' : 'forks';
  return `scorer: wait ${s.wait ?? 'race'}; ${s.forks.length} ${plural} [${runs}]; claude ${s.claudeMs ?? 0}ms; total ${s.ms}ms`;
}

type Ui = {
  ui: { log: (t: string, o?: { to?: 'transcript' | 'debug' }) => void; toast: (t: string, o?: { timeoutMs?: number }) => void };
};

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

/** The debug log only: detail for whoever investigates, never a transcript line. Returns true. */
function debug($: Ui, text: string): true {
  try {
    $.ui.log(text, { to: 'debug' });
  } catch {
    // Diagnostics must never fail the hook.
  }
  return true;
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

/** The engine's `next()` rejects empty `messages`, so an empty transcript is vetoed here. */
const EMPTY_SKIP_REASON = 'nothing to compact yet';

/**
 * `$.session.compact()` rejects in a headless (-p / SDK) session on 2.1.281, where compaction
 * only runs inside a turn (a `/compact` prompt). Resolves false on a rejection, which the caller
 * takes as final for the session: asking again every turn would only repeat the same failure.
 * Top-level because the engine follows `$` only into functions declared at the top of the file.
 */
/**
 * `compacted` when the engine ran the compaction, `retry` when it refused for now (a turn is running),
 * `off` when it refused for good (a headless session).
 */
async function requestCompaction($: EngineInterface): Promise<'compacted' | 'retry' | 'off'> {
  try {
    await $.session.compact();
    return 'compacted';
  } catch (error) {
    const text = message(error);
    // Only the headless refusal is final: 2.1.281 also rejects while a turn runs, which the
    // next turn can get past.
    if (!HEADLESS_REFUSAL.test(text)) {
      notify($, `auto-compact not requested this turn (${text}); will try again next turn`, false);
      return 'retry';
    }
    notify($, `auto-compact off for this session: $.session.compact() was refused (${text}). ` +
      'In a headless (-p / SDK) session send /compact yourself.');
    return 'off';
  }
}

/** The text 2.1.281's `$.session.compact()` rejects with in a -p / SDK session. */
const HEADLESS_REFUSAL = /not available in a headless/;

/**
 * Transcripts this long go straight to the built-in compaction: the engine may cap what a hook
 * can hand back, and nothing here has been measured at that size.
 */
const MAX_MESSAGES = 4096;

/**
 * `$.session.cwd()`, or undefined when the engine lacks it or refuses: the rules then fall
 * back to suffix-matching relative paths. Top-level on purpose: the engine validates `$`
 * use only in top-level functions of this module.
 */
export async function sessionCwd($: { session: { cwd: () => Promise<string> } }): Promise<string | undefined> {
  try {
    const cwd = await $.session.cwd();
    return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : undefined;
  } catch {
    return undefined;
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;
  let autoCompactOff = false;
  // Set once this plugin's own request compacted; cleared when usage reads under the threshold again.
  // Without it a prune that leaves context above the threshold is followed by another compaction on
  // the very next turn, which has little left to prune and falls back to a full built-in summary.
  let awaitingDrop = false;
  // register() has no `$`, so the effective config is logged by the first hook that runs.
  let configLogged = false;

  on('session.compact', async ($, event, next) => {
    if (!configLogged) configLogged = debug($, `config ${JSON.stringify(config)}`);
    // Bounds the fork-timeout sleep: aborts it as soon as the race is decided (win, lose, or
    // error), instead of leaving it pending until claudeTimeoutMs elapses or the dispatch ends.
    const cancelSleep = new AbortController();
    // Once next() has been called the compaction is core's: a throw from it is rethrown, never
    // answered with a second next().
    let handedOff = false;
    const handOff = () => {
      handedOff = true;
      return next(event);
    };
    try {
      const signal = next.signal ? AbortSignal.any([next.signal, cancelSleep.signal]) : cancelSleep.signal;
      if (event.messages.length === 0) {
        notify($, EMPTY_SKIP_REASON, false);
        return { skip: EMPTY_SKIP_REASON };
      }
      if (event.messages.length >= MAX_MESSAGES) {
        notify($, `${event.messages.length} messages: handed to the built-in compaction untouched`, false);
        return handOff();
      }
      if (wantsSummary(event)) return handOff();
      // A precompute runs in the background ahead of the threshold; what it returns is kept and
      // installed by the compaction that comes, so it runs the real pipeline, gives the forks the
      // ceiling, and reports in the log only (nobody is looking at a toast for it).
      const background = event.trigger === 'precompute';
      const prefix = background ? 'precompute: ' : '';
      const fork: ForkFn | undefined = mayFork(event) ? (request) => $.model.fork(request) : undefined;
      const sleep: SleepFn = (ms) => $.clock.sleep(ms, { signal });
      const { result, messages } = await compactSession(event.messages, config, fork, sleep, background, await sessionCwd($));
      const forks = describeForks(result);
      if (forks) debug($, forks);
      if (gateRatio(result) < config.minReductionRatio) {
        notify($, `${prefix}fallback to built-in summary (below ${Math.round(config.minReductionRatio * 100)}%: ${summarize(result)})`, !background);
        return handOff();
      }
      notify($, `${prefix}kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`, !background);
      return { messages };
    } catch (error) {
      if (handedOff) throw error;
      notify($, `fallback to built-in summary (${message(error)})`, event.trigger !== 'precompute');
      return handOff();
    } finally {
      cancelSleep.abort();
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (!configLogged) configLogged = debug($, `config ${JSON.stringify(config)}`);
    if (compacting || autoCompactOff || event.agentId !== undefined || event.reason !== 'answer') return next(event);
    compacting = true;
    try {
      const { context } = await $.session.usage();
      const percent = context.percent ?? 0;
      debug($, `context ${percent}% (compacts at ${config.compactAtPercent}%)`);
      if (percent < config.compactAtPercent) awaitingDrop = false;
      else if (awaitingDrop) debug($, `waiting for context to drop under ${config.compactAtPercent}% before compacting again`);
      else {
        const outcome = await requestCompaction($);
        autoCompactOff = outcome === 'off';
        awaitingDrop = outcome === 'compacted';
      }
    } catch (error) {
      notify($, `auto-compact skipped (${message(error)})`, false);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
