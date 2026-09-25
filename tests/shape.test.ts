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

  it('keeps a tail for a read of a log or task output that ends with a verdict', () => {
    const log = `${'x'.repeat(3000)}\n      Tests  312 passed (312)\n`;
    expect(wantsTail(bash('tail -30 /tmp/p/tasks/b1.output 2>/dev/null || echo "still running"', log))).toBe(true);
    expect(wantsTail(bash('cat build.log', log))).toBe(true);
    expect(wantsTail(bash('cat src/a.test.ts', log))).toBe(false);
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

  it('widens to head+tail, or excerpts a window, so every pinned token survives', () => {
    const text = `${'h'.repeat(2000)}PINNEDTOKEN${'t'.repeat(500)}`;
    const widened = planShapes([decision('drop_result')], [bash('./run.sh', text, { refTokens: ['PINNEDTOKEN'] })], options);
    expect(widened.tails.get('u1')).toBe(1000);
    const mid = `${'h'.repeat(9000)}PINNEDTOKEN${'t'.repeat(5000)}`;
    const excerpted = planShapes([decision('drop_result')], [bash('./run.sh', mid, { refTokens: ['PINNEDTOKEN'] })], options);
    expect(excerpted.decisions).toEqual([{ ...decision('drop_result'), windows: [[8800, 9211]] }]);
    expect(excerpted.tails.has('u1')).toBe(false);
  });

  it('keeps verbatim when the excerpt windows would keep more than the cap', () => {
    const tokens = Array.from({ length: 30 }, (_, k) => `PINNED_${String(k).padStart(8, '0')}`);
    // Mid-line tokens: every window is a full radius either side, 30 of them far past the cap.
    const text = tokens.map((t) => `${'x'.repeat(1000)} ${t} `).join('') + 'x'.repeat(1000);
    const kept = planShapes([decision('drop_result')], [bash('./run.sh', text, { refTokens: tokens })], options);
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

describe('planShapes with a per-call head', () => {
  const options = resolveOptions({});
  it('keeps no tail on a drop that was turned into an empty truncation (headChars 0)', () => {
    const d: CallDecision = { id: 't1', tool: 'Bash', action: 'drop_result', source: 'claude', headChars: 0 };
    const out = planShapes([d], [bash('npm test')], options);
    expect(out.tails.has('u1')).toBe(false);
    expect(out.decisions[0]).toEqual(d);
  });

  it('extends the head of a pinned result to its token instead of keeping it whole', () => {
    const text = `${'h'.repeat(2000)}\nPINNEDTOKEN\n${'t'.repeat(5000)}`;
    const d: CallDecision = { id: 't1', tool: 'Bash', action: 'drop_call', source: 'claude' };
    const out = planShapes([d], [bash('./run.sh', text, { refTokens: ['PINNEDTOKEN'] })], options);
    expect(out.decisions[0]).toMatchObject({ action: 'drop_result', headChars: 2012 });
    expect(out.tails.has('u1')).toBe(false);
  });

  it('starts from headChars 0 for a pinned empty truncation and still reaches the token', () => {
    const text = `${'h'.repeat(5000)}PINNEDTOKEN${'t'.repeat(100)}`;
    const d: CallDecision = { id: 't1', tool: 'Bash', action: 'drop_result', source: 'claude', headChars: 0 };
    const out = planShapes([d], [bash('./run.sh', text, { refTokens: ['PINNEDTOKEN'] })], options);
    expect(out.decisions[0]).toMatchObject({ action: 'drop_result', headChars: 0 });
    expect(out.tails.get('u1')).toBe(1000);
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
    // On the original the token is out of reach: an excerpt window. On the rewritten text the head holds it.
    expect(planShapes([d], [call], resolveOptions({})).decisions[0]!.windows).toEqual([[4800, 5211]]);
    expect(planShapes([d], [call], resolveOptions({}), new Map([['u1', rewritten]])).decisions[0]).toEqual({ ...d, action: 'drop_result' });
  });
});
