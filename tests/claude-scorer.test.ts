import { describe, expect, it } from 'vitest';
import {
  buildPrompt, candidateLine, parseReply, scoreWithClaude, selectCandidates,
  type ForkFn, type ToolCall,
} from '../src/index.js';

function c(id: string, tool: string, input: Record<string, unknown>, resultChars = 100, isError = false): ToolCall {
  return { id, tool_use_id: `u-${id}`, tool, input, callIndex: 1, resultIndex: 2, resultChars, isError, pinned: false };
}

const calls = [
  c('t1', 'Read', { file_path: 'src/a.ts' }, 4213),
  c('t2', 'Bash', { command: 'x'.repeat(500) }, 20, true),
];

describe('candidate list', () => {
  it('formats one line per call with a truncated input', () => {
    expect(candidateLine(calls[0]!)).toBe('t1 Read {"file_path":"src/a.ts"} → ok 4213ch');
    const line = candidateLine(calls[1]!);
    expect(line.startsWith('t2 Bash {"command":"xxx')).toBe(true);
    expect(line.endsWith('… → error 20ch')).toBe(true);
    expect(line.length).toBeLessThan(160);
  });

  it('caps by largest results and keeps transcript order', () => {
    const many = [c('t1', 'A', {}, 5), c('t2', 'B', {}, 50), c('t3', 'C', {}, 500)];
    expect(selectCandidates(many, 2).map((x) => x.id)).toEqual(['t2', 't3']);
    expect(selectCandidates(many, 5)).toHaveLength(3);
  });

  it('builds a prompt that lists candidates and asks for JSON only', () => {
    const prompt = buildPrompt(calls);
    expect(prompt).toContain('t1 Read');
    expect(prompt).toContain('{"drop":[],"truncate":[]}');
  });
});

describe('parseReply', () => {
  const ids = new Set(['t1', 't2', 't3']);
  it('reads drop and truncate arrays', () => {
    const v = parseReply('{"drop":["t1"],"truncate":["t2"]}', ids);
    expect(v?.get('t1')).toEqual({ action: 'drop_call', source: 'claude' });
    expect(v?.get('t2')).toEqual({ action: 'drop_result', source: 'claude' });
  });
  it('tolerates prose around the JSON', () => {
    expect(parseReply('Here you go:\n{"drop":["t1"],"truncate":[]}\nThanks', ids)?.size).toBe(1);
  });
  it('ignores unknown ids and resolves conflicts to truncate', () => {
    const v = parseReply('{"drop":["t1","t9"],"truncate":["t1"]}', ids);
    expect(v?.size).toBe(1);
    expect(v?.get('t1')?.action).toBe('drop_result');
  });
  it('rejects malformed replies', () => {
    expect(parseReply('no json here', ids)).toBeUndefined();
    expect(parseReply('{"drop":"t1","truncate":[]}', ids)).toBeUndefined();
    expect(parseReply('{"drop":[1],"truncate":[]}', ids)).toBeUndefined();
  });
});

describe('scoreWithClaude', () => {
  it('returns verdicts when the fork answers', async () => {
    const fork: ForkFn = async () => ({ text: '{"drop":["t2"],"truncate":["t1"]}' });
    const out = await scoreWithClaude(fork, calls, 400);
    expect(out.status).toBe('ran');
    expect(out.verdicts.size).toBe(2);
  });
  it('reports null, unparseable and error without throwing', async () => {
    expect((await scoreWithClaude(async () => null, calls, 400)).status).toBe('null');
    expect((await scoreWithClaude(async () => ({ text: 'nope' }), calls, 400)).status).toBe('unparseable');
    const boom: ForkFn = async () => { throw new Error('api down'); };
    const out = await scoreWithClaude(boom, calls, 400);
    expect(out.status).toBe('error');
    expect(out.verdicts.size).toBe(0);
  });
  it('reads the 2.1.281 answered shape', async () => {
    const fork: ForkFn = async () => ({ isAnswered: true, text: '{"drop":["t2"],"truncate":[]}', usage: {} });
    const out = await scoreWithClaude(fork, calls, 400);
    expect(out.status).toBe('ran');
    expect(out.verdicts.get('t2')?.action).toBe('drop_call');
  });
  it.each([
    [{ isAnswered: false, reason: 'nothing-to-fork' }, 'no-fork'],
    [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' }, 'api-error 529'],
    [{ isAnswered: false, reason: 'api-error', status: null, error: 'unknown' }, 'api-error'],
    [{ isAnswered: false, reason: 'aborted' }, 'aborted'],
    [{ isAnswered: false, reason: 'empty-reply' }, 'empty'],
    [{ isAnswered: false, reason: 'some-future-reason' }, 'error'],
  ])('labels the unanswered 2.1.281 shape %j as %s, never unparseable', async (reply, status) => {
    const fork = (async () => reply) as unknown as ForkFn;
    const out = await scoreWithClaude(fork, calls, 400);
    expect(out.status).toBe(status);
    expect(out.verdicts.size).toBe(0);
  });
  it('skips the fork when there is nothing to score', async () => {
    let called = false;
    const out = await scoreWithClaude(async () => { called = true; return null; }, [], 400);
    expect(called).toBe(false);
    expect(out.status).toBe('skipped');
  });
  it('gives up with status timeout when the fork outlasts the timeout', async () => {
    const never: ForkFn = () => new Promise(() => {});
    let waited = -1;
    const sleep = async (ms: number) => { waited = ms; };
    const out = await scoreWithClaude(never, calls, 400, { timeoutMs: 6000, sleep });
    expect(out.status).toBe('timeout');
    expect(out.verdicts.size).toBe(0);
    expect(waited).toBe(6000);
  });
  it('uses the reply when the fork answers before the timeout', async () => {
    const fork: ForkFn = async () => ({ text: '{"drop":["t2"],"truncate":[]}' });
    const out = await scoreWithClaude(fork, calls, 400, { timeoutMs: 6000, sleep: () => new Promise(() => {}) });
    expect(out.status).toBe('ran');
  });
  it('treats a reply without string text as empty, not unparseable', async () => {
    const bad = (async () => ({})) as unknown as ForkFn;
    const out = await scoreWithClaude(bad, calls, 400);
    expect(out.status).toBe('empty');
    expect(out.verdicts.size).toBe(0);
  });
});
