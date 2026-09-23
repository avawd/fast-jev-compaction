import { describe, expect, it } from 'vitest';
import { makeScorer, type ForkFn, type ToolCall } from '../src/index.js';

function c(id: string, tool: string, input: Record<string, unknown>, pinned = false): ToolCall {
  return { id, tool_use_id: `u-${id}`, tool, input, callIndex: 1, resultIndex: 2, resultChars: 100, isError: false, pinned };
}

const calls = [
  c('t1', 'Read', { file_path: 'src/a.ts' }),
  c('t2', 'Bash', { command: 'ls' }),
  c('t3', 'Edit', { file_path: 'src/a.ts' }),
  c('t4', 'Bash', { command: 'pwd' }, true),
];

describe('makeScorer', () => {
  it('sends only unpinned calls the rules left undecided to Claude, and rules win', async () => {
    let prompt = '';
    const fork: ForkFn = async (req) => {
      prompt = req.prompt;
      return { text: '{"drop":["t1","t2"],"truncate":[]}' };
    };
    const out = await makeScorer({ fork, useClaudeScorer: true, maxCandidates: 400 })(calls);
    expect(prompt).toContain('t2 Bash');
    expect(prompt).not.toMatch(/^t1 /m);
    expect(prompt).not.toMatch(/^t4 /m);
    expect(out.verdicts.get('t1')).toMatchObject({ source: 'rule', rule: 'stale_read' });
    expect(out.verdicts.get('t2')).toMatchObject({ source: 'claude', action: 'drop_call' });
    expect(out.claude).toBe('ran');
  });

  it('is rules-only when disabled or when no fork is available', async () => {
    let called = false;
    const fork: ForkFn = async () => { called = true; return null; };
    const off = await makeScorer({ fork, useClaudeScorer: false, maxCandidates: 400 })(calls);
    const none = await makeScorer({ useClaudeScorer: true, maxCandidates: 400 })(calls);
    expect(called).toBe(false);
    expect(off.claude).toBe('skipped');
    expect(none.claude).toBe('skipped');
    expect(off.verdicts.size).toBe(1);
  });

  it('keeps rule verdicts when the Claude stage fails', async () => {
    const out = await makeScorer({ fork: async () => null, useClaudeScorer: true, maxCandidates: 400 })(calls);
    expect(out.claude).toBe('null');
    expect(out.verdicts.get('t1')?.rule).toBe('stale_read');
  });

  it('keeps rule verdicts when the Claude stage times out', async () => {
    const out = await makeScorer({
      fork: () => new Promise(() => {}),
      useClaudeScorer: true,
      maxCandidates: 400,
      claudeTimeoutMs: 6000,
      sleep: async () => {},
    })(calls);
    expect(out.claude).toBe('timeout');
    expect(out.verdicts.size).toBe(1);
    expect(out.verdicts.get('t1')?.rule).toBe('stale_read');
  });
});
