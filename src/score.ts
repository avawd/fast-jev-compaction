import { scoreWithClaude, type ForkFn, type ForkTimeout, type SleepFn } from './claude-scorer.js';
import { applyRules } from './rules.js';
import type { Scorer } from './types.js';

export interface ScorerOptions {
  fork?: ForkFn;
  useClaudeScorer: boolean;
  maxCandidates: number;
  /** How long the fork may take before the Claude stage gives up. Needs `sleep`. */
  claudeTimeoutMs?: number;
  /** The clock the timeout waits on. Without it the fork is not bounded. */
  sleep?: SleepFn;
}

function forkTimeout(options: ScorerOptions): ForkTimeout | undefined {
  const ms = options.claudeTimeoutMs;
  if (!options.sleep || typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return { timeoutMs: ms, sleep: options.sleep };
}

/**
 * Rules first; the calls they leave undecided go to one Claude fork. Rule verdicts always win.
 * A call cited as a rule verdict's evidence is not offered to the fork either: dropping the
 * later Read or Grep that made an earlier one redundant would lose both copies.
 */
export function makeScorer(options: ScorerOptions): Scorer {
  return async (calls) => {
    const verdicts = applyRules(calls);
    const evidence = new Set([...verdicts.values()].flatMap((v) => (v.evidence ? [v.evidence] : [])));
    const undecided = calls.filter((call) => !call.pinned && !verdicts.has(call.id) && !evidence.has(call.id));
    if (!options.useClaudeScorer || !options.fork || undecided.length === 0) {
      return { verdicts, claude: 'skipped' };
    }
    const claude = await scoreWithClaude(options.fork, undecided, options.maxCandidates, forkTimeout(options));
    for (const [id, verdict] of claude.verdicts) if (!verdicts.has(id)) verdicts.set(id, verdict);
    return { verdicts, claude: claude.status };
  };
}
