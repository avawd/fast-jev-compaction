import { describe, expect, it } from 'vitest';
import { ageRule, applyRules, type ToolCall } from '../src/index.js';

let n = 0;
function c(tool: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
  n += 1;
  return {
    id: `t${n}`, tool_use_id: `u${n}`, tool, input, callIndex: n, resultIndex: n,
    resultChars: 1000, isError: false, pinned: false, resultText: 'x'.repeat(1000), stale: true, ...extra,
  };
}

describe('ageRule', () => {
  it('truncates stale Read and Bash file-read results', () => {
    n = 0;
    const calls = [
      c('Read', { file_path: 'src/a.ts' }),
      c('Bash', { command: 'cd /r && sed -n 1,50p lib/x.ts' }),
      c('Read', { file_path: 'src/b.ts' }, { stale: false }),
      c('Bash', { command: 'cd /r; grep -rn foo lib | head; ls lib/core' }),
    ];
    const v = ageRule(calls, new Set());
    expect(v.get('t1')).toEqual({ action: 'drop_result', source: 'rule', rule: 'stale_age' });
    expect(v.get('t2')?.rule).toBe('stale_age');
    expect(v.has('t3')).toBe(false);
    expect(v.get('t4')?.rule).toBe('stale_age');
  });

  it('skips other tools, errors, pinned, decided, persisted-output wrappers and task-output reads', () => {
    n = 0;
    const calls = [
      c('Bash', { command: 'npm test' }),
      c('Grep', { pattern: 'x' }),
      c('Read', { file_path: 'a.ts' }, { isError: true }),
      c('Read', { file_path: 'a.ts' }, { pinned: true }),
      c('Read', { file_path: 'a.ts' }),
      c('Bash', { command: 'cat a.ts' }, { resultText: '<persisted-output>\nOutput too large' }),
      c('Read', { file_path: '/home/me/.claude/projects/p/s/tool-results/b1.txt' }),
      c('Read', { file_path: '/private/tmp/claude-1/p/tasks/a1.output' }),
    ];
    expect([...ageRule(calls, new Set(['t5'])).keys()]).toEqual([]);
  });

  it('runs through applyRules after the supersession rules', () => {
    n = 0;
    const calls = [
      c('Read', { file_path: 'src/a.ts' }),
      c('Read', { file_path: 'src/a.ts' }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')?.rule).toBe('stale_read');
    expect(v.get('t2')?.rule).toBe('stale_age');
  });
});
