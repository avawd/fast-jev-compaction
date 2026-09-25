import { scoreWithClaude, type ForkFn, type ForkTimeout, type SleepFn } from './claude-scorer.js';
import { applyDecisions, messageChars } from './compact.js';
import { resultChars } from './gate.js';
import { DEFAULT_CHUNK_SIZE } from './jev-scorer.js';
import { applyRules } from './rules.js';
import type { CallDecision, Message, ResolvedCompactOptions, Scorer, ToolCall, Verdict } from './types.js';
import { compactUserRows, teammateChars } from './user-rows.js';

/** Whether these verdicts alone would clear the reduction gate. */
export type GateFn = (calls: readonly ToolCall[], verdicts: ReadonlyMap<string, Verdict>) => boolean;

export interface ScorerOptions {
  fork?: ForkFn;
  useClaudeScorer: boolean;
  maxCandidates: number;
  /** Maps the fork's `unsure` list (jev-scorer.ts `unsureAction`). Default 0.5. */
  keepThreshold?: number;
  /** Most calls per fork. Default 60. */
  chunkSize?: number;
  /**
   * Results shorter than this are kept whole without asking: dropping one saves too little to be
   * worth the fork time its id costs. Default 0 (ask about every call).
   */
  minCandidateChars?: number;
  /** Messages in the transcript, for each candidate's `msg i/N`. */
  messageCount?: number;
  /** How long the forks may take when the rules alone already clear the gate. Needs `sleep`. */
  claudeTimeoutMs?: number;
  /** How long the forks may take when they are needed to clear the gate. Default `claudeTimeoutMs`. */
  claudeAwaitMs?: number;
  /** The clock the timeout waits on. Without it the forks are not bounded. */
  sleep?: SleepFn;
  /** Decides race (short timeout) or await (long ceiling). Without it the short timeout always applies. */
  rulesClearGate?: GateFn;
}

function forkTimeout(ms: number | undefined, sleep: SleepFn | undefined): ForkTimeout | undefined {
  if (!sleep || typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return { timeoutMs: ms, sleep };
}

/**
 * The gate as the hook applies it (gate.ts `gateRatio`: characters saved over the tool-result
 * and teammate-message characters before), projected for a set of verdicts. It skips what compact() does after scoring
 * (drop_call→drop_result(0), head+tail shapes, the referenced-later pin, MCP furniture stripping),
 * so it is an estimate: the pin can only lower the real saving, shapes and stripping move it by a
 * tail's worth per call. If gateRatio's measure changes, change this with it.
 */
export function rulesGate(
  messages: readonly Message[],
  headChars: number,
  minRatio: number,
  /** The compact options, so the teammate-row pass counts as it will (user-rows.ts); absent: tool output only. */
  options?: ResolvedCompactOptions,
): GateFn {
  return (calls, verdicts) => {
    const decisions: CallDecision[] = [];
    for (const call of calls) {
      const verdict = verdicts.get(call.id);
      if (!call.pinned && verdict) {
        decisions.push({ id: call.id, tool: call.tool, action: verdict.action, source: verdict.source });
      }
    }
    const denominator = resultChars(messages) + (options ? teammateChars(messages) : 0);
    if (denominator === 0 || (decisions.length === 0 && !options)) return false;
    const before = messages.reduce((sum, m) => sum + messageChars(m), 0);
    const pruned = applyDecisions(messages, decisions, calls, headChars);
    const after = (options ? compactUserRows(pruned, options).messages : pruned).reduce((sum, m) => sum + messageChars(m), 0);
    return Math.min(1, (before - after) / denominator) >= minRatio;
  };
}

/**
 * Rules first; the calls they leave undecided go to Jev-style Claude forks. Rule verdicts always
 * win. A call cited as a rule verdict's evidence is not offered to the forks either: dropping the
 * later Read or Grep that made an earlier one redundant would lose both copies.
 *
 * The forks race the short `claudeTimeoutMs` only when the rules alone already clear the gate (a
 * slow fork then costs only its extra pruning); otherwise they are the only way to clear it, so
 * they get the long `claudeAwaitMs`.
 */
export function makeScorer(options: ScorerOptions): Scorer {
  return async (calls) => {
    const verdicts = applyRules(calls);
    const evidence = new Set([...verdicts.values()].flatMap((v) => [...(v.evidence ? [v.evidence] : []), ...(v.moreEvidence ?? [])]));
    const minChars = options.minCandidateChars ?? 0;
    const undecided = calls.filter(
      (call) => !call.pinned && !verdicts.has(call.id) && !evidence.has(call.id) && call.resultChars >= minChars,
    );
    if (!options.useClaudeScorer || !options.fork || undecided.length === 0) {
      return { verdicts, claude: 'skipped' };
    }
    const race = !options.rulesClearGate || options.rulesClearGate(calls, verdicts);
    const ms = race ? options.claudeTimeoutMs : (options.claudeAwaitMs ?? options.claudeTimeoutMs);
    const started = Date.now();
    const claude = await scoreWithClaude(options.fork, undecided, {
      maxCandidates: options.maxCandidates,
      keepThreshold: options.keepThreshold ?? 0.5,
      chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      context: { messageCount: options.messageCount ?? 0 },
      timeout: forkTimeout(ms, options.sleep),
    });
    const claudeMs = Date.now() - started;
    for (const [id, verdict] of claude.verdicts) if (!verdicts.has(id)) verdicts.set(id, verdict);
    if (claude.status === 'skipped') return { verdicts, claude: claude.status };
    return { verdicts, claude: claude.status, claudeMs, forks: claude.forks, wait: race ? 'race' : 'await' };
  };
}
