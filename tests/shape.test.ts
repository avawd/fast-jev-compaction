import { describe, expect, it } from 'vitest';
import { planShapes, resolveOptions, wantsTail, type CallDecision, type ToolCall } from '../src/index.js';

function bash(command: string, resultText = 'x'.repeat(3000), extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1', tool_use_id: 'u1', tool: 'Bash', input: { command }, callIndex: 1, resultIndex: 2,
    resultChars: resultText.length, isError: false, pinned: false, resultText, ...extra,
  };
}

describe('wantsTail', () => {
  it('keeps a tail for test, build, deploy, lint, install and push commands', () => {
    for (const cmd of ['npm test', 'cd /r && npm run build', 'npx vitest run', 'wi-deploy', 'npm run check:push',
      'git push origin x', 'npm install', 'npx eslint .', 'npm run test:db', 'npx tsc --noEmit']) {
      expect(wantsTail(bash(cmd)), cmd).toBe(true);
    }
  });

  it('keeps a tail when the result ends with a verdict line', () => {
    expect(wantsTail(bash('./run.sh', `${'x'.repeat(3000)}\n Tests  57 passed (57)\n`))).toBe(true);
    expect(wantsTail(bash('./run.sh', `${'x'.repeat(3000)}\nexit code 1`))).toBe(true);
  });

  it('keeps plain head for file reads, other commands and other tools', () => {
    expect(wantsTail(bash('cat tests/a.test.ts'))).toBe(false);
    expect(wantsTail(bash('ls tests'))).toBe(false);
    expect(wantsTail(bash('./run.sh'))).toBe(false);
    expect(wantsTail({ ...bash('npm test'), tool: 'Read', input: { file_path: 'test.ts' } })).toBe(false);
  });
});

describe('planShapes', () => {
  const options = resolveOptions({});
  const decision = (action: CallDecision['action']): CallDecision => ({ id: 't1', tool: 'Bash', action, source: 'rule', rule: 'stale_age' });

  it('gives a log-like truncation the configured tail and a plain one none', () => {
    const logs = planShapes([decision('drop_result')], [bash('npm test')], options);
    expect(logs.tails.get('u1')).toBe(1000);
    const plain = planShapes([decision('drop_result')], [bash('./run.sh')], options);
    expect(plain.tails.has('u1')).toBe(false);
    expect(plain.decisions).toEqual([decision('drop_result')]);
  });

  it('widens to head+tail, or keeps verbatim, so every pinned token survives', () => {
    const text = `${'h'.repeat(2000)}PINNEDTOKEN${'t'.repeat(500)}`;
    const widened = planShapes([decision('drop_result')], [bash('./run.sh', text, { refTokens: ['PINNEDTOKEN'] })], options);
    expect(widened.tails.get('u1')).toBe(1000);
    const mid = `${'h'.repeat(2000)}PINNEDTOKEN${'t'.repeat(5000)}`;
    const kept = planShapes([decision('drop_result')], [bash('./run.sh', mid, { refTokens: ['PINNEDTOKEN'] })], options);
    expect(kept.decisions).toEqual([{ id: 't1', tool: 'Bash', action: 'keep', source: 'pinned' }]);
  });

  it('turns a drop_call on a pinned-token result into a covering truncation', () => {
    const text = `PINNEDTOKEN${'t'.repeat(5000)}`;
    const out = planShapes([decision('drop_call')], [bash('./run.sh', text, { refTokens: ['PINNEDTOKEN'] })], options);
    expect(out.decisions[0]!.action).toBe('drop_result');
    expect(out.decisions[0]!.rule).toBe('stale_age');
  });

  it('ignores pinned tokens when pinReferenced is off', () => {
    const mid = `${'h'.repeat(2000)}PINNEDTOKEN${'t'.repeat(5000)}`;
    const out = planShapes([decision('drop_call')], [bash('./run.sh', mid, { refTokens: ['PINNEDTOKEN'] })],
      resolveOptions({ pinReferenced: false }));
    expect(out.decisions).toEqual([decision('drop_call')]);
  });
});

describe('planShapes over rewritten text', () => {
  it('judges the pin window on the text that will be truncated', () => {
    const original = `${'f'.repeat(5000)}PINNEDTOKEN${'t'.repeat(5000)}`;
    const rewritten = `PINNEDTOKEN${'t'.repeat(5000)}`;
    const call: ToolCall = {
      id: 't1', tool_use_id: 'u1', tool: 'mcp__r__getThing', input: {}, callIndex: 1, resultIndex: 2,
      resultChars: original.length, isError: false, pinned: false, resultText: original, refTokens: ['PINNEDTOKEN'],
    };
    const d: CallDecision = { id: 't1', tool: call.tool, action: 'drop_result', source: 'claude' };
    expect(planShapes([d], [call], resolveOptions({})).decisions[0]!.action).toBe('keep');
    expect(planShapes([d], [call], resolveOptions({}), new Map([['u1', rewritten]])).decisions[0]!.action).toBe('drop_result');
  });
});
