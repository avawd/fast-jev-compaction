/**
 * Loads a worktree's plugin src/ by dynamic import and runs it in three arms.
 * Only public pure exports are used: compact, makeScorer, collectToolCalls,
 * reductionRatio. Nothing here sends a model request.
 *
 * Arms (each goes through the branch's own `compact()` and truncation):
 *  - rules: the branch's rules alone (useClaudeScorer: false). With the
 *    scorer answering "keep" for everything, this is also the CEILING for fact
 *    survival: a scorer can only remove more.
 *  - trunc: rules, then every call the rules left undecided gets drop_result
 *    (the branch's truncation shape). A scorer that truncates all it is unsure of.
 *  - floor: rules, then every undecided call gets drop_call. The FLOOR: a scorer
 *    that drops everything it is asked about.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EvalMessage } from './parse.ts';

export type Arm = 'rules' | 'trunc' | 'floor';
export const ARMS: readonly Arm[] = ['rules', 'trunc', 'floor'];

interface PluginCall {
  id: string;
  tool_use_id: string;
  tool: string;
  resultIndex: number;
  resultChars: number;
  pinned: boolean;
}
interface PluginVerdict {
  action: string;
  source: string;
  rule?: string;
}
interface PluginOutcome {
  verdicts: Map<string, PluginVerdict>;
  claude: string;
  [key: string]: unknown;
}
type PluginScorer = (calls: readonly PluginCall[], ...rest: unknown[]) => Promise<PluginOutcome>;
interface PluginDecision {
  id: string;
  action: string;
  source: string;
  rule?: string;
}
export interface PluginResult {
  messages: EvalMessage[];
  decisions: PluginDecision[];
  stats: Record<string, unknown>;
}

export interface PluginApi {
  srcDir: string;
  head: string;
  compact: (messages: readonly EvalMessage[], scorer: PluginScorer, options?: Record<string, unknown>) => Promise<PluginResult>;
  makeScorer: (options: Record<string, unknown>) => PluginScorer;
  collectToolCalls: (messages: readonly EvalMessage[], preserveRecentMessages: number) => PluginCall[];
  reductionRatio: (result: PluginResult) => number;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** `--src` may name a worktree root or its src/ directory; default is this checkout. */
export function resolveSrcDir(arg?: string): string {
  const base = resolve(arg ?? join(HERE, '..'));
  if (existsSync(join(base, 'src', 'index.ts'))) return join(base, 'src');
  if (existsSync(join(base, 'index.ts'))) return base;
  throw new Error(`--src ${base}: no src/index.ts or index.ts there`);
}

function gitHead(dir: string): string {
  try {
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' }).trim();
    return `${branch}@${sha}${dirty ? '+dirty' : ''}`;
  } catch {
    return 'unknown';
  }
}

export async function loadPlugin(srcArg?: string): Promise<PluginApi> {
  const srcDir = resolveSrcDir(srcArg);
  const mod = (await import(pathToFileURL(join(srcDir, 'index.ts')).href)) as Record<string, unknown>;
  const missing = ['compact', 'makeScorer', 'collectToolCalls', 'reductionRatio'].filter((k) => typeof mod[k] !== 'function');
  if (missing.length) {
    throw new Error(`${srcDir}/index.ts does not export ${missing.join(', ')}; update eval/plugin.ts for this branch's API`);
  }
  return {
    srcDir,
    head: gitHead(srcDir),
    compact: mod['compact'] as PluginApi['compact'],
    makeScorer: mod['makeScorer'] as PluginApi['makeScorer'],
    collectToolCalls: mod['collectToolCalls'] as PluginApi['collectToolCalls'],
    reductionRatio: mod['reductionRatio'] as PluginApi['reductionRatio'],
  };
}

export interface ArmRun {
  arm: Arm;
  result: PluginResult;
  /** Undecided unpinned calls the arm filled in (0 for `rules`). */
  filled: number;
  /** Unpinned calls still at source 'default' after a trunc/floor arm: nonzero means the Scorer contract moved. */
  unfilled: number;
}

/**
 * Runs one arm. The wrapper forwards every argument compact() hands the
 * scorer, so a branch that passes extra context (e.g. messages) still works.
 */
export async function runArm(
  api: PluginApi,
  messages: readonly EvalMessage[],
  arm: Arm,
  options: Record<string, unknown>,
): Promise<ArmRun> {
  const base = api.makeScorer({ ...options, useClaudeScorer: false, maxCandidates: options['maxCandidates'] ?? 400 });
  let filled = 0;
  const scorer: PluginScorer = async (calls, ...rest) => {
    const outcome = await base(calls, ...rest);
    if (arm === 'rules') return outcome;
    const verdicts = new Map(outcome.verdicts);
    for (const call of calls) {
      if (call.pinned || verdicts.has(call.id)) continue;
      verdicts.set(call.id, { action: arm === 'floor' ? 'drop_call' : 'drop_result', source: 'claude' });
      filled += 1;
    }
    return { ...outcome, verdicts, claude: 'ran' };
  };
  const result = await api.compact(messages, scorer, options);
  const unfilled = arm === 'rules' ? 0 : result.decisions.filter((d) => d.source === 'default').length;
  return { arm, result, filled, unfilled };
}
