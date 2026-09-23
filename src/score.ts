import { scoreWithClaude, type ForkFn } from './claude-scorer.js';
import { applyRules } from './rules.js';
import type { Scorer } from './types.js';

export interface ScorerOptions {
  fork?: ForkFn;
  useClaudeScorer: boolean;
  maxCandidates: number;
}

/** Rules first; the calls they leave undecided go to one Claude fork. Rule verdicts always win. */
export function makeScorer(options: ScorerOptions): Scorer {
  return async (calls) => {
    const verdicts = applyRules(calls);
    const undecided = calls.filter((call) => !call.pinned && !verdicts.has(call.id));
    if (!options.useClaudeScorer || !options.fork || undecided.length === 0) {
      return { verdicts, claude: 'skipped' };
    }
    const claude = await scoreWithClaude(options.fork, undecided, options.maxCandidates);
    for (const [id, verdict] of claude.verdicts) if (!verdicts.has(id)) verdicts.set(id, verdict);
    return { verdicts, claude: claude.status };
  };
}
