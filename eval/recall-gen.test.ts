import { describe, expect, it } from 'vitest';
import { factSets } from './facts.ts';
import type { EvalMessage } from './parse.ts';
import { ageBucket, callDescription, clozeItem, recallSets, selectRecallFacts, singleCarrier, toolCategory } from './recall-gen.ts';

const call = (id: string, tool: string, input: Record<string, unknown>): EvalMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
});
const result = (id: string, text: string): EvalMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text }],
});
const say = (text: string): EvalMessage => ({ role: 'assistant', text, toolUses: [] });

describe('toolCategory', () => {
  it('groups tools into the strata the report uses', () => {
    expect(toolCategory('Bash')).toBe('Bash');
    expect(toolCategory('Read')).toBe('Read');
    expect(toolCategory('Grep')).toBe('Grep');
    expect(toolCategory('Glob')).toBe('Grep');
    expect(toolCategory('mcp__claude_ai_Atlassian__getJiraIssue')).toBe('MCP');
    expect(toolCategory('Agent')).toBe('Agent');
    expect(toolCategory('Task')).toBe('Agent');
    expect(toolCategory('WebFetch')).toBe('Other');
  });
});

describe('ageBucket', () => {
  it('splits a segment into position quartiles', () => {
    expect(ageBucket(0, 100)).toBe('oldest');
    expect(ageBucket(30, 100)).toBe('old');
    expect(ageBucket(60, 100)).toBe('recent');
    expect(ageBucket(99, 100)).toBe('newest');
  });
});

describe('factSets echoed', () => {
  it('lists tokens a result introduced that later assistant text repeats', () => {
    const messages: EvalMessage[] = [
      { role: 'user', text: 'go', toolUses: [] },
      call('u1', 'Bash', { command: 'git log' }),
      result('u1', 'commit abc1234f quiet\ncommit 9999888 echoed'),
      say('I see 9999888.'),
    ];
    const f = factSets(messages, [{ tool_use_id: 'u1', tool: 'Bash', resultIndex: 2 }]);
    expect(f.echoed.map((x) => x.token)).toEqual(['9999888']);
    expect(f.neverEchoed.map((x) => x.token)).toEqual(['abc1234f']);
  });
});

describe('singleCarrier', () => {
  it('is false when another result or any text also holds the token', () => {
    const messages: EvalMessage[] = [
      call('u1', 'Bash', { command: 'a' }),
      result('u1', 'id 55501234'),
      call('u2', 'Bash', { command: 'b' }),
      result('u2', 'again 55501234 and 66601234'),
    ];
    expect(singleCarrier('55501234', 'u1', messages)).toBe(false);
    expect(singleCarrier('66601234', 'u2', messages)).toBe(true);
  });
});

describe('callDescription', () => {
  it('shows a Bash command with secrets elided, capped', () => {
    const d = callDescription({ tool_use_id: 'x', tool: 'Bash', input: { command: 'TOKEN=abc123 curl -H "Authorization: Bearer zzz" https://h/x' } });
    expect(d).not.toContain('abc123');
    expect(d).not.toContain('zzz');
    expect(d.length).toBeLessThanOrEqual(100);
  });
  it('shows a Read path and an MCP tool by its short name', () => {
    expect(callDescription({ tool_use_id: 'x', tool: 'Read', input: { file_path: 'lib/a.ts' } })).toBe('Read lib/a.ts');
    expect(callDescription({ tool_use_id: 'x', tool: 'mcp__srv__getIssue', input: { key: 'K' } })).toMatch(/^getIssue /);
  });
});

describe('clozeItem', () => {
  it('blanks the token in its own line and masks other answers', () => {
    const text = 'header\n/wt/one  818d0ee1 [branch-a]  other 7654321\nfooter';
    const item = clozeItem({ token: '818d0ee1', kind: 'sha' }, text, 'Bash git worktree list', ['7654321']);
    expect(item).toBeDefined();
    expect(item).toContain('___');
    expect(item).not.toContain('818d0ee1');
    expect(item).not.toContain('7654321');
    expect(item).toContain('git worktree list');
  });
  it('gives up when the line holds no context around the token', () => {
    expect(clozeItem({ token: '818d0ee1', kind: 'sha' }, 'x\n818d0ee1\ny', 'Bash git log', [])).toBeUndefined();
  });
});

describe('askable filters', () => {
  const at = (text: string, tool = 'Bash') => {
    const messages: EvalMessage[] = [{ role: 'user', text: 'go', toolUses: [] }, call('u1', tool, { command: 'x' }), result('u1', text)];
    return selectRecallFacts(messages, [{ tool_use_id: 'u1', tool, resultIndex: 2 }], { neverEchoed: 5, echoed: 0, seed: 1 }).map((f) => f.token);
  };
  it('skips a hex run that is only the prefix of a uuid', () => {
    expect(at('request "id":"834d22b5-80ef-4fe1-ac3a-975652364551" done here')).toEqual([]);
  });
  it('skips plumbing ids (invocation, message, agent ids)', () => {
    expect(at('the agentId: aad6c7ddde4401e78 (internal ID)')).toEqual([]);
    expect(at('"msg_id":"fb1274916abc" routing stuff')).toEqual([]);
    expect(at('{ "self": "https://api.example.test/rest/issue/61469/comment/1254169", "id": 1 }', 'mcp__s__get')).toEqual([]);
  });
  it('skips a URL the assistant can re-derive from a number it quoted (a PR link after "#912")', () => {
    const messages: EvalMessage[] = [
      { role: 'user', text: 'go', toolUses: [] },
      call('u1', 'Bash', { command: 'gh pr create' }),
      result('u1', 'created: https://example.test/org/repo/pull/912 done'),
      say('Opened #912.'),
    ];
    expect(selectRecallFacts(messages, [{ tool_use_id: 'u1', tool: 'Bash', resultIndex: 2 }], { neverEchoed: 5, echoed: 5, seed: 1 })).toEqual([]);
  });
  it('strips trailing punctuation a URL match swallowed', () => {
    expect(at('the public url **`https://example.test/app` is the host')).toEqual(['https://example.test/app']);
  });
});

describe('selectRecallFacts + recallSets', () => {
  // 8 calls over 4 tools, each result introduces one quiet fact; two results are echoed later.
  const messages: EvalMessage[] = [{ role: 'user', text: 'go', toolUses: [] }];
  const tools = ['Bash', 'Read', 'Grep', 'mcp__s__get'];
  const calls: Array<{ tool_use_id: string; tool: string; resultIndex: number }> = [];
  for (let i = 0; i < 8; i += 1) {
    const tool = tools[i % 4]!;
    messages.push(call(`u${i}`, tool, tool === 'Bash' ? { command: `cmd${i}` } : { file_path: `f${i}.ts` }));
    messages.push(result(`u${i}`, `line before value ${1000000 + i} line after\nshared prose`));
    calls.push({ tool_use_id: `u${i}`, tool, resultIndex: messages.length - 1 });
  }
  messages.push(say(`noted ${1000000 + 6} and ${1000000 + 7}`));

  it('takes at most one fact per call, spreads over tools, and separates echoed controls', () => {
    const facts = selectRecallFacts(messages, calls, { neverEchoed: 4, echoed: 2, seed: 1 });
    const ne = facts.filter((f) => !f.echoed);
    const ec = facts.filter((f) => f.echoed);
    expect(ne).toHaveLength(4);
    expect(new Set(ne.map((f) => f.category)).size).toBe(4);
    expect(ec.map((f) => f.token).sort()).toEqual(['1000006', '1000007']);
    expect(new Set(facts.map((f) => f.tool_use_id)).size).toBe(facts.length);
    // deterministic for a seed
    expect(selectRecallFacts(messages, calls, { neverEchoed: 4, echoed: 2, seed: 1 })).toEqual(facts);
  });

  it('batches questions, never leaking an expected token into any question', () => {
    const facts = selectRecallFacts(messages, calls, { neverEchoed: 6, echoed: 2, seed: 2 });
    const sets = recallSets(facts, 3);
    expect(sets.map((s) => s.expected.length)).toEqual([3, 3, 2]);
    const questions = sets.map((s) => s.question).join('\n');
    for (const f of facts) expect(questions).not.toContain(f.token);
    expect(sets[0]!.facts![0]).toMatchObject({ token: sets[0]!.expected[0] });
  });
});
