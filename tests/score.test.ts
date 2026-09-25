import { describe, expect, it } from 'vitest';
import { makeScorer, rulesGate, type ForkFn, type Message, type ToolCall } from '../src/index.js';

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
      const ids = [...req.prompt.matchAll(/^(t\d+) /gm)].map((m) => m[1]);
      return { text: JSON.stringify({ result_needed: [], call_matters: [], unsure: [], drop: ids }) };
    };
    const out = await makeScorer({ fork, useClaudeScorer: true, maxCandidates: 400 })(calls);
    expect(prompt).toMatch(/^t2 Bash/m);
    expect(prompt).not.toMatch(/^t1 /m);
    expect(prompt).not.toMatch(/^t4 /m);
    expect(out.verdicts.get('t1')).toMatchObject({ source: 'rule', rule: 'stale_read' });
    expect(out.verdicts.get('t2')).toMatchObject({ source: 'claude', action: 'drop_call' });
    expect(out.claude).toBe('ran');
    expect(out.forks).toHaveLength(1);
  });

  it('passes position, threshold, chunk size and ref-later through to the forks', async () => {
    const prompts: string[] = [];
    const fork: ForkFn = async (req) => {
      prompts.push(req.prompt);
      return { text: '{"result_needed":[],"call_matters":[],"unsure":["t2","t3"]}' };
    };
    const many = [c('t2', 'Bash', { command: 'a' }), { ...c('t3', 'Bash', { command: 'b' }), refLater: 4 }];
    const out = await makeScorer({
      fork, useClaudeScorer: true, maxCandidates: 400, chunkSize: 1, keepThreshold: 0.9, messageCount: 42,
    })(many);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/^t2 Bash msg 2\/42/m);
    expect(prompts[1]).toMatch(/ref-later:4/);
    expect(out.verdicts.get('t2')?.action).toBe('drop_call'); // unsure above 0.75
  });

  it('does not ask about results under minCandidateChars: they are kept whole, and none saves anything worth a fork', async () => {
    const prompts: string[] = [];
    const fork: ForkFn = async (req) => {
      prompts.push(req.prompt);
      return { text: '{"result_needed":[],"call_matters":[],"unsure":[],"drop":["t2","t3"]}' };
    };
    const sized = [{ ...c('t2', 'Bash', { command: 'a' }), resultChars: 150 }, { ...c('t3', 'Bash', { command: 'b' }), resultChars: 400 }];
    const out = await makeScorer({ fork, useClaudeScorer: true, maxCandidates: 400, minCandidateChars: 200 })(sized);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toMatch(/^t2 /m);
    expect(prompts[0]).toMatch(/^t3 /m);
    expect(out.verdicts.has('t2')).toBe(false);
    const none = await makeScorer({ fork, useClaudeScorer: true, maxCandidates: 400, minCandidateChars: 500 })(sized);
    expect(none.claude).toBe('skipped');
    expect(prompts).toHaveLength(1);
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

describe('evidence protection', () => {
  // The fork replies as if it wanted every listed call gone.
  const greedy = (seen: string[]): ForkFn => async (req) => {
    seen.push(req.prompt);
    const ids = [...req.prompt.matchAll(/^(t\d+) /gm)].map((m) => m[1]);
    return { isAnswered: true, text: JSON.stringify({ result_needed: [], call_matters: [], unsure: [], drop: ids }) };
  };

  it('never offers the later Grep that justified dropping an identical earlier one', async () => {
    const seen: string[] = [];
    const grep = [c('t1', 'Grep', { pattern: 'foo' }), c('t2', 'Grep', { pattern: 'foo' }), c('t3', 'Bash', { command: 'ls' })];
    const out = await makeScorer({ fork: greedy(seen), useClaudeScorer: true, maxCandidates: 400 })(grep);
    expect(out.verdicts.get('t1')).toMatchObject({ rule: 'repeated_search', evidence: 't2' });
    expect(seen[0]).not.toMatch(/^t2 /m);
    expect(out.verdicts.has('t2')).toBe(false);
    expect(out.verdicts.get('t3')?.source).toBe('claude');
  });

  it('never offers any of the calls a multi-evidence Bash verdict relied on', async () => {
    const seen: string[] = [];
    const calls = [
      c('t1', 'Bash', { command: 'cat a/x.ts; cat a/y.ts' }), c('t2', 'Read', { file_path: 'a/x.ts' }),
      c('t3', 'Read', { file_path: 'a/y.ts' }), c('t4', 'Bash', { command: 'npm test' }),
    ];
    const out = await makeScorer({ fork: greedy(seen), useClaudeScorer: true, maxCandidates: 400 })(calls);
    expect(out.verdicts.get('t1')).toMatchObject({ rule: 'bash_read_superseded' });
    expect(seen[0]).not.toMatch(/^t2 /m);
    expect(seen[0]).not.toMatch(/^t3 /m);
    expect(seen[0]).toMatch(/^t4 /m);
  });

  it('never offers the later Read that made an earlier one stale', async () => {
    const seen: string[] = [];
    const read = [c('t1', 'Read', { file_path: 'src/a.ts' }), c('t2', 'Read', { file_path: 'src/a.ts' })];
    const out = await makeScorer({ fork: greedy(seen), useClaudeScorer: true, maxCandidates: 400 })(read);
    expect(out.verdicts.get('t1')).toMatchObject({ rule: 'stale_read', evidence: 't2' });
    expect(out.verdicts.has('t2')).toBe(false);
    // Nothing else was undecided, so no fork was needed at all.
    expect(seen).toHaveLength(0);
    expect(out.claude).toBe('skipped');
  });
});

const never = () => new Promise<never>(() => {});

describe('race or await', () => {
  const run = async (clears: boolean) => {
    const waited: number[] = [];
    let seen: ReadonlyMap<string, unknown> | undefined;
    const out = await makeScorer({
      fork: never, useClaudeScorer: true, maxCandidates: 400,
      claudeTimeoutMs: 6000, claudeAwaitMs: 45_000,
      sleep: async (ms) => { waited.push(ms); },
      rulesClearGate: (_calls, verdicts) => { seen = verdicts; return clears; },
    })(calls);
    return { out, waited, seen };
  };

  it('races the short timeout when rules alone already clear the gate', async () => {
    const { out, waited, seen } = await run(true);
    expect(waited).toEqual([6000]);
    expect(out.wait).toBe('race');
    expect(seen?.has('t1')).toBe(true); // judged on the rule verdicts
  });

  it('awaits the fork up to the long ceiling when rules alone do not', async () => {
    const { out, waited } = await run(false);
    expect(waited).toEqual([45_000]);
    expect(out.wait).toBe('await');
  });

  it('without a gate, keeps the short timeout', async () => {
    const waited: number[] = [];
    await makeScorer({
      fork: never, useClaudeScorer: true, maxCandidates: 400, claudeTimeoutMs: 6000, claudeAwaitMs: 45_000,
      sleep: async (ms) => { waited.push(ms); },
    })(calls);
    expect(waited).toEqual([6000]);
  });
});

describe('rulesGate', () => {
  const big = 'y'.repeat(3000);
  const messages: Message[] = [
    { role: 'user', text: 'go', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u-t1', tool: 'Read', input: { file_path: 'a' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u-t1', text: big }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u-t2', tool: 'Read', input: { file_path: 'b' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u-t2', text: big }] },
  ];
  const pair = [
    { ...c('t1', 'Read', { file_path: 'a' }), callIndex: 1, resultIndex: 2 },
    { ...c('t2', 'Read', { file_path: 'b' }), callIndex: 3, resultIndex: 4 },
  ];

  it('projects the reduction the verdicts would give and compares it with the minimum', () => {
    const gate = rulesGate(messages, 300, 0.25);
    expect(gate(pair, new Map())).toBe(false);
    expect(gate(pair, new Map([['t1', { action: 'drop_call', source: 'rule' }]]))).toBe(true);
    expect(rulesGate(messages, 300, 0.6)(pair, new Map([['t1', { action: 'drop_result', source: 'rule' }]])))
      .toBe(false);
  });

  it('ignores verdicts on pinned calls, as compaction does', () => {
    const pinned = [{ ...pair[0]!, pinned: true }, pair[1]!];
    expect(rulesGate(messages, 300, 0.25)(pinned, new Map([['t1', { action: 'drop_call', source: 'rule' }]])))
      .toBe(false);
  });
});
